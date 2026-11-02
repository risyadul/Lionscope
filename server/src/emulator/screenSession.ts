import { DEFAULT_SCREEN_FPS_CAP, SCREEN_BINARY_KIND } from '@lionscope/protocol';
import type {
  ScreenClientMessage,
  ScreenErrorCode,
  ScreenFpsCap,
  ScreenRotation,
  ScreenServerMessage,
  ScreenSize,
} from '@lionscope/protocol';
import { errorMessage, log } from '../log.ts';
import { ClipboardBridge } from './clipboardBridge.ts';
import { isAuthError } from './emulatorClient.ts';
import { WheelDrags } from './wheelDrags.ts';
import type { EmulatorClient, FrameStream, InputStream, ScreenFrame } from './emulatorClient.ts';
import {
  frameBox,
  isQuarterTurn,
  keyEvent,
  liftEvent,
  nextRotationZ,
  rotationForZ,
  touchEvent,
  WHEEL_FINGER_ID,
} from './screenInput.ts';
import type { DisplaySize, EmulatorInputEvent } from './screenInput.ts';

/** What a screen session needs of its WebSocket. */
export interface ScreenSocket {
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** After a rotation, how long (attempts × interval) to wait for the emulator to report the new orientation. */
export const SETTLE_ATTEMPTS = 20;
export const SETTLE_INTERVAL_MS = 50;
/** No screenshot is taken for a socket with this much unsent data… */
export const SCREENSHOT_SKIP_BUFFERED_BYTES = 4 * 1024 * 1024;
/** …and a socket this far behind (only frames that must go out still queue) is dropped. */
export const MAX_SCREEN_BUFFERED_BYTES = 16 * 1024 * 1024;
/** While the socket still has unsent data, the paused stream checks it again this often. */
export const DRAIN_POLL_MS = 10;
/** A failed input stream (not a refused token) is reopened no sooner than this. */
export const INPUT_RETRY_MS = 1000;
/** On close, how long the client stays open for the finger lift to be delivered. */
export const LIFT_GRACE_MS = 500;
const FRAME_KIND = Buffer.from([SCREEN_BINARY_KIND.frame]);
const SCREENSHOT_KIND = Buffer.from([SCREEN_BINARY_KIND.screenshot]);
export const ENDED_MESSAGE = 'The emulator stopped streaming its screen';
export const AUTH_MESSAGE = 'The emulator refused the gRPC token';

function failureOf(error: unknown): { code: ScreenErrorCode; message: string } {
  return isAuthError(error)
    ? { code: 'auth', message: AUTH_MESSAGE }
    : { code: 'ended', message: ENDED_MESSAGE };
}

/**
 * One mirrored screen: a screenshot stream scaled to the size preset, forwarded as binary frames, and the
 * socket's input forwarded on one long-lived input stream.
 *
 * Frames are paced at the fps cap with backpressure on the stream itself: it is paused on every frame and
 * resumed once the cap's interval has passed and the socket has sent everything, so the emulator encodes no frame
 * that would only be dropped. A frame that arrives before then waits (the newest replaces it) instead of being
 * dropped, so the last frame of a change (the settled screen) always reaches the dashboard.
 */
export class ScreenSession {
  private display: DisplaySize | null = null;
  private size: ScreenSize;
  private stream: FrameStream | null = null;
  private fpsCap: ScreenFpsCap;
  /**
   * The fps cap's cadence (Date.now()): when the last frame was due. A frame that goes out a little late keeps
   * the cadence, so timer and delivery delays don't pull the rate below the cap.
   */
  private frameSlot = -Infinity;
  /** The newest stream frame not sent yet (the cap's interval or the socket's unsent data holds it). */
  private pending: ScreenFrame | null = null;
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rotation the current stream's bounding box was computed for. */
  private streamRotation: ScreenRotation = 0;
  /** The last screenInfo sent: the dashboard maps its input to the frame it shows. */
  private shown: Extract<ScreenServerMessage, { type: 'screenInfo' }> | null = null;
  private shownKey = '';
  private input: InputStream | null = null;
  private readonly fingersDown = new Set<number>();
  private screenshotPending = false;
  private inputRetryAt = 0;
  /** Set while close() waits for the lift to reach the emulator. */
  private closeClient: (() => void) | null = null;
  private readonly clipboard: ClipboardBridge;
  private rotating = false;
  /** Stream frames so far, and the current prime request: see prime(). */
  private streamFrames = 0;
  private lastStreamRotation: ScreenRotation | null = null;
  private readonly wheels: WheelDrags;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private primeRequest = 0;
  private closed = false;

  constructor(
    private readonly socket: ScreenSocket,
    private readonly client: EmulatorClient,
    readonly serial: string,
    size: ScreenSize,
    fpsCap: ScreenFpsCap = DEFAULT_SCREEN_FPS_CAP,
  ) {
    this.size = size;
    this.fpsCap = fpsCap;
    this.wheels = new WheelDrags({
      geometry: () => (this.display ? { display: this.display, rotation: this.rotation } : null),
      isTouching: () => this.fingersDown.size > 0,
      touch: ({ display, rotation }, point, pressure, droppable) => {
        if (pressure > 0) this.fingersDown.add(WHEEL_FINGER_ID);
        else this.fingersDown.delete(WHEEL_FINGER_ID);
        const event = touchEvent(display, rotation, [{ id: WHEEL_FINGER_ID, ...point, pressure }]);
        this.sendInput(event, { droppable });
      },
      later: (delayMs, action) => this.later(delayMs, action),
    });
    this.clipboard = new ClipboardBridge({
      client,
      serial,
      deliver: (text) => this.send(JSON.stringify({ type: 'clipboard', text } satisfies ScreenServerMessage)),
      pressPaste: () => this.sendInput(keyEvent({ type: 'key', key: 'Paste', eventType: 'keypress' })),
      onAuthFailure: () => this.fail('auth', AUTH_MESSAGE),
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    try {
      this.display = await this.client.getDisplaySize();
    } catch (error) {
      const { code, message } = failureOf(error);
      this.fail(code, message);
      return;
    }
    this.startStream(this.streamRotation);
  }

  handle(message: ScreenClientMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'touch': {
        if (!this.display) return;
        // Only moves of fingers already down may be dropped under back-pressure, never downs or ups.
        const moves = message.touches.every((touch) => touch.pressure > 0 && this.fingersDown.has(touch.id));
        for (const touch of message.touches) {
          if (touch.pressure > 0) this.fingersDown.add(touch.id);
          else this.fingersDown.delete(touch.id);
        }
        this.sendInput(touchEvent(this.display, this.rotation, message.touches), { droppable: moves });
        return;
      }
      case 'wheel':
        if (this.display) this.wheels.add(message);
        return;
      case 'key':
      case 'text':
      case 'nav':
        this.sendInput(keyEvent(message));
        return;
      case 'rotate':
        void this.rotate(message.direction);
        return;
      case 'setSize':
        if (message.size === this.size) return;
        this.size = message.size;
        this.startStream(this.streamRotation);
        return;
      case 'setFpsCap':
        if (message.fps === this.fpsCap) return;
        this.fpsCap = message.fps;
        // Re-time a wait that was set for the old cap.
        this.pace();
        return;
      case 'screenshot':
        void this.screenshot();
        return;
      case 'keyFrame':
        // PNG frames stand on their own.
        return;
      case 'clipboardSync':
      case 'clipboard':
      case 'paste':
        this.clipboard.handle(message);
        return;
    }
  }

  /** Send `screenError` and close the socket. */
  fail(code: ScreenErrorCode, message: string): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify({ type: 'screenError', code, message } satisfies ScreenServerMessage));
    this.socket.close(1000, code);
    this.close();
  }

  /**
   * Release the gRPC streams and the client. Fingers still down (also the wheel's) are lifted first, on a new
   * input stream if the old one ended, so a dropped socket never leaves a finger pressed on the device. The
   * client then closes once the input stream has ended (closing it at once would cancel a call that has not
   * started yet), at the latest after LIFT_GRACE_MS.
   */
  close(): void {
    if (this.closed) return;
    const lifting = this.fingersDown.size > 0;
    if (lifting) this.sendInput(liftEvent(this.fingersDown), { force: true });
    this.fingersDown.clear();
    this.closed = true;
    this.clipboard.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearPaceTimer();
    this.pending = null;
    this.stream?.cancel();
    this.stream = null;
    const input = this.input;
    this.input = null;
    input?.end();
    if (!input || !lifting) {
      this.client.close();
      return;
    }
    this.closeClient = () => {
      clearTimeout(grace);
      this.closeClient = null;
      this.client.close();
    };
    const grace = setTimeout(() => this.closeClient?.(), LIFT_GRACE_MS);
    grace.unref();
  }

  private get rotation(): ScreenRotation {
    return this.shown?.rotation ?? this.streamRotation;
  }

  private startStream(rotation: ScreenRotation): void {
    if (!this.display || this.closed) return;
    this.stream?.cancel();
    this.streamRotation = rotation;
    const stream = this.client.streamScreenshot(frameBox(this.display, rotation, this.size), {
      onFrame: (frame) => {
        if (this.stream !== stream) return;
        stream.pause();
        this.streamFrames += 1;
        this.lastStreamRotation = frame.rotation;
        this.pending = frame;
        this.followOrientation(frame);
        this.pace();
      },
      onEnd: (error) => {
        const { code, message } = failureOf(error);
        this.fail(code, message);
      },
    });
    this.stream = stream;
    // A new stream starts flowing: the pace timer, if any, still holds the next frame back to the cap.
    if (this.paceTimer !== null || this.pending) stream.pause();
    void this.prime();
  }

  /**
   * Send the waiting frame, or resume the stream, once the cap's interval has passed and the socket has sent
   * everything; until then check again (the stream stays paused). Nothing runs while the screen is idle: the
   * stream is resumed and only a change brings the next frame.
   */
  private pace(): void {
    this.clearPaceTimer();
    if (this.closed) return;
    // Date.now() counts whole milliseconds: less than one left is due.
    const wait = this.frameSlot + this.interval - Date.now();
    if (wait >= 1) return this.paceLater(wait);
    if (this.socket.bufferedAmount > 0) return this.paceLater(DRAIN_POLL_MS);
    const frame = this.pending;
    if (frame) {
      this.pending = null;
      this.deliver(frame);
      // The stream stays paused until the next slot.
      if (!this.closed) this.paceLater(this.frameSlot + this.interval - Date.now());
      return;
    }
    this.stream?.resume();
  }

  private get interval(): number {
    return 1000 / this.fpsCap;
  }

  private paceLater(delayMs: number): void {
    this.paceTimer = setTimeout(() => {
      this.paceTimer = null;
      this.pace();
    }, delayMs);
  }

  private clearPaceTimer(): void {
    if (this.paceTimer === null) return;
    clearTimeout(this.paceTimer);
    this.paceTimer = null;
  }

  /**
   * The stream only sends a frame when the screen content changes; after a restart (new size or orientation) or
   * a rotation that leaves the content as it is, the dashboard would keep the old frame. So fetch the current one
   * (until it reports `expected`, if given) and send it, unless the stream has sent a newer frame meanwhile or a
   * later prime took over.
   */
  private async prime(expected?: ScreenRotation): Promise<void> {
    const request = ++this.primeRequest;
    const framesBefore = this.streamFrames;
    let rotation = expected ?? this.rotation;
    for (let attempt = 1; ; attempt += 1) {
      const display = this.display;
      if (!display || this.closed || request !== this.primeRequest) return;
      let frame: ScreenFrame;
      try {
        frame = await this.client.getScreenshot(frameBox(display, rotation, this.size));
      } catch (error) {
        log.warn(`Fetching the screen of ${this.serial} failed: ${errorMessage(error)}`);
        return;
      }
      if (this.closed || request !== this.primeRequest) return;
      // A newer stream frame (in the expected orientation) makes this one stale.
      const overtaken =
        this.streamFrames !== framesBefore &&
        (expected === undefined || this.lastStreamRotation === expected);
      if (overtaken) return;
      const settled = expected === undefined || frame.rotation === expected || attempt >= SETTLE_ATTEMPTS;
      if (settled && isQuarterTurn(frame.rotation) === isQuarterTurn(rotation)) {
        // A stream frame still waiting came before this request: older.
        this.pending = null;
        this.followOrientation(frame);
        this.deliver(frame);
        return;
      }
      // Not there yet, or letterboxed into a box of the other orientation: ask again.
      if (!settled) await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
      rotation = frame.rotation;
    }
  }

  /**
   * Frames come rotated: after a quarter turn, restart with a box of the new orientation so the short edge stays
   * at the preset. The frame (letterboxed into the old box) still goes out.
   */
  private followOrientation(frame: ScreenFrame): void {
    if (isQuarterTurn(frame.rotation) !== isQuarterTurn(this.streamRotation))
      this.startStream(frame.rotation);
  }

  /** Send a frame, screenInfo first if it changed. */
  private deliver(frame: ScreenFrame): void {
    const display = this.display;
    if (!display || this.closed) return;
    // Late by less than half an interval: the next slot, else a new cadence from now (never a burst).
    const now = Date.now();
    const next = this.frameSlot + this.interval;
    this.frameSlot = now - next < this.interval / 2 ? next : now;
    const info = {
      type: 'screenInfo',
      serial: this.serial,
      codec: 'png',
      displayWidth: display.width,
      displayHeight: display.height,
      rotation: frame.rotation,
      frameWidth: frame.width,
      frameHeight: frame.height,
    } satisfies ScreenServerMessage;
    const key = JSON.stringify(info);
    if (key !== this.shownKey) {
      if (!this.send(key)) return;
      this.shownKey = key;
      this.shown = info;
    }
    this.send(Buffer.concat([FRAME_KIND, frame.png]));
  }

  /** Send, unless the socket is hopelessly behind: then it is terminated. */
  private send(data: string | Buffer): boolean {
    if (this.socket.bufferedAmount > MAX_SCREEN_BUFFERED_BYTES) {
      log.warn(`Dropping a screen socket of ${this.serial} that is not reading its frames`);
      this.socket.terminate();
      this.close();
      return false;
    }
    this.socket.send(data);
    return true;
  }

  /**
   * `force`: also during the back-off after a failed input stream (fingers are lifted on close). `droppable`:
   * see InputStream.send.
   */
  private sendInput(event: EmulatorInputEvent, options: { force?: boolean; droppable?: boolean } = {}): void {
    if (this.closed || (!this.input && !options.force && Date.now() < this.inputRetryAt)) return;
    this.input ??= this.client.openInput((error) => {
      this.input = null;
      if (this.closed) {
        this.closeClient?.();
        return;
      }
      if (isAuthError(error)) {
        this.fail('auth', AUTH_MESSAGE);
      } else if (error) {
        log.warn(`Input stream of ${this.serial} failed: ${error.message}`);
        this.inputRetryAt = Date.now() + INPUT_RETRY_MS;
      }
    });
    this.input.send(event, options.droppable);
  }

  private later(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, delayMs);
    this.timers.add(timer);
  }

  private async rotate(direction: 'left' | 'right'): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      const z = nextRotationZ(await this.client.getRotationZ(), direction);
      await this.client.setRotationZ(z);
      void this.prime(rotationForZ(z));
    } catch (error) {
      log.warn(`Rotating ${this.serial} failed: ${errorMessage(error)}`);
    } finally {
      this.rotating = false;
    }
  }

  private async screenshot(): Promise<void> {
    if (this.screenshotPending || this.socket.bufferedAmount > SCREENSHOT_SKIP_BUFFERED_BYTES) return;
    this.screenshotPending = true;
    try {
      const frame = await this.client.getScreenshot();
      if (!this.closed) this.send(Buffer.concat([SCREENSHOT_KIND, frame.png]));
    } catch (error) {
      log.warn(`Screenshot of ${this.serial} failed: ${errorMessage(error)}`);
    } finally {
      this.screenshotPending = false;
    }
  }
}

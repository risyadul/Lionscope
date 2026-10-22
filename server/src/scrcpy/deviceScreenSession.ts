import type { Socket } from 'node:net';
import { SCREEN_BINARY_KIND, SCREEN_VIDEO_FLAG, SCREEN_VIDEO_HEADER_BYTES } from '@lionscope/protocol';
import type {
  ScreenClientMessage,
  ScreenErrorCode,
  ScreenRotation,
  ScreenServerMessage,
  ScreenSize,
} from '@lionscope/protocol';
import { adbShell, execBinary } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { truncateUtf8 } from '../emulator/clipboardBridge.ts';
import { WHEEL_NOTCH } from '../emulator/screenInput.ts';
import { MAX_SCREEN_BUFFERED_BYTES, SCREENSHOT_SKIP_BUFFERED_BYTES } from '../emulator/screenSession.ts';
import type { ScreenSocket } from '../emulator/screenSession.ts';
import { errorMessage, log } from '../log.ts';
import { androidKey, NAV_KEYCODES } from './keycodes.ts';
import {
  backOrScreenOn,
  CODEC_ID_H264,
  DeviceMessageParser,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  KEY_ACTION,
  MOTION_ACTION,
  resetVideo,
  rotateDevice,
  setClipboard,
  VideoStreamParser,
} from './protocol.ts';
import type { ScrcpyPosition, VideoPacket } from './protocol.ts';
import { maxSizeFor, MirrorStartError, parseWmSize, ScrcpyServer } from './scrcpyServer.ts';
import type { ScrcpyConnection, Size } from './scrcpyServer.ts';

/** Above this much unsent data, video packets are dropped until the next key frame (config packets never). */
export const VIDEO_BACKLOG_BYTES = 2 * 1024 * 1024;
/** After a drop, a new key frame (RESET_VIDEO) is requested at most this often. */
export const KEY_FRAME_REQUEST_MS = 1000;
/** Touch moves are dropped while this much input waits to reach the device (downs and ups never). */
export const CONTROL_BACKLOG_BYTES = 256 * 1024;
/** A device with this much unread input has stopped reading it: the session ends. */
export const MAX_CONTROL_BUFFERED_BYTES = 4 * 1024 * 1024;
export const INPUT_STALLED_MESSAGE = 'The device stopped reading input';
/**
 * A connected server must announce its capture (session packet) within this time. Frames may take longer: the
 * encoder only produces them while the screen is on.
 */
export const STREAM_START_TIMEOUT_MS = 15_000;
/** When the stream ends, how long to wait for the server's last words on stderr. */
export const EXIT_SETTLE_MS = 500;
const ADB_TIMEOUT_MS = 5000;
const SCREENCAP_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SCREENSHOT_KIND = Buffer.from([SCREEN_BINARY_KIND.screenshot]);
/** InputManager logs this when the shell user may not inject events (Xiaomi without the security setting). */
const INJECT_DENIED_MARKER = 'INJECT_EVENTS permission';

export const DEVICE_ENDED_MESSAGE = 'The device stopped streaming its screen';
export const INPUT_DENIED_MESSAGE =
  'The device refused touch and key input (the screen is still mirrored). On Xiaomi / HyperOS, turn on ' +
  '"USB debugging (Security settings)" in Developer options, then reboot the device.';

export interface DeviceScreenSessionOptions {
  socket: ScreenSocket;
  adb: Adb;
  serial: string;
  size: ScreenSize;
  /** The vendored scrcpy-server (resolveScrcpyJar). */
  jarPath: string;
}

/**
 * One mirrored physical device, through scrcpy-server: the H.264 stream forwarded packet by packet as `video`
 * messages, the socket's input turned into scrcpy control messages, and the device's clipboard changes
 * forwarded while sharing is on. Clipboard text is never logged.
 */
export class DeviceScreenSession {
  readonly serial: string;
  private readonly socket: ScreenSocket;
  private size: ScreenSize;
  private display: Size | null = null;
  private server: ScrcpyServer | null = null;
  private control: Socket | null = null;
  /** The current video size (last session packet): touch positions are expressed in it. */
  private video: Size | null = null;
  /** Bumped by every (re)start and by close(): events of an older server are ignored. */
  private generation = 0;
  private endingGeneration = -1;
  /** This server sent its session packet (its capture runs) / any video packet. */
  private announced = false;
  /** A key frame to ask for once the capture runs. */
  private keyFramePending = false;
  private received = false;
  private dropping = false;
  private lastKeyFrameRequest = -Infinity;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fingers down, at their last position (lifted on restart and close). */
  private readonly fingers = new Map<number, ScrcpyPosition>();
  private clipboardSync = false;
  /** The last text this socket put on the clipboard: a change to it is our own echo. */
  private lastSet: string | null = null;
  private stderrWindow = '';
  private inputDenied = false;
  private screenshotPending = false;
  private closed = false;
  private closing: Promise<void> = Promise.resolve();

  constructor(private readonly options: DeviceScreenSessionOptions) {
    this.serial = options.serial;
    this.socket = options.socket;
    this.size = options.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    let output: string;
    try {
      output = await adbShell(this.options.adb, this.serial, 'wm size', { timeoutMs: ADB_TIMEOUT_MS });
    } catch (error) {
      log.warn(`Reading the display size of ${this.serial} failed: ${errorMessage(error)}`);
      output = '';
    }
    if (this.closed) return;
    this.display = parseWmSize(output);
    if (!this.display) {
      this.fail('mirror_failed', 'Could not read the display size of the device');
      return;
    }
    await this.launch(++this.generation);
  }

  handle(message: ScreenClientMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'touch':
        this.touch(message.touches);
        return;
      case 'wheel': {
        const position = this.position(message.x, message.y);
        if (!position) return;
        this.write(
          injectScroll({ position, hscroll: message.dx / WHEEL_NOTCH, vscroll: message.dy / WHEEL_NOTCH }),
        );
        return;
      }
      case 'key': {
        const key = androidKey(message.key);
        if (!key) return;
        if (message.eventType !== 'keyup')
          this.write(injectKeycode(KEY_ACTION.down, key.keycode, 0, key.metaState));
        if (message.eventType !== 'keydown')
          this.write(injectKeycode(KEY_ACTION.up, key.keycode, 0, key.metaState));
        return;
      }
      case 'text':
        this.write(injectText(message.text));
        return;
      case 'nav':
        if (message.button === 'back') {
          this.write(backOrScreenOn(KEY_ACTION.down));
          this.write(backOrScreenOn(KEY_ACTION.up));
        } else {
          this.write(injectKeycode(KEY_ACTION.down, NAV_KEYCODES[message.button]));
          this.write(injectKeycode(KEY_ACTION.up, NAV_KEYCODES[message.button]));
        }
        return;
      case 'rotate':
        // ROTATE_DEVICE toggles portrait / landscape; the new orientation arrives as a session packet.
        this.write(rotateDevice());
        return;
      case 'setSize':
        if (message.size === this.size) return;
        this.size = message.size;
        void this.restart();
        return;
      case 'screenshot':
        void this.screenshot();
        return;
      case 'keyFrame':
        this.requestKeyFrame();
        return;
      case 'clipboardSync':
        this.clipboardSync = message.enabled;
        return;
      case 'clipboard':
        if (!this.clipboardSync) return;
        this.lastSet = message.text;
        this.write(setClipboard(0n, message.text, false));
        return;
      case 'paste':
        this.lastSet = message.text;
        this.write(setClipboard(0n, message.text, true));
        return;
    }
  }

  /** Send `screenError` and close the socket. */
  fail(code: ScreenErrorCode, message: string): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify({ type: 'screenError', code, message } satisfies ScreenServerMessage));
    this.socket.close(1000, code);
    void this.close();
  }

  /** Lift fingers still down, then stop the server. Resolves once the device side is cleaned up. */
  close(): Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    this.generation += 1;
    this.liftFingers();
    this.clearStartTimer();
    const server = this.server;
    this.server = null;
    this.control = null;
    this.closing = server ? server.stop() : Promise.resolve();
    return this.closing;
  }

  private async launch(generation: number): Promise<void> {
    const display = this.display;
    if (!display || this.closed || generation !== this.generation) return;
    this.video = null;
    this.announced = false;
    this.keyFramePending = false;
    this.received = false;
    this.dropping = false;
    this.stderrWindow = '';
    const server = new ScrcpyServer({
      adb: this.options.adb,
      serial: this.serial,
      maxSize: maxSizeFor(display, this.size),
      jarPath: this.options.jarPath,
      onStderr: (text) => {
        if (generation === this.generation) this.onStderr(text);
      },
      onExit: () => void this.onEnded(server, generation),
    });
    this.server = server;
    let connection: ScrcpyConnection;
    try {
      connection = await server.start();
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      log.warn(`Mirroring ${this.serial} failed: ${errorMessage(error)}`);
      this.fail(
        'mirror_failed',
        error instanceof MirrorStartError ? error.message : 'scrcpy could not start',
      );
      return;
    }
    if (this.closed || generation !== this.generation) {
      void server.stop();
      return;
    }
    this.attach(connection, server, generation);
  }

  /** A new size: lift fingers, stop the server, start one with the new max_size. */
  private async restart(): Promise<void> {
    const generation = ++this.generation;
    this.liftFingers();
    this.clearStartTimer();
    const previous = this.server;
    this.server = null;
    this.control = null;
    await previous?.stop();
    await this.launch(generation);
  }

  private attach(connection: ScrcpyConnection, server: ScrcpyServer, generation: number): void {
    const { video, control, leftover } = connection;
    const current = () => !this.closed && generation === this.generation;
    this.control = control;
    // The key frame that opens the stream may come before the dashboard's decoder is configured: a fresh one is
    // asked for as soon as the capture runs (a new session packet, config packet and key frame follow).
    this.keyFramePending = true;
    const parser = new VideoStreamParser({
      deviceName: () => undefined,
      codec: (id) => {
        if (id !== CODEC_ID_H264 && current()) {
          const summary = server.errorSummary;
          this.fail(
            'mirror_failed',
            summary ? `scrcpy could not start: ${summary}` : 'The device sent no H.264 video',
          );
        }
      },
      session: (width, height) => {
        if (current()) this.onSession(width, height);
      },
      packet: (packet) => {
        if (current()) this.onPacket(packet);
      },
    });
    const onVideo = (chunk: Buffer) => {
      if (!current()) return;
      try {
        parser.push(chunk);
      } catch (error) {
        log.warn(`Unexpected video data from ${this.serial}: ${errorMessage(error)}`);
        this.fail('mirror_failed', 'The mirroring stream from the device could not be read');
      }
    };
    let deviceMessagesBroken = false;
    const messages = new DeviceMessageParser({ clipboard: (text) => this.onDeviceClipboard(text) });
    video.on('data', onVideo);
    video.on('close', () => void this.onEnded(server, generation));
    control.on('data', (chunk: Buffer) => {
      if (!current() || deviceMessagesBroken) return;
      try {
        messages.push(chunk);
      } catch (error) {
        deviceMessagesBroken = true;
        log.warn(`Unexpected control data from ${this.serial}: ${errorMessage(error)}`);
      }
    });
    control.on('close', () => void this.onEnded(server, generation));
    if (leftover.length > 0) onVideo(leftover);
    video.resume();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!current() || this.announced) return;
      const summary = server.errorSummary;
      this.fail('mirror_failed', summary ? `scrcpy sent no video: ${summary}` : 'The device sent no video');
    }, STREAM_START_TIMEOUT_MS);
    this.startTimer.unref();
  }

  /** The server's stream or process ended on its own: report it once, with its stderr when it never streamed. */
  private async onEnded(server: ScrcpyServer, generation: number): Promise<void> {
    if (this.closed || generation !== this.generation || this.endingGeneration === generation) return;
    // Before the sockets are connected, start() reports the failure.
    if (this.server !== server || this.control === null) return;
    this.endingGeneration = generation;
    await server.waitForExit(EXIT_SETTLE_MS);
    if (this.closed || generation !== this.generation) return;
    const summary = server.errorSummary;
    if (this.received) this.fail('ended', DEVICE_ENDED_MESSAGE);
    else
      this.fail(
        'mirror_failed',
        summary ? `scrcpy stopped: ${summary}` : 'scrcpy stopped before sending video',
      );
  }

  private onStderr(text: string): void {
    this.stderrWindow = (this.stderrWindow + text).slice(-1024);
    if (this.inputDenied || !this.stderrWindow.includes(INJECT_DENIED_MARKER)) return;
    this.inputDenied = true;
    log.warn(`${this.serial} refused input injection (INJECT_EVENTS)`);
    // Not fatal: the socket stays open and mirroring goes on.
    this.send(
      JSON.stringify({
        type: 'screenError',
        code: 'input_denied',
        message: INPUT_DENIED_MESSAGE,
      } satisfies ScreenServerMessage),
    );
  }

  private onSession(width: number, height: number): void {
    const display = this.display;
    if (!display) return;
    this.video = { width, height };
    if (!this.announced) {
      this.announced = true;
      this.clearStartTimer();
    }
    if (this.keyFramePending) {
      // The one a (re)start asks for (requests made before this one merge into it): outside the rate limit.
      this.keyFramePending = false;
      this.write(resetVideo());
    }
    // Physical devices rotate by themselves: a frame whose orientation differs from the display's is turned.
    const rotation: ScreenRotation =
      width !== height && width > height !== display.width > display.height ? 90 : 0;
    this.send(
      JSON.stringify({
        type: 'screenInfo',
        serial: this.serial,
        codec: 'h264',
        displayWidth: display.width,
        displayHeight: display.height,
        rotation,
        frameWidth: width,
        frameHeight: height,
      } satisfies ScreenServerMessage),
    );
  }

  private onPacket(packet: VideoPacket): void {
    if (!this.video) return;
    this.received = true;
    if (!packet.config) {
      // Never queue without bound: drop until the next key frame (asked for at once) while the socket is behind.
      if (this.socket.bufferedAmount > VIDEO_BACKLOG_BYTES) {
        this.dropping = true;
        this.requestKeyFrame();
        return;
      }
      if (this.dropping && !packet.key) return;
      this.dropping = false;
    }
    const header = Buffer.alloc(SCREEN_VIDEO_HEADER_BYTES);
    header.writeUInt8(SCREEN_BINARY_KIND.video, 0);
    header.writeUInt8(
      (packet.config ? SCREEN_VIDEO_FLAG.config : 0) | (packet.key ? SCREEN_VIDEO_FLAG.key : 0),
      1,
    );
    header.writeDoubleBE(packet.ptsUs, 2);
    this.send(Buffer.concat([header, packet.data]));
  }

  /**
   * RESET_VIDEO, once the capture runs: scrcpy 5.0.1 dereferences the capture control without a null check, so a
   * reset that arrives before its session packet kills the server (NullPointerException in control-recv).
   */
  private requestKeyFrame(): void {
    if (!this.announced) {
      this.keyFramePending = true;
      return;
    }
    const now = Date.now();
    if (now - this.lastKeyFrameRequest < KEY_FRAME_REQUEST_MS) return;
    this.lastKeyFrameRequest = now;
    this.write(resetVideo());
  }

  private onDeviceClipboard(text: string): void {
    if (this.closed || !this.clipboardSync || text === '' || text === this.lastSet) return;
    this.send(JSON.stringify({ type: 'clipboard', text: truncateUtf8(text) } satisfies ScreenServerMessage));
  }

  /** Normalized frame coordinates → a position in the current video frame (with its size). */
  private position(u: number, v: number): ScrcpyPosition | null {
    const video = this.video;
    if (!video) return null;
    const clamp = (value: number, size: number) => Math.min(Math.max(Math.round(value * size), 0), size - 1);
    return { x: clamp(u, video.width), y: clamp(v, video.height), width: video.width, height: video.height };
  }

  private touch(touches: Extract<ScreenClientMessage, { type: 'touch' }>['touches']): void {
    if (!this.video) return;
    // Only moves of fingers already down may be dropped under back-pressure, never downs or ups.
    const droppable = touches.every((touch) => touch.pressure > 0 && this.fingers.has(touch.id));
    for (const touch of touches) {
      const position = this.position(touch.x, touch.y);
      if (!position) return;
      const isDown = this.fingers.has(touch.id);
      if (touch.pressure <= 0 && !isDown) continue;
      const action =
        touch.pressure <= 0 ? MOTION_ACTION.up : isDown ? MOTION_ACTION.move : MOTION_ACTION.down;
      if (action === MOTION_ACTION.up) this.fingers.delete(touch.id);
      else this.fingers.set(touch.id, position);
      const pressure = action === MOTION_ACTION.up ? 0 : touch.pressure;
      this.write(injectTouch({ action, pointerId: BigInt(touch.id), position, pressure }), droppable);
    }
  }

  /** Never throws: close() and restart() must go on to stop the server whatever happens here. */
  private liftFingers(): void {
    const fingers = [...this.fingers];
    this.fingers.clear();
    try {
      for (const [id, position] of fingers) {
        this.write(injectTouch({ action: MOTION_ACTION.up, pointerId: BigInt(id), position, pressure: 0 }));
      }
    } catch (error) {
      log.warn(`Lifting the fingers on ${this.serial} failed: ${errorMessage(error)}`);
    }
  }

  private write(data: Buffer, droppable = false): void {
    const control = this.control;
    if (!control?.writable) return;
    if (droppable && control.writableLength > CONTROL_BACKLOG_BYTES) return;
    control.write(data);
    if (control.writableLength > MAX_CONTROL_BUFFERED_BYTES) {
      log.warn(`${this.serial} is not reading its input: closing its screen`);
      this.fail('ended', INPUT_STALLED_MESSAGE);
    }
  }

  /** Send, unless the socket is hopelessly behind: then it is terminated. */
  private send(data: string | Buffer): void {
    if (this.closed) return;
    if (this.socket.bufferedAmount > MAX_SCREEN_BUFFERED_BYTES) {
      log.warn(`Dropping a screen socket of ${this.serial} that is not reading its video`);
      this.socket.terminate();
      void this.close();
      return;
    }
    this.socket.send(data);
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private async screenshot(): Promise<void> {
    if (this.screenshotPending || this.socket.bufferedAmount > SCREENSHOT_SKIP_BUFFERED_BYTES) return;
    this.screenshotPending = true;
    try {
      const png = await execBinary(this.options.adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: SCREENCAP_TIMEOUT_MS,
        maxBytes: MAX_SCREENSHOT_BYTES,
      });
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
        throw new Error('screencap sent no PNG');
      this.send(Buffer.concat([SCREENSHOT_KIND, png]));
    } catch (error) {
      log.warn(`Screenshot of ${this.serial} failed: ${errorMessage(error)}`);
    } finally {
      this.screenshotPending = false;
    }
  }
}

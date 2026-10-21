import type { SdkFrame, SdkStatus } from '@lionscope/protocol';
import { ErrorThrottle } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { SdkFrameAggregator } from '../metrics/sdkFrames.ts';
import type { SessionStore } from '../store/sessionStore.ts';
import type { SdkHello, SdkLink, SdkLinkHandler, SdkLinkMessage } from './sdkLink.ts';

/** gfxinfo polling resumes this long after the last SDK frames arrived. */
export const SDK_FRAMES_IDLE_MS = 3000;
const DRAIN_INTERVAL_MS = 500;
/** The SDK flushes frames every 500 ms: a bucket is complete this long after it ended. */
const SETTLE_MS = 750;
/**
 * Accepted frame times around the laptop clock (after the offset); others come from a broken clock. Age is
 * measured on completion (`ts + totalMs`: a cold-start frame can take many seconds), the lead on `ts`.
 */
export const MAX_FRAME_AGE_MS = 10_000;
export const MAX_FRAME_LEAD_MS = 2000;
/** A frame over a minute is no rendering measurement (a held breakpoint, a stopped process): dropped. */
export const MAX_FRAME_DURATION_MS = 60_000;
/**
 * Messages a pending link may send before its PID is verified (its current screen, the first frames):
 * held, replayed once it is verified, discarded if it is refused. Beyond this they are dropped.
 */
export const MAX_HELD_MESSAGES = 16;
export const droppedFramesMessage = (count: number): string =>
  `SDK reported ${count} dropped frames (device busy); frame counts may read low`;
export const SDK_CLOCK_MESSAGE = 'SDK frames dropped: the device clock does not match the laptop clock';

export const DISCONNECTED_SDK: SdkStatus = {
  connected: false,
  sdkVersion: null,
  processName: null,
  apiLevel: null,
  framesActive: false,
};

export interface SdkBridgeOptions {
  store: SessionStore;
  now: () => number;
  /** Screen spans never start before the session did. */
  startedAt: number;
  /** laptop clock − device clock, in ms. */
  clockOffsetMs: () => number;
  /** Resolves true when `pid` is a process of the session's app on the session's device. */
  verifyPid: (pid: number) => Promise<boolean>;
  /** true while SDK frames flow: gfxinfo polling pauses (observer effect, `reset` clashes). */
  setGfxinfoPaused: (paused: boolean) => void;
  /** `status` changed (the session broadcasts its state). */
  onStatusChange: () => void;
  /** A throttled, client-facing problem report. */
  notify: (key: string, message: string) => void;
  logPrefix: string;
}

interface LinkEntry {
  hello: SdkHello;
  link: SdkLink;
  held: SdkLinkMessage[];
}

/**
 * Feeds one session's SDK link into its store: screen spans, frame samples (`source: 'sdk'`) and frame
 * breakdowns. A new link is pending until its hello PID is confirmed to be the app's process on the session
 * device (anything on the phone can reach the gateway and claim a package name); until then its messages
 * are held back, never stored. Only one verified link is live at a time; a newly verified one replaces (and closes) the older.
 */
export class SdkBridge {
  private current: SdkStatus = DISCONNECTED_SDK;
  private active: LinkEntry | null = null;
  private readonly pending = new Set<LinkEntry>();
  private readonly frames = new SdkFrameAggregator();
  private readonly refusals: ErrorThrottle;
  private lastFramesAt = 0;
  /** Frames FrameMetrics dropped before the SDK saw them, summed over the session. */
  private droppedFrames = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: SdkBridgeOptions) {
    this.refusals = new ErrorThrottle(options.now);
  }

  get status(): SdkStatus {
    return this.current;
  }

  attach(hello: SdkHello, link: SdkLink): SdkLinkHandler {
    const entry: LinkEntry = { hello, link, held: [] };
    this.pending.add(entry);
    void this.verify(entry);
    return {
      onMessage: (message) => {
        if (this.stopped) return;
        if (this.active === entry) this.onMessage(message);
        else if (this.pending.has(entry) && entry.held.length < MAX_HELD_MESSAGES) entry.held.push(message);
      },
      onClose: () => {
        this.pending.delete(entry);
        if (this.active !== entry || this.stopped) return;
        this.active = null;
        this.release();
        this.update({ connected: false, framesActive: false });
      },
    };
  }

  /** The session stopped: close every link and wrap up open data. Status changes are not announced. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending) entry.link.close('no_session');
    this.pending.clear();
    const active = this.active;
    this.active = null;
    this.release();
    active?.link.close('no_session');
    this.current = { ...this.current, connected: false, framesActive: false };
  }

  private async verify(entry: LinkEntry): Promise<void> {
    const { pid } = entry.hello;
    let verified = false;
    try {
      verified = await this.options.verifyPid(pid);
    } catch (error) {
      this.refuse(`SDK pid check failed: ${errorMessage(error)}`);
    }
    // Closed (or the session stopped) while checking.
    if (!this.pending.delete(entry) || this.stopped) return;
    if (!verified) {
      this.refuse(`refused an SDK link: pid ${pid} is not a process of the app on this device`);
      entry.link.close('no_session');
      return;
    }
    const previous = this.active;
    this.active = entry;
    // The app reconnected (or restarted): the screen span and gfxinfo pause carry over to the new link.
    previous?.link.close();
    this.update({
      connected: true,
      sdkVersion: entry.hello.sdkVersion,
      processName: entry.hello.processName,
      apiLevel: entry.hello.apiLevel,
    });
    for (const message of entry.held.splice(0)) this.onMessage(message);
  }

  private onClockSkew(rejected: number, worstSkewMs: number): void {
    if (this.refusals.shouldReport('clock')) {
      const direction = worstSkewMs > 0 ? 'ahead of' : 'behind';
      log.warn(
        `${this.options.logPrefix} dropped ${rejected} SDK frames: up to ${Math.round(Math.abs(worstSkewMs))} ms ` +
          `${direction} the accepted window (clock offset ${this.options.clockOffsetMs()} ms)`,
      );
    }
    this.options.notify('sdk:clock', SDK_CLOCK_MESSAGE);
  }

  private refuse(reason: string): void {
    if (this.refusals.shouldReport(reason)) log.warn(`${this.options.logPrefix} ${reason}`);
  }

  private onMessage(message: SdkLinkMessage): void {
    switch (message.type) {
      case 'screen': {
        const start = Math.max(
          this.options.startedAt,
          Math.min(this.toLaptop(message.ts), this.options.now()),
        );
        this.options.store.appendScreen(start, message.screen);
        return;
      }
      case 'frames':
        this.onFrames(message);
        return;
      case 'heartbeat':
        if (message.droppedMessages > 0) {
          this.options.notify(
            'sdk:dropped',
            `SDK dropped ${message.droppedMessages} messages (device link too slow)`,
          );
        }
        return;
    }
  }

  private onFrames(message: Extract<SdkLinkMessage, { type: 'frames' }>): void {
    if (message.droppedFrames) {
      this.droppedFrames += message.droppedFrames;
      this.options.notify('sdk:dropped-frames', droppedFramesMessage(this.droppedFrames));
    }
    const now = this.options.now();
    const accepted: SdkFrame[] = [];
    /** Largest distance (ms) of a rejected frame from its accepted range: + ahead, − behind. */
    let worstSkewMs = 0;
    let outliers = 0;
    for (const frame of message.frames) {
      if (frame.totalMs > MAX_FRAME_DURATION_MS) {
        outliers += 1;
        continue;
      }
      const ts = this.toLaptop(frame.ts);
      const lead = ts - (now + MAX_FRAME_LEAD_MS);
      const age = ts + frame.totalMs - (now - MAX_FRAME_AGE_MS);
      if (lead > 0 || age < 0) {
        const skew = lead > 0 ? lead : age;
        if (Math.abs(skew) > Math.abs(worstSkewMs)) worstSkewMs = skew;
        continue;
      }
      accepted.push({ ...frame, ts: Math.min(ts, now) });
    }
    if (outliers > 0 && this.refusals.shouldReport('outliers')) {
      log.warn(`${this.options.logPrefix} dropped ${outliers} SDK frames over ${MAX_FRAME_DURATION_MS} ms`);
    }
    const rejected = message.frames.length - accepted.length - outliers;
    if (rejected > 0) this.onClockSkew(rejected, worstSkewMs);
    if (accepted.length === 0) return;
    if (!this.current.framesActive) {
      // Hand over from gfxinfo: SDK frames take the stream after its last sample, never overlapping it.
      this.frames.reset(this.options.store.last('frames')?.ts);
      this.options.setGfxinfoPaused(true);
      this.update({ framesActive: true });
    }
    this.frames.add(accepted, message.intervalMs);
    this.lastFramesAt = now;
    this.drainTimer ??= setInterval(() => this.tick(), DRAIN_INTERVAL_MS);
  }

  private tick(): void {
    const now = this.options.now();
    this.drain(now - SETTLE_MS);
    if (now - this.lastFramesAt < SDK_FRAMES_IDLE_MS) return;
    this.stopFrames();
    this.update({ framesActive: false });
  }

  private drain(untilMs: number): void {
    const { store } = this.options;
    for (const bucket of this.frames.drain(untilMs, (ts) => store.topScreenAt(ts))) {
      store.append('frames', bucket.frames);
      if (bucket.breakdown) store.append('breakdown', bucket.breakdown);
    }
  }

  /** The live link is gone: flush its frames, close its screen span, resume gfxinfo. */
  private release(): void {
    this.drain(Infinity);
    this.stopFrames();
    this.options.store.closeScreen(this.options.now());
  }

  private stopFrames(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.frames.reset();
    if (this.current.framesActive) this.options.setGfxinfoPaused(false);
  }

  private update(changes: Partial<SdkStatus>): void {
    this.current = { ...this.current, ...changes };
    this.options.onStatusChange();
  }

  private toLaptop(deviceMs: number): number {
    return deviceMs + this.options.clockOffsetMs();
  }
}

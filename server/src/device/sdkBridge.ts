import { DEFAULT_SDK_OPTIONS, DEVICE_PROTOCOL_V7, HTTP_EXCHANGES_PER_SECOND } from '@lionscope/protocol';
import type {
  DeviceMessageType,
  SdkFrame,
  SdkNetworkState,
  SdkOptions,
  SdkStatus,
} from '@lionscope/protocol';
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
export const droppedHttpMessage = (count: number): string =>
  `SDK skipped ${count} HTTP calls (over ${HTTP_EXCHANGES_PER_SECOND} per second); the Network list is incomplete`;
export const SDK_CLOCK_MESSAGE = 'SDK frames dropped: the device clock does not match the laptop clock';
/**
 * Accepted stall / StrictMode times (after the offset). Looser than frames on purpose: these are rare, discrete
 * events sent when they end (a stall up to 30 s after its start, a coalesced violation up to 1 s later), possibly
 * held while the link's PID is checked, so losing one costs more than placing one slightly off. The lead is
 * judged on `ts` (then clamped to now), the age on completion (`ts + durationMs` for a stall).
 */
export const MAX_EVENT_AGE_MS = 60_000;
export const MAX_EVENT_LEAD_MS = MAX_FRAME_LEAD_MS;
export const INVALID_DIAGNOSTIC_MESSAGE = 'SDK sent an invalid diagnostic; ignored';
/** Option changes are pushed to the SDK this long after the last one (a dashboard may send several at once). */
export const CONFIG_DEBOUNCE_MS = 150;
export const SDK_EVENT_CLOCK_MESSAGE =
  'SDK events (stalls, StrictMode, layouts) dropped: the device clock does not match the laptop clock';

export const DISCONNECTED_SDK: SdkStatus = {
  connected: false,
  sdkVersion: null,
  processName: null,
  apiLevel: null,
  framesActive: false,
  protocolVersion: null,
  options: DEFAULT_SDK_OPTIONS,
  network: null,
};

/** Network capture on a link: v7 with a link proof in its welcome, v7 without one, or an older SDK. */
export function networkStateOf(protocolVersion: number, proven: boolean): SdkNetworkState {
  if (protocolVersion < DEVICE_PROTOCOL_V7) return 'needs_sdk';
  return proven ? 'active' : 'unverified';
}

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
  /**
   * The live, verified link changed (null: none is live anymore), with its network state (null without a link); the
   * session's mock rules follow an `active` one.
   */
  onLiveLink?: (link: SdkLink | null, network: SdkNetworkState | null) => void;
  /** The live link's SDK applied mock rule set `rev`. */
  onMocksApplied?: (rev: number) => void;
}

interface LinkEntry {
  hello: SdkHello;
  link: SdkLink;
  held: SdkLinkMessage[];
  network: SdkNetworkState;
}

/**
 * Feeds one session's SDK link into its store: screen spans, frame samples (`source: 'sdk'`), frame
 * breakdowns, main-thread stalls and StrictMode violations; and pushes the session's SDK options to it. A new
 * link is pending until its hello PID is confirmed to be the app's process on the session device (anything on
 * the phone can reach the gateway and claim a package name); until then its messages are held back, never
 * stored. Only one verified link is live at a time; a newly verified one replaces (and closes) the older.
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
  /** HTTP calls the SDK did not record (its rate cap), summed over the session. */
  private droppedHttp = 0;
  /** Network messages from a link without the link proof: dropped, never stored or forwarded. */
  private unprovenHttp = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private configTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: SdkBridgeOptions) {
    this.refusals = new ErrorThrottle(options.now);
  }

  get status(): SdkStatus {
    return this.current;
  }

  /** The verified live link (Inspector snapshots are asked of it), null while there is none. */
  get liveLink(): SdkLink | null {
    return this.stopped ? null : (this.active?.link ?? null);
  }

  /**
   * Change the SDK options (partial): announced with the status at once and, when they changed, pushed to the
   * links CONFIG_DEBOUNCE_MS after the last change.
   */
  setOptions(changes: Partial<SdkOptions>): void {
    if (this.stopped) return;
    const previous = this.sdkOptions;
    const options: SdkOptions = {
      stallThresholdMs: changes.stallThresholdMs ?? previous.stallThresholdMs,
      strictMode: changes.strictMode ?? previous.strictMode,
      inflateTracking: changes.inflateTracking ?? previous.inflateTracking,
      rxTracking: changes.rxTracking ?? previous.rxTracking,
    };
    this.update({ options });
    if (
      options.stallThresholdMs === previous.stallThresholdMs &&
      options.strictMode === previous.strictMode &&
      options.inflateTracking === previous.inflateTracking &&
      options.rxTracking === previous.rxTracking
    ) {
      return;
    }
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = setTimeout(() => this.pushConfig(), CONFIG_DEBOUNCE_MS);
  }

  /**
   * `verified`: the gateway already confirmed the hello's PID on the session device (no second check). `proven`: its
   * welcome carries the link proof (the app holds the link key), so network capture and mocks run on it.
   */
  attach(hello: SdkHello, link: SdkLink, verified = false, proven = false): SdkLinkHandler {
    const network = networkStateOf(link.protocolVersion, proven);
    const entry: LinkEntry = { hello, link, held: [], network };
    this.pending.add(entry);
    // Options are not sensitive: a link gets them right after its welcome, before its PID is verified.
    link.sendConfig(this.sdkOptions);
    if (verified) this.activate(entry);
    else void this.verify(entry);
    return {
      onMessage: (message) => {
        if (this.stopped) return;
        if (this.active === entry) this.onMessage(message);
        else if (this.pending.has(entry) && entry.held.length < MAX_HELD_MESSAGES) entry.held.push(message);
      },
      onInvalidDiagnostic: () => {
        if (this.active === entry && !this.stopped) {
          this.options.notify('sdk:invalid-diagnostic', INVALID_DIAGNOSTIC_MESSAGE);
        }
      },
      onClose: () => {
        this.pending.delete(entry);
        if (this.active !== entry || this.stopped) return;
        this.active = null;
        this.release();
        this.options.store.http.linkClosed(link);
        this.update({ connected: false, framesActive: false, protocolVersion: null, network: null });
        this.options.onLiveLink?.(null, null);
      },
    };
  }

  /** The session stopped: close every link and wrap up open data. Status changes are not announced. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = null;
    for (const entry of this.pending) entry.link.close('no_session');
    this.pending.clear();
    const active = this.active;
    this.active = null;
    this.release();
    this.options.store.http.end();
    active?.link.close('no_session');
    this.current = {
      ...this.current,
      connected: false,
      framesActive: false,
      protocolVersion: null,
      network: null,
    };
  }

  private pushConfig(): void {
    this.configTimer = null;
    const links = this.active ? [...this.pending, this.active] : [...this.pending];
    for (const entry of links) entry.link.sendConfig(this.sdkOptions);
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
    this.activate(entry);
  }

  /** A pending link checked out: it becomes the live one. */
  private activate(entry: LinkEntry): void {
    this.pending.delete(entry);
    if (this.stopped) return;
    const previous = this.active;
    this.active = entry;
    // The app reconnected (or restarted): the screen span and gfxinfo pause carry over to the new link.
    previous?.link.close();
    // Calls still open on the old link get no response anymore.
    if (previous) this.options.store.http.linkClosed(previous.link);
    this.update({
      connected: true,
      sdkVersion: entry.hello.sdkVersion,
      processName: entry.hello.processName,
      apiLevel: entry.hello.apiLevel,
      protocolVersion: entry.link.protocolVersion,
      network: entry.network,
    });
    this.options.onLiveLink?.(entry.link, entry.network);
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

  /** Network messages dropped because their link has no link proof (an old, foreign or forged SDK). */
  get unprovenNetworkMessages(): number {
    return this.unprovenHttp;
  }

  private dropUnproven(type: string): void {
    this.unprovenHttp += 1;
    this.refuse(
      `dropped SDK ${type} messages from a link without the link proof, ${this.unprovenHttp} so far`,
      'unproven-http',
    );
  }

  private refuse(reason: string, key = reason): void {
    if (this.refusals.shouldReport(key)) log.warn(`${this.options.logPrefix} ${reason}`);
  }

  private onMessage(message: SdkLinkMessage): void {
    switch (message.type) {
      case 'screen':
        this.options.store.appendScreen(this.sessionTime(message.ts), message.screen);
        return;
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
      case 'stall': {
        const ts = this.eventTime('stall', message.ts, message.durationMs);
        if (ts === null) return;
        const { durationMs, frames, samples, truncated, debugger: debuggerAttached } = message;
        const { outerFrames, rx, coroutine } = message;
        this.options.store.append('stalls', {
          ts,
          durationMs,
          frames,
          samples,
          truncated,
          screen: this.screenAt(ts, message.screen),
          debugger: debuggerAttached,
          // 0.9.0 origin facts, only when the SDK sent them.
          ...(outerFrames === undefined ? {} : { outerFrames }),
          ...(rx === undefined ? {} : { rx }),
          ...(coroutine === undefined ? {} : { coroutine }),
        });
        return;
      }
      case 'strictmode': {
        const ts = this.eventTime('strictmode', message.ts, 0);
        if (ts === null) return;
        const { policy, violation, count, frames } = message;
        this.options.store.append('strictMode', {
          ts,
          policy,
          violation,
          message: message.message,
          frames,
          count,
          screen: this.screenAt(ts, message.screen),
        });
        return;
      }
      case 'inflate': {
        const ts = this.eventTime('inflate', message.ts, message.maxMs);
        if (ts === null) return;
        const { layout, label, library, nested, count, totalMs, maxMs, views } = message;
        this.options.store.append('inflates', {
          ts,
          layout,
          label,
          library,
          nested,
          screen: this.screenAt(ts, message.screen),
          count,
          totalMs,
          maxMs,
          views,
        });
        return;
      }
      case 'httpRequest': {
        // Network data counts only from a link that got the link proof (a proven SDK sends nothing else).
        if (this.current.network !== 'active') return this.dropUnproven(message.type);
        if (message.dropped > 0) {
          this.droppedHttp += message.dropped;
          this.options.notify('sdk:dropped-http', droppedHttpMessage(this.droppedHttp));
        }
        const link = this.active?.link;
        if (link) this.options.store.http.request(link, this.sessionTime(message.ts), message);
        return;
      }
      case 'httpResponse': {
        if (this.current.network !== 'active') return this.dropUnproven(message.type);
        const link = this.active?.link;
        if (link) this.options.store.http.response(link, message);
        return;
      }
      case 'mocksApplied':
        if (this.current.network !== 'active') return this.dropUnproven(message.type);
        this.options.onMocksApplied?.(message.rev);
        return;
      case 'viewtree': {
        const ts = this.eventTime('viewtree', message.ts, 0);
        if (ts === null) return;
        const { window, views, viewGroups, maxDepth, deepestPath, topClasses } = message;
        this.options.store.append('viewTrees', {
          ts,
          screen: this.screenAt(ts, message.screen),
          window,
          views,
          viewGroups,
          maxDepth,
          deepestPath,
          topClasses,
        });
        return;
      }
    }
  }

  /**
   * Laptop time of a stall / StrictMode event, or null when it lies outside the accepted window (reported) or
   * ended before the session started (dropped quietly). One that straddles the session start begins at it, like
   * screen spans; its duration is kept.
   */
  private eventTime(type: DeviceMessageType, deviceTs: number, durationMs: number): number | null {
    const now = this.options.now();
    const ts = this.toLaptop(deviceTs);
    const lead = ts - (now + MAX_EVENT_LEAD_MS);
    const age = ts + durationMs - (now - MAX_EVENT_AGE_MS);
    if (lead <= 0 && age >= 0) {
      const { startedAt } = this.options;
      return ts + durationMs < startedAt ? null : Math.max(startedAt, Math.min(ts, now));
    }
    if (this.refusals.shouldReport('event-clock')) {
      const skew = lead > 0 ? `${Math.round(lead)} ms ahead of` : `${Math.round(-age)} ms behind`;
      log.warn(
        `${this.options.logPrefix} dropped an SDK ${type} event ${skew} the accepted window ` +
          `(clock offset ${this.options.clockOffsetMs()} ms)`,
      );
    }
    this.options.notify('sdk:event-clock', SDK_EVENT_CLOCK_MESSAGE);
    return null;
  }

  /** The SDK's own screen name, else the top screen of the recorded spans. */
  private screenAt(ts: number, sdkScreen: string | null): string | null {
    return sdkScreen ?? this.options.store.topScreenAt(ts);
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

  private get sdkOptions(): SdkOptions {
    return this.current.options ?? DEFAULT_SDK_OPTIONS;
  }

  private update(changes: Partial<SdkStatus>): void {
    this.current = { ...this.current, ...changes };
    this.options.onStatusChange();
  }

  private toLaptop(deviceMs: number): number {
    return deviceMs + this.options.clockOffsetMs();
  }

  /** Laptop time of a device timestamp, clamped into [session start, now]. */
  private sessionTime(deviceMs: number): number {
    return Math.max(this.options.startedAt, Math.min(this.toLaptop(deviceMs), this.options.now()));
  }
}

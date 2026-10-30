import { isValidPackageName, isValidSerial } from '@lionscope/protocol';
import type {
  CpuSample,
  HttpExchangeDetail,
  MemorySample,
  NetworkMockRule,
  NetworkMocksState,
  SdkOptions,
  ServerMessage,
  SessionState,
  SessionStatus,
  Snapshot,
  TimelineEvent,
  TimelineEventKind,
} from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { ShellSession } from '../adb/shellSession.ts';
import { BUFFER_WINDOW_MS } from '../config.ts';
import { SdkBridge } from '../device/sdkBridge.ts';
import type { SdkHello, SdkLink, SdkLinkHandler } from '../device/sdkLink.ts';
import { PublicError } from '../errors.ts';
import { log } from '../log.ts';
import { computeCpuUsage } from '../metrics/cpu.ts';
import type { CpuReading } from '../metrics/cpu.ts';
import { FrameAggregator } from '../metrics/frames.ts';
import { FRAMESTATS_HISTORY_ROWS, parseFramestats } from '../parsers/gfxinfo.ts';
import { parseMeminfo } from '../parsers/meminfo.ts';
import { parseProcStat } from '../parsers/procStat.ts';
import { parsePidList, parsePidof, parseUptime } from '../parsers/shellValues.ts';
import { SessionStore } from '../store/sessionStore.ts';
import { CollectorErrorReporter } from './collectorErrors.ts';
import { CollectorScheduler } from './collectorScheduler.ts';
import { DEFAULT_DEVICE_FACTS, probeDevice } from './deviceProbe.ts';
import { LogBatcher, startLogcatStream } from './logcatStream.ts';
import type { LogcatStream } from './logcatStream.ts';
import { MockRules, NO_SESSION_MOCKS_MESSAGE } from './mockRules.ts';
import type { MockOrigin } from './mockRules.ts';

export interface CollectorIntervals {
  cpuMs: number;
  framesMs: number;
  memoryMs: number;
  logFlushMs: number;
  logcatRestartMs: number;
}

export const DEFAULT_INTERVALS: CollectorIntervals = {
  cpuMs: 1000,
  // HWUI keeps only 120 frames per window: poll often enough not to lose any at 120 Hz.
  framesMs: 500,
  memoryMs: 3000,
  logFlushMs: 250,
  logcatRestartMs: 2000,
};

const TIMEOUTS = { cpu: 3000, frames: 8000, memory: 10_000 };

export interface ProfilingSessionOptions {
  adb: Adb;
  serial: string;
  packageName: string;
  emit: (message: ServerMessage) => void;
  now?: () => number;
  bufferWindowMs?: number;
  intervals?: Partial<CollectorIntervals>;
  /** The device probe finished (the clock offset is known): the SDK link may be set up. */
  onReady?: () => void;
}

/**
 * Profiles one app on one device: CPU + PID tracking, frames and memory on separate persistent
 * shells (a slow `dumpsys meminfo` never delays CPU sampling), a logcat stream for the PID, and the
 * in-app SDK link when the app has one.
 */
export class ProfilingSession {
  readonly serial: string;
  readonly packageName: string;
  readonly startedAt: number;

  private readonly adb: Adb;
  private readonly emit: (message: ServerMessage) => void;
  private readonly now: () => number;
  private readonly intervals: CollectorIntervals;
  private readonly shells: Record<'cpu' | 'frames' | 'memory', ShellSession>;
  private readonly scheduler: CollectorScheduler;
  private readonly onReady: (() => void) | undefined;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private status: SessionStatus = 'waiting_for_process';
  private error: string | undefined;
  private appPid: number | null = null;
  private appPidStartTime: number | null = null;
  private pidObserved = false;
  private pidRefresh: Promise<number[]> | null = null;
  private ready = false;
  private stopped = false;

  private device = { ...DEFAULT_DEVICE_FACTS };
  private cpuBaseline: CpuReading | null = null;
  private readonly frameAggregator = new FrameAggregator();
  private truncationWarned = false;
  private logcat: LogcatStream | null = null;
  private readonly logs: LogBatcher;
  private readonly errors: CollectorErrorReporter;
  private readonly store: SessionStore;
  private readonly sdk: SdkBridge;
  private readonly mocks: MockRules;

  constructor(options: ProfilingSessionOptions) {
    if (!isValidSerial(options.serial)) throw new Error('invalid adb serial');
    if (!isValidPackageName(options.packageName)) throw new Error('invalid package name');
    this.adb = options.adb;
    this.serial = options.serial;
    this.packageName = options.packageName;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.startedAt = this.now();
    this.errors = new CollectorErrorReporter({
      logPrefix: `[${this.serial} ${this.packageName}]`,
      emit: this.emit,
      now: this.now,
      isStopped: () => this.stopped,
    });
    this.scheduler = new CollectorScheduler({
      now: this.now,
      report: (collector, error) => this.errors.report(collector, error),
    });
    this.onReady = options.onReady;

    const spawnShell = () => this.adb.spawn(['-s', this.serial, 'shell']);
    this.shells = {
      cpu: new ShellSession(spawnShell),
      frames: new ShellSession(spawnShell),
      memory: new ShellSession(spawnShell),
    };
    const windowMs = options.bufferWindowMs ?? BUFFER_WINDOW_MS;
    this.store = new SessionStore({ windowMs, emit: this.emit, now: this.now });
    this.logs = new LogBatcher({
      maxPending: 5000,
      windowMs,
      now: this.now,
      flush: (entries) => this.store.append('logs', ...entries),
    });
    this.mocks = new MockRules({ now: this.now, emit: this.emit });
    this.sdk = new SdkBridge({
      store: this.store,
      now: this.now,
      startedAt: this.startedAt,
      clockOffsetMs: () => this.device.clockOffsetMs,
      verifyPid: async (pid) => (await this.refreshPid()).includes(pid),
      logPrefix: `[${this.serial} ${this.packageName}]`,
      setGfxinfoPaused: (paused) => this.setCollectorEnabled('frames', !paused),
      onStatusChange: () => this.emit({ type: 'session', session: this.state }),
      notify: (key, message) => this.errors.notify(key, message),
      // Mocks only reach an app that holds the link key: an unproven SDK keeps them off anyway.
      onLiveLink: (link, network) =>
        link && network === 'active' ? this.mocks.linkUp(link) : this.mocks.linkDown(),
      onMocksApplied: (rev) => this.mocks.applied(rev),
    });
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** The device probe is done; before that the clock offset is unknown and SDK links are refused. */
  get isReady(): boolean {
    return this.ready && !this.stopped;
  }

  get state(): SessionState {
    return {
      status: this.status,
      serial: this.serial,
      packageName: this.packageName,
      pid: this.appPid,
      startedAt: this.startedAt,
      ...(this.error === undefined ? {} : { error: this.error }),
      sdk: this.sdk.status,
    };
  }

  snapshot(): Snapshot {
    return this.store.snapshot();
  }

  /** Change this session's SDK options (partial); the session is re-announced and live links get `config`. */
  setSdkOptions(changes: Partial<SdkOptions>): void {
    this.sdk.setOptions(changes);
  }

  /** Network messages dropped because their link had no link proof. */
  get unprovenNetworkMessages(): number {
    return this.sdk.unprovenNetworkMessages;
  }

  /** The live, verified SDK link of this session (null while none is), for Inspector snapshots. */
  get sdkLink(): SdkLink | null {
    return this.sdk.liveLink;
  }

  /** Headers and bodies of one HTTP exchange of this session; null when it is not (or no longer) kept. */
  httpExchange(id: number): HttpExchangeDetail | null {
    return this.store.http.detail(id);
  }

  /** The session's mock rules (empty once it stopped). */
  get networkMocks(): NetworkMocksState {
    return this.mocks.state;
  }

  /** Create or replace a mock rule (see MockRules.set); refused once the session stopped. */
  setNetworkMock(input: unknown, origin: MockOrigin): NetworkMockRule {
    if (this.stopped) throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
    return this.mocks.set(input, origin);
  }

  /** Remove one rule (`id`) or all of them; false when `id` names no rule. */
  clearNetworkMocks(id?: string): boolean {
    if (id !== undefined) return this.mocks.remove(id);
    this.mocks.clear();
    return true;
  }

  /** The top screen as the SDK last reported it, null when unknown or in the background. */
  topScreen(): string | null {
    return this.store.topScreenAt(this.now());
  }

  /**
   * Hand an SDK connection for this app to the session; it goes live once its PID checks out (at once when
   * `verified`: its PID was already checked on the session device). `proven`: its welcome carries the link proof.
   */
  attachSdk(hello: SdkHello, link: SdkLink, verified = false, proven = false): SdkLinkHandler {
    return this.sdk.attach(hello, link, verified, proven);
  }

  /** The app's SDK was linked at some point of this session, though it may have dropped since. */
  get sdkEverLinked(): boolean {
    return this.sdk.everLinked;
  }

  /** HTTP exchanges seen over the whole session, however many are still kept. */
  get httpExchangesSeen(): number {
    return this.store.http.totalSeen;
  }

  /** HTTP exchanges kept (status counts them without building a snapshot). */
  get httpExchangeCount(): number {
    return this.store.http.count();
  }

  /**
   * `pidof` the app now (concurrent callers share one call) and apply the result; resolves with every PID
   * of the app. A no-op ([]) before the session is ready.
   */
  refreshPid(): Promise<number[]> {
    if (!this.isReady) return Promise.resolve([]);
    this.pidRefresh ??= this.shells.cpu
      .run(`pidof ${this.packageName}`, TIMEOUTS.cpu)
      .then((output) => {
        if (!this.stopped) this.updatePid(parsePidof(output), false);
        return parsePidList(output);
      })
      .finally(() => {
        this.pidRefresh = null;
      });
    return this.pidRefresh;
  }

  /** Pause or resume gfxinfo polling; once resumed it re-primes (frames from the pause are not counted). */
  setCollectorEnabled(collector: 'frames', enabled: boolean): void {
    if (this.scheduler.setPaused(collector, !enabled)) this.frameAggregator.reset();
  }

  /** Probe the device, take the first PID reading and start every collector. */
  async start(): Promise<void> {
    this.device = await probeDevice(this.shells.cpu, this.now, (error) => this.errors.report('setup', error));
    if (this.stopped) return;
    this.ready = true;
    this.onReady?.();
    await this.scheduler.run('cpu', () => this.cpuTick());
    if (this.stopped) return;
    this.scheduler.loop('cpu', this.intervals.cpuMs, () => this.cpuTick(), this.intervals.cpuMs);
    this.scheduler.loop('frames', this.intervals.framesMs, () => this.framesTick(), 0);
    this.scheduler.loop('memory', this.intervals.memoryMs, () => this.memoryTick(), 0);
    this.flushTimer = setInterval(() => this.logs.flush(), this.intervals.logFlushMs);
  }

  /** Stop all collectors and release device resources. Idempotent. */
  stop(finalStatus: Extract<SessionStatus, 'idle' | 'error'> = 'idle', error?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sdk.stop();
    this.mocks.end();
    this.scheduler.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.logs.flush();
    this.logcat?.stop();
    this.logcat = null;
    for (const shell of Object.values(this.shells)) shell.close();
    this.status = finalStatus;
    this.error = error;
    this.appPid = null;
    this.emit({ type: 'session', session: this.state });
  }

  private async cpuTick(): Promise<void> {
    await this.refreshPid();
    const pid = this.appPid;
    if (this.stopped || pid === null) return;

    const output = await this.shells.cpu.run(`cat /proc/uptime /proc/${pid}/stat`, TIMEOUTS.cpu);
    if (this.stopped || this.appPid !== pid) return;
    const stat = parseProcStat(output);
    const uptime = parseUptime(output);
    // A missing stat line usually means the process died between the two commands (the next tick
    // notices); only a streak of them is reported.
    this.errors.parsed('cpu', stat !== null && uptime !== null, output);
    if (!stat || stat.pid !== pid || uptime === null) return;
    if (this.appPidStartTime !== null && stat.startTime !== this.appPidStartTime) {
      // Same PID, different process: it died and the PID was reused between two ticks.
      this.updatePid(pid, true);
    }
    this.appPidStartTime = stat.startTime;

    const reading: CpuReading = { ticks: stat.utime + stat.stime, atSec: uptime, threads: stat.numThreads };
    const usage = computeCpuUsage(this.cpuBaseline, reading, this.device.clkTck, this.device.cores);
    this.cpuBaseline = reading;
    if (!usage) return;
    const sample: CpuSample = { ts: this.now(), ...usage };
    this.store.append('cpu', sample);
  }

  private async framesTick(): Promise<void> {
    const pid = this.appPid;
    if (pid === null) return;
    // Uptime in the same call gives the device-side elapsed time between dumps.
    const output = await this.shells.frames.run(
      `cat /proc/uptime; dumpsys gfxinfo ${pid} framestats reset`,
      TIMEOUTS.frames,
    );
    if (this.stopped || this.appPid !== pid) return;
    const newline = output.indexOf('\n');
    const uptime = parseUptime(newline === -1 ? output : output.slice(0, newline));
    if (uptime === null) return;
    const framestats = parseFramestats(output.slice(newline + 1));
    const { blockCount, maxWindowRows } = framestats;
    // No PROFILEDATA block: no data, not 0 fps. The process header without any window (cold start, nothing
    // drawn yet) is simply "no windows yet"; only output we can't make sense of counts as a parse miss.
    const noWindowsYet = framestats.processHeader && framestats.windowCount === 0;
    this.errors.parsed('frames', blockCount > 0 || noWindowsYet, output);
    if (blockCount === 0) return;
    if (maxWindowRows >= FRAMESTATS_HISTORY_ROWS && !this.truncationWarned) {
      this.truncationWarned = true;
      log.warn(
        `[${this.serial} ${this.packageName}] a window reported ${maxWindowRows} frames in one poll; ` +
          'frames may have been dropped from the framestats history',
      );
    }
    // The first dump after (re)start holds frames from before we were watching: ingest() drops it.
    const sample = this.frameAggregator.ingest(framestats, this.now(), uptime);
    // Paused while the dump was in flight: SDK frames own the stream now.
    if (!sample || this.scheduler.isPaused('frames')) return;
    this.store.append('frames', sample);
  }

  private async memoryTick(): Promise<void> {
    const pid = this.appPid;
    if (pid === null) return;
    // `--local` collects the same App Summary from the system side. Without it the target app is asked
    // to dump its own runtime stats, which forces an explicit GC there on every poll (observer effect).
    const output = await this.shells.memory.run(`dumpsys meminfo --local ${pid}`, TIMEOUTS.memory);
    if (this.stopped || this.appPid !== pid) return;
    const breakdown = parseMeminfo(output);
    this.errors.parsed('memory', breakdown !== null, output);
    if (!breakdown) return;
    const sample: MemorySample = { ts: this.now(), ...breakdown };
    this.store.append('memory', sample);
  }

  /** Apply a PID observation; `reused` marks a new process that got the same PID. */
  private updatePid(pid: number | null, reused: boolean): void {
    if (this.pidObserved && pid === this.appPid && !reused) return;
    const previous = this.appPid;
    const firstObservation = !this.pidObserved;
    this.pidObserved = true;
    this.appPid = pid;
    this.appPidStartTime = null;
    this.cpuBaseline = null;
    this.frameAggregator.reset();
    this.errors.resetParseMisses();
    this.logs.forgetResume();
    this.status = pid === null ? 'waiting_for_process' : 'running';

    if (!firstObservation) {
      let kind: TimelineEventKind = 'process_restart';
      if (previous === null) kind = 'process_start';
      else if (pid === null) kind = 'process_died';
      const event: TimelineEvent = { ts: this.now(), kind, pid: pid ?? previous };
      this.store.append('events', event);
    }
    this.emit({ type: 'session', session: this.state });
    this.followLogcat(pid);
  }

  private followLogcat(pid: number | null): void {
    this.logcat?.stop();
    this.logcat = null;
    if (pid === null || this.stopped) return;

    let stream: LogcatStream | null = null;
    try {
      stream = startLogcatStream({
        adb: this.adb,
        serial: this.serial,
        pid,
        clockOffsetMs: this.device.clockOffsetMs,
        resume: this.logs.resume,
        onEntry: (entry, deviceTs) => this.logs.add(entry, deviceTs),
        onExit: (reason) => {
          if (this.logcat !== stream) return;
          this.logcat = null;
          this.restartLogcatLater(pid, `${reason}; restarting`);
        },
      });
    } catch (error) {
      this.restartLogcatLater(pid, error);
      return;
    }
    this.logcat = stream;
  }

  private restartLogcatLater(pid: number, reason: unknown): void {
    if (this.stopped || this.appPid !== pid) return;
    this.errors.report('logcat', reason);
    this.scheduler.schedule(
      'logcat',
      () => {
        if (this.appPid === pid && !this.logcat) this.followLogcat(pid);
      },
      this.intervals.logcatRestartMs,
    );
  }
}

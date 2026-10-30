import { DEVICE_LINK_PORT, DEVICE_PROTOCOL_V7, isValidPackageName, isValidSerial } from '@lionscope/protocol';
import type {
  AppInfo,
  DeviceInfo,
  HttpExchangeDetail,
  NetworkMockRule,
  NetworkMocksState,
  SdkOptions,
  ServerMessage,
  SessionState,
  Snapshot,
} from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { BUFFER_WINDOW_MS } from '../config.ts';
import type { InspectLinks } from '../device/inspectLinks.ts';
import { deliverLinkKey } from '../device/linkKey.ts';
import { ReverseTunnel } from '../device/reverseTunnel.ts';
import type { SdkAttachResult, SdkHello, SdkLink, SdkLinkTarget } from '../device/sdkLink.ts';
import { ErrorThrottle, PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { parseDevices } from '../parsers/devices.ts';
import { buildAppList, parsePackageList } from '../parsers/packages.ts';
import { parsePs } from '../parsers/ps.ts';
import { parsePidList } from '../parsers/shellValues.ts';
import type { AppCrash } from '../store/crashLog.ts';
import { emptySnapshot } from '../store/sessionStore.ts';
import { EMPTY_MOCKS, NO_SESSION_MOCKS_MESSAGE } from './mockRules.ts';
import type { MockOrigin } from './mockRules.ts';
import { ProfilingSession } from './profilingSession.ts';
import type { CollectorIntervals } from './profilingSession.ts';
import { NO_SESSION_MARKERS_MESSAGE } from './runMarkers.ts';
import type { RunMarker } from './runMarkers.ts';

export const DEFAULT_DEVICE_POLL_MS = 2000;
/** Consecutive `adb devices` failures before an active session is put into error. */
export const MAX_DEVICE_LIST_FAILURES = 3;
/**
 * Consecutive successful listings without the session's device (or with it not in state `device`)
 * before the session is stopped: USB renegotiation and some OEM mode switches flicker for ~1 s.
 */
export const DEVICE_GONE_LISTINGS = 3;
export const ADB_UNAVAILABLE_MESSAGE =
  'adb is not available. Install Android platform-tools, or set LIONSCOPE_ADB or ANDROID_HOME.';
export const SESSION_ADB_UNAVAILABLE = 'adb unavailable: cannot list devices';
export const SDK_LINK_UNAVAILABLE = 'SDK link unavailable (adb reverse failed)';
export const SDK_GATEWAY_DOWN = 'SDK link unavailable (the SDK gateway is not listening)';
/** While no SDK is connected, the `adb reverse` mapping is re-applied this often (it may have been lost). */
export const REMAP_INTERVAL_MS = 10_000;
const DEVICES_TIMEOUT_MS = 5000;
const APPS_TIMEOUT_MS = 15_000;
const PIDOF_TIMEOUT_MS = 5000;
const NO_SESSION: SdkAttachResult = { ok: false, reason: 'no_session' };

export interface InspectorSessionSource {
  packageName: string;
  link: SdkLink | null;
  screen: string | null;
}

export const IDLE_SESSION: SessionState = {
  status: 'idle',
  serial: null,
  packageName: null,
  pid: null,
  startedAt: null,
};

export interface SessionManagerOptions {
  adb: Adb;
  broadcast: (message: ServerMessage) => void;
  now?: () => number;
  devicePollMs?: number;
  bufferWindowMs?: number;
  sessionIntervals?: Partial<CollectorIntervals>;
  /**
   * Bound port of the SDK device gateway (null while it isn't listening). Omitted = no SDK gateway at all:
   * no `adb reverse` for sessions.
   */
  deviceGatewayPort?: () => number | null;
  /** Replaces the TCP probe that tells a live server's `adb reverse` mapping from a stale one (tests). */
  isHostPortLive?: (port: number) => Promise<boolean>;
  /**
   * Inspect-only SDK links outside the session: verified hellos of other apps go there, they hear about the
   * session's mapping and device listings, and take a device's mapping over when its session ends.
   */
  inspectLinks?: InspectLinks;
}

/**
 * Owns the device list, at most one profiling session, and that session's SDK link; routes every SDK hello (to the
 * session, or to the inspect-only links).
 */
export class SessionManager implements SdkLinkTarget {
  private readonly adb: Adb;
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly now: () => number;
  private readonly devicePollMs: number;
  private readonly bufferWindowMs: number;
  private readonly sessionIntervals: Partial<CollectorIntervals> | undefined;
  private readonly tunnel: ReverseTunnel;
  private readonly gatewayPort: (() => number | null) | undefined;
  private readonly linkErrors: ErrorThrottle;
  private readonly refusals: ErrorThrottle;
  private readonly inspectLinks: InspectLinks | undefined;
  private gatewayDownReported = false;
  private staleChecked = false;
  private lastTunnelAt = 0;

  private devices: DeviceInfo[] = [];
  private devicesKey = '[]';
  private lastListingOk = false;
  private consecutiveFailures = 0;
  private deviceGoneListings = 0;
  private adbErrorReported = false;
  private refreshInFlight: Promise<DeviceInfo[]> | null = null;
  private readonly appsInFlight = new Map<string, Promise<AppInfo[]>>();
  private session: ProfilingSession | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Serializes start/stop so overlapping requests can't leave two sessions running. */
  private operations: Promise<unknown> = Promise.resolve();

  constructor(options: SessionManagerOptions) {
    this.adb = options.adb;
    this.broadcast = options.broadcast;
    this.now = options.now ?? Date.now;
    this.devicePollMs = options.devicePollMs ?? DEFAULT_DEVICE_POLL_MS;
    this.bufferWindowMs = options.bufferWindowMs ?? BUFFER_WINDOW_MS;
    this.sessionIntervals = options.sessionIntervals;
    this.linkErrors = new ErrorThrottle(this.now);
    this.refusals = new ErrorThrottle(this.now);
    this.gatewayPort = options.deviceGatewayPort;
    this.inspectLinks = options.inspectLinks;
    this.tunnel = new ReverseTunnel({
      adb: this.adb,
      devicePort: DEVICE_LINK_PORT,
      hostPort: options.deviceGatewayPort ?? (() => null),
      ...(options.isHostPortLive ? { isHostPortLive: options.isHostPortLive } : {}),
      ...(options.inspectLinks ? { devices: options.inspectLinks.queues } : {}),
      onOpenFailed: (error) => {
        log.warn(`adb reverse failed, continuing without the SDK link: ${errorMessage(error)}`);
        if (!this.closed && this.linkErrors.shouldReport('reverse')) {
          this.broadcast({ type: 'error', code: 'sdk_link_unavailable', message: SDK_LINK_UNAVAILABLE });
        }
      },
    });
  }

  getDevices(): DeviceInfo[] {
    return this.devices;
  }

  getSessionState(): SessionState {
    return this.session?.state ?? IDLE_SESSION;
  }

  getSnapshot(): Snapshot {
    return this.session?.snapshot() ?? emptySnapshot();
  }

  /** The newest time of a log line the current (or last) session already dropped; null while none was. */
  getLogsDroppedThrough(): number | null {
    return this.session?.logsDroppedThrough() ?? null;
  }

  /** A hello on the session gateway: only the session's device maps its port there. */
  attachSdk(hello: SdkHello, link: SdkLink): Promise<SdkAttachResult> {
    return this.attachSdkOn(this.tunnel.serial, hello, link, true);
  }

  /**
   * An SDK said hello on a connection from `serial` (null: from no device we mapped, refused). Its PID is checked
   * on that device first, whatever package it claims; then the ready session's own app joins the session, and any
   * other app may get an inspect-only link. Every refusal is `no_session` on the wire and comes after the same
   * check, so a probe can't learn which package is being profiled; the reason is logged here. A v7 session link
   * whose hello has a nonce first gets a link key over adb, and its welcome the proof (deliverLinkKey); inspect-only
   * links never do. `viaSession`: it arrived through the session gateway.
   */
  async attachSdkOn(
    serial: string | null,
    hello: SdkHello,
    link: SdkLink,
    viaSession = false,
  ): Promise<SdkAttachResult> {
    if (serial === null || this.closed) return NO_SESSION;
    const { packageName, pid } = hello;
    let pids: number[];
    try {
      // The same check for every package (not the session's own pidof): its timing must not tell them apart.
      const output = await adbShell(this.adb, serial, `pidof ${packageName}`, {
        timeoutMs: PIDOF_TIMEOUT_MS,
      });
      pids = parsePidList(output);
    } catch (error) {
      this.refuse(serial, packageName, `its pid check failed: ${errorMessage(error)}`);
      return NO_SESSION;
    }
    if (!pids.includes(pid)) {
      this.refuse(serial, packageName, `pid ${pid} is not a process of the app`);
      return NO_SESSION;
    }
    // The session may have started or stopped while checking.
    let current = this.readySessionOf(serial, packageName);
    let proof: string | null = null;
    if (current && link.protocolVersion >= DEVICE_PROTOCOL_V7 && hello.nonce !== undefined) {
      proof = await this.proveLink(serial, { packageName, pid, nonce: hello.nonce }, link.protocolVersion);
      current = this.closed ? null : this.readySessionOf(serial, packageName);
    }
    if (current) {
      const handler = current.attachSdk(hello, link, true, proof !== null);
      return proof === null
        ? { ok: true, mode: 'session', handler }
        : { ok: true, mode: 'session', handler, proof };
    }
    const result = (await this.inspectLinks?.attach(serial, hello, link, viaSession)) ?? NO_SESSION;
    if (!result.ok) {
      const profiling =
        this.session && !this.session.isStopped ? `profiling ${this.session.packageName}` : null;
      this.refuse(serial, packageName, profiling ?? 'no session');
    }
    return result;
  }

  /**
   * What the running session knows of `serial` for an Inspector snapshot: its app, its live SDK link (null while
   * none is) and the top screen. Null when no session runs on that device.
   */
  inspectorSource(serial: string): InspectorSessionSource | null {
    const session = this.session;
    if (!session || session.isStopped || session.serial !== serial) return null;
    return { packageName: session.packageName, link: session.sdkLink, screen: session.topScreen() };
  }

  /** Change the SDK options of the running session (announced with a `session` broadcast). false: no session. */
  setSdkOptions(changes: Partial<SdkOptions>): boolean {
    const session = this.session;
    if (!session || session.isStopped) return false;
    session.setSdkOptions(changes);
    return true;
  }

  /** Headers and bodies of one HTTP exchange of the current (or last) session; null when it is not kept. */
  getHttpExchange(id: number): HttpExchangeDetail | null {
    return this.session?.httpExchange(id) ?? null;
  }

  /** Crashes of the current (or last) session, oldest first. */
  getCrashes(): AppCrash[] {
    return this.session?.crashes() ?? [];
  }

  /** HTTP exchanges kept by the current (or last) session. */
  getHttpExchangeCount(): number {
    return this.session?.httpExchangeCount ?? 0;
  }

  /** Whether the current (or last) session's SDK was linked at some point, even if it dropped since. */
  getSdkEverLinked(): boolean {
    return this.session?.sdkEverLinked ?? false;
  }

  /** HTTP exchanges the current (or last) session has seen in all, not only those still kept. */
  getHttpExchangesSeen(): number {
    return this.session?.httpExchangesSeen ?? 0;
  }

  /** The session's mock rules; none without a session (they end with it). */
  getNetworkMocks(): NetworkMocksState {
    return this.session?.networkMocks ?? EMPTY_MOCKS;
  }

  /**
   * Create or replace a mock rule of the running session (announced with a `networkMocks` broadcast). Throws a
   * PublicError without a session, or for a rule MockRules refuses.
   */
  setNetworkMock(input: unknown, origin: MockOrigin): NetworkMockRule {
    const session = this.session;
    if (!session || session.isStopped) throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
    return session.setNetworkMock(input, origin);
  }

  /** Remove one rule (`id`) or all; a no-op without a session. false: there was nothing to remove. */
  clearNetworkMocks(id?: string): boolean {
    const session = this.session;
    if (!session || session.isStopped) return false;
    return session.clearNetworkMocks(id);
  }

  /**
   * Mark `label` now in the running session (RunMarkers.mark), after any start or stop requested before it: a mark
   * sent right after start_session lands on the new session. Rejects with a PublicError without one.
   */
  mark(label: string): Promise<{ marker: RunMarker; replacedTs: number | null }> {
    return this.enqueue(async () => {
      const session = this.session;
      if (!session || session.isStopped) throw new PublicError(NO_SESSION_MARKERS_MESSAGE);
      return session.mark(label);
    });
  }

  /** Markers of the current (or last) session, oldest first. */
  getMarkers(): RunMarker[] {
    return this.session?.runMarkers() ?? [];
  }

  /** Poll `adb devices -l` every devicePollMs until close(). */
  startDevicePolling(): void {
    const poll = async (): Promise<void> => {
      await this.refreshDevices();
      if (this.closed) return;
      this.pollTimer = setTimeout(() => void poll(), this.devicePollMs);
    };
    void poll();
  }

  /**
   * Re-read the device list (concurrent callers share one `adb devices` call). Broadcasts only
   * when the list changed; on failure the previous list is kept and returned.
   */
  refreshDevices(): Promise<DeviceInfo[]> {
    this.refreshInFlight ??= this.listDevices().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** Apps on a connected device; concurrent requests for the same serial share one listing. */
  listApps(serial: string): Promise<AppInfo[]> {
    if (!isValidSerial(serial)) return Promise.reject(new PublicError('invalid adb serial'));
    let pending = this.appsInFlight.get(serial);
    if (!pending) {
      pending = this.loadApps(serial).finally(() => this.appsInFlight.delete(serial));
      this.appsInFlight.set(serial, pending);
    }
    return pending;
  }

  startSession(serial: string, packageName: string): Promise<SessionState> {
    return this.enqueue(async () => {
      if (!isValidSerial(serial)) throw new PublicError('invalid adb serial');
      if (!isValidPackageName(packageName)) throw new PublicError('invalid package name');
      await this.requireReadyDevice(serial);
      if (this.closed) throw new PublicError('server is shutting down');

      void this.endSession('idle');
      this.deviceGoneListings = 0;
      const session = new ProfilingSession({
        adb: this.adb,
        serial,
        packageName,
        emit: (message) => {
          if (this.session === session) this.broadcast(message);
        },
        now: this.now,
        bufferWindowMs: this.bufferWindowMs,
        intervals: this.sessionIntervals,
        // Only once the clock offset is known: SDK data before that would be misplaced in time.
        onReady: () => {
          if (this.session === session) this.openTunnel(serial, packageName);
        },
      });
      this.session = session;
      this.broadcast({ type: 'session', session: session.state });
      this.broadcast({ type: 'snapshot', snapshot: emptySnapshot() });
      this.broadcast({ type: 'networkMocks', mocks: session.networkMocks });
      log.info(`Profiling ${packageName} on ${serial}`);
      // Not awaited: the first device round-trips must not hold up a following stop/start request.
      session.start().catch((error: unknown) => log.error('session start failed:', errorMessage(error)));
      return session.state;
    });
  }

  stopSession(): Promise<SessionState> {
    return this.enqueue(async () => {
      this.endSession('idle');
      return this.getSessionState();
    });
  }

  /** Stop the session if it profiles `serial` (its emulator is about to shut down). */
  stopSessionOn(serial: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.session && !this.session.isStopped && this.session.serial === serial)
        await this.endSession('idle');
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.operations.catch(() => undefined);
    await this.endSession('idle');
  }

  /**
   * Stop the session (if any) and release its `adb reverse` mapping: removed, or, while an Inspector still wants
   * the device, taken over by its inspect-only link.
   */
  private endSession(status: 'idle' | 'error', error?: string): Promise<void> {
    const session = this.session;
    session?.stop(status, error);
    if (session && !this.closed && this.inspectLinks?.sessionEnded(session.serial))
      return this.tunnel.release();
    return this.tunnel.close();
  }

  private readySessionOf(serial: string, packageName: string): ProfilingSession | null {
    const session = this.session;
    return session?.isReady && session.serial === serial && session.packageName === packageName
      ? session
      : null;
  }

  /**
   * Hand the app a fresh link key over adb and sign the hello's nonce with it (deliverLinkKey); null when it could
   * not be delivered: the link is welcomed without a proof and its SDK keeps network capture and mocks off.
   */
  private async proveLink(
    serial: string,
    hello: { packageName: string; pid: number; nonce: string },
    protocolVersion: number,
  ): Promise<string | null> {
    const result = await deliverLinkKey(this.adb, serial, hello, protocolVersion);
    if (result.ok) return result.proof;
    if (this.linkErrors.shouldReport(`link-key ${serial}`)) {
      log.warn(
        `No link key for ${hello.packageName} on ${serial} (${result.error}): HTTP capture and mocks stay off`,
      );
    }
    return null;
  }

  private refuse(serial: string, packageName: string, reason: string): void {
    if (this.refusals.shouldReport(`${serial} ${packageName}`)) {
      log.info(`Refused an SDK link from ${packageName} on ${serial}: ${reason}`);
    }
  }

  /** (Re-)map `adb reverse` for the session device; reported once if the SDK gateway isn't listening. */
  private openTunnel(serial: string, packageName: string): void {
    if (!this.gatewayPort) return;
    if (this.gatewayPort() === null) {
      if (this.gatewayDownReported || this.closed) return;
      this.gatewayDownReported = true;
      log.warn('No adb reverse for the session: the SDK gateway is not listening');
      this.broadcast({ type: 'error', code: 'sdk_link_unavailable', message: SDK_GATEWAY_DOWN });
      return;
    }
    this.lastTunnelAt = this.now();
    void this.tunnel.open(serial);
    this.inspectLinks?.sessionMapped(serial, packageName);
  }

  private async listDevices(): Promise<DeviceInfo[]> {
    let devices: DeviceInfo[];
    try {
      devices = parseDevices(await this.adb.exec(['devices', '-l'], { timeoutMs: DEVICES_TIMEOUT_MS }));
    } catch (error) {
      this.onListingFailed(error);
      return this.devices;
    }
    this.lastListingOk = true;
    const recovered = this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.adbErrorReported = false;
    if (this.closed) return devices;
    if (!this.staleChecked && this.gatewayPort) {
      // First listing of this run: mappings of the device port on connected devices are leftovers.
      this.staleChecked = true;
      // (A mapping an inspect-only link makes meanwhile points at a live listener: the sweep leaves it alone.)
      const ready = devices.filter((device) => device.state === 'device').map((device) => device.serial);
      void this.tunnel.clearStale(ready);
    }

    const key = JSON.stringify(devices);
    if (key !== this.devicesKey) {
      this.devicesKey = key;
      this.devices = devices;
      this.broadcast({ type: 'devices', devices });
    }
    this.inspectLinks?.onDevices(devices, recovered);
    this.checkSessionDevice(recovered);
    return this.devices;
  }

  /** A failed listing says nothing about the device: keep the last list, don't touch the session. */
  private onListingFailed(error: unknown): void {
    this.lastListingOk = false;
    this.consecutiveFailures += 1;
    if (!this.adbErrorReported) {
      this.adbErrorReported = true;
      log.warn(`\`${this.adb.path} devices -l\` failed: ${errorMessage(error)}`);
      if (!this.closed)
        this.broadcast({ type: 'error', code: 'adb_unavailable', message: ADB_UNAVAILABLE_MESSAGE });
    }
    const session = this.session;
    if (this.consecutiveFailures >= MAX_DEVICE_LIST_FAILURES && session && !session.isStopped) {
      log.warn(`Stopping session: adb failed ${this.consecutiveFailures} times in a row`);
      void this.endSession('error', SESSION_ADB_UNAVAILABLE);
    }
  }

  private async requireReadyDevice(serial: string): Promise<void> {
    const devices = await this.refreshDevices();
    if (!this.lastListingOk) throw new PublicError(ADB_UNAVAILABLE_MESSAGE);
    const device = devices.find((candidate) => candidate.serial === serial);
    if (!device) throw new PublicError(`Device ${serial} is not connected`);
    if (device.state !== 'device') throw new PublicError(`Device ${serial} is ${device.state}`);
  }

  private async loadApps(serial: string): Promise<AppInfo[]> {
    await this.requireReadyDevice(serial);
    const options = { timeoutMs: APPS_TIMEOUT_MS };
    const [all, thirdParty, ps] = await Promise.all([
      adbShell(this.adb, serial, 'pm list packages', options),
      adbShell(this.adb, serial, 'pm list packages -3', options),
      adbShell(this.adb, serial, 'ps -A -o PID,NAME', options),
    ]);
    return buildAppList(parsePackageList(all), parsePackageList(thirdParty), parsePs(ps));
  }

  /** `listingRecovered`: adb listings failed before this one. */
  private checkSessionDevice(listingRecovered: boolean): void {
    const session = this.session;
    if (!session || session.isStopped) return;
    const device = this.devices.find((candidate) => candidate.serial === session.serial);
    if (device?.state === 'device') {
      // After a USB flicker or an adb server restart the mapping is gone; and while no SDK is connected,
      // re-apply it now and then in case it was lost unnoticed.
      const flickered = this.deviceGoneListings > 0;
      this.deviceGoneListings = 0;
      const remapDue = !session.state.sdk?.connected && this.now() - this.lastTunnelAt >= REMAP_INTERVAL_MS;
      if (session.isReady && (flickered || listingRecovered || remapDue)) {
        this.openTunnel(session.serial, session.packageName);
      }
      return;
    }
    this.deviceGoneListings += 1;
    if (this.deviceGoneListings < DEVICE_GONE_LISTINGS) return;
    const message = device
      ? `Device ${session.serial} is ${device.state}`
      : `Device ${session.serial} disconnected`;
    log.warn(message);
    void this.endSession('error', message);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => undefined);
    return result;
  }
}

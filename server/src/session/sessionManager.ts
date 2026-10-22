import { DEVICE_LINK_PORT, isValidPackageName, isValidSerial } from '@lionscope/protocol';
import type {
  AppInfo,
  DeviceInfo,
  SdkOptions,
  ServerMessage,
  SessionState,
  Snapshot,
} from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { BUFFER_WINDOW_MS } from '../config.ts';
import { ReverseTunnel } from '../device/reverseTunnel.ts';
import type { SdkAttachResult, SdkHello, SdkLink, SdkLinkTarget } from '../device/sdkLink.ts';
import { ErrorThrottle, PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { parseDevices } from '../parsers/devices.ts';
import { buildAppList, parsePackageList } from '../parsers/packages.ts';
import { parsePs } from '../parsers/ps.ts';
import { emptySnapshot } from '../store/sessionStore.ts';
import { ProfilingSession } from './profilingSession.ts';
import type { CollectorIntervals } from './profilingSession.ts';

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
}

/** Owns the device list, at most one profiling session, and that session's SDK link. */
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
    this.tunnel = new ReverseTunnel({
      adb: this.adb,
      devicePort: DEVICE_LINK_PORT,
      hostPort: options.deviceGatewayPort ?? (() => null),
      ...(options.isHostPortLive ? { isHostPortLive: options.isHostPortLive } : {}),
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

  /**
   * An SDK said hello: only the active, ready session's own app gets a link. Every refusal is `no_session`
   * on the wire, so a probe can't learn which package is being profiled; the reason is logged here.
   */
  attachSdk(hello: SdkHello, link: SdkLink): SdkAttachResult {
    const session = this.session;
    if (!session?.isReady) return { ok: false, reason: 'no_session' };
    if (hello.packageName !== session.packageName) {
      if (this.refusals.shouldReport(hello.packageName)) {
        log.info(`Refused an SDK link from ${hello.packageName}: profiling ${session.packageName}`);
      }
      return { ok: false, reason: 'no_session' };
    }
    return { ok: true, handler: session.attachSdk(hello, link) };
  }

  /** Change the SDK options of the running session (announced with a `session` broadcast). false: no session. */
  setSdkOptions(changes: Partial<SdkOptions>): boolean {
    const session = this.session;
    if (!session || session.isStopped) return false;
    session.setSdkOptions(changes);
    return true;
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
          if (this.session === session) this.openTunnel(serial);
        },
      });
      this.session = session;
      this.broadcast({ type: 'session', session: session.state });
      this.broadcast({ type: 'snapshot', snapshot: emptySnapshot() });
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

  /** Stop the session (if any) and release its `adb reverse` mapping. */
  private endSession(status: 'idle' | 'error', error?: string): Promise<void> {
    this.session?.stop(status, error);
    return this.tunnel.close();
  }

  /** (Re-)map `adb reverse` for the session device; reported once if the SDK gateway isn't listening. */
  private openTunnel(serial: string): void {
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
      const ready = devices.filter((device) => device.state === 'device').map((device) => device.serial);
      void this.tunnel.clearStale(ready);
    }

    const key = JSON.stringify(devices);
    if (key !== this.devicesKey) {
      this.devicesKey = key;
      this.devices = devices;
      this.broadcast({ type: 'devices', devices });
    }
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
      if (session.isReady && (flickered || listingRecovered || remapDue)) this.openTunnel(session.serial);
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

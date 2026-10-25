import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { MIN_MOCK_LOCATION_API } from '@lionscope/protocol';
import type { DeviceInfo, DeviceLocation, ServerMessage } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import type { EmulatorClient, GpsPoint } from '../emulator/emulatorClient.ts';
import { isEmulatorSerial } from '../emulator/screenGateway.ts';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import {
  installProviders,
  MockLocationRefused,
  probeDevice,
  pushLocation,
  removeProviders,
} from './mockProviders.ts';
import type { AppOpMode, LocationMarker, MockProvider } from './mockProviders.ts';

/** Mock locations are re-sent this often, like a GPS fix (apps that ask for a fresh one get it). */
export const MOCK_REFRESH_MS = 1000;
const EMU_TIMEOUT_MS = 5000;
const PS_TIMEOUT_MS = 2000;
/** On close, restoring the devices' real locations gets this long before the server stops anyway. */
export const CLOSE_RESTORE_MS = 4000;
export const LOCATION_OFF_WARNING =
  'Location is off on the device: turn it on in Settings so apps receive this location.';

export interface LocationServiceOptions {
  adb: Adb;
  /** A gRPC client for a running emulator (closed after use); null when it has no endpoint (`adb emu` is used). */
  emulatorClient: (serial: string) => EmulatorClient | null;
  broadcast: (message: ServerMessage) => void;
  now?: () => number;
  refreshMs?: number;
  /** This server's pid, written into the device marker. */
  pid?: number;
  /** Whether a host process lives: a marker of a live Lionscope is not ours to clean up. */
  isProcessAlive?: (pid: number) => boolean;
  /** This machine, in the device marker (MARKER_HOST_PATTERN); defaults to a hash of the host name. */
  host?: string;
}

interface EmulatorState {
  kind: 'emulator';
  location: DeviceLocation;
  /** The fix before the first setLocation, restored by clearLocation (null: unknown, e.g. no gRPC). */
  original: GpsPoint | null;
}

interface MockState {
  kind: 'mock';
  location: DeviceLocation;
  providers: MockProvider[];
  /** The shell's app op mode before, restored by clearLocation. */
  appOp: AppOpMode;
  timer: ReturnType<typeof setInterval>;
  pushing: boolean;
  failing: boolean;
}

type DeviceState = EmulatorState | MockState;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * A live process that looks like a Lionscope server (its command line names lionscope or the server's main.ts), so a
 * pid reused by another program after a reboot does not hold a phone's marker forever. Without `ps` (Windows) any
 * live process counts.
 */
export function isLionscopeProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  if (process.platform === 'win32') return true;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    });
    return /lionscope|src\/main\.ts/i.test(command);
  } catch {
    // ps exits non-zero when the process is gone.
    return false;
  }
}

/** Short and shell-safe: 12 hex characters of the host name's SHA-256. */
export function hostId(name: string = hostname()): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12);
}

/** An emulator reports 0, 0 for a fix it doesn't have (proto3 defaults): not a point to go back to. */
function knownFix(point: GpsPoint | null): GpsPoint | null {
  return point && (point.latitude !== 0 || point.longitude !== 0) ? point : null;
}

async function withDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The locations Lionscope puts on devices (dashboard and agents): an emulator's GPS fix, or a physical device's
 * test providers. One operation per device at a time; every change is broadcast as `locations`.
 */
export class LocationService {
  private readonly adb: Adb;
  private readonly options: LocationServiceOptions;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly host: string;
  private readonly states = new Map<string, DeviceState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Physical devices seen in the `device` state (each is checked for a leftover once when it appears). */
  private ready = new Set<string>();
  private closed = false;

  constructor(options: LocationServiceOptions) {
    this.options = options;
    this.adb = options.adb;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isProcessAlive ?? isLionscopeProcess;
    this.host = options.host ?? hostId();
  }

  getLocations(): DeviceLocation[] {
    return [...this.states.values()].map((state) => state.location);
  }

  getLocation(serial: string): DeviceLocation | null {
    return this.states.get(serial)?.location ?? null;
  }

  /** The emulator's current GPS fix (also one Lionscope did not set); null for other devices or without gRPC. */
  async readEmulatorGps(serial: string): Promise<GpsPoint | null> {
    if (!isEmulatorSerial(serial)) return null;
    const client = this.options.emulatorClient(serial);
    if (!client) return null;
    try {
      return await client.getGps();
    } finally {
      client.close();
    }
  }

  setLocation(serial: string, point: GpsPoint): Promise<DeviceLocation> {
    return this.queue(serial, async () => {
      const location = isEmulatorSerial(serial)
        ? await this.setOnEmulator(serial, point)
        : await this.setOnDevice(serial, point);
      this.publish();
      return location;
    });
  }

  /**
   * False when Lionscope had not set a location there. A physical device without a location here is still restored
   * when it carries a Lionscope marker (a set that failed halfway, another server's or a dead one's): Reset always
   * gives a phone its real location back. On failure the location stays, so Reset can be tried again.
   */
  clearLocation(serial: string): Promise<boolean> {
    return this.queue(serial, async () => {
      try {
        const state = this.states.get(serial);
        if (!state) return isEmulatorSerial(serial) ? false : await this.removeMarked(serial);
        if (state.kind === 'mock') {
          clearInterval(state.timer);
          try {
            await removeProviders(this.adb, serial, state.appOp);
          } catch (error) {
            state.timer = this.startRefresh(serial, state);
            throw error;
          }
        } else if (state.original) {
          await this.moveEmulator(serial, state.original);
        }
        this.states.delete(serial);
        return true;
      } finally {
        // Also when nothing changed: a dashboard waiting for an answer gets one.
        this.publish();
      }
    });
  }

  /**
   * The adb device list changed: a device that went away loses its location here (a physical one gets its real
   * location back when it returns); one that appears is checked for a location a dead Lionscope left on it.
   */
  setDevices(devices: readonly DeviceInfo[]): void {
    const ready = new Set(
      devices
        .filter((device) => device.state === 'device' && !isEmulatorSerial(device.serial))
        .map((device) => device.serial),
    );
    const present = new Set(devices.filter((d) => d.state === 'device').map((device) => device.serial));
    let changed = false;
    for (const [serial, state] of this.states) {
      if (present.has(serial)) continue;
      if (state.kind === 'mock') clearInterval(state.timer);
      this.states.delete(serial);
      changed = true;
    }
    if (changed) this.publish();
    for (const serial of ready) {
      if (!this.ready.has(serial))
        void this.queue(serial, () => this.cleanLeftover(serial)).catch(() => undefined);
    }
    this.ready = ready;
  }

  /** Give every physical device its real location back (emulators keep their fix, as in Android Studio). */
  async close(): Promise<void> {
    this.closed = true;
    const deadline = performance.now() + CLOSE_RESTORE_MS;
    // A set in flight stores its state when it lands: wait for it, so it is restored below.
    await withDeadline(Promise.all(this.chains.values()), deadline);
    const restores = [...this.states].map(([serial, state]) => {
      if (state.kind !== 'mock') return Promise.resolve();
      clearInterval(state.timer);
      return removeProviders(this.adb, serial, state.appOp).catch((error: unknown) =>
        log.warn(`Restoring the location of ${serial} failed: ${errorMessage(error)}`),
      );
    });
    this.states.clear();
    await withDeadline(Promise.all(restores), deadline);
  }

  private queue<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new PublicError('server is shutting down'));
    const previous = this.chains.get(serial) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => undefined);
    this.chains.set(serial, tail);
    void tail.then(() => {
      if (this.chains.get(serial) === tail) this.chains.delete(serial);
    });
    return result;
  }

  private publish(): void {
    this.options.broadcast({ type: 'locations', locations: this.getLocations() });
  }

  private async setOnEmulator(serial: string, point: GpsPoint): Promise<DeviceLocation> {
    const previous = this.states.get(serial);
    const original =
      previous?.kind === 'emulator'
        ? previous.original
        : await this.readEmulatorGps(serial).then(knownFix, () => null);
    await this.moveEmulator(serial, point);
    const location: DeviceLocation = {
      serial,
      ...point,
      method: 'emulator',
      since: this.now(),
      warning: await this.locationWarning(serial),
    };
    this.states.set(serial, { kind: 'emulator', location, original });
    return location;
  }

  /** Over gRPC when the emulator has an endpoint, else its console through `adb emu` (longitude first). */
  private async moveEmulator(serial: string, point: GpsPoint): Promise<void> {
    const client = this.options.emulatorClient(serial);
    if (client) {
      try {
        await client.setGps(point);
      } finally {
        client.close();
      }
      return;
    }
    await this.adb.exec(
      ['-s', serial, 'emu', 'geo', 'fix', point.longitude.toFixed(7), point.latitude.toFixed(7)],
      { timeoutMs: EMU_TIMEOUT_MS },
    );
  }

  private async locationWarning(serial: string): Promise<string | null> {
    try {
      const { locationEnabled } = await probeDevice(this.adb, serial);
      return locationEnabled === false ? LOCATION_OFF_WARNING : null;
    } catch {
      return null;
    }
  }

  private async setOnDevice(serial: string, point: GpsPoint): Promise<DeviceLocation> {
    const previous = this.states.get(serial);
    if (previous?.kind === 'mock') {
      await pushLocation(this.adb, serial, previous.providers, point.latitude, point.longitude);
      previous.location = { ...previous.location, ...point, since: this.now() };
      return previous.location;
    }
    const probe = await probeDevice(this.adb, serial);
    if (probe.sdk !== null && probe.sdk < MIN_MOCK_LOCATION_API) {
      throw new PublicError(
        `Changing the location of a physical device needs Android 12 or newer (this one has API ${probe.sdk})`,
      );
    }
    const marker = this.markerFor(serial, probe.marker, probe.appOp);
    let providers: MockProvider[];
    try {
      providers = await installProviders(this.adb, serial, marker);
      await pushLocation(this.adb, serial, providers, point.latitude, point.longitude);
      // close() gave up waiting for this set: it could not see these providers.
      if (this.closed) throw new PublicError('server is shutting down');
    } catch (error) {
      if (error instanceof MockLocationRefused) {
        throw new PublicError(`The device refused mock locations: ${error.message}`);
      }
      // Halfway (a timeout can leave the device still adding them): never leave providers without a location.
      await removeProviders(this.adb, serial, marker.mode).catch((undo: unknown) =>
        log.warn(`Undoing the mock location of ${serial} failed: ${errorMessage(undo)}`),
      );
      throw error;
    }
    const location: DeviceLocation = {
      serial,
      ...point,
      method: 'mock_provider',
      since: this.now(),
      warning: probe.locationEnabled === false ? LOCATION_OFF_WARNING : null,
    };
    const state: MockState = {
      kind: 'mock',
      location,
      providers,
      appOp: marker.mode,
      pushing: false,
      failing: false,
      timer: undefined as unknown as MockState['timer'],
    };
    state.timer = this.startRefresh(serial, state);
    this.states.set(serial, state);
    return location;
  }

  private startRefresh(serial: string, state: MockState): ReturnType<typeof setInterval> {
    const timer = setInterval(() => this.refresh(serial, state), this.options.refreshMs ?? MOCK_REFRESH_MS);
    timer.unref();
    return timer;
  }

  /** Another Lionscope server on this host that still runs (a marker from another host has no owner here). */
  private isLiveOwner(marker: LocationMarker): boolean {
    return marker.host === this.host && marker.pid !== this.pid && this.isAlive(marker.pid);
  }

  /** Remove a Lionscope marker's providers, whoever set them. */
  private async removeMarked(serial: string): Promise<boolean> {
    const { marker } = await probeDevice(this.adb, serial);
    if (!marker) return false;
    await removeProviders(this.adb, serial, marker.mode);
    log.info(`Gave ${serial} its real location back`);
    return true;
  }

  /** The marker to write: a live Lionscope's is refused, a dead one's (or our own lost one) keeps its app op mode. */
  private markerFor(serial: string, found: LocationMarker | null, appOp: AppOpMode): LocationMarker {
    if (!found) return { pid: this.pid, host: this.host, mode: appOp };
    if (this.isLiveOwner(found)) {
      throw new PublicError(
        `Another Lionscope server (pid ${found.pid}) is changing the location of ${serial}: Reset it there or here first`,
      );
    }
    return { pid: this.pid, host: this.host, mode: found.mode };
  }

  /** Through the device's queue, so a refresh never lands after a newer point or a Reset. */
  private refresh(serial: string, state: MockState): void {
    if (state.pushing || this.closed) return;
    state.pushing = true;
    void this.queue(serial, () => this.push(serial, state)).catch(() => {
      state.pushing = false;
    });
  }

  private async push(serial: string, state: MockState): Promise<void> {
    if (this.states.get(serial) !== state) {
      state.pushing = false;
      return;
    }
    const { latitude, longitude } = state.location;
    try {
      await pushLocation(this.adb, serial, state.providers, latitude, longitude);
      state.failing = false;
    } catch (error) {
      // Once per failure streak (a device that went away is dropped by setDevices).
      if (!state.failing)
        log.warn(`Refreshing the mock location of ${serial} failed: ${errorMessage(error)}`);
      state.failing = true;
    } finally {
      state.pushing = false;
    }
  }

  /** A marker without a live owner is a location a Lionscope left behind (it was killed, or the device went away). */
  private async cleanLeftover(serial: string): Promise<void> {
    if (this.states.has(serial)) return;
    try {
      const { marker } = await probeDevice(this.adb, serial);
      if (!marker || this.isLiveOwner(marker)) return;
      await removeProviders(this.adb, serial, marker.mode);
      log.info(`Gave ${serial} its real location back (a mock location was left on it)`);
    } catch (error) {
      log.warn(`Checking ${serial} for a leftover mock location failed: ${errorMessage(error)}`);
    }
  }
}

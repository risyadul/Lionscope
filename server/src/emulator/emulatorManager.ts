import { isValidAvdName } from '@lionscope/protocol';
import type { BootMode, DeviceInfo, EmulatorInfo, ScreenErrorCode, ServerMessage } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { AvdNameLookup } from './avdNameLookup.ts';
import { AvdCatalog, bootArguments, pickConsolePort, pickGrpcPort } from './avds.ts';
import { readRunningEmulators } from './discovery.ts';
import type { GrpcEndpoint } from './discovery.ts';
import type { EmulatorHost } from './emulatorHost.ts';
import { InstanceProbe } from './instanceProbe.ts';
import { forceEmulator, SHUTDOWN_GRACE_MS, stopEmulator, withTimeout } from './managedShutdown.ts';
import type { ManagedEmulator, ShutdownTools } from './managedShutdown.ts';
import type { RunningEmulator } from './instanceProbe.ts';

/** Discovery is re-read this often while an emulator boots or shuts down. */
export const EMULATOR_POLL_MS = 1000;
export const NO_EMULATOR_MESSAGE =
  'Android Emulator not found. Install it with the SDK Manager, or set ANDROID_HOME to the SDK.';
/** On close, in-flight boots and shutdowns get this long before the managed emulators are stopped anyway. */
export const CLOSE_OPERATIONS_WAIT_MS = 1000;
const EMULATOR_SERIAL = /^emulator-\d{1,5}$/;
/** Boots and shutdowns waiting or running at once; more are refused as busy. */
export const MAX_QUEUED_OPERATIONS = 4;

export type MirrorTarget =
  { ok: true; endpoint: GrpcEndpoint } | { ok: false; code: ScreenErrorCode; message: string };

export interface EmulatorManagerOptions {
  adb: Adb;
  host: EmulatorHost;
  broadcast: (message: ServerMessage) => void;
  pollMs?: number;
  /** How long an AVD listing is reused (AVD_LIST_TTL_MS). */
  avdListTtlMs?: number;
  platform?: NodeJS.Platform;
  shutdownGraceMs?: number;
  now?: () => number;
}

/** Boots AVDs headless, tracks every AVD's state, and shuts down (only) the emulators it booted. */
export class EmulatorManager {
  private readonly adb: Adb;
  private readonly host: EmulatorHost;
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly pollMs: number;
  private readonly shutdownGraceMs: number;
  private readonly matchPid: boolean;
  private readonly catalog: AvdCatalog;
  /** AVDs with a boot or shutdown queued or running, and how many operations there are. */
  private readonly pendingAvds = new Set<string>();
  private queuedOperations = 0;
  private running: RunningEmulator[] = [];
  private devices: DeviceInfo[] = [];
  private readonly managed = new Map<string, ManagedEmulator>();
  private readonly probe: InstanceProbe;
  private readonly shutdownTools: ShutdownTools;
  private readonly avdNames: AvdNameLookup;
  private readonly listeners = new Set<() => void>();
  private emulators: EmulatorInfo[] = [];
  private emulatorsKey = '[]';
  private pollInFlight: Promise<void> | null = null;
  private pollAgain = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(options: EmulatorManagerOptions) {
    this.adb = options.adb;
    this.host = options.host;
    this.broadcast = options.broadcast;
    this.pollMs = options.pollMs ?? EMULATOR_POLL_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.matchPid = (options.platform ?? process.platform) !== 'win32';
    this.catalog = new AvdCatalog(options.host, options.avdListTtlMs);
    this.probe = new InstanceProbe(options.adb, options.host.createClient, options.now);
    this.avdNames = new AvdNameLookup(options.adb, options.now);
    this.shutdownTools = { adb: options.adb, createClient: options.host.createClient };
  }

  getEmulators(): EmulatorInfo[] {
    return this.emulators;
  }

  /** Called after every state change (screen sockets end when their emulator goes away). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-list the AVDs and re-read the running emulators. */
  async refresh(): Promise<EmulatorInfo[]> {
    await this.catalog.refresh();
    await this.poll();
    return this.emulators;
  }

  /** The adb device list changed (an emulator appeared or went away). */
  setDevices(devices: DeviceInfo[]): void {
    this.devices = devices;
    void this.poll();
  }

  /** Whether `serial` can be mirrored, and its gRPC endpoint. */
  mirrorTarget(serial: string): MirrorTarget {
    const emulator = this.running.find((candidate) => candidate.serial === serial);
    const current = emulator && this.instanceOf(emulator.avdName) === emulator;
    if (!emulator || !current || this.infoOf(emulator.avdName)?.state !== 'running') {
      return { ok: false, code: 'not_emulator', message: `${serial} is not a running emulator` };
    }
    if (!emulator.grpc || !this.host.createClient) {
      return { ok: false, code: 'unavailable', message: `${serial} has no usable gRPC endpoint to mirror` };
    }
    return { ok: true, endpoint: emulator.grpc };
  }

  boot(avdName: string, mode: BootMode): Promise<void> {
    return this.enqueue(avdName, async () => {
      if (!this.host.emulatorPath) throw new PublicError(NO_EMULATOR_MESSAGE);
      if (!isValidAvdName(avdName)) throw new PublicError('invalid AVD name');
      await this.catalog.refresh();
      if (!this.catalog.list.some((avd) => avd.name === avdName))
        throw new PublicError(`No AVD named ${avdName}`);
      await this.poll();
      const state = this.infoOf(avdName)?.state ?? 'off';
      if (state !== 'off') throw new PublicError(`${avdName} is already ${state.replace('_', ' ')}`);
      if (this.closed) throw new PublicError('server is shutting down');
      const isFree = (candidate: number) => this.host.isPortFree(candidate);
      const port = await pickConsolePort(this.usedConsolePorts(), isFree);
      if (port === null) throw new PublicError('No free emulator console port (5554-5682)');
      const usedGrpc = new Set([
        ...this.running.flatMap((emulator) => (emulator.grpc ? [emulator.grpc.port] : [])),
        ...[...this.managed.values()].map((managed) => managed.grpcPort),
      ]);
      const grpc = await pickGrpcPort(port, usedGrpc, isFree);
      if (grpc === null) throw new PublicError('No free port for the emulator gRPC endpoint (8554-8999)');

      const child = this.host.spawnEmulator(bootArguments(avdName, mode, { console: port, grpc }), avdName);
      const entry: ManagedEmulator = {
        process: child,
        serial: `emulator-${port}`,
        grpcPort: grpc,
        exited: false,
        shuttingDown: false,
        escalation: null,
      };
      this.managed.set(avdName, entry);
      child.on('error', (error) => {
        // Also emitted when a signal cannot be delivered: only a process that never got a pid failed to start.
        if (child.pid !== undefined) {
          log.warn(`The emulator process for ${avdName}: ${errorMessage(error)}`);
          return;
        }
        log.warn(`Cannot start the emulator for ${avdName}: ${errorMessage(error)}`);
        this.onProcessExit(avdName, entry, null);
      });
      child.on('exit', (code) => this.onProcessExit(avdName, entry, code));
      log.info(`Booting ${avdName} as ${entry.serial} (${mode} boot, headless, host GPU)`);
      await this.poll();
    });
  }

  shutdown(avdName: string): Promise<void> {
    return this.enqueue(avdName, async () => {
      const entry = this.managed.get(avdName);
      if (!entry) {
        const serial = this.instanceOf(avdName)?.serial;
        const how = serial ? `run adb -s ${serial} emu kill, or close it` : 'close it';
        throw new PublicError(
          `${avdName} was not started by Lionscope: ${how} where it was started (e.g. Android Studio)`,
        );
      }
      // Asked again while it is shutting down: force it now.
      if (entry.shuttingDown) return this.force(avdName, entry);
      entry.shuttingDown = true;
      this.publish();
      await this.stop(avdName, entry);
      entry.escalation = setTimeout(() => void this.force(avdName, entry), this.shutdownGraceMs);
      entry.escalation.unref();
      await this.poll();
    });
  }

  /** Shut down every emulator this server booted; the others are left alone. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    // A hung boot or shutdown must not use up the server's exit deadline (main.ts).
    await withTimeout(this.operations, CLOSE_OPERATIONS_WAIT_MS).catch(() => undefined);
    for (const entry of this.managed.values()) if (entry.escalation) clearTimeout(entry.escalation);
    await Promise.all(
      [...this.managed].map(([avdName, entry]) => {
        // A launcher that exited may have left the emulator itself running.
        if (entry.shuttingDown || (entry.exited && !this.isRunning(avdName))) return Promise.resolve();
        entry.shuttingDown = true;
        return this.stop(avdName, entry);
      }),
    );
    this.probe.close();
  }

  private stop(avdName: string, entry: ManagedEmulator): Promise<void> {
    return stopEmulator(this.shutdownTools, avdName, entry, this.instanceOf(avdName));
  }

  private async force(avdName: string, entry: ManagedEmulator): Promise<void> {
    if (await forceEmulator(this.shutdownTools, avdName, entry, this.instanceOf(avdName))) await this.poll();
  }

  /**
   * The launcher exited: the entry goes once the AVD no longer runs (readState). A failure (not shut down by
   * us, exit code other than 0) is reported.
   */
  private onProcessExit(avdName: string, entry: ManagedEmulator, code: number | null): void {
    if (entry.exited) return;
    entry.exited = true;
    void this.poll().then(() => {
      // Our own instance (by serial and pid), not just any emulator of that AVD.
      const stillRunning = this.running.some((emulator) => this.isOurs(entry, emulator));
      if (entry.shuttingDown || this.closed || stillRunning) return;
      if (code === 0) {
        log.info(`The emulator for ${avdName} exited`);
        return;
      }
      const detail = code === null ? '' : ` (exit code ${code})`;
      log.warn(`The emulator for ${avdName} exited${detail}`);
      this.broadcast({
        type: 'error',
        code: 'emulator_exited',
        message: `${avdName} exited${detail}. The server log names the emulator's log file.`,
      });
    });
  }

  private isRunning(avdName: string): boolean {
    return this.instanceOf(avdName) !== undefined;
  }

  /** The running instance of an AVD; for one this server booted, only its own (see ManagedEmulator). */
  private instanceOf(avdName: string): RunningEmulator | undefined {
    const entry = this.managed.get(avdName);
    return this.running.find(
      (emulator) => emulator.avdName === avdName && (!entry || this.isOurs(entry, emulator)),
    );
  }

  private isOurs(entry: ManagedEmulator, emulator: RunningEmulator): boolean {
    const pidMatches =
      !this.matchPid || entry.process.pid === undefined || emulator.pid === entry.process.pid;
    const grpcMatches = !emulator.grpc || emulator.grpc.port === entry.grpcPort;
    return emulator.serial === entry.serial && pidMatches && grpcMatches;
  }

  /** Console ports taken by running emulators, adb devices and our own boots. */
  private usedConsolePorts(): Set<number> {
    const serials = [
      ...this.running.map((emulator) => emulator.serial),
      ...this.devices.map((device) => device.serial),
      ...[...this.managed.values()].map((entry) => entry.serial),
    ];
    return new Set(
      serials.filter((serial) => EMULATOR_SERIAL.test(serial)).map((serial) => Number(serial.slice(9))),
    );
  }

  /** Re-read discovery and statuses; concurrent callers share one pass, and a call during a pass queues one more. */
  private poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pollInFlight) {
      this.pollAgain = true;
      return this.pollInFlight;
    }
    this.pollInFlight = (async () => {
      do {
        this.pollAgain = false;
        await this.readState();
        this.publish();
      } while (this.pollAgain && !this.closed);
    })().finally(() => {
      this.pollInFlight = null;
      this.schedulePoll();
    });
    return this.pollInFlight;
  }

  private schedulePoll(): void {
    if (this.closed || this.pollTimer) return;
    const busy = this.emulators.some((info) => info.state === 'booting' || info.state === 'shutting_down');
    if (!busy) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, this.pollMs);
  }

  private async readState(): Promise<void> {
    const discovered: RunningEmulator[] = await readRunningEmulators(this.host.discoveryDirs, {
      isAlive: (pid) => this.host.isAlive(pid),
    });
    const extra = await this.undiscoveredEmulators(discovered);
    const running = [...discovered, ...extra];
    await this.probe.update(running, (serial) => this.isAdbReady(serial));
    this.running = running.filter((emulator) => !this.probe.isStale(emulator));
    for (const [avdName, entry] of this.managed) {
      if (!entry.exited || this.isRunning(avdName)) continue;
      if (entry.escalation) clearTimeout(entry.escalation);
      this.managed.delete(avdName);
    }
  }

  /** Emulators adb lists that left no discovery file (another discovery directory, old emulators). */
  private async undiscoveredEmulators(discovered: readonly RunningEmulator[]): Promise<RunningEmulator[]> {
    const known = new Set(discovered.map((emulator) => emulator.serial));
    this.avdNames.retain(new Set(this.devices.map((device) => device.serial)));
    const extra: RunningEmulator[] = [];
    for (const device of this.devices) {
      if (!EMULATOR_SERIAL.test(device.serial) || known.has(device.serial) || device.state !== 'device')
        continue;
      const avdName = await this.avdNames.nameOf(device.serial);
      if (avdName)
        extra.push({ pid: null, serial: device.serial, avdName, displayName: null, grpc: null, cmdline: '' });
    }
    return extra;
  }

  private isAdbReady(serial: string): boolean {
    return this.devices.some((device) => device.serial === serial && device.state === 'device');
  }

  private infoOf(avdName: string): EmulatorInfo | undefined {
    return this.emulators.find((info) => info.avdName === avdName);
  }

  /** Rebuild the EmulatorInfo list; broadcast and notify when it changed. */
  private publish(): void {
    const names = this.catalog.list.map((avd) => avd.name);
    for (const emulator of this.running) if (!names.includes(emulator.avdName)) names.push(emulator.avdName);
    const emulators = names.map((name) => this.describe(name));
    const key = JSON.stringify(emulators);
    if (key === this.emulatorsKey) return;
    this.emulatorsKey = key;
    this.emulators = emulators;
    if (!this.closed) this.broadcast({ type: 'emulators', emulators });
    for (const listener of this.listeners) listener();
  }

  private describe(avdName: string): EmulatorInfo {
    const emulator = this.instanceOf(avdName);
    const entry = this.managed.get(avdName);
    const displayName =
      this.catalog.list.find((avd) => avd.name === avdName)?.displayName ?? emulator?.displayName ?? null;
    let state: EmulatorInfo['state'] = 'off';
    if (entry?.shuttingDown && (emulator || !entry.exited)) state = 'shutting_down';
    else if (emulator) state = this.probe.isBooted(emulator) ? 'running' : 'booting';
    else if (entry && !entry.exited) state = 'booting';
    return {
      avdName,
      displayName,
      state,
      serial: emulator?.serial ?? null,
      managed: entry !== undefined,
      canMirror: Boolean(emulator?.grpc && this.host.createClient),
      renderer: emulator ? this.probe.rendererOf(emulator) : 'unknown',
    };
  }

  /**
   * One boot or shutdown at a time, in order. Refused while one for the same AVD is pending or the queue is
   * full; operations still queued when the server closes do not start.
   */
  private enqueue<T>(avdName: string, operation: () => Promise<T>): Promise<T> {
    if (this.pendingAvds.has(avdName)) {
      return Promise.reject(new PublicError(`${avdName} is busy: a boot or shutdown is still in progress`));
    }
    if (this.queuedOperations >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new PublicError('Emulator operations are busy: try again in a moment'));
    }
    this.pendingAvds.add(avdName);
    this.queuedOperations += 1;
    const run = (): Promise<T> => {
      if (this.closed) return Promise.reject(new PublicError('server is shutting down'));
      return operation();
    };
    const result = this.operations.then(run, run).finally(() => {
      this.pendingAvds.delete(avdName);
      this.queuedOperations -= 1;
    });
    this.operations = result.catch(() => undefined);
    return result;
  }
}

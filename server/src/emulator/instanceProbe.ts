import type { EmulatorRenderer } from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';
import type { DiscoveredEmulator } from './discovery.ts';
import type { EmulatorClient, EmulatorClientFactory } from './emulatorClient.ts';
import { rendererFromCmdline, rendererFromSurfaceFlinger } from './renderer.ts';

const ADB_TIMEOUT_MS = 5000;
/**
 * A discovered instance that neither adb lists nor answers gRPC for this long is stale: its discovery file names
 * a pid that was reused by some other process after the emulator died.
 */
export const STALE_INSTANCE_MS = 30_000;

/** A running emulator: from its discovery file, or (no discovery file) from adb alone (`pid` null). */
export type RunningEmulator = Pick<
  DiscoveredEmulator,
  'serial' | 'avdName' | 'displayName' | 'grpc' | 'cmdline'
> & {
  pid: number | null;
};

/** One running instance: serial + pid (a restarted emulator on the same serial is a new instance). */
export function instanceKey(emulator: RunningEmulator): string {
  return `${emulator.serial}#${emulator.pid ?? '-'}`;
}

/**
 * Per running instance: booted yet (gRPC getStatus, else `sys.boot_completed`), and then its renderer. Both are
 * checked until known and then kept for the instance's lifetime. The gRPC channel used for the status is closed
 * once the instance has booted.
 */
export class InstanceProbe {
  private readonly booted = new Set<string>();
  private readonly renderers = new Map<string, EmulatorRenderer>();
  private readonly clients = new Map<string, EmulatorClient>();
  /** When each instance was first seen, and the ones that ever answered (gRPC status or an adb listing). */
  private readonly firstSeen = new Map<string, number>();
  private readonly answered = new Set<string>();
  private closed = false;

  constructor(
    private readonly adb: Adb,
    private readonly createClient: EmulatorClientFactory | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Never answered (see STALE_INSTANCE_MS): not an emulator at all. */
  isStale(emulator: RunningEmulator): boolean {
    const key = instanceKey(emulator);
    const since = this.firstSeen.get(key);
    return !this.answered.has(key) && since !== undefined && this.now() - since >= STALE_INSTANCE_MS;
  }

  isBooted(emulator: RunningEmulator): boolean {
    return this.booted.has(instanceKey(emulator));
  }

  rendererOf(emulator: RunningEmulator): EmulatorRenderer {
    return this.renderers.get(instanceKey(emulator)) ?? 'unknown';
  }

  /** Forget instances that are gone, then check the running ones. `isAdbReady`: adb lists it as `device`. */
  async update(running: readonly RunningEmulator[], isAdbReady: (serial: string) => boolean): Promise<void> {
    const live = new Set(running.map(instanceKey));
    for (const [key, client] of this.clients) {
      if (live.has(key)) continue;
      client.close();
      this.clients.delete(key);
    }
    for (const key of this.booted) if (!live.has(key)) this.booted.delete(key);
    for (const key of this.renderers.keys()) if (!live.has(key)) this.renderers.delete(key);
    for (const key of this.firstSeen.keys()) if (!live.has(key)) this.firstSeen.delete(key);
    for (const key of this.answered) if (!live.has(key)) this.answered.delete(key);
    await Promise.all(
      running.map((emulator) => {
        const key = instanceKey(emulator);
        if (!this.firstSeen.has(key)) this.firstSeen.set(key, this.now());
        if (isAdbReady(emulator.serial)) this.answered.add(key);
        return this.check(emulator, isAdbReady(emulator.serial));
      }),
    );
  }

  /** Close every channel; no new ones are opened after this. */
  close(): void {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private async check(emulator: RunningEmulator, adbReady: boolean): Promise<void> {
    const key = instanceKey(emulator);
    if (!this.booted.has(key)) {
      if (!(await this.probeBooted(emulator, key, adbReady))) return;
      this.booted.add(key);
      this.clients.get(key)?.close();
      this.clients.delete(key);
    }
    if ((this.renderers.get(key) ?? 'unknown') !== 'unknown') return;
    let renderer = rendererFromCmdline(emulator.cmdline);
    if (renderer === 'unknown' && adbReady) {
      try {
        renderer = rendererFromSurfaceFlinger(
          await adbShell(this.adb, emulator.serial, 'dumpsys SurfaceFlinger', { timeoutMs: ADB_TIMEOUT_MS }),
        );
      } catch (error) {
        log.warn(`Cannot read the renderer of ${emulator.serial}: ${errorMessage(error)}`);
      }
    }
    this.renderers.set(key, renderer);
  }

  private async probeBooted(emulator: RunningEmulator, key: string, adbReady: boolean): Promise<boolean> {
    if (emulator.grpc && this.createClient && !this.closed) {
      let client = this.clients.get(key);
      if (!client) {
        client = this.createClient(emulator.grpc);
        this.clients.set(key, client);
      }
      try {
        const { booted } = await client.getStatus();
        this.answered.add(key);
        return booted;
      } catch {
        // Not answering yet while it boots; adb below is the fallback.
      }
    }
    if (!adbReady) return false;
    try {
      const value = await adbShell(this.adb, emulator.serial, 'getprop sys.boot_completed', {
        timeoutMs: ADB_TIMEOUT_MS,
      });
      return value.trim() === '1';
    } catch {
      return false;
    }
  }
}

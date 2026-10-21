import { createConnection } from 'node:net';
import type { Adb } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';

const LIST_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 500;

export interface ReverseTunnelOptions {
  adb: Adb;
  /** Port the SDK connects to on the device. */
  devicePort: number;
  /** Bound port of the device gateway, null when it isn't listening (then no mapping is made). */
  hostPort: () => number | null;
  /** `adb reverse` failed: the session continues without the SDK link. */
  onOpenFailed: (error: unknown) => void;
  /** Whether something accepts connections on 127.0.0.1:`port` (tests replace the TCP probe). */
  isHostPortLive?: (port: number) => Promise<boolean>;
}

/**
 * Host port `devicePort` is mapped to in `adb reverse --list` output (`<transport> tcp:<device> tcp:<host>`
 * lines): null for a non-TCP target, undefined when the device port isn't mapped.
 */
export function mappedHostPort(output: string, devicePort: number): number | null | undefined {
  for (const line of output.split('\n')) {
    const [, device, host] = line.trim().split(/\s+/);
    if (device !== `tcp:${devicePort}`) continue;
    const port = /^tcp:(\d+)$/.exec(host ?? '')?.[1];
    return port === undefined ? null : Number(port);
  }
  return undefined;
}

/** A TCP connect to 127.0.0.1:`port`: true when something is listening there. */
export function probeLoopbackPort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The `adb reverse` mapping for the active session's device. Operations run strictly in order, so a
 * `--remove` for the previous session can never land after the mapping of the next one.
 */
export class ReverseTunnel {
  private chain: Promise<void> = Promise.resolve();
  /** Serial we mapped (or tried to: the intent is recorded first, so close() always attempts removal). */
  private mapped: string | null = null;

  constructor(private readonly options: ReverseTunnelOptions) {}

  /**
   * Map the device port of `serial` to the gateway. Idempotent for the same device (`adb reverse` replaces
   * its own mapping), so it can be re-run after USB flickers; a previous device's mapping is removed first.
   */
  open(serial: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.mapped !== null && this.mapped !== serial) await this.removeMapping();
      const hostPort = this.options.hostPort();
      if (hostPort === null) return;
      this.mapped = serial;
      try {
        await this.options.adb.reverse(serial, this.options.devicePort, hostPort);
      } catch (error) {
        this.options.onOpenFailed(error);
      }
    });
  }

  /** Remove the mapping, if any (best effort: a vanished device can't be cleaned up). */
  close(): Promise<void> {
    return this.enqueue(() => this.removeMapping());
  }

  /**
   * Remove mappings of the device port left behind by an earlier run (crash, kill -9) on these devices, so a
   * stale mapping can't route an SDK to a server that no longer exists. A mapping to another host port that
   * still accepts connections belongs to another Lionscope server running next to this one: it is left alone.
   * Best effort, logged.
   */
  clearStale(serials: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      for (const serial of serials) {
        if (serial === this.mapped) continue;
        try {
          const listing = await this.options.adb.exec(['-s', serial, 'reverse', '--list'], {
            timeoutMs: LIST_TIMEOUT_MS,
          });
          const target = mappedHostPort(listing, this.options.devicePort);
          if (target === undefined) continue;
          if (target !== null && target !== this.options.hostPort() && (await this.isHostPortLive(target))) {
            log.info(
              `Left adb reverse tcp:${this.options.devicePort} on ${serial} alone: another server listens on ${target}`,
            );
            continue;
          }
          await this.options.adb.removeReverse(serial, this.options.devicePort);
          log.info(`Removed a stale adb reverse tcp:${this.options.devicePort} on ${serial}`);
        } catch (error) {
          log.warn(`Could not check adb reverse on ${serial}: ${errorMessage(error)}`);
        }
      }
    });
  }

  private isHostPortLive(port: number): Promise<boolean> {
    return (this.options.isHostPortLive ?? probeLoopbackPort)(port);
  }

  private async removeMapping(): Promise<void> {
    const serial = this.mapped;
    if (serial === null) return;
    this.mapped = null;
    try {
      await this.options.adb.removeReverse(serial, this.options.devicePort);
    } catch (error) {
      log.warn(`Could not remove adb reverse on ${serial}: ${errorMessage(error)}`);
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    // A failing step (e.g. a throwing callback) must not wedge the chain for every later operation.
    this.chain = this.chain
      .then(operation)
      .catch((error: unknown) => log.warn(`adb reverse step failed: ${errorMessage(error)}`));
    return this.chain;
  }
}

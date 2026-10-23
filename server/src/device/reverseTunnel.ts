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
  /** Runs the `adb reverse` steps per device; shared with the inspect-only links so their steps never interleave. */
  devices?: DeviceReverseQueues;
}

/**
 * Runs `adb reverse` steps strictly one after another. A failing step is logged and never wedges the queue for
 * the steps after it.
 */
export class ReverseQueue {
  private chain: Promise<void> = Promise.resolve();

  run(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(operation)
      .catch((error: unknown) => log.warn(`adb reverse step failed: ${errorMessage(error)}`));
    return this.chain;
  }
}

/**
 * One ReverseQueue per device: steps on one device run strictly in order, while a slow or unplugged device does not
 * hold up the others. A device's queue is dropped once it is idle.
 */
export class DeviceReverseQueues {
  private readonly queues = new Map<string, { queue: ReverseQueue; steps: number; last: Promise<void> }>();

  run(serial: string, operation: () => Promise<void>): Promise<void> {
    let entry = this.queues.get(serial);
    if (!entry) {
      entry = { queue: new ReverseQueue(), steps: 0, last: Promise.resolve() };
      this.queues.set(serial, entry);
    }
    const current = entry;
    current.steps += 1;
    current.last = current.queue.run(operation).finally(() => {
      current.steps -= 1;
      if (current.steps === 0 && this.queues.get(serial) === current) this.queues.delete(serial);
    });
    return current.last;
  }

  /** Resolves once every step scheduled so far, on every device, is done. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()].map((entry) => entry.last));
  }
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
 * The `adb reverse` mapping for the active session's device. Each adb step joins its device's queue
 * (DeviceReverseQueues) when open() / close() is called, so steps on one device land in call order: a `--remove`
 * for the previous session can never land after the mapping of the next one, nor after a step another owner of the
 * queue (an inspect-only link) scheduled later.
 */
export class ReverseTunnel {
  private readonly devices: DeviceReverseQueues;
  /** Serial we mapped (or are mapping: the intent is recorded first, so close() always attempts removal). */
  private mapped: string | null = null;

  constructor(private readonly options: ReverseTunnelOptions) {
    this.devices = options.devices ?? new DeviceReverseQueues();
  }

  /** The device whose port is mapped to the gateway (connections to it come from there), null when none is. */
  get serial(): string | null {
    return this.mapped;
  }

  /**
   * Map the device port of `serial` to the gateway. Idempotent for the same device (`adb reverse` replaces
   * its own mapping), so it can be re-run after USB flickers; a previous device's mapping is removed.
   */
  open(serial: string): Promise<void> {
    const previous = this.mapped;
    const removed = previous !== null && previous !== serial ? this.remove(previous) : Promise.resolve();
    const hostPort = this.options.hostPort();
    if (hostPort === null) {
      if (previous !== serial) this.mapped = null;
      return removed;
    }
    this.mapped = serial;
    const mapping = this.devices.run(serial, async () => {
      try {
        await this.options.adb.reverse(serial, this.options.devicePort, hostPort);
      } catch (error) {
        this.options.onOpenFailed(error);
      }
    });
    return Promise.all([removed, mapping]).then(() => undefined);
  }

  /** Remove the mapping, if any (best effort: a vanished device can't be cleaned up). */
  close(): Promise<void> {
    const serial = this.mapped;
    this.mapped = null;
    return serial === null ? Promise.resolve() : this.remove(serial);
  }

  /** Forget the mapping without removing it: another owner (an inspect-only link) re-points it. */
  release(): Promise<void> {
    this.mapped = null;
    return Promise.resolve();
  }

  /**
   * Remove mappings of the device port left behind by an earlier run (crash, kill -9) on these devices, so a
   * stale mapping can't route an SDK to a server that no longer exists. A mapping to another host port that
   * still accepts connections belongs to another Lionscope server running next to this one: it is left alone.
   * Best effort, logged.
   */
  clearStale(serials: readonly string[]): Promise<void> {
    const mapped = this.mapped;
    const steps = serials
      .filter((serial) => serial !== mapped)
      .map((serial) => this.devices.run(serial, () => this.clearStaleOn(serial)));
    return Promise.all(steps).then(() => undefined);
  }

  private async clearStaleOn(serial: string): Promise<void> {
    try {
      const listing = await this.options.adb.exec(['-s', serial, 'reverse', '--list'], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      const target = mappedHostPort(listing, this.options.devicePort);
      if (target === undefined) return;
      if (target !== null && target !== this.options.hostPort() && (await this.isHostPortLive(target))) {
        log.info(
          `Left adb reverse tcp:${this.options.devicePort} on ${serial} alone: another server listens on ${target}`,
        );
        return;
      }
      await this.options.adb.removeReverse(serial, this.options.devicePort);
      log.info(`Removed a stale adb reverse tcp:${this.options.devicePort} on ${serial}`);
    } catch (error) {
      log.warn(`Could not check adb reverse on ${serial}: ${errorMessage(error)}`);
    }
  }

  private isHostPortLive(port: number): Promise<boolean> {
    return (this.options.isHostPortLive ?? probeLoopbackPort)(port);
  }

  private remove(serial: string): Promise<void> {
    return this.devices.run(serial, async () => {
      try {
        await this.options.adb.removeReverse(serial, this.options.devicePort);
      } catch (error) {
        log.warn(`Could not remove adb reverse on ${serial}: ${errorMessage(error)}`);
      }
    });
  }
}

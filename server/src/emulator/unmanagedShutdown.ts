import type { ServerMessage } from '@lionscope/protocol';
import { PublicError } from '../errors.ts';
import { log } from '../log.ts';
import { instanceKey } from './instanceProbe.ts';
import type { RunningEmulator } from './instanceProbe.ts';
import { emuKill, requestShutdown } from './managedShutdown.ts';
import type { ShutdownTools } from './managedShutdown.ts';

/** The refusal of an unconfirmed shutdown of an emulator this server did not boot. */
export function notStartedHere(avdName: string, serial: string | undefined): PublicError {
  const how = serial ? `run adb -s ${serial} emu kill, or close it` : 'close it';
  return new PublicError(
    `${avdName} was not started by Lionscope: ${how} where it was started (e.g. Android Studio)`,
  );
}

/**
 * The one instance of an AVD this server did not boot that may be shut down: found in a discovery file (read
 * from a private directory of this user, its pid alive) and listed by adb as `device`. None, several, or one
 * known from adb alone is refused rather than guessed.
 */
export function unmanagedInstance(
  avdName: string,
  running: readonly RunningEmulator[],
  isAdbReady: (serial: string) => boolean,
): RunningEmulator {
  const instances = running.filter((emulator) => emulator.avdName === avdName);
  const [instance] = instances;
  if (instance === undefined) throw new PublicError(`${avdName} is not running`);
  if (instances.length > 1) {
    const serials = instances.map((emulator) => emulator.serial).join(', ');
    throw new PublicError(
      `${avdName} runs ${instances.length} times (${serials}): shut down the one you mean where it was started`,
    );
  }
  if (instance.pid === null) {
    throw new PublicError(
      `${avdName} (${instance.serial}) has no emulator discovery file, so it cannot be identified safely: ` +
        'close it where it was started',
    );
  }
  if (!isAdbReady(instance.serial)) {
    throw new PublicError(`${avdName} (${instance.serial}) is not ready in adb yet: try again in a moment`);
  }
  return instance;
}

interface Shutdown {
  /** instanceKey: a restarted emulator on the same serial is not this one. */
  key: string;
  serial: string;
  /** Kills it over the console when it ignored the shutdown (graceMs). */
  escalation: ReturnType<typeof setTimeout> | null;
}

export interface UnmanagedShutdownsOptions {
  tools: ShutdownTools;
  graceMs: number;
  broadcast: (message: ServerMessage) => void;
  /** After a forced shutdown: re-read the emulators. */
  onForced: () => void;
}

/**
 * Shutdowns of emulators this server did not boot, tracked per AVD until their instance is gone. Only gRPC
 * SHUTDOWN and `adb emu kill` reach them, on their own endpoint and serial: their processes are never signalled.
 */
export class UnmanagedShutdowns {
  private readonly shutdowns = new Map<string, Shutdown>();

  constructor(private readonly options: UnmanagedShutdownsOptions) {}

  has(avdName: string): boolean {
    return this.shutdowns.has(avdName);
  }

  isShuttingDown(avdName: string, instance: RunningEmulator): boolean {
    return this.shutdowns.get(avdName)?.key === instanceKey(instance);
  }

  /** Shown as shutting down from now on; call request() next. */
  track(avdName: string, instance: RunningEmulator): void {
    this.shutdowns.set(avdName, { key: instanceKey(instance), serial: instance.serial, escalation: null });
  }

  /** Ask `instance` to shut down; when neither gRPC nor the console took it, it is no longer tracked. */
  async request(avdName: string, instance: RunningEmulator): Promise<void> {
    const shutdown = this.shutdowns.get(avdName);
    if (!shutdown) return;
    if (!(await requestShutdown(this.options.tools, avdName, instance))) {
      this.forget(avdName);
      throw new PublicError(`${avdName} did not accept the shutdown: close it where it was started`);
    }
    shutdown.escalation = setTimeout(() => void this.force(avdName), this.options.graceMs);
    shutdown.escalation.unref();
  }

  /** It ignored the shutdown (or was asked again): `adb emu kill` its serial. */
  async force(avdName: string): Promise<void> {
    const shutdown = this.shutdowns.get(avdName);
    if (!shutdown) return;
    if (shutdown.escalation) clearTimeout(shutdown.escalation);
    shutdown.escalation = null;
    log.warn(`${avdName} did not shut down: killing it over its console`);
    if (!(await emuKill(this.options.tools, avdName, shutdown.serial))) {
      this.forget(avdName);
      this.options.broadcast({
        type: 'error',
        code: 'shutdownEmulator_failed',
        message: `${avdName} did not shut down: close it where it was started`,
      });
    }
    this.options.onForced();
  }

  /** Stop tracking shutdowns whose instance no longer runs. */
  retain(running: readonly RunningEmulator[]): void {
    const live = new Set(running.map(instanceKey));
    for (const [avdName, shutdown] of this.shutdowns) if (!live.has(shutdown.key)) this.forget(avdName);
  }

  close(): void {
    for (const shutdown of this.shutdowns.values())
      if (shutdown.escalation) clearTimeout(shutdown.escalation);
    this.shutdowns.clear();
  }

  private forget(avdName: string): void {
    const shutdown = this.shutdowns.get(avdName);
    if (shutdown?.escalation) clearTimeout(shutdown.escalation);
    this.shutdowns.delete(avdName);
  }
}

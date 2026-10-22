import type { Adb } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';
import type { EmulatorClientFactory } from './emulatorClient.ts';
import type { EmulatorProcess } from './emulatorHost.ts';
import type { RunningEmulator } from './instanceProbe.ts';

/** Per step of a shutdown (gRPC, then `adb emu kill`): the server's own exit must not wait for long. */
export const SHUTDOWN_STEP_TIMEOUT_MS = 2000;
/** An emulator still running this long after a shutdown request is killed (as is one asked to shut down twice). */
export const SHUTDOWN_GRACE_MS = 45_000;

/**
 * An emulator this server booted, pinned to the console and gRPC ports it was given (`-port`, `-grpc`). Its
 * instance is the one on that serial with that gRPC port and, on POSIX, with the pid of the process we spawned
 * (the launcher execs qemu, so the discovery file names that pid). Only that instance is shut down.
 *
 * Known Windows limitations: the launcher may not exec qemu, so the instance is matched without the pid, and
 * may exit early while qemu keeps running; the last-resort signal then reaches the launcher only (no process
 * groups), which can leave qemu running.
 */
export interface ManagedEmulator {
  process: EmulatorProcess;
  serial: string;
  grpcPort: number;
  exited: boolean;
  shuttingDown: boolean;
  /** Forces the shutdown when the emulator ignored it (SHUTDOWN_GRACE_MS). */
  escalation: ReturnType<typeof setTimeout> | null;
}

/** What a shutdown needs: adb for `emu kill`, the gRPC client factory for SHUTDOWN. */
export interface ShutdownTools {
  adb: Adb;
  createClient: EmulatorClientFactory | null;
}

/**
 * gRPC SHUTDOWN (snapshot saved on quick boot), else `adb emu kill` on its serial, both only to `instance`.
 * false: neither was accepted.
 */
export async function requestShutdown(
  tools: ShutdownTools,
  avdName: string,
  instance: RunningEmulator,
): Promise<boolean> {
  if (instance.grpc && tools.createClient) {
    const client = tools.createClient(instance.grpc);
    try {
      await withTimeout(client.shutdown(), SHUTDOWN_STEP_TIMEOUT_MS);
      log.info(`Shutting down ${avdName}`);
      return true;
    } catch (error) {
      log.warn(`gRPC shutdown of ${avdName} failed: ${errorMessage(error)}`);
    } finally {
      client.close();
    }
  }
  if (await emuKill(tools, avdName, instance.serial)) {
    log.info(`Killed ${avdName} (${instance.serial})`);
    return true;
  }
  return false;
}

/**
 * requestShutdown to `instance` (the entry's own, found by the caller); else (or without an instance) a signal
 * to the process group this server spawned.
 */
export async function stopEmulator(
  tools: ShutdownTools,
  avdName: string,
  entry: ManagedEmulator,
  instance: RunningEmulator | undefined,
): Promise<void> {
  if (instance && (await requestShutdown(tools, avdName, instance))) return;
  if (!entry.exited) entry.process.kill('SIGTERM');
}

/**
 * The emulator did not shut down: `adb emu kill` its own serial, then kill the process group we spawned.
 * false: nothing to do (it is gone already).
 */
export async function forceEmulator(
  tools: ShutdownTools,
  avdName: string,
  entry: ManagedEmulator,
  instance: RunningEmulator | undefined,
): Promise<boolean> {
  if (entry.escalation) clearTimeout(entry.escalation);
  entry.escalation = null;
  if (!instance && entry.exited) return false;
  log.warn(`${avdName} did not shut down: killing it`);
  if (instance && (await emuKill(tools, avdName, entry.serial))) {
    await waitUntil(() => entry.exited, SHUTDOWN_STEP_TIMEOUT_MS);
  }
  if (!entry.exited) entry.process.kill('SIGKILL');
  return true;
}

/** `adb -s <serial> emu kill`; false (logged) when the console did not take it. */
export async function emuKill(tools: ShutdownTools, avdName: string, serial: string): Promise<boolean> {
  try {
    await tools.adb.exec(['-s', serial, 'emu', 'kill'], { timeoutMs: SHUTDOWN_STEP_TIMEOUT_MS });
    return true;
  } catch (error) {
    log.warn(`adb emu kill of ${avdName} failed: ${errorMessage(error)}`);
    return false;
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition() || Date.now() >= deadline) resolve();
      else setTimeout(check, 100).unref();
    };
    check();
  });
}

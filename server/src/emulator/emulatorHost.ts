import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolveAdbOptions } from '../adb/resolveAdb.ts';
import { HOST } from '../config.ts';
import { errorMessage, log } from '../log.ts';
import { avdHomeDirectory } from './avds.ts';
import { discoveryDirectories, isProcessAlive } from './discovery.ts';
import { createEmulatorClientFactory, loadEmulatorController } from './emulatorClient.ts';
import type { EmulatorClientFactory } from './emulatorClient.ts';
import { resolveEmulatorToolchain } from './toolchain.ts';

/** A booted emulator process (the `emulator` launcher we spawned). */
export interface EmulatorProcess {
  /** The emulator's pid: the launcher execs qemu (verified on emulator 36.6, macOS), so it is also the pid in
   * the discovery file. Undefined when the spawn failed. */
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/** Everything the emulator manager needs from the machine; tests pass fakes. */
export interface EmulatorHost {
  /** null without an installed Android Emulator: no AVD list, no boot. */
  readonly emulatorPath: string | null;
  /** null when the proto is missing or unusable: nothing can be mirrored. */
  readonly createClient: EmulatorClientFactory | null;
  readonly avdHome: string;
  readonly discoveryDirs: readonly string[];
  /** `emulator <args>` to completion; resolves with stdout. */
  runEmulator(args: readonly string[]): Promise<string>;
  /** Start `emulator <args>` in its own process group, output to a log file. */
  spawnEmulator(args: readonly string[], logName: string): EmulatorProcess;
  isAlive(pid: number): boolean;
  /** Nothing listens on 127.0.0.1:`port`. */
  isPortFree(port: number): Promise<boolean>;
}

const LIST_AVDS_TIMEOUT_MS = 15_000;
const LOG_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

/**
 * A signal goes to the whole process group the spawned emulator leads (it was started detached), which also
 * reaches qemu should a launcher start it as a child instead of exec'ing it; Windows has no groups: the
 * process itself only.
 */
export class SpawnedEmulator implements EmulatorProcess {
  constructor(
    private readonly child: ChildProcess,
    private readonly platform: NodeJS.Platform,
  ) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const pid = this.child.pid;
    if (this.platform !== 'win32' && pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        // The group is gone already, or never formed: fall back to the launcher itself.
      }
    }
    return this.child.kill(signal);
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit' | 'error', listener: (...args: never[]) => void): this {
    this.child.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
}

/** Nothing listens on 127.0.0.1:`port` (a listen attempt succeeds). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, HOST, () => server.close(() => resolve(true)));
  });
}

function loadClientFactory(protoPath: string | null): EmulatorClientFactory | null {
  if (!protoPath) {
    log.warn(
      'emulator_controller.proto not found in the SDK (emulator/lib): update the Android Emulator to mirror',
    );
    return null;
  }
  try {
    return createEmulatorClientFactory(loadEmulatorController(protoPath));
  } catch (error) {
    log.warn(`Cannot load ${protoPath}, emulator mirroring is off: ${errorMessage(error)}`);
    return null;
  }
}

/** The real host: the emulator of the SDK that `adbPath` belongs to (or the usual SDK locations). */
export function createEmulatorHost(adbPath: string, options: ResolveAdbOptions = {}): EmulatorHost {
  const toolchain = resolveEmulatorToolchain(adbPath, options);
  if (!toolchain) log.info('Android Emulator not found in the SDK: emulator boot and mirroring are off');
  const emulatorPath = toolchain?.emulatorPath ?? null;
  let logDir: string | undefined;
  return {
    emulatorPath,
    createClient: toolchain ? loadClientFactory(toolchain.protoPath) : null,
    avdHome: avdHomeDirectory(options),
    discoveryDirs: discoveryDirectories(options),
    runEmulator(args) {
      return new Promise((resolve, reject) => {
        if (!emulatorPath) return reject(new Error('no Android Emulator'));
        execFile(
          emulatorPath,
          [...args],
          { timeout: LIST_AVDS_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
    },
    spawnEmulator(args, logName) {
      if (!emulatorPath) throw new Error('no Android Emulator');
      // A private directory (0700) per server run; the file is private too, and never opened through a symlink.
      logDir ??= mkdtempSync(path.join(tmpdir(), 'lionscope-'));
      const logFile = path.join(logDir, `emulator-${logName}.log`);
      const fd = openSync(logFile, LOG_FLAGS, 0o600);
      try {
        // Own process group: Ctrl+C in the server's terminal must not kill it; the server shuts it down itself
        // (gracefully, so Quick Boot saves its snapshot).
        const child = spawn(emulatorPath, [...args], {
          detached: true,
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        });
        child.unref();
        log.info(`Emulator output goes to ${logFile}`);
        return new SpawnedEmulator(child, options.platform ?? process.platform);
      } finally {
        closeSync(fd);
      }
    },
    isPortFree,
    isAlive: isProcessAlive,
  };
}

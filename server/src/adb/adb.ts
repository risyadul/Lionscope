import { execFile, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** The subset of ChildProcess the server relies on (lets tests pass in fakes). */
export interface ChildProcessLike {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ExecOptions {
  timeoutMs?: number;
}

/**
 * Host-side adb access. Arguments are always passed as an array (never through a host shell).
 * Callers are responsible for validating serials / package names before they get here.
 */
export interface Adb {
  readonly path: string;
  /** Run `adb <args>` to completion and resolve with stdout. */
  exec(args: readonly string[], options?: ExecOptions): Promise<string>;
  /** Spawn a long-running `adb <args>` process (persistent shell, logcat). */
  spawn(args: readonly string[]): ChildProcessLike;
  /** `adb -s <serial> reverse tcp:<devicePort> tcp:<hostPort>`: device connections reach the host port. */
  reverse(serial: string, devicePort: number, hostPort: number): Promise<void>;
  /** `adb -s <serial> reverse --remove tcp:<devicePort>`. */
  removeReverse(serial: string, devicePort: number): Promise<void>;
}

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const REVERSE_TIMEOUT_MS = 5000;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createAdb(adbPath: string): Adb {
  const exec: Adb['exec'] = (args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        adbPath,
        [...args],
        {
          timeout: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          maxBuffer: MAX_EXEC_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim() || error.message;
            reject(new Error(`adb ${args.join(' ')} failed: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  return {
    path: adbPath,
    exec,
    spawn(args) {
      return spawn(adbPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    },
    async reverse(serial, devicePort, hostPort) {
      await exec(['-s', serial, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`], {
        timeoutMs: REVERSE_TIMEOUT_MS,
      });
    },
    async removeReverse(serial, devicePort) {
      await exec(['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`], {
        timeoutMs: REVERSE_TIMEOUT_MS,
      });
    },
  };
}

/** `adb -s <serial> shell <command>` as a one-shot process. */
export function adbShell(adb: Adb, serial: string, command: string, options?: ExecOptions): Promise<string> {
  return adb.exec(['-s', serial, 'shell', command], options);
}

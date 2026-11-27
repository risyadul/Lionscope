import { execFile, spawn } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { redactLogText } from '@lionscope/protocol/insights';

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
  /** Aborting kills the child process and rejects promptly. */
  signal?: AbortSignal | undefined;
  /** Explicit sensitive strings (e.g. a deep-link URI) to scrub from stderr before generic log redaction. */
  redactValues?: readonly string[] | undefined;
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

/** An intent's `key` extra: the link key handed to the app (device/linkKey.ts). */
const KEY_EXTRA = /(--es key )\S+/g;
/** An intent's `-d <uri>` data argument inside a single `am start`/`am broadcast` shell command string. */
const AM_DATA_URI_INLINE =
  /(\bam\s+(?:start(?:-activity)?|broadcast)\b[^\r\n]*?(?:\s)-d\s+)('[^']*(?:'\\''[^']*)*'|\S+)/g;

function unquotePosixSingle(arg: string): string {
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) {
    return arg.slice(1, -1).replaceAll("'\\''", "'");
  }
  return arg;
}

/** Extracts raw intent `-d <uri>` values from `adb … shell am …` args so stderr echoes can be scrubbed too. */
function extractIntentDataUris(args: readonly string[]): string[] {
  const uris: string[] = [];
  const shellIdx = args.indexOf('shell');
  if (shellIdx === -1) return uris;

  const isAmArray = args[shellIdx + 1] === 'am';
  if (isAmArray) {
    for (let i = shellIdx + 2; i < args.length - 1; i++) {
      if (args[i] === '-d') {
        const raw = args[i + 1]!;
        uris.push(raw);
        const unquoted = unquotePosixSingle(raw);
        if (unquoted !== raw) uris.push(unquoted);
        i++;
      }
    }
    return uris;
  }

  for (let i = shellIdx + 1; i < args.length; i++) {
    const arg = args[i]!;
    for (const match of arg.matchAll(AM_DATA_URI_INLINE)) {
      if (match[2]) {
        uris.push(match[2]);
        const unquoted = unquotePosixSingle(match[2]);
        if (unquoted !== match[2]) uris.push(unquoted);
      }
    }
  }
  return uris;
}

/**
 * Typed text can be a password, a link key is a secret, and an `am start`/`am broadcast` intent `-d <uri>` can
 * carry auth tokens or opaque path credentials: none of them ever reach an error message or a log line.
 * ADB's own `-d` (USB device selector, e.g. `adb -d get-state`) is NOT masked.
 */
export function describeArgs(args: readonly string[]): string {
  const shellIdx = args.indexOf('shell');
  const isAmArray = shellIdx !== -1 && args[shellIdx + 1] === 'am';
  const out: string[] = [];
  let redactNextDataUri = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (redactNextDataUri) {
      redactNextDataUri = false;
      out.push('<redacted>');
      continue;
    }
    if (isAmArray && i > shellIdx + 1 && arg === '-d') {
      redactNextDataUri = true;
      out.push(arg);
      continue;
    }
    if (/^input text\b/.test(arg)) {
      out.push('input text <redacted>');
      continue;
    }
    let sanitized = arg.replace(KEY_EXTRA, '$1<redacted>');
    if (shellIdx !== -1 && i > shellIdx) {
      sanitized = sanitized.replace(AM_DATA_URI_INLINE, '$1<redacted>');
    }
    out.push(redactLogText(sanitized));
  }
  return out.join(' ');
}

function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.replaceAll(secret, '<redacted>');
    }
  }
  return redactLogText(out);
}

/** stderr (known secrets & credentials redacted), else why the process ended; never Node's message. */
function failureDetail(error: ExecFileException, stderr: string, secrets: readonly string[]): string {
  if (stderr.trim() !== '') return scrubKnownSecrets(stderr.trim(), secrets);
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return 'aborted';
  if (error.killed) return 'timed out';
  return typeof error.code === 'number' ? `exit code ${error.code}` : (error.code ?? 'failed');
}

export function createAdb(adbPath: string): Adb {
  const exec: Adb['exec'] = (args, options = {}) =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error(`adb ${describeArgs(args)} aborted`));
        return;
      }
      const secrets = [...extractIntentDataUris(args), ...(options.redactValues ?? [])];
      execFile(
        adbPath,
        [...args],
        {
          timeout: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          maxBuffer: MAX_EXEC_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          if (error) {
            if (options.signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
              reject(new Error(`adb ${describeArgs(args)} aborted`));
              return;
            }
            reject(new Error(`adb ${describeArgs(args)} failed: ${failureDetail(error, stderr, secrets)}`));
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

/** Safe unquoted POSIX shell token (alphanumerics and benign punctuation only). */
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;

/**
 * Quotes one argument for the device's POSIX shell (`/system/bin/sh`). Benign barewords stay unquoted for
 * readability; anything with shell metacharacters (including `&`, `?`, `;`, `$`, spaces or quotes) is single-quoted.
 */
export function quoteShellArg(arg: string): string {
  if (arg.length > 0 && SAFE_SHELL_TOKEN.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** `adb -s <serial> shell <command>` as a one-shot process. */
export function adbShell(adb: Adb, serial: string, command: string, options?: ExecOptions): Promise<string> {
  return adb.exec(['-s', serial, 'shell', command], options);
}

/**
 * `adb -s <serial> shell <arg1> <arg2> …` with every argument validated/quoted for the remote POSIX shell and
 * passed as an array to `adb` (never interpolated through a host shell).
 */
export function adbShellArgs(
  adb: Adb,
  serial: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<string> {
  return adb.exec(['-s', serial, 'shell', ...args.map(quoteShellArg)], options);
}

export interface ExecBinaryOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Aborting kills the process and rejects. */
  signal?: AbortSignal;
}

/** `adb <args>` to completion with stdout as bytes (exec decodes UTF-8), e.g. `exec-out screencap -p`. */
export function execBinary(adb: Adb, args: readonly string[], options: ExecBinaryOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = adb.spawn(args);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let exitCode: number | null | undefined;
    let ended = false;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes));
    };
    const maybeDone = () => {
      if (!ended || exitCode === undefined) return;
      if (exitCode === 0) finish(null);
      else
        finish(
          new Error(
            `adb ${describeArgs(args)} failed: ${stderr.trim() ? redactLogText(stderr.trim()) : `exit code ${exitCode}`}`,
          ),
        );
    };
    const timer = setTimeout(
      () => finish(new Error(`adb ${describeArgs(args)} timed out`)),
      options.timeoutMs,
    );
    const onAbort = () => finish(new Error(`adb ${describeArgs(args)} aborted`));
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes)
        finish(new Error(`adb ${describeArgs(args)}: output over ${options.maxBytes} bytes`));
      else chunks.push(chunk);
    });
    child.stdout?.on('end', () => {
      ended = true;
      maybeDone();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      stderr = (stderr + text).slice(-4096);
    });
    child.on('exit', (code) => {
      exitCode = code;
      if (!child.stdout) ended = true;
      maybeDone();
    });
    child.on('error', (error) => finish(error));
  });
}

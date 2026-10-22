import { createHash, randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbShell, execBinary } from '../adb/adb.ts';
import type { Adb, ChildProcessLike } from '../adb/adb.ts';
import { IS_BUNDLE } from '../config.ts';
import { errorMessage, log } from '../log.ts';
import { SCRCPY_VERSION } from './protocol.ts';

/** The vendored scrcpy-server (server/vendor in a clone, next to the bundle in the npm package). */
export const SCRCPY_JAR_NAME = `scrcpy-server-v${SCRCPY_VERSION}`;
/** Where the jar goes on the device. With `cleanup=true` the server deletes it once it has started. */
export const DEVICE_JAR_PATH = '/data/local/tmp/lionscope-scrcpy.jar';

/** Connection attempts on the video socket while the server starts up (like scrcpy: 100 × 100 ms). */
export const CONNECT_ATTEMPTS = 100;
export const CONNECT_RETRY_MS = 100;
const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;
/** After the sockets close, how long the server gets to exit by itself before it is killed. */
export const STOP_GRACE_MS = 1000;
const PUSH_TIMEOUT_MS = 30_000;
const PUSH_OUTPUT_BYTES = 64 * 1024;
const ADB_TIMEOUT_MS = 5000;
/** Kept of the server's stderr, for the error summary (its output is otherwise dropped). */
const STDERR_KEPT_BYTES = 8 * 1024;
export const MAX_ERROR_SUMMARY_CHARS = 300;

/** A failure with a message fit for the dashboard (no host paths). */
export class MirrorStartError extends Error {}

export function resolveScrcpyJar(moduleUrl: string = import.meta.url, bundled: boolean = IS_BUNDLE): string {
  return fileURLToPath(
    new URL(bundled ? `./${SCRCPY_JAR_NAME}` : `../../vendor/${SCRCPY_JAR_NAME}`, moduleUrl),
  );
}

/**
 * SHA-256 of scrcpy-server v5.0.1, from the release's SHA256SUMS.txt (also in server/vendor/*.sha256, which a
 * test keeps equal). Built in rather than read next to the jar, so a swapped jar can't bring its own checksum.
 */
export const SCRCPY_JAR_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';

/**
 * The jar's bytes, checked against `expectedSha256` before they go to a device: only these exact bytes are
 * pushed. Throws MirrorStartError on a missing file or a mismatch.
 */
export async function readVerifiedJar(
  jarPath: string,
  expectedSha256: string = SCRCPY_JAR_SHA256,
): Promise<Buffer> {
  let jar: Buffer;
  try {
    jar = await readFile(jarPath);
  } catch (error) {
    log.warn(`Cannot read the scrcpy server: ${errorMessage(error)}`);
    throw new MirrorStartError(`${SCRCPY_JAR_NAME} is missing from this Lionscope installation`);
  }
  if (createHash('sha256').update(jar).digest('hex') !== expectedSha256) {
    throw new MirrorStartError(`${SCRCPY_JAR_NAME} does not match its SHA-256 checksum; reinstall Lionscope`);
  }
  return jar;
}

/**
 * `adb push` of exactly these bytes: written to a private temporary directory (mkdtemp is 0700) first, so the
 * file adb reads can't be swapped between the check and the push.
 */
async function pushJar(adb: Adb, serial: string, jar: Buffer, signal: AbortSignal): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-scrcpy-'));
  try {
    const copy = path.join(dir, SCRCPY_JAR_NAME);
    await writeFile(copy, jar, { mode: 0o600 });
    // Spawned rather than exec'd: stop() aborts a slow push by killing it.
    await execBinary(adb, ['-s', serial, 'push', copy, DEVICE_JAR_PATH], {
      timeoutMs: PUSH_TIMEOUT_MS,
      maxBytes: PUSH_OUTPUT_BYTES,
      signal,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A random 31-bit session id as the server expects it (8 hex digits, never negative). */
export function randomScid(): string {
  return randomInt(0, 0x8000_0000).toString(16).padStart(8, '0');
}

const SCID_PATTERN = /^[0-9a-f]{8}$/;
/**
 * Seconds between key frames (scrcpy's default is 10): a dashboard that lost one recovers within this time even
 * without asking. `video_codec_options` is `key[:type]=value` (CodecOption.parse), applied after the default.
 */
export const KEY_FRAME_INTERVAL_S = 2;
/** max_size is a u16 in the scrcpy client. */
const MAX_SIZE_LIMIT = 0xffff;

/**
 * The `adb shell` arguments that start the server. Built from presets only: `scid` is generated here and
 * `maxSize` computed from the size preset, both validated, so nothing from a client reaches the device shell.
 */
export function scrcpyServerArgs(scid: string, maxSize: number): string[] {
  if (!SCID_PATTERN.test(scid)) throw new Error(`invalid scid ${scid}`);
  if (!Number.isInteger(maxSize) || maxSize < 0 || maxSize > MAX_SIZE_LIMIT) {
    throw new Error(`invalid max_size ${maxSize}`);
  }
  return [
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_VERSION,
    `scid=${scid}`,
    'log_level=info',
    'tunnel_forward=true',
    'audio=false',
    'control=true',
    'video_codec=h264',
    `max_size=${maxSize}`,
    'max_fps=60',
    `video_codec_options=i-frame-interval:int=${KEY_FRAME_INTERVAL_S}`,
    'clipboard_autosync=true',
    // Keeps the screen on while plugged in (stay_on_while_plugged_in); the server's cleanup restores it on exit.
    'stay_awake=true',
    'cleanup=true',
  ];
}

export interface Size {
  width: number;
  height: number;
}

/** `wm size`: the override size when set (that is what is shown), else the physical size; natural orientation. */
export function parseWmSize(output: string): Size | null {
  const sizes = new Map<string, Size>();
  for (const match of output.matchAll(/^\s*(Physical|Override) size:\s*(\d+)x(\d+)\s*$/gm)) {
    const [, kind = '', width = '0', height = '0'] = match;
    sizes.set(kind, { width: Number(width), height: Number(height) });
  }
  const size = sizes.get('Override') ?? sizes.get('Physical');
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/**
 * scrcpy's `max_size` (the long edge) for a short-edge size preset on a display of this size; never larger than
 * the display. The server aligns the result to the encoder (e.g. 1220×2712 at 540 gives a 536×1200 video).
 */
export function maxSizeFor(display: Size, shortEdge: number): number {
  const short = Math.min(display.width, display.height);
  const long = Math.max(display.width, display.height);
  if (shortEdge >= short) return Math.min(long, MAX_SIZE_LIMIT);
  return Math.min(Math.round((long * shortEdge) / short), MAX_SIZE_LIMIT);
}

/** A Java exception line of a stack trace (`java.lang.SecurityException: …`). */
const EXCEPTION_LINE = /^[\w$.]+(?:Exception|Error)\b/;

/** Control (Cc) and format (Cf) characters, removed from anything shown in the dashboard. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * What went wrong according to the server's stderr: its ERROR lines (without the `[server] ERROR: ` prefix and
 * stack traces), else the last line; sanitised and capped. null without output.
 */
export function summarizeStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(UNPRINTABLE, '').trim())
    .filter((line) => line !== '');
  // Each ERROR line, with the exception that follows it (`java.lang.NullPointerException: …`), if any.
  const errors = lines.flatMap((line, index) => {
    const match = /^\[server\] ERROR: (.*)$/.exec(line);
    if (!match?.[1]) return [];
    const next = lines[index + 1] ?? '';
    return [EXCEPTION_LINE.test(next) ? `${match[1]}: ${next}` : match[1]];
  });
  const summary = errors.length > 0 ? errors.join(' ') : lines.at(-1);
  if (!summary) return null;
  return summary.length > MAX_ERROR_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_ERROR_SUMMARY_CHARS - 1)}…`
    : summary;
}

/** The connected server: video socket (paused, `leftover` holds bytes read past the dummy byte) and control. */
export interface ScrcpyConnection {
  video: Socket;
  control: Socket;
  leftover: Buffer;
}

export interface ScrcpyServerOptions {
  adb: Adb;
  serial: string;
  maxSize: number;
  jarPath: string;
  /** Every chunk of the server's stderr, as it arrives. Its stdout (INFO lines) is dropped. */
  onStderr?: (text: string) => void;
  /** The `adb shell` running the server exited (the server ended, crashed, or the device went away). */
  onExit?: () => void;
}

/** Starts are serialised per device: one server's cleanup deletes the jar another one may have just pushed. */
const startLocks = new Map<string, Promise<unknown>>();

function withStartLock<T>(serial: string, operation: () => Promise<T>): Promise<T> {
  const previous = startLocks.get(serial) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.catch(() => undefined);
  startLocks.set(serial, settled);
  void settled.then(() => {
    if (startLocks.get(serial) === settled) startLocks.delete(serial);
  });
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One scrcpy-server on a device: push (checksum verified), `adb forward` to its abstract socket, `app_process`
 * through `adb shell` (argument arrays only), then the video and control sockets. stop() releases everything on
 * every path: sockets, the forward, and the device process (killed by its scid if it does not exit by itself).
 */
export class ScrcpyServer {
  readonly scid = randomScid();
  /** Aborted by stop(): kills a push in flight. */
  private readonly abort = new AbortController();
  private child: ChildProcessLike | null = null;
  private exited = false;
  private readonly exitWaiters = new Set<() => void>();
  private forwardPort: number | null = null;
  private readonly sockets = new Set<Socket>();
  private connected = false;
  private stopping: Promise<void> | null = null;
  /** The start in progress (or done): stop() waits for it, so the cleanup sees what it set up. */
  private running: Promise<unknown> = Promise.resolve();
  private stderrTail = '';

  constructor(private readonly options: ScrcpyServerOptions) {}

  get isStopped(): boolean {
    return this.stopping !== null;
  }

  /** The server's stderr so far (the last STDERR_KEPT_BYTES), summarised. */
  get errorSummary(): string | null {
    return summarizeStderr(this.stderrTail);
  }

  /** Resolves when the server is connected; throws MirrorStartError (or a stop() during start). */
  start(): Promise<ScrcpyConnection> {
    const result = withStartLock(this.options.serial, () => this.run());
    this.running = result.catch(() => undefined);
    return result;
  }

  /** Idempotent; resolves once the device side is cleaned up. */
  stop(): Promise<void> {
    this.stopping ??= this.cleanup();
    return this.stopping;
  }

  private checkStopped(): void {
    if (this.stopping) throw new MirrorStartError('mirroring stopped');
  }

  private async run(): Promise<ScrcpyConnection> {
    const { adb, serial } = this.options;
    this.checkStopped();
    const jar = await readVerifiedJar(this.options.jarPath);
    this.checkStopped();
    try {
      await pushJar(adb, serial, jar, this.abort.signal);
    } catch (error) {
      log.warn(`Pushing the scrcpy server to ${serial} failed: ${errorMessage(error)}`);
      throw new MirrorStartError('Could not copy the mirroring server (scrcpy) to the device');
    }
    this.checkStopped();
    const socketName = `localabstract:scrcpy_${this.scid}`;
    try {
      // tcp:0 lets adb pick a free port and print it.
      const output = await adb.exec(['-s', serial, 'forward', 'tcp:0', socketName], {
        timeoutMs: ADB_TIMEOUT_MS,
      });
      const port = Number(output.trim());
      if (!Number.isInteger(port) || port <= 0 || port > 65535)
        throw new Error(`unexpected output "${output}"`);
      this.forwardPort = port;
    } catch (error) {
      log.warn(`adb forward for ${serial} failed: ${errorMessage(error)}`);
      throw new MirrorStartError('Could not open a connection to the device (adb forward failed)');
    }
    this.checkStopped();
    this.spawnServer();
    const { socket: video, leftover } = await this.connectVideo(this.forwardPort);
    const control = await this.connectControl(this.forwardPort);
    this.connected = true;
    // Like scrcpy: the tunnel is not needed once both sockets are connected.
    await this.removeForward();
    this.checkStopped();
    return { video, control, leftover };
  }

  private spawnServer(): void {
    const { adb, serial, maxSize } = this.options;
    const child = adb.spawn(['-s', serial, 'shell', ...scrcpyServerArgs(this.scid, maxSize)]);
    this.child = child;
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    let partial = '';
    let afterError = false;
    child.stderr?.on('data', (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_KEPT_BYTES);
      this.options.onStderr?.(text);
      // The server's errors (and the exception after each) go to our log too, sanitised. Its WARN and INFO lines
      // do not: they may name typed characters.
      const lines = (partial + text).split(/\r?\n/);
      partial = (lines.pop() ?? '').slice(-STDERR_KEPT_BYTES);
      for (const raw of lines) {
        const line = raw.replace(UNPRINTABLE, '').trim().slice(0, MAX_ERROR_SUMMARY_CHARS);
        const isError = line.startsWith('[server] ERROR:');
        if (isError || (afterError && EXCEPTION_LINE.test(line))) log.warn(`scrcpy on ${serial}: ${line}`);
        afterError = isError;
      }
    });
    const onExit = () => {
      if (this.exited) return;
      this.exited = true;
      for (const waiter of this.exitWaiters) waiter();
      this.exitWaiters.clear();
      this.options.onExit?.();
    };
    child.on('exit', onExit);
    child.on('error', (error) => {
      log.warn(`scrcpy server on ${serial}: ${error.message}`);
      onExit();
    });
  }

  private failure(): MirrorStartError {
    const summary = this.errorSummary;
    return new MirrorStartError(
      summary ? `scrcpy could not start: ${summary}` : 'scrcpy did not start on the device',
    );
  }

  /** Connect and read the dummy byte: adb accepts the connection even before the server listens. */
  private async connectVideo(port: number): Promise<{ socket: Socket; leftover: Buffer }> {
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      this.checkStopped();
      if (this.exited) throw this.failure();
      const result = await this.tryConnect(port);
      if (result) return result;
      await delay(CONNECT_RETRY_MS);
    }
    throw this.failure();
  }

  private tryConnect(port: number): Promise<{ socket: Socket; leftover: Buffer } | null> {
    return new Promise((resolve) => {
      const socket = this.track(connect(port, '127.0.0.1'));
      const done = (result: { socket: Socket; leftover: Buffer } | null) => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('close', onClose);
        if (!result) socket.destroy();
        resolve(result);
      };
      const onData = (chunk: Buffer) => {
        socket.pause();
        done(chunk[0] === 0 ? { socket, leftover: chunk.subarray(1) } : null);
      };
      const onClose = () => done(null);
      const timer = setTimeout(() => done(null), CONNECT_ATTEMPT_TIMEOUT_MS);
      socket.on('data', onData);
      socket.on('close', onClose);
      socket.on('error', () => undefined);
    });
  }

  private connectControl(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.track(connect(port, '127.0.0.1'));
      socket.setNoDelay(true);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        resolve(socket);
      });
      socket.once('error', () => reject(this.failure()));
      socket.once('close', () => reject(this.failure()));
      socket.on('error', () => undefined);
    });
  }

  private track(socket: Socket): Socket {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    // A connection attempt racing stop() is dropped at once.
    if (this.stopping) socket.destroy();
    return socket;
  }

  private async removeForward(): Promise<void> {
    const port = this.forwardPort;
    if (port === null) return;
    this.forwardPort = null;
    try {
      await this.options.adb.exec(['-s', this.options.serial, 'forward', '--remove', `tcp:${port}`], {
        timeoutMs: ADB_TIMEOUT_MS,
      });
    } catch (error) {
      log.warn(`Removing the adb forward for ${this.options.serial} failed: ${errorMessage(error)}`);
    }
  }

  /** Resolves true once the `adb shell` running the server has exited, false after `timeoutMs`. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited || !this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.exitWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.exitWaiters.add(waiter);
    });
  }

  private async cleanup(): Promise<void> {
    // Unblock a start in progress (push, connection attempts), then clean up whatever it set up.
    this.abort.abort();
    if (!this.connected) for (const socket of this.sockets) socket.destroy();
    await this.running;
    // The control socket is ended, not destroyed: finger lifts written just before still go out.
    for (const socket of this.sockets) {
      if (this.connected && socket.writable) socket.end();
      else socket.destroy();
    }
    const forward = this.removeForward();
    // A connected server exits when its sockets close; one still starting up waits in accept() forever.
    const exited = await this.waitForExit(this.connected ? STOP_GRACE_MS : 0);
    for (const socket of this.sockets) socket.destroy();
    if (this.child && !exited) {
      this.child.kill();
      // Killing the local adb does not always end the device process: find it by its scid. The bracket keeps
      // the pattern from matching the shell that runs pkill.
      const pattern = `scid=[${this.scid.slice(0, 1)}]${this.scid.slice(1)}`;
      await adbShell(this.options.adb, this.options.serial, `pkill -f '${pattern}'`, {
        timeoutMs: ADB_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    await forward;
  }
}

/**
 * Our scrcpy servers on a device: `<pid> <ppid> <cmdline>` of every scrcpy Server process whose CLASSPATH is our
 * jar path (other scrcpy users push their own jar elsewhere). Ends with `true`: an empty list is no failure.
 */
export const LIST_LEFTOVERS_COMMAND =
  "for p in $(pgrep -f com.genymobile.scrcpy.Server); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | " +
  `grep -qx 'CLASSPATH=${DEVICE_JAR_PATH}' && echo "$p $(cut -d' ' -f4 /proc/$p/stat) ` +
  "$(tr '\\0' ' ' < /proc/$p/cmdline)\"; done; true";

export interface ScrcpyProcess {
  pid: number;
  ppid: number;
  scid: string;
}

export function parseScrcpyProcesses(output: string): ScrcpyProcess[] {
  return output.split('\n').flatMap((line) => {
    const match = /^(\d+) (\d+) .*\bcom\.genymobile\.scrcpy\.Server\b.*\bscid=([0-9a-f]{8})\b/.exec(
      line.trim(),
    );
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), scid: match[3] ?? '' }] : [];
  });
}

export interface ScrcpyForward {
  serial: string;
  local: string;
  scid: string;
}

/** `adb forward --list` lines that point at a scrcpy socket. */
export function parseScrcpyForwards(output: string): ScrcpyForward[] {
  return output.split('\n').flatMap((line) => {
    const match = /^(\S+) (tcp:\d+) localabstract:scrcpy_([0-9a-f]{8})$/.exec(line.trim());
    return match ? [{ serial: match[1] ?? '', local: match[2] ?? '', scid: match[3] ?? '' }] : [];
  });
}

/**
 * Best effort at startup: servers a previous Lionscope left behind (killed before its cleanup ran) on these
 * devices. A leftover is one of our servers that still has its `adb forward` (it never connected: a running
 * Lionscope removes the forward within a second of starting a server) or that lost its parent shell. Those
 * processes are killed and those forwards removed; other processes and forwards are never touched.
 */
export async function cleanupScrcpyLeftovers(adb: Adb, serials: readonly string[]): Promise<void> {
  if (serials.length === 0) return;
  let forwards: ScrcpyForward[] = [];
  try {
    forwards = parseScrcpyForwards(await adb.exec(['forward', '--list'], { timeoutMs: ADB_TIMEOUT_MS }));
  } catch (error) {
    log.warn(`Listing adb forwards failed: ${errorMessage(error)}`);
  }
  await Promise.all(
    serials.map(async (serial) => {
      try {
        const processes = parseScrcpyProcesses(
          await adbShell(adb, serial, LIST_LEFTOVERS_COMMAND, { timeoutMs: ADB_TIMEOUT_MS }),
        );
        const stale = forwards.filter(
          (forward) =>
            forward.serial === serial && processes.some((process) => process.scid === forward.scid),
        );
        const leftovers = processes.filter(
          (process) => process.ppid === 1 || stale.some((forward) => forward.scid === process.scid),
        );
        for (const forward of stale) {
          await adb.exec(['-s', serial, 'forward', '--remove', forward.local], { timeoutMs: ADB_TIMEOUT_MS });
        }
        if (leftovers.length === 0) return;
        await adbShell(adb, serial, `kill ${leftovers.map((process) => process.pid).join(' ')}`, {
          timeoutMs: ADB_TIMEOUT_MS,
        });
        log.info(`Stopped ${leftovers.length} scrcpy server(s) left behind on ${serial}`);
      } catch (error) {
        log.warn(`Cleaning up scrcpy leftovers on ${serial} failed: ${errorMessage(error)}`);
      }
    }),
  );
}

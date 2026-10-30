/**
 * The UI helper (android-sdk/ui-helper): a long-lived `uiautomator dump` that Lionscope runs on a device through
 * app_process. It keeps one UiAutomation connected and answers dump requests over the `adb shell`'s stdin and
 * stdout (never a socket), in a few hundred ms and without waiting for an animating screen to go idle.
 *
 * Per device: the checksum-verified jar is pushed under a fresh name (the helper deletes it once it runs, and
 * every stop removes it again), started, and its READY line awaited; requests are serialised, a crash is
 * restarted once, and an idle helper is stopped. Only one UiAutomation can be connected at a time, so after any
 * failure the helper is stopped (uiautomator could not run beside it) and not tried again for a while.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbShell, execBinary } from '../adb/adb.ts';
import type { Adb, ChildProcessLike } from '../adb/adb.ts';
import { IS_BUNDLE } from '../config.ts';
import { errorMessage, log } from '../log.ts';
import { UI_HELPER_JAR_NAME, UI_HELPER_JAR_SHA256, UI_HELPER_PROTOCOL } from './uiHelperJar.ts';
import { MAX_UI_XML_BYTES } from './uiXml.ts';

export const UI_HELPER_MAIN = 'io.github.risyadul.lionscope.uihelper.UiHelper';
/**
 * An idle helper is stopped after this long. While it runs, no other UiAutomation (Appium, …) can connect, and
 * every app sees accessibility as enabled (AccessibilityManager.isEnabled()), which can change how it behaves.
 */
export const UI_HELPER_IDLE_MS = 20_000;
/** Below this, connecting would suppress the accessibility services (TalkBack): uiautomator is used instead. */
export const UI_HELPER_MIN_API = 24;
/** After a failure the helper is not tried again on that device for this long (uiautomator is used). */
export const UI_HELPER_BACKOFF_MS = 30_000;
/** Push, start and connect. */
export const UI_HELPER_START_MS = 10_000;
/** After `exit` and the end of stdin, how long the helper gets to exit by itself before it is killed. */
export const UI_HELPER_STOP_GRACE_MS = 1000;
const PUSH_TIMEOUT_MS = 30_000;
const PUSH_OUTPUT_BYTES = 64 * 1024;
const ADB_TIMEOUT_MS = 5000;
/** A response line longer than this cannot be a dump the parser would accept. */
const MAX_LINE_CHARS = MAX_UI_XML_BYTES + 1024;

/** Why the helper gave no dump (no app data in it); the dump then falls back to uiautomator. */
export class UiHelperError extends Error {
  override name = 'UiHelperError';
}

/** The helper process ended while it was needed: worth one restart. */
class UiHelperCrash extends UiHelperError {}

export const HELPER_BUSY = 'another UI automation (Appium, a uiautomator test or dump) is connected';
export const HELPER_CONNECT = 'it could not connect to the accessibility service';
export const HELPER_NO_START = 'it did not start';
export const HELPER_CRASHED = 'it stopped unexpectedly';
export const HELPER_TIMEOUT = 'it did not answer in time';
export const HELPER_FAILED = 'it could not read the screen';
export const HELPER_TOO_LARGE = 'its dump was too large';
export const HELPER_NO_PUSH = 'it could not be copied to the device';
export const HELPER_BAD_JAR = `${UI_HELPER_JAR_NAME} is missing or does not match its SHA-256 checksum`;
export const HELPER_CLOSED = 'Lionscope is shutting down';
export const HELPER_OLD_API = `it needs Android 7.0 (API ${UI_HELPER_MIN_API}) or later`;

export function resolveUiHelperJar(
  moduleUrl: string = import.meta.url,
  bundled: boolean = IS_BUNDLE,
): string {
  return fileURLToPath(
    new URL(bundled ? `./${UI_HELPER_JAR_NAME}` : `../../vendor/${UI_HELPER_JAR_NAME}`, moduleUrl),
  );
}

/** The jar's bytes, only if they match `expectedSha256`. */
export async function readVerifiedHelperJar(jarPath: string, expectedSha256: string): Promise<Buffer> {
  let jar: Buffer;
  try {
    jar = await readFile(jarPath);
  } catch (error) {
    log.warn(`Cannot read the UI helper: ${errorMessage(error)}`);
    throw new UiHelperError(HELPER_BAD_JAR);
  }
  if (createHash('sha256').update(jar).digest('hex') !== expectedSha256)
    throw new UiHelperError(HELPER_BAD_JAR);
  return jar;
}

/** A dump's XML, or null when the screen has no active window (uiautomator's "null root node"). */
export type HelperDump = { xml: string } | null;

export interface UiHelperOptions {
  adb: Adb;
  /** Defaults to the vendored jar (resolveUiHelperJar). */
  jarPath?: string;
  /** Tests pass the checksum of their fixture. */
  jarSha256?: string;
  idleMs?: number;
  backoffMs?: number;
  startMs?: number;
}

interface Pending {
  nonce: string;
  resolve: (line: string) => void;
  reject: (error: UiHelperError) => void;
}

/** One running helper on one device. */
class HelperProcess {
  readonly token = randomBytes(6).toString('hex');
  readonly devicePath = `/data/local/tmp/lionscope-ui-helper-v${UI_HELPER_PROTOCOL}-${this.token}.jar`;
  private child: ChildProcessLike | null = null;
  private exited = false;
  private readonly exitWaiters = new Set<() => void>();
  private buffer = '';
  /** The READY line, then each response. */
  private pending: Pending | null = null;
  private ready: Pending | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly adb: Adb,
    readonly serial: string,
  ) {}

  get stopped(): boolean {
    return this.stopping !== null;
  }

  get alive(): boolean {
    return this.child !== null && !this.exited && this.stopping === null;
  }

  async start(jar: Buffer, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    await this.push(jar, timeoutMs);
    // Stopped (the server is closing) while the jar was on its way: nothing is started.
    if (this.stopping) throw new UiHelperError(HELPER_CLOSED);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new UiHelperError(HELPER_TIMEOUT);
    // The token is an argument only so that stop() can find the process (pkill -f); the helper ignores it.
    const child = this.adb.spawn([
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=${this.devicePath}`,
      'app_process',
      '/',
      UI_HELPER_MAIN,
      this.token,
    ]);
    this.child = child;
    // A write after the device went away (unplugged, `adb kill-server`) fails with EPIPE; unhandled, that error
    // would end the whole server. Any stream failing counts as the helper exiting.
    const onStreamError = (error: Error) => {
      log.warn(`UI helper on ${this.serial}: ${error.message}`);
      child.kill();
      this.onExit();
    };
    child.stdin?.on('error', onStreamError);
    child.stdout?.on('error', onStreamError);
    child.stderr?.on('error', onStreamError);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => this.onData(text));
    child.stderr?.resume();
    child.on('exit', () => this.onExit());
    child.on('error', (error) => {
      log.warn(`UI helper on ${this.serial}: ${error.message}`);
      this.onExit();
    });
    const line = await this.awaitLine(null, remaining);
    if (line === `READY ${UI_HELPER_PROTOCOL}`) return;
    throw new UiHelperError(
      line === 'ERR - busy' ? HELPER_BUSY : line === 'ERR - connect' ? HELPER_CONNECT : HELPER_NO_START,
    );
  }

  /** `adb push` of exactly these bytes, from a private temporary copy (mkdtemp is 0700). */
  private async push(jar: Buffer, timeoutMs: number): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-ui-helper-'));
    try {
      const copy = path.join(dir, UI_HELPER_JAR_NAME);
      await writeFile(copy, jar, { mode: 0o600 });
      await execBinary(this.adb, ['-s', this.serial, 'push', copy, this.devicePath], {
        timeoutMs: Math.max(1, Math.min(PUSH_TIMEOUT_MS, Math.floor(timeoutMs))),
        maxBytes: PUSH_OUTPUT_BYTES,
      });
    } catch (error) {
      log.warn(`Pushing the UI helper to ${this.serial} failed: ${errorMessage(error)}`);
      throw new UiHelperError(HELPER_NO_PUSH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The dump, or null for no active window; throws UiHelperError (UiHelperCrash when the process ended). */
  async dump(timeoutMs: number): Promise<HelperDump> {
    const nonce = randomBytes(8).toString('hex');
    const line = await this.awaitLine(nonce, timeoutMs, `dump ${nonce}\n`);
    const ok = `OK ${nonce} `;
    if (line.startsWith(ok)) return { xml: line.slice(ok.length) };
    if (line === `ERR ${nonce} no-root`) return null;
    throw new UiHelperError(HELPER_FAILED);
  }

  /** The next line answering `nonce` (null: the READY line), after writing `request`. */
  private awaitLine(nonce: string | null, timeoutMs: number, request?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.alive) {
        reject(new UiHelperCrash(HELPER_CRASHED));
        return;
      }
      const timer = setTimeout(
        () => {
          settle();
          reject(new UiHelperError(HELPER_TIMEOUT));
        },
        Math.max(0, timeoutMs),
      );
      const settle = () => {
        clearTimeout(timer);
        if (nonce === null) this.ready = null;
        else this.pending = null;
      };
      const waiter: Pending = {
        nonce: nonce ?? '',
        resolve: (line) => {
          settle();
          resolve(line);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      if (nonce === null) this.ready = waiter;
      else this.pending = waiter;
      if (request !== undefined) this.child?.stdin?.write(request);
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      // A PTY shell (API < 24) writes \r\n, and echoes the requests: lines that answer nothing are dropped.
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = '';
      this.pending?.reject(new UiHelperError(HELPER_TOO_LARGE));
      void this.stop();
    }
  }

  private onLine(line: string): void {
    if (this.ready && (line.startsWith('READY ') || line.startsWith('ERR - '))) {
      this.ready.resolve(line);
      return;
    }
    const pending = this.pending;
    if (pending && (line.startsWith(`OK ${pending.nonce} `) || line.startsWith(`ERR ${pending.nonce} `))) {
      pending.resolve(line);
    }
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.ready?.reject(new UiHelperCrash(HELPER_NO_START));
    this.pending?.reject(new UiHelperCrash(HELPER_CRASHED));
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters.clear();
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
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

  /** Idempotent: `exit`, then a kill (also on the device, by token) if needed, and the jar removed. */
  stop(): Promise<void> {
    this.stopping ??= this.cleanup();
    return this.stopping;
  }

  private async cleanup(): Promise<void> {
    const child = this.child;
    if (child && !this.exited) {
      child.stdin?.write('exit\n');
      child.stdin?.end();
      if (!(await this.waitForExit(UI_HELPER_STOP_GRACE_MS))) {
        child.kill();
        // Killing the local adb does not always end the device process. The bracket keeps the pattern from
        // matching the shell that runs pkill.
        const pattern = `${UI_HELPER_MAIN} [${this.token.slice(0, 1)}]${this.token.slice(1)}`;
        await adbShell(this.adb, this.serial, `pkill -f '${pattern}'`, { timeoutMs: ADB_TIMEOUT_MS }).catch(
          () => undefined,
        );
      }
    }
    await adbShell(this.adb, this.serial, `rm -f ${this.devicePath}`, { timeoutMs: ADB_TIMEOUT_MS }).catch(
      () => undefined,
    );
  }
}

/** The helpers of every device this server dumps. */
export class UiHelpers {
  private readonly helpers = new Map<string, HelperProcess>();
  /** Per device, the requests in turn. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly backoff = new Map<string, { until: number; reason: string }>();
  /** Per device, its API level (ro.build.version.sdk), once read. */
  private readonly apiLevels = new Map<string, number>();
  private closed = false;

  constructor(private readonly options: UiHelperOptions) {}

  /** Why the helper is not used on this device right now, or null when it is. */
  unavailable(serial: string): string | null {
    if (this.closed) return HELPER_CLOSED;
    const api = this.apiLevels.get(serial);
    if (api !== undefined && api < UI_HELPER_MIN_API) return HELPER_OLD_API;
    const entry = this.backoff.get(serial);
    if (!entry) return null;
    if (performance.now() < entry.until) return entry.reason;
    this.backoff.delete(serial);
    return null;
  }

  /** A helper is running on this device: a dump does not have to start one first. */
  isRunning(serial: string): boolean {
    return this.helpers.get(serial)?.alive === true;
  }

  /** The device's API level (ro.build.version.sdk), read once; null when getprop gave none in `timeoutMs`. */
  async apiLevel(serial: string, timeoutMs: number): Promise<number | null> {
    if (!this.apiLevels.has(serial)) await this.readApiLevel(serial, timeoutMs);
    return this.apiLevels.get(serial) ?? null;
  }

  /** A dump within `timeoutMs`; throws UiHelperError, after which the helper on that device is stopped. */
  dump(serial: string, timeoutMs: number): Promise<HelperDump> {
    return this.serialized(serial, async () => {
      const deadline = performance.now() + timeoutMs;
      if (!this.apiLevels.has(serial)) await this.readApiLevel(serial, timeoutMs);
      const reason = this.unavailable(serial);
      if (reason !== null) throw new UiHelperError(reason);
      this.clearIdle(serial);
      try {
        for (let attempt = 0; ; attempt++) {
          const helper = await this.running(serial, deadline);
          try {
            return await helper.dump(deadline - performance.now());
          } catch (error) {
            // A crash is restarted once, time permitting (never once the server is closing).
            const retry =
              error instanceof UiHelperCrash &&
              attempt === 0 &&
              !this.closed &&
              deadline - performance.now() >= 1000;
            if (!retry) throw error;
            log.warn(`UI helper on ${serial} stopped; starting it again`);
            await this.stopHelper(serial);
          }
        }
      } catch (error) {
        const reason = error instanceof UiHelperError ? error.message : HELPER_FAILED;
        if (!(error instanceof UiHelperError)) log.warn(`UI helper on ${serial}: ${errorMessage(error)}`);
        if (!this.closed && reason !== HELPER_OLD_API) {
          log.warn(`UI helper on ${serial} not used for now: ${reason}`);
          this.backoff.set(serial, {
            until: performance.now() + (this.options.backoffMs ?? UI_HELPER_BACKOFF_MS),
            reason,
          });
        }
        await this.stopHelper(serial);
        throw new UiHelperError(reason);
      } finally {
        if (this.helpers.has(serial)) this.armIdle(serial);
      }
    });
  }

  /** Stops every helper and removes their jars; later dumps go to uiautomator. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await Promise.all([...this.helpers.keys()].map((serial) => this.stopHelper(serial)));
  }

  /** Unread (no failure counted) when getprop fails: it is asked again next time. */
  private async readApiLevel(serial: string, timeoutMs: number): Promise<void> {
    try {
      const output = await adbShell(this.options.adb, serial, 'getprop ro.build.version.sdk', {
        timeoutMs: Math.max(1, Math.min(ADB_TIMEOUT_MS, Math.floor(timeoutMs))),
      });
      const api = Number(output.trim());
      if (Number.isInteger(api) && api > 0) this.apiLevels.set(serial, api);
    } catch (error) {
      log.warn(`Reading the API level of ${serial} failed: ${errorMessage(error)}`);
    }
  }

  private async running(serial: string, deadline: number): Promise<HelperProcess> {
    if (this.closed) throw new UiHelperError(HELPER_CLOSED);
    const current = this.helpers.get(serial);
    if (current?.alive) return current;
    if (current) await this.stopHelper(serial);
    const jar = await readVerifiedHelperJar(
      this.options.jarPath ?? resolveUiHelperJar(),
      this.options.jarSha256 ?? UI_HELPER_JAR_SHA256,
    );
    if (this.closed) throw new UiHelperError(HELPER_CLOSED);
    const helper = new HelperProcess(this.options.adb, serial);
    this.helpers.set(serial, helper);
    const timeoutMs = Math.min(this.options.startMs ?? UI_HELPER_START_MS, deadline - performance.now());
    await helper.start(jar, timeoutMs);
    // close() stopped it meanwhile.
    if (helper.stopped) throw new UiHelperError(HELPER_CLOSED);
    return helper;
  }

  private async stopHelper(serial: string): Promise<void> {
    const helper = this.helpers.get(serial);
    if (!helper) return;
    this.helpers.delete(serial);
    this.clearIdle(serial);
    await helper.stop();
  }

  private armIdle(serial: string): void {
    this.clearIdle(serial);
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(serial);
      void this.serialized(serial, () => this.stopHelper(serial));
    }, this.options.idleMs ?? UI_HELPER_IDLE_MS);
    timer.unref();
    this.idleTimers.set(serial, timer);
  }

  private clearIdle(serial: string): void {
    const timer = this.idleTimers.get(serial);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(serial);
  }

  private serialized<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.catch(() => undefined);
    this.queues.set(serial, settled);
    void settled.then(() => {
      if (this.queues.get(serial) === settled) this.queues.delete(serial);
    });
    return result;
  }
}

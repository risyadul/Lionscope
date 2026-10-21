import { randomBytes } from 'node:crypto';
import type { ChildProcessLike } from './adb.ts';

export const DEFAULT_SHELL_TIMEOUT_MS = 5_000;
/** Guard against a runaway command filling memory while we wait for the marker. */
const MAX_PENDING_OUTPUT_CHARS = 32 * 1024 * 1024;
/** Commands waiting behind the running one; more are rejected (callers poll, they don't need a backlog). */
export const MAX_QUEUED_COMMANDS = 32;

interface PendingCommand {
  id: number;
  command: string;
  timeoutMs: number;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

/** Longest possible marker (`\r\n__LS_<16 hex>_<id>__\r\n`) — bounds how far back a search must start. */
const MARKER_SEARCH_OVERLAP = 64;

/**
 * A persistent `adb -s <serial> shell` process that runs one command at a time (FIFO).
 *
 * Each command is followed by `printf` of an end marker made of a random per-session nonce and the
 * command id; output is everything before the marker. The literal marker never appears in the
 * command text (printf builds it from `%s`), so an echoing shell cannot confuse the framing, and
 * the nonce keeps command output from forging it. `\r\n` line endings (PTY shells on API < 24)
 * are accepted around the marker. stderr is merged into stdout on the device side.
 * On timeout or process exit the in-flight and queued commands are rejected and the process is
 * respawned lazily on the next `run`.
 */
export class ShellSession {
  private child: ChildProcessLike | null = null;
  private readonly queue: PendingCommand[] = [];
  private current: PendingCommand | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly nonce = randomBytes(8).toString('hex');
  private markerPattern: RegExp | null = null;
  private searchFrom = 0;

  constructor(private readonly spawnShell: () => ChildProcessLike) {}

  run(command: string, timeoutMs = DEFAULT_SHELL_TIMEOUT_MS): Promise<string> {
    if (this.closed) return Promise.reject(new Error('shell session closed'));
    if (this.queue.length >= MAX_QUEUED_COMMANDS) {
      return Promise.reject(new Error(`adb shell queue full (${MAX_QUEUED_COMMANDS} commands waiting)`));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, command, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('shell session closed'));
    this.killChild();
  }

  private pump(): void {
    if (this.current || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;

    const child = this.ensureChild();
    if (!child) {
      next.reject(new Error('failed to start adb shell'));
      this.pump();
      return;
    }
    this.current = next;
    this.buffer = '';
    this.searchFrom = 0;
    this.markerPattern = new RegExp(`\\r?\\n__LS_${this.nonce}_${next.id}__\\r?\\n`, 'g');
    this.timer = setTimeout(() => this.onTimeout(next), next.timeoutMs);
    child.stdin?.write(`${next.command}\nprintf '\\n__LS_${this.nonce}_%s__\\n' ${next.id}\n`);
  }

  private ensureChild(): ChildProcessLike | null {
    if (this.child) return this.child;
    let child: ChildProcessLike;
    try {
      child = this.spawnShell();
    } catch {
      return null;
    }
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (this.child === child) this.onData(chunk);
    });
    // Device-side stderr is merged into stdout (`exec 2>&1`); what arrives here comes from adb
    // itself (e.g. "device offline") and is only used to explain an exit.
    let hostError = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      hostError = (hostError + String(chunk)).slice(-1000);
    });
    child.stdin?.on('error', () => {
      // EPIPE when the process dies; the 'exit' handler takes care of pending commands.
    });
    const onGone = (reason: string): void => {
      if (this.child !== child) return;
      this.child = null;
      const detail = hostError.trim();
      this.failAll(new Error(detail ? `${reason}: ${detail}` : reason));
    };
    child.on('exit', (code, signal) =>
      onGone(`adb shell exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`),
    );
    child.on('error', (error) => onGone(`adb shell error: ${error.message}`));
    child.stdin?.write('exec 2>&1\n');
    return child;
  }

  private onData(chunk: string): void {
    const current = this.current;
    const pattern = this.markerPattern;
    if (!current || !pattern) return;
    this.buffer += chunk;
    pattern.lastIndex = this.searchFrom;
    const match = pattern.exec(this.buffer);
    if (!match) {
      this.searchFrom = Math.max(0, this.buffer.length - MARKER_SEARCH_OVERLAP);
      if (this.buffer.length > MAX_PENDING_OUTPUT_CHARS) {
        this.abortCurrent(new Error(`output of "${current.command}" exceeded limit`));
      }
      return;
    }
    const output = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length);
    this.finishCurrent();
    current.resolve(output);
    this.pump();
  }

  private onTimeout(command: PendingCommand): void {
    if (this.current !== command) return;
    this.abortCurrent(
      new Error(`adb shell command timed out after ${command.timeoutMs} ms: ${command.command}`),
    );
  }

  /** Reject the in-flight command and drop the process (its output stream is now out of sync). */
  private abortCurrent(error: Error): void {
    const current = this.current;
    this.finishCurrent();
    current?.reject(error);
    this.killChild();
    this.pump();
  }

  private finishCurrent(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.markerPattern = null;
  }

  private failAll(error: Error): void {
    const pending = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.finishCurrent();
    this.queue.length = 0;
    this.buffer = '';
    for (const command of pending) command.reject(error);
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin?.end();
    child.kill();
  }
}

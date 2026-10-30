import type { LogEntry } from '@lionscope/protocol';
import { redactLogText } from '@lionscope/protocol/insights';

/**
 * A crash of the session's app, read from logcat's `crash` buffer and kept apart from the log buffer, which a chatty
 * app turns over in under a minute. Its texts are stored redacted (redactLogText) and cut to MAX_CRASH_LINE_CHARS.
 */
export interface AppCrash {
  /** Laptop clock, like LogEntry.ts: the `FATAL EXCEPTION` line, or crash_dump's report of a native crash. */
  ts: number;
  /** The crashed process and thread. */
  pid: number;
  tid: number;
  /** `java`: an uncaught exception (AndroidRuntime); `native`: a fatal signal (crash_dump's `DEBUG` report). */
  kind: 'java' | 'native';
  /** `main` from `FATAL EXCEPTION: main`, or the thread named in `pid: 1234, tid: 1250, name: RenderThread`. */
  thread: string | null;
  /** `com.example.shop`, or `com.example.shop:remote`. */
  process: string;
  /** The exception class (`java.lang.IllegalStateException`) or the signal (`SIGSEGV`). */
  exception: string | null;
  /** The exception's message; a native crash's abort message, else its `signal …` line. */
  message: string | null;
  /**
   * The lines after the exception line as logged (`at …` frames, `Caused by: …`, `... 12 more`), or a native
   * crash's `Cause: …` line and backtrace (`#00 pc …`). Every line that is not a frame is kept; past MAX_CRASH_FRAMES_PER_CAUSE frames of one
   * exception, a `… N more frames` line counts the rest.
   */
  stack: string[];
  /** Lines past MAX_CRASH_STACK_LINES, not kept. */
  droppedLines: number;
}

export const MAX_CRASHES = 50;
/** Frames kept per exception of a chain (and of a native backtrace). */
export const MAX_CRASH_FRAMES_PER_CAUSE = 30;
/** Lines kept per crash in all (a chain of hundreds of `Caused by` / `Suppressed`). */
export const MAX_CRASH_STACK_LINES = 400;
/** The count line that stands for frames past MAX_CRASH_FRAMES_PER_CAUSE. */
export const MORE_FRAMES = /^… (\d+) more frames$/;
/** `at …` (Java) or `#00 pc …` (native), after any indentation. */
export const FRAME_LINE = /^\s*(?:at |#\d+ pc )/;
/** Characters kept per text, after redaction (a 4000-character exception message, a long frame). */
export const MAX_CRASH_LINE_CHARS = 500;
/**
 * A Java crash is one log record that logcat prints line by line (all with the same timestamp); a line of the same
 * thread more than this long after the previous one is not part of it. crash_dump logs a native report as it goes,
 * and before Android 12 it unwinds before printing `backtrace:`: its lines get longer.
 */
const CRASH_LINE_GAP_MS: Readonly<Record<AppCrash['kind'], number>> = { java: 1000, native: 5000 };
/** Crash reports being read at once (each thread that crashes, each crash_dump). */
const MAX_OPEN_BLOCKS = 16;

const FATAL_EXCEPTION = /^FATAL EXCEPTION: (.*)$/;
/** `Process: com.example.shop, PID: 1234`; just `PID: 1234` before the process has a name. */
const PROCESS_LINE = /^(?:Process: (.*), )?PID: \d+$/;
/** `java.lang.IllegalStateException: message`, `kotlin.KotlinNullPointerException`. */
const EXCEPTION_LINE = /^([A-Za-z_$][\w$]*(?:\.[\w$]+)+)(?::\s?([\s\S]*))?$/;
const TOMBSTONE_START = /^\*\*\* \*\*\* \*\*\*/;
/** `pid: 1234, tid: 1250, name: RenderThread  >>> com.example.shop <<<`. */
const TOMBSTONE_PROCESS = /^pid: (\d+), tid: (\d+), name: (.*?) +>>> (.*) <<<$/;
const TOMBSTONE_SIGNAL = /^signal \d+ \((\w+)\)/;
const ABORT_MESSAGE = /^Abort message: '([\s\S]*)'$/;
/** `Cause: null pointer dereference`, after a native crash's signal line. */
const NATIVE_CAUSE = /^Cause: /;

/** A crash text as stored: redacted before it is cut, so the cut can't keep half a token. */
function storedText(text: string): string {
  const redacted = redactLogText(text);
  return redacted.length <= MAX_CRASH_LINE_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_CRASH_LINE_CHARS)}… (${redacted.length - MAX_CRASH_LINE_CHARS} more chars)`;
}

interface OpenBlock {
  kind: AppCrash['kind'];
  ts: number;
  lastTs: number;
  /** `FATAL EXCEPTION: <thread>`. */
  thread: string | null;
  /** Filled once the process line names the session's app. */
  crash: AppCrash | null;
  /** Another app's crash, an unnamed process or one already recorded: its lines are passed over. */
  skipped: boolean;
  /** Java: the exception line was read. Native: inside `backtrace:`. */
  inStack: boolean;
  /** Frames of the current exception, and the index of its `… N more frames` line (-1: none yet). */
  frames: number;
  moreAt: number;
}

const threadKey = (entry: LogEntry): string => `${entry.pid}:${entry.tid}`;

/**
 * The last MAX_CRASHES crashes of one app, read from logcat's `crash` buffer: `FATAL EXCEPTION` blocks (AndroidRuntime)
 * and crash_dump's native reports (`DEBUG`), each claimed by its `Process: …` / `>>> … <<<` line for the package or one
 * of its processes (`:remote`). Lines of other threads and processes may come in between.
 */
export class CrashLog {
  private readonly crashes: AppCrash[] = [];
  /** Reports still taking lines, by the logging `pid:tid`. */
  private readonly open = new Map<string, OpenBlock>();

  constructor(
    private readonly packageName: string,
    private readonly maxCrashes = MAX_CRASHES,
  ) {}

  add(entries: readonly LogEntry[]): void {
    for (const entry of entries) this.addEntry(entry);
  }

  /** Oldest first; copies. */
  list(): AppCrash[] {
    return this.crashes.map((crash) => ({ ...crash, stack: [...crash.stack] }));
  }

  /** Reports still open (bounded by MAX_OPEN_BLOCKS, emptied by later lines once they go quiet). */
  get openReports(): number {
    return this.open.size;
  }

  private addEntry(entry: LogEntry): void {
    this.closeStale(entry.ts);
    const key = threadKey(entry);
    if (entry.tag === 'AndroidRuntime') {
      const header = FATAL_EXCEPTION.exec(entry.message);
      if (header) return this.openBlock(key, 'java', entry.ts, header[1] ?? null);
    } else if (entry.tag === 'DEBUG' && TOMBSTONE_START.test(entry.message)) {
      return this.openBlock(key, 'native', entry.ts, null);
    }
    const block = this.open.get(key);
    if (!block) return;
    if (entry.tag !== (block.kind === 'java' ? 'AndroidRuntime' : 'DEBUG')) {
      this.open.delete(key);
      return;
    }
    block.lastTs = entry.ts;
    if (block.skipped) return;
    if (block.kind === 'java') this.javaLine(block, entry);
    else this.nativeLine(block, entry.message);
  }

  private openBlock(key: string, kind: AppCrash['kind'], ts: number, thread: string | null): void {
    this.open.delete(key);
    if (this.open.size >= MAX_OPEN_BLOCKS) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(key, {
      kind,
      ts,
      lastTs: ts,
      thread,
      crash: null,
      skipped: false,
      inStack: false,
      frames: 0,
      moreAt: -1,
    });
  }

  /** A crashed process never logs again: without this its block would stay open for good. */
  private closeStale(now: number): void {
    for (const [key, block] of this.open) {
      if (now - block.lastTs > CRASH_LINE_GAP_MS[block.kind]) this.open.delete(key);
    }
  }

  private javaLine(block: OpenBlock, entry: LogEntry): void {
    const { crash } = block;
    const line = entry.message;
    if (crash === null) {
      const process = PROCESS_LINE.exec(line)?.[1];
      block.crash =
        process === undefined ? null : this.record(block, entry.pid, entry.tid, block.thread, process);
      block.skipped = block.crash === null;
      return;
    }
    if (!block.inStack) {
      block.inStack = true;
      const thrown = EXCEPTION_LINE.exec(line);
      crash.exception = thrown?.[1] ? storedText(thrown[1]) : null;
      const message = thrown ? thrown[2] : line;
      crash.message = message === undefined ? null : storedText(message);
      return;
    }
    this.stackLine(block, crash, line);
  }

  private nativeLine(block: OpenBlock, line: string): void {
    const { crash } = block;
    if (crash === null) {
      const process = TOMBSTONE_PROCESS.exec(line);
      if (!process) return;
      const [, pid, tid, thread, name] = process;
      block.crash = this.record(block, Number(pid), Number(tid), thread ?? null, name ?? '');
      block.skipped = block.crash === null;
      return;
    }
    const signal = TOMBSTONE_SIGNAL.exec(line);
    const abort = ABORT_MESSAGE.exec(line);
    if (signal) {
      crash.exception = signal[1] ?? null;
      crash.message ??= storedText(line);
    } else if (abort) {
      crash.message = storedText(abort[1] ?? line);
    } else if (NATIVE_CAUSE.test(line)) {
      this.stackLine(block, crash, line);
    } else if (line.trim() === 'backtrace:') {
      block.inStack = true;
    } else if (block.inStack) {
      if (FRAME_LINE.test(line)) this.stackLine(block, crash, line.trim());
      else block.inStack = false;
    }
  }

  private stackLine(block: OpenBlock, crash: AppCrash, line: string): void {
    if (crash.stack.length >= MAX_CRASH_STACK_LINES) {
      crash.droppedLines++;
      return;
    }
    if (!FRAME_LINE.test(line)) {
      block.frames = 0;
      block.moreAt = -1;
      crash.stack.push(storedText(line));
    } else if (block.frames < MAX_CRASH_FRAMES_PER_CAUSE) {
      block.frames++;
      crash.stack.push(storedText(line));
    } else if (block.moreAt === -1) {
      block.moreAt = crash.stack.length;
      crash.stack.push('… 1 more frames');
    } else {
      const count = Number(MORE_FRAMES.exec(crash.stack[block.moreAt] ?? '')?.[1] ?? 0) + 1;
      crash.stack[block.moreAt] = `… ${count} more frames`;
    }
  }

  /** A new crash of the session's app; null for another app's or one already recorded (a replayed buffer). */
  private record(
    block: OpenBlock,
    pid: number,
    tid: number,
    thread: string | null,
    process: string,
  ): AppCrash | null {
    if (process !== this.packageName && !process.startsWith(`${this.packageName}:`)) return null;
    const { kind, ts } = block;
    const seen = this.crashes.some(
      (crash) => crash.kind === kind && crash.pid === pid && crash.tid === tid && crash.ts === ts,
    );
    if (seen) return null;
    const crash: AppCrash = {
      ts,
      pid,
      tid,
      kind,
      thread: thread === null ? null : storedText(thread),
      process: storedText(process),
      exception: null,
      message: null,
      stack: [],
      droppedLines: 0,
    };
    this.crashes.push(crash);
    if (this.crashes.length > this.maxCrashes) this.crashes.shift();
    return crash;
  }
}

import { createInterface } from 'node:readline';
import type { LogEntry } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { parseLogcatLine } from '../parsers/logcat.ts';

/** Lines of history requested when following a new process. */
export const LOGCAT_HISTORY_LINES = 200;
const STDERR_TAIL_CHARS = 1024;

export interface LogcatResumePoint {
  /** Device epoch ms of the last line already delivered. */
  deviceTs: number;
  /** How many lines with exactly that timestamp were already delivered (`-T` is inclusive). */
  linesAtTs: number;
}

export interface LogcatStreamOptions {
  adb: Adb;
  /** Must already be validated with isValidSerial. */
  serial: string;
  /** Only this process's lines (`--pid`); null: every process. */
  pid: number | null;
  /** A logcat buffer (`-b crash`) instead of the default ones. */
  buffer?: 'crash';
  /** laptop clock − device clock, in ms. */
  clockOffsetMs: number;
  /** Device epoch ms to start from instead of the last lines (`historyLines`). */
  since?: number;
  /** Lines of history to start with when there is no `since` (default LOGCAT_HISTORY_LINES). */
  historyLines?: number;
  /** Resume point after an unexpected exit; lines already delivered are skipped. */
  resume?: LogcatResumePoint | null;
  onEntry: (entry: LogEntry, deviceTs: number) => void;
  /** `reason` includes adb's stderr and is meant for the server log only. */
  onExit: (reason: string) => void;
}

export interface LogcatStream {
  stop(): void;
}

function formatEpoch(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}

/**
 * Follow `adb logcat -v epoch [-b <buffer>] [--pid=<pid>]` and emit parsed entries until stopped. Throws if the
 * process cannot be spawned at all.
 */
export function startLogcatStream(options: LogcatStreamOptions): LogcatStream {
  const { adb, serial, pid, buffer, since, clockOffsetMs, onEntry, onExit } = options;
  const resume = options.resume ?? null;
  let tail = String(options.historyLines ?? LOGCAT_HISTORY_LINES);
  if (resume !== null) tail = formatEpoch(resume.deviceTs);
  else if (since !== undefined) tail = formatEpoch(Math.max(0, Math.round(since)));
  const child = adb.spawn([
    '-s',
    serial,
    'logcat',
    '-v',
    'epoch',
    ...(buffer === undefined ? [] : ['-b', buffer]),
    ...(pid === null ? [] : [`--pid=${pid}`]),
    '-T',
    tail,
  ]);
  let stopped = false;
  let duplicatesToSkip = resume?.linesAtTs ?? 0;

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (stopped) return;
      const parsed = parseLogcatLine(line);
      if (!parsed) return;
      if (resume !== null) {
        if (parsed.deviceTs < resume.deviceTs) return;
        if (parsed.deviceTs === resume.deviceTs && duplicatesToSkip > 0) {
          duplicatesToSkip -= 1;
          return;
        }
      }
      onEntry(
        {
          ts: Math.round(parsed.deviceTs + clockOffsetMs),
          pid: parsed.pid,
          tid: parsed.tid,
          level: parsed.level,
          tag: parsed.tag,
          message: parsed.message,
        },
        parsed.deviceTs,
      );
    });
  }
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
  });
  child.stdin?.end();

  const finish = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    const detail = stderrTail.trim();
    onExit(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('exit', (code, signal) =>
    finish(`logcat exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`),
  );
  child.on('error', (error) => finish(`logcat failed: ${error.message}`));

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
    },
  };
}

export interface LogBatcherOptions {
  /** Pending lines that force an early flush. */
  maxPending: number;
  /** Lines older than this (e.g. `-T` history) are dropped at flush time. */
  windowMs: number;
  now: () => number;
  flush: (entries: LogEntry[]) => void;
}

/** Collects logcat lines between flushes and tracks where a restarted `logcat -T` has to resume. */
export class LogBatcher {
  private pending: LogEntry[] = [];
  private resumePoint: LogcatResumePoint | null = null;

  constructor(private readonly options: LogBatcherOptions) {}

  get resume(): LogcatResumePoint | null {
    return this.resumePoint;
  }

  /** A new process: its logcat starts from fresh history. */
  forgetResume(): void {
    this.resumePoint = null;
  }

  add(entry: LogEntry, deviceTs: number): void {
    if (this.resumePoint?.deviceTs === deviceTs) this.resumePoint.linesAtTs += 1;
    else this.resumePoint = { deviceTs, linesAtTs: 1 };
    this.pending.push(entry);
    if (this.pending.length >= this.options.maxPending) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    // `-T` history can predate the buffer window; such entries would be pruned immediately anyway.
    const cutoff = this.options.now() - this.options.windowMs;
    const entries = this.pending.filter((entry) => entry.ts >= cutoff);
    this.pending = [];
    if (entries.length > 0) this.options.flush(entries);
  }
}

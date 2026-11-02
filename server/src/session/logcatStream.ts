import { createInterface } from 'node:readline';
import type { LogEntry } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { parseLogcatLine, parseThreadtimeLine } from '../parsers/logcat.ts';
import type { LegacyLogClock } from '../parsers/logcat.ts';

/** Lines of history requested when following a new process. */
export const LOGCAT_HISTORY_LINES = 200;
/**
 * Legacy logcat can't filter by PID, so a line-count start without a point in time (a new stream) replays more
 * lines of every process than the modern 200.
 */
export const LEGACY_LOGCAT_HISTORY_LINES = 2000;
/**
 * A `-T` count past the size of any logcat ring buffer: the whole retained range (API 23 logcat reads a count
 * as an unsigned 32-bit number, and the ring holds far fewer lines). For a `since` or `resume` point `-T` cannot
 * express because the device's year changed since: everything retained is replayed, and the lines before the
 * point are dropped here, so a gap longer than any fixed count still arrives.
 */
export const LEGACY_LOGCAT_RETAINED_LINES = 2_147_483_647;
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
  /** Only this process's lines (`--pid`, or a filter on the PID column with legacyClock); null: every process. */
  pid: number | null;
  /**
   * The device's logcat has no `-v epoch` and no `--pid` (API < 24): follow `-v threadtime` instead, dated
   * with this clock. `since` and `resume` start at the device's local `-T 'MM-DD HH:mm:ss.SSS'` (lines before
   * them are still dropped here; a point in another year than the device's present one replays the whole
   * retained range instead); `historyLines` is a line count, for a start that has no point in time.
   */
  legacyClock?: LegacyLogClock | null;
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
 * `-T` value of a point in time for `-v threadtime` (device local time, no year). Null when the point lies in
 * another year than the device's present one: logcat reads the missing year as the current one, so the point
 * would land in the future and stream nothing.
 */
export function formatLegacyTimestamp(
  deviceTs: number,
  clock: LegacyLogClock,
  deviceNowMs: number,
): string | null {
  const local = new Date(Math.max(0, Math.round(deviceTs)) + clock.utcOffsetMs);
  const present = new Date(deviceNowMs + clock.utcOffsetMs);
  if (Number.isNaN(local.getTime()) || local.getUTCFullYear() !== present.getUTCFullYear()) return null;
  const iso = local.toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 23)}`;
}

/**
 * Follow `adb logcat -v epoch [-b <buffer>] [--pid=<pid>]` (`-v threadtime`, no `--pid` and a local-time `-T` on
 * API < 24) and emit parsed entries until stopped. Throws if the process cannot be spawned at all.
 */
export function startLogcatStream(options: LogcatStreamOptions): LogcatStream {
  const { adb, serial, pid, buffer, since, clockOffsetMs, onEntry, onExit } = options;
  const resume = options.resume ?? null;
  const legacyClock = options.legacyClock ?? null;
  let tail = String(options.historyLines ?? LOGCAT_HISTORY_LINES);
  if (legacyClock !== null) {
    const startMs = resume !== null ? resume.deviceTs : since;
    const stamp =
      startMs === undefined ? null : formatLegacyTimestamp(startMs, legacyClock, Date.now() - clockOffsetMs);
    if (stamp !== null) tail = stamp;
    else if (startMs !== undefined) tail = String(LEGACY_LOGCAT_RETAINED_LINES);
    else tail = String(options.historyLines ?? LEGACY_LOGCAT_HISTORY_LINES);
  } else if (resume !== null) tail = formatEpoch(resume.deviceTs);
  else if (since !== undefined) tail = formatEpoch(Math.max(0, Math.round(since)));
  const child = adb.spawn([
    '-s',
    serial,
    'logcat',
    '-v',
    legacyClock === null ? 'epoch' : 'threadtime',
    ...(buffer === undefined ? [] : ['-b', buffer]),
    ...(pid === null || legacyClock !== null ? [] : [`--pid=${pid}`]),
    '-T',
    tail,
  ]);
  let stopped = false;
  let duplicatesToSkip = resume?.linesAtTs ?? 0;

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (stopped) return;
      const parsed = legacyClock === null ? parseLogcatLine(line) : parseThreadtimeLine(line, legacyClock);
      if (!parsed) return;
      if (legacyClock !== null) {
        if (pid !== null && parsed.pid !== pid) return;
        if (since !== undefined && parsed.deviceTs < since) return;
      }
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

export interface ProcStat {
  pid: number;
  utime: number;
  stime: number;
  numThreads: number;
  /** Process start time in clock ticks after boot; changes when a PID is reused. */
  startTime: number;
}

// Indices into the fields that follow the closing `)` of comm: field 3 (state) is index 0.
const UTIME_INDEX = 14 - 3;
const STIME_INDEX = 15 - 3;
const NUM_THREADS_INDEX = 20 - 3;
const START_TIME_INDEX = 22 - 3;

function toInt(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Parse one `/proc/<pid>/stat` line. comm may contain spaces and parentheses, so the fixed fields
 * are read after the LAST `)`. Returns null for anything that doesn't look like a stat line
 * (e.g. "No such file or directory" when the process just died).
 */
export function parseProcStat(text: string): ProcStat | null {
  const line = text.split(/\r?\n/).find((candidate) => /^\s*\d+\s+\(/.test(candidate));
  if (!line) return null;
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (close < open) return null;

  const pid = toInt(line.slice(0, open).trim());
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const utime = toInt(fields[UTIME_INDEX]);
  const stime = toInt(fields[STIME_INDEX]);
  const numThreads = toInt(fields[NUM_THREADS_INDEX]);
  const startTime = toInt(fields[START_TIME_INDEX]);
  if (pid === null || utime === null || stime === null || numThreads === null || startTime === null)
    return null;

  return { pid, utime, stime, numThreads, startTime };
}

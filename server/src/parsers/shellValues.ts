/** Small parsers for one-line device shell outputs. */

/** First PID printed by `pidof`, or null if the process isn't running. */
export function parsePidof(text: string): number | null {
  const match = /^\s*(\d+)/.exec(text);
  if (!match?.[1]) return null;
  const pid = Number(match[1]);
  return pid > 0 ? pid : null;
}

/** Every PID printed by `pidof` (several processes can share a name); [] for anything else. */
export function parsePidList(text: string): number[] {
  const line = text.trim();
  if (!/^\d+(\s+\d+)*$/.test(line)) return [];
  return line
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0);
}

/** First number of `/proc/uptime` (seconds since boot), or null. */
export function parseUptime(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s*$/m.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

/** A positive integer on its own line (e.g. `getconf CLK_TCK`, `nproc`), or null. */
export function parsePositiveInt(text: string): number | null {
  const match = /^\s*(\d+)\s*$/m.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return value > 0 ? value : null;
}

/**
 * Device wall clock from `date +%s%3N` in epoch ms. Toybox prints milliseconds; shells without
 * `%N` support print whole seconds (possibly followed by a literal `%3N`/`N`), in which case the
 * middle of that second is assumed.
 */
export function parseDeviceEpochMs(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d{13,}$/.test(trimmed)) return Number(trimmed);
  const seconds = /^(\d{9,11})(?!\d)/.exec(trimmed);
  return seconds?.[1] ? Number(seconds[1]) * 1000 + 500 : null;
}

/**
 * Number of CPUs in a kernel CPU list such as `/sys/devices/system/cpu/possible` (`0-3`, `0-3,6`,
 * `0`), or null if the text isn't one.
 */
export function parseCpuList(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(trimmed)) return null;
  let count = 0;
  for (const part of trimmed.split(',')) {
    const [start, end] = part.split('-').map(Number);
    if (start === undefined) return null;
    const last = end ?? start;
    if (last < start) return null;
    count += last - start + 1;
  }
  return count > 0 ? count : null;
}

import type { LegacyLogClock } from './logcat.ts';

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

/** More PIDs under one app name than any app has processes: such a `pidof` ignored its argument. */
export const MAX_PLAUSIBLE_APP_PIDS = 16;

/**
 * Toybox `pidof` of API 23 ignores the name and prints every PID (init's 1 included). A list holding
 * PID 1 or an absurd number of PIDs is that, not the PIDs of an app.
 */
export function isImplausibleAppPidList(pids: readonly number[]): boolean {
  return pids.includes(1) || pids.length > MAX_PLAUSIBLE_APP_PIDS;
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
 * `%N` support print the 10 digits of whole seconds followed by what they made of `%3N` (nothing, a
 * literal `%3N`, `3N` or `N`), in which case the middle of that second is assumed.
 */
export function parseDeviceEpochMs(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d{13,}$/.test(trimmed)) return Number(trimmed);
  const seconds = /^(\d{10})(?:%?3?N)?$/.exec(trimmed);
  return seconds?.[1] ? Number(seconds[1]) * 1000 + 500 : null;
}

/**
 * Zone offset of the device from `date "+%s %Y-%m-%d %H:%M:%S"` (one call, so both readings are the same
 * instant): its local wall time read as UTC, minus its epoch. Null for anything else.
 */
export function parseLegacyLogClock(text: string): LegacyLogClock | null {
  const match = /^\s*(\d{10})\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*$/m.exec(text);
  if (!match) return null;
  const [epoch, year, month, day, hour, minute, second] = Array.from({ length: 7 }, (_, i) =>
    Number(match[i + 1]),
  ) as [number, number, number, number, number, number, number];
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = local - epoch * 1000;
  // Real zones are multiples of 15 minutes.
  return { utcOffsetMs: Math.round(offset / 900_000) * 900_000, probeMs: epoch * 1000 };
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

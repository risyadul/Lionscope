import type { LogLevel } from '@lionscope/protocol';

export const MAX_LOG_MESSAGE_CHARS = 4000;

export interface ParsedLogLine {
  /** Device clock, epoch ms. */
  deviceTs: number;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

// `<sec>.<millis> <pid> <tid> <level> <tag>: <message>`; the tag may be padded with spaces.
const LINE = /^\s*(\d+)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s(.*?)\s*: ?(.*)$/;
// `MM-DD HH:MM:SS.mmm <pid> <tid> <level> <tag>: <message>` (`-v threadtime`, device local time).
const THREADTIME_LINE =
  /^\s*(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s(.*?)\s*: ?(.*)$/;
const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;

/**
 * What `-v threadtime` lacks (API < 24 has no `-v epoch`): the year and the zone offset of the device,
 * read once from the device clock.
 */
export interface LegacyLogClock {
  /** Device local time − UTC, in ms. */
  utcOffsetMs: number;
  /** The device clock when the offset was read, epoch ms: tells which year a line belongs to. */
  probeMs: number;
}

function buildLine(
  deviceTs: number,
  pid: string,
  tid: string,
  level: string,
  tag: string,
  message: string,
): ParsedLogLine {
  return {
    deviceTs,
    pid: Number(pid),
    tid: Number(tid),
    // 'A' (assert) is reported by logcat for wtf(); fold it into fatal.
    level: level === 'A' ? 'F' : (level as LogLevel),
    tag: tag.trim(),
    message: message.length > MAX_LOG_MESSAGE_CHARS ? message.slice(0, MAX_LOG_MESSAGE_CHARS) : message,
  };
}

/** Parse one `logcat -v epoch` line; separator / unparsable lines return null. */
export function parseLogcatLine(line: string): ParsedLogLine | null {
  if (line.startsWith('--------- beginning of')) return null;
  const match = LINE.exec(line);
  if (!match) return null;
  const [, sec, millis, pid, tid, level, tag, message] = match;
  if (!sec || !millis || !pid || !tid || !level || tag === undefined || message === undefined) return null;
  return buildLine(Number(sec) * 1000 + Number(millis), pid, tid, level, tag, message);
}

/** Parse one `logcat -v threadtime` line (API < 24) onto the device's epoch; separators return null. */
export function parseThreadtimeLine(line: string, clock: LegacyLogClock): ParsedLogLine | null {
  const match = THREADTIME_LINE.exec(line);
  if (!match) return null;
  const [, month, day, hour, minute, second, millis, pid, tid, level, tag, message] = match;
  if (!month || !day || !hour || !minute || !second || !millis || !pid || !tid || !level) return null;
  if (tag === undefined || message === undefined) return null;
  const year = new Date(clock.probeMs + clock.utcOffsetMs).getUTCFullYear();
  const at = (y: number): number =>
    Date.UTC(
      y,
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millis),
    ) - clock.utcOffsetMs;
  let deviceTs = at(year);
  // No year in the line: a date half a year away from the probe is the neighbouring year's (New Year's Eve).
  if (deviceTs - clock.probeMs > HALF_YEAR_MS) deviceTs = at(year - 1);
  else if (clock.probeMs - deviceTs > HALF_YEAR_MS) deviceTs = at(year + 1);
  return buildLine(deviceTs, pid, tid, level, tag, message);
}

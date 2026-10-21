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

/** Parse one `logcat -v epoch` line; separator / unparsable lines return null. */
export function parseLogcatLine(line: string): ParsedLogLine | null {
  if (line.startsWith('--------- beginning of')) return null;
  const match = LINE.exec(line);
  if (!match) return null;
  const [, sec, millis, pid, tid, level, tag, message] = match;
  if (!sec || !millis || !pid || !tid || !level || tag === undefined || message === undefined) return null;
  return {
    deviceTs: Number(sec) * 1000 + Number(millis),
    pid: Number(pid),
    tid: Number(tid),
    // 'A' (assert) is reported by logcat for wtf(); fold it into fatal.
    level: level === 'A' ? 'F' : (level as LogLevel),
    tag: tag.trim(),
    message: message.length > MAX_LOG_MESSAGE_CHARS ? message.slice(0, MAX_LOG_MESSAGE_CHARS) : message,
  };
}

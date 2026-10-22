import { formatClock } from './format.ts';
import type { LogRecord } from './store.ts';

/** One line as it is copied: `HH:MM:SS.mmm L Tag: message` (a multi-line message keeps its line breaks). */
export function formatLogLine(record: LogRecord): string {
  const time = Number.isFinite(record.ts) ? formatClock(record.ts) : '--:--:--.---';
  return `${time} ${record.level} ${record.tag}: ${record.message}`;
}

export function formatLogLines(records: readonly LogRecord[]): string {
  return records.map(formatLogLine).join('\n');
}

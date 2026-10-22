/** Logcat filtering: the dashboard's Logcat panel and the agent's `search_logcat`. */
import type { LogEntry, LogLevel } from '../wire.ts';

export const LOG_LEVELS: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'F'];

export const LOG_LEVEL_NAMES: Readonly<Record<LogLevel, string>> = {
  V: 'Verbose',
  D: 'Debug',
  I: 'Info',
  W: 'Warn',
  E: 'Error',
  F: 'Fatal',
};

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };

export function levelRank(level: LogLevel): number {
  return LEVEL_RANK[level];
}

export interface LogFilter {
  /** Lowest level shown; everything at or above it passes. */
  minLevel: LogLevel;
  /** Case-insensitive substring matched against tag and message. */
  query: string;
}

export interface FilteredLogs<T extends LogEntry> {
  /** Matching rows, oldest first, limited to the newest `limit`. */
  rows: T[];
  /** Total number of matching rows before the limit was applied. */
  matched: number;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Hot-path matcher: `needle` must already be normalized (see `normalizeQuery`). */
function matchesNormalized(entry: LogEntry, minRank: number, needle: string): boolean {
  if (LEVEL_RANK[entry.level] < minRank) return false;
  if (needle === '') return true;
  return entry.tag.toLowerCase().includes(needle) || entry.message.toLowerCase().includes(needle);
}

export function matchesLog(entry: LogEntry, filter: LogFilter): boolean {
  return matchesNormalized(entry, LEVEL_RANK[filter.minLevel], normalizeQuery(filter.query));
}

/** Filters logs and keeps only the newest `limit` matches (scans newest → oldest). */
export function filterLogs<T extends LogEntry>(
  logs: readonly T[],
  filter: LogFilter,
  limit: number,
): FilteredLogs<T> {
  const minRank = LEVEL_RANK[filter.minLevel];
  const needle = normalizeQuery(filter.query);
  const newestFirst: T[] = [];
  let matched = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry === undefined || !matchesNormalized(entry, minRank, needle)) continue;
    matched++;
    if (newestFirst.length < limit) newestFirst.push(entry);
  }
  return { rows: newestFirst.reverse(), matched };
}

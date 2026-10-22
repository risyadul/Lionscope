/** Logcat filtering lives in @lionscope/protocol/insights (the agent's search_logcat uses it too). */
import { normalizeQuery } from '@lionscope/protocol/insights';

export {
  filterLogs,
  levelRank,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  matchesLog,
  normalizeQuery,
} from '@lionscope/protocol/insights';
export type { FilteredLogs, LogFilter } from '@lionscope/protocol/insights';

/** Splits `text` around the first case-insensitive occurrence of `query` for highlighting. */
export function splitMatch(
  text: string,
  query: string,
): [before: string, match: string, after: string] | null {
  const needle = normalizeQuery(query);
  if (needle === '') return null;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  return [text.slice(0, at), text.slice(at, at + needle.length), text.slice(at + needle.length)];
}

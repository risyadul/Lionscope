/** `search_logcat`: the session app's logcat, filtered like the dashboard's Logcat panel. */
import { z } from 'zod';
import type { LogEntry } from '@lionscope/protocol';
import { filterLogs, levelRank, redactLogText } from '@lionscope/protocol/insights';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { iso, truncate } from './views.ts';

const MAX_LINES = 200;

/** Messages as agents see them, by entry: the buffer hands out the same entries on every read, so a line is redacted once. */
const redactedMessages = new WeakMap<LogEntry, string>();

function redactedMessage(entry: LogEntry): string {
  let message = redactedMessages.get(entry);
  if (message === undefined) {
    message = redactLogText(entry.message);
    redactedMessages.set(entry, message);
  }
  return message;
}

/** `since`: milliseconds ago, or an ISO 8601 time. */
function sinceTs(since: number | string | undefined, now: number): number {
  if (since === undefined) return -Infinity;
  if (typeof since === 'number') return now - since;
  const ts = Date.parse(since);
  if (Number.isNaN(ts))
    throw new ToolError(`since must be milliseconds ago or an ISO 8601 time (got "${truncate(since, 40)}")`);
  return ts;
}

export const logcatTool = defineTool({
  name: 'search_logcat',
  title: 'Search logcat',
  description: `Logcat lines of the profiled app's process (the session's buffer, up to 10 minutes), filtered like the dashboard's Logcat panel: level is the minimum (V < D < I < W < E < F), query a case-insensitive substring of tag or message, since milliseconds ago or an ISO time. Returns the newest matching lines, oldest first, each {time, level, tag, message}; messages over 500 characters are cut. matched counts every match before the limit. Credentials (sensitive header lines like Authorization or Cookie, Bearer/Basic values, JWTs, sensitive name=value pairs, JSON values and URL parameters) are replaced by ‹redacted› before matching and cutting. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    level: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).default('V').describe('Minimum level.'),
    query: z.string().max(200).default('').describe('Substring of tag or message, case-insensitive.'),
    since: z
      .union([z.number().int().positive(), z.string().max(40)])
      .optional()
      .describe('Only lines from this many milliseconds ago on, or from this ISO 8601 time on.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINES)
      .default(50)
      .describe(`Most lines returned (1-${MAX_LINES}).`),
  }),
  annotations: READ_ONLY,
  async run({ level, query, since, limit }, ctx) {
    const from = sinceTs(since, ctx.now());
    const minRank = levelRank(level);
    // Redacted before matching: a query for the credential itself must not find it through `matched`.
    const logs = ctx.sessions
      .getSnapshot()
      .logs.filter((entry) => entry.ts >= from && levelRank(entry.level) >= minRank)
      .map((entry) => ({ ...entry, message: redactedMessage(entry) }));
    const { rows, matched } = filterLogs(logs, { minLevel: level, query }, limit);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        matched,
        returned: rows.length,
        lines: rows.map((entry) => ({
          time: iso(entry.ts),
          level: entry.level,
          tag: truncate(entry.tag, 100),
          message: truncate(entry.message),
        })),
      },
    };
  },
});

/** `search_logcat`: the session app's logcat, filtered like the dashboard's Logcat panel; `get_crashes`. */
import { z } from 'zod';
import type { LogEntry } from '@lionscope/protocol';
import { filterLogs, levelRank, redactLogText } from '@lionscope/protocol/insights';
import { BUFFER_WINDOW_MS } from '../config.ts';
import { FRAME_LINE, MAX_CRASHES, MORE_FRAMES } from '../store/crashLog.ts';
import type { AppCrash } from '../store/crashLog.ts';
import { MAX_LOG_ENTRIES } from '../store/sessionStore.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { iso, truncate } from './views.ts';

const MAX_LINES = 200;
/** Frames shown per exception of a crash's chain (the thrown one, then each `Caused by:`); the rest are counted. */
const FRAMES_PER_CAUSE = 12;

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
  description: `Logcat lines of the profiled app's process from the session's buffer: the newest ${MAX_LOG_ENTRIES} lines (at most 8 MB) of the last ${BUFFER_WINDOW_MS / 60_000} minutes, so a chatty app (HTTP logging) keeps well under a minute; retained says what the buffer holds now ({entries, capacity, oldest, newest}), to tell "no match" from "already dropped". Crashes outlive the buffer: use get_crashes for them. Filtered like the dashboard's Logcat panel: level is the minimum (V < D < I < W < E < F), query a case-insensitive substring of tag or message, since milliseconds ago or an ISO time. Returns the newest matching lines, oldest first, each {time, level, tag, message}; messages over 500 characters are cut. matched counts every match before the limit. Credentials (sensitive header lines like Authorization or Cookie, Bearer/Basic values, JWTs, sensitive name=value pairs, JSON values and URL parameters) are replaced by ‹redacted› before matching and cutting. ${UNTRUSTED_DESCRIPTION}`,
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
    const buffer = ctx.sessions.getSnapshot().logs;
    const [oldest, newest] = [buffer[0], buffer.at(-1)];
    const minRank = levelRank(level);
    // Redacted before matching: a query for the credential itself must not find it through `matched`.
    const logs = buffer
      .filter((entry) => entry.ts >= from && levelRank(entry.level) >= minRank)
      .map((entry) => ({ ...entry, message: redactedMessage(entry) }));
    const { rows, matched } = filterLogs(logs, { minLevel: level, query }, limit);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        retained: {
          entries: buffer.length,
          capacity: MAX_LOG_ENTRIES,
          oldest: oldest === undefined ? null : iso(oldest.ts),
          newest: newest === undefined ? null : iso(newest.ts),
        },
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

/** A crash's stack (stored redacted and cut) with each exception of the chain cut to FRAMES_PER_CAUSE frames. */
function crashStack(crash: AppCrash): string[] {
  const lines: string[] = [];
  let frames = 0;
  let skipped = 0;
  const countSkipped = () => {
    if (skipped > 0) lines.push(`… ${skipped} more frames`);
    skipped = 0;
  };
  for (const raw of crash.stack) {
    // Frames the store did not keep count with the ones cut here.
    const notKept = MORE_FRAMES.exec(raw);
    if (notKept) {
      skipped += Number(notKept[1]);
      continue;
    }
    const line = raw.trim();
    if (!FRAME_LINE.test(line)) {
      countSkipped();
      frames = 0;
      lines.push(line);
    } else if (frames < FRAMES_PER_CAUSE) {
      frames++;
      lines.push(line);
    } else {
      skipped++;
    }
  }
  countSkipped();
  if (crash.droppedLines > 0) lines.push(`… ${crash.droppedLines} more lines not kept`);
  return lines;
}

export const crashesTool = defineTool({
  name: 'get_crashes',
  title: 'Crashes',
  description: `The profiled app's crashes since the session started, read from logcat's crash buffer and kept apart from the log buffer (search_logcat loses them once newer lines push them out): uncaught Java/Kotlin exceptions (AndroidRuntime FATAL EXCEPTION) and native crashes (fatal signals as crash_dump reports them), of the package's process and its package:* processes (also :remote ones, also processes that crashed before Lionscope saw their PID), the last ${MAX_CRASHES}. Use it to tell whether the app crashed (get_summary's processRestarts also counts force-stops). since: milliseconds ago or an ISO time. Returns the newest crashes, oldest first, each {time, kind (java/native), pid, tid, thread, process, exception (class or signal), message (a native crash's abort message or signal line), stack (with a native crash's Cause line)}; the stack keeps every Caused by line and the first ${FRAMES_PER_CAUSE} frames of each exception (of the backtrace for a native crash). total counts every crash kept since then. Credentials are redacted like in search_logcat. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    since: z
      .union([z.number().int().positive(), z.string().max(40)])
      .optional()
      .describe('Only crashes from this many milliseconds ago on, or from this ISO 8601 time on.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CRASHES)
      .default(10)
      .describe(`Most crashes returned (1-${MAX_CRASHES}).`),
  }),
  annotations: READ_ONLY,
  async run({ since, limit }, ctx) {
    const from = sinceTs(since, ctx.now());
    const crashes = ctx.sessions.getCrashes().filter((crash) => crash.ts >= from);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        total: crashes.length,
        returned: Math.min(limit, crashes.length),
        crashes: crashes.slice(-limit).map((crash) => ({
          time: iso(crash.ts),
          kind: crash.kind,
          pid: crash.pid,
          tid: crash.tid,
          thread: crash.thread,
          process: crash.process,
          exception: crash.exception,
          message: crash.message,
          stack: crashStack(crash),
        })),
      },
    };
  },
});

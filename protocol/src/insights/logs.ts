/** Logcat filtering: the dashboard's Logcat panel and the agent's `search_logcat`; credential redaction for agents. */
import { HTTP_REDACTED } from '../wire.ts';
import type { LogEntry, LogLevel } from '../wire.ts';
import { isSensitiveName, redactJsonText, redactUrl, redactXmlText } from './network.ts';

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

/** Also sensitive in logs: PKCE's `code_verifier` (logcat only, so the network rule and its Kotlin twin stay as they are). */
const LOG_SENSITIVE_PART = /verifier/i;
/** Values after these names are secrets whatever their shape (`password: hunter2`). */
const ALWAYS_SECRET = /(?:password|passwd|secret)$/i;

/** Sensitive names as logcat redaction reads them, `code` aside (see isSensitiveLogPair). */
function isSensitiveLogName(name: string): boolean {
  return name.toLowerCase() !== 'code' && (isSensitiveName(name) || LOG_SENSITIVE_PART.test(name));
}

/**
 * A pair to redact: `code` only when its value looks like an OAuth code (`code=4/0AX4…`), not a status (`code=500`,
 * `"code":"E401"`); a URL's `?code=` is always redacted, by `redactUrl`.
 */
function isSensitiveLogPair(name: string, value: string): boolean {
  return name.toLowerCase() === 'code' ? looksLikeCredential(value) : isSensitiveLogName(name);
}

/**
 * Shaped like a credential rather than a word: 16+ characters, or 8+ with a digit, `+`, `/`, `=` or a capital after
 * a small letter (`dXNlcjpwYXNz`, `ghp_Ab…`, not `expired` or `verification`). One pass, no regex backtracking.
 */
function looksLikeCredential(value: string): boolean {
  if (value.length >= 16) return true;
  if (value.length < 8) return false;
  let lower = false;
  for (const char of value) {
    if ((char >= '0' && char <= '9') || char === '+' || char === '/' || char === '=') return true;
    if (char >= 'a' && char <= 'z') lower = true;
    else if (lower && char >= 'A' && char <= 'Z') return true;
  }
  return false;
}

// Every pattern below is linear on any line: a run is only entered at its start (`(?<!…)` lookbehinds), repeated
// parts never overlap what follows them, and the shape tests run in callbacks. A 4000-character line of one
// character class must not cost milliseconds (search_logcat redacts up to 5000 lines per call).

/** A `"name": value` pair outside any object it can see (pretty-printed bodies log one line per entry). */
const LOG_JSON_PAIR = /"([^"\\\r\n]{1,100})"([ \t]*:[ \t]*)("(?:[^"\\]|\\.)*"?|[^\s,"{}[\]]+)/g;
/** `Authorization: …`, `Cookie: …` anywhere in a line (`D/OkHttp: Set-Cookie: …`): the rest of the line is a credential. */
const LOG_AUTH_HEADER =
  /(?<![\w-])(authorization|proxy-authorization|cookie|set-cookie)([ \t]*:[ \t]*)\S[^\r\n]*/gi;
/**
 * Any other `name: value` line, after a short prefix (`-> ` from Ktor): a hyphenated sensitive name is a header
 * (`X-Api-Key: …`, `X-Auth-Token: …`) and its whole value goes; another sensitive name (`token: abc123`,
 * `sessionId: 9f8e7d6c`) loses a one-word value with a digit or a credential's shape. A class name followed by prose
 * (`AuthRepository: login failed`, `Session: restored 3 screens`) is not a pair.
 */
const LOG_HEADER_LINE = /^([^\w\r\n]{0,10})([A-Za-z][\w-]*)([ \t]*:[ \t]*)(\S[^\r\n]*)/gm;
/** URLs of any scheme (`https://`, an app's `myapp://callback?code=…`). */
const LOG_URL = /(?<![\w+.-])[A-Za-z][\w+.-]*:\/\/[^\s"'<>]+/g;
const LOG_BEARER = /(?<![\w-])(Bearer)(\s+)[^\s,;"'\])}]+/gi;
/** `Basic …` / `Token …` (`Authorization: token ghp_…`): both words also start sentences (`Token refresh failed`). */
const LOG_SCHEME = /(?<![\w-])([Bb]asic|BASIC|[Tt]oken|TOKEN)(\s+)([\w+/=.~-]{8,})/g;
/** A JWT (`eyJ….eyJ….…`, base64url JSON header and payload) wherever it appears, with or without `Bearer`. */
const LOG_JWT = /(?<![\w-])eyJ[\w-]+\.eyJ[\w-]+(?:\.[\w-]+)*/g;
/**
 * `Refreshed token: …`, `Google access token: …`, `x-api-key: …`, `password: …` anywhere in a line: a password or
 * secret always, the others when the value looks like a credential (`Invalid token: expired` stays).
 */
const LOG_COLON_PAIR =
  /(?<![\w-])([\w-]*(?:token|secret|password|passwd|api[-_]?key))([ \t]*:[ \t]*["']?)([^\s,;"'<>]+)/gi;
/** `name=value`, also `Authorization=[Bearer …]` as OkHttp's `toMultimap()` prints it. */
const LOG_PAIR = /(?<![\w.-])([\w.-]+)=(\[?)((?:(?:Bearer|Basic|Token)\s+)?[^\s&;,"'[\]{}()]+)/g;

/**
 * A log message as agents get it, with credentials replaced by `‹redacted›`: JSON values and XML elements and
 * attributes of sensitive names, sensitive header lines, URL parameters, `Bearer …`, `Basic` / `Token` before a
 * credential-shaped word, bare JWTs, credential-shaped values after `…token:` / `…password:` / `…api-key:`, and
 * sensitive `name=value` pairs. Like `redactFreeText`, but tuned for prose. Server-side only (the SDK never sees
 * logcat), so it has no Kotlin twin.
 */
export function redactLogText(text: string): string {
  const structured = redactXmlText(
    redactJsonText(text, isSensitiveLogName).replace(
      LOG_JSON_PAIR,
      (match: string, name: string, colon: string, value: string) =>
        isSensitiveLogPair(name, value.replace(/^"|"$/g, '')) ? `"${name}"${colon}"${HTTP_REDACTED}"` : match,
    ),
    isSensitiveLogName,
  );
  return structured
    .replace(LOG_AUTH_HEADER, (_, name: string, colon: string) => `${name}${colon}${HTTP_REDACTED}`)
    .replace(LOG_HEADER_LINE, (match: string, prefix: string, name: string, colon: string, value: string) => {
      const word = value.trimEnd();
      const redact = name.includes('-')
        ? isSensitiveLogName(name)
        : !/\s/.test(word) &&
          (/\d/.test(word) || looksLikeCredential(word)) &&
          isSensitiveLogPair(name, word);
      return redact ? `${prefix}${name}${colon}${HTTP_REDACTED}` : match;
    })
    .replace(LOG_URL, (url) => redactUrl(url))
    .replace(LOG_BEARER, (_, scheme: string, space: string) => `${scheme}${space}${HTTP_REDACTED}`)
    .replace(LOG_SCHEME, (match: string, scheme: string, space: string, value: string) =>
      looksLikeCredential(value) ? `${scheme}${space}${HTTP_REDACTED}` : match,
    )
    .replace(LOG_JWT, HTTP_REDACTED)
    .replace(LOG_COLON_PAIR, (match: string, name: string, colon: string, value: string) =>
      ALWAYS_SECRET.test(name) || looksLikeCredential(value) ? `${name}${colon}${HTTP_REDACTED}` : match,
    )
    .replace(LOG_PAIR, (match: string, name: string, bracket: string, value: string) =>
      isSensitiveLogPair(name, value) ? `${name}=${bracket}${HTTP_REDACTED}` : match,
    );
}

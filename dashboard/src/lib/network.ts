/**
 * The Network tab's pure parts: the list filter, body display, the mock editor's draft and validation (mirroring
 * the server's bounds, so most mistakes are caught before a round trip), the top bar's mock state and the
 * timeline lane's bar layout. Status classes, URL parts and matching come from the shared insights.
 */
import type {
  HttpBody,
  HttpExchange,
  HttpExchangeDetail,
  HttpHeader,
  MockAction,
  MockMatch,
  NetworkMockInput,
  NetworkMockRule,
  NetworkMocksState,
} from '@lionscope/protocol/wire';
import {
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_HEADER_NAME_CHARS,
  MAX_HTTP_HEADER_VALUE_CHARS,
  MAX_MOCK_BODY_BYTES,
  MAX_MOCK_DELAY_MS,
  MAX_MOCK_GLOB_STARS,
  MAX_MOCK_HEADER_BYTES,
  MAX_MOCK_HEADERS,
  MAX_MOCK_URL_CHARS,
} from '@lionscope/protocol/wire';
import {
  exchangesInWindow,
  matchesExchange,
  statusClassOf,
  type HttpFilter,
  type HttpStatusClass,
} from '@lionscope/protocol/insights';
import { formatInteger } from './format.ts';

/** The methods the editor and the list's method menu offer; a captured request may use any other token. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** The status filter's choices (`1xx` and pending exchanges show under All only). */
export type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed';

export interface ListFilter {
  query: string;
  /** Upper-case method, null for any. */
  method: string | null;
  status: StatusFilter;
  mockedOnly: boolean;
}

export const NO_LIST_FILTER: ListFilter = { query: '', method: null, status: 'all', mockedOnly: false };

export function toHttpFilter(filter: ListFilter): HttpFilter {
  return {
    query: filter.query,
    method: filter.method,
    statusClass: filter.status === 'all' ? null : (filter.status as HttpStatusClass),
    mocked: filter.mockedOnly ? true : null,
  };
}

/** Exchanges in the window that pass the filter, oldest first. */
export function listExchanges(
  exchanges: readonly HttpExchange[],
  fromTs: number,
  toTs: number,
  now: number,
  filter: ListFilter,
): HttpExchange[] {
  const httpFilter = toHttpFilter(filter);
  return exchangesInWindow(exchanges, fromTs, toTs, now).filter((e) => matchesExchange(e, httpFilter));
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** `0 B`, `812 B`, `4.2 KB`, `47 KB`, `1.4 MB`; the em dash when unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** The media type without parameters, lower case (`application/json`). */
export function mediaType(contentType: string | null): string | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type ? type : null;
}

export function isJsonType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type !== null && (type === 'application/json' || type.endsWith('+json'));
}

export interface BodyText {
  text: string;
  /** Parsed as JSON and pretty-printed. */
  isJson: boolean;
}

/** JSON (by type, or text that looks like it) pretty-printed when it parses; anything else as captured. */
export function formatBodyText(text: string, contentType: string | null): BodyText {
  const trimmed = text.trimStart();
  const looksJson = isJsonType(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson && trimmed !== '') {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), isJson: true };
    } catch {
      // A cut or malformed body: shown as it came.
    }
  }
  return { text, isJson: false };
}

/** A body in plain words when its text is not there; null when there is text to show. */
export function bodyNote(body: HttpBody | null, encoding: string | null = null): string | null {
  if (body === null) return 'No body.';
  if (body.text !== null && body.omitted === null) {
    return body.size === 0 && body.text === '' ? 'Empty body.' : null;
  }
  const facts = [body.contentType ? mediaType(body.contentType) : null, sizeFact(body.size)].filter(
    (fact): fact is string => fact !== null,
  );
  const detail = facts.length > 0 ? ` (${facts.join(', ')})` : '';
  switch (body.omitted) {
    case 'type': {
      const type = mediaType(body.contentType);
      const what =
        type === null
          ? 'content without a type'
          : type.startsWith('multipart/')
            ? 'multipart content'
            : 'binary content';
      return `Not captured: ${what}${detail}.`;
    }
    case 'streaming':
      return `Not captured: a streaming body (server-sent events, a WebSocket or a duplex call)${detail}.`;
    case 'encoding':
      return `Not captured: compressed as ${encoding ?? 'an encoding'} Lionscope can’t decode${detail}.`;
    case 'one_shot':
      return `Not captured: a one-shot request body, which can only be written once${detail}.`;
    case 'error':
      return `Not captured: reading it for the capture failed; the app’s call was not affected${detail}.`;
    case null:
      return body.size === 0 ? 'Empty body.' : `No text captured${detail}.`;
  }
}

function sizeFact(size: number | null): string | null {
  return size === null ? null : formatBytes(size);
}

/** Said under a cut body; null when the text is whole. */
export function truncatedNote(body: HttpBody | null): string | null {
  if (body === null || !body.truncated) return null;
  const of = body.size === null ? 'a longer body' : formatBytes(body.size);
  return `Truncated: the first ${formatBytes(MAX_HTTP_BODY_BYTES)} of ${of} are shown.`;
}

/** The first value of a header (names compare case-insensitively). */
export function headerValue(headers: readonly HttpHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find(([n]) => n.toLowerCase() === lower)?.[1] ?? null;
}

/** The URL without `?query` and `#fragment`. */
export function urlWithoutQuery(url: string): string {
  const end = [url.indexOf('?'), url.indexOf('#')].filter((at) => at !== -1);
  return end.length === 0 ? url : url.slice(0, Math.min(...end));
}

const MATCH_LABELS: Record<MockMatch, string> = { exact: 'Exact', prefix: 'Prefix', glob: 'Glob' };
export const ACTION_LABELS: Record<MockAction, string> = {
  respond: 'Respond',
  timeout: 'Timeout',
  connection_error: 'Connection error',
};

export function matchLabel(match: MockMatch): string {
  return MATCH_LABELS[match];
}

/** What a rule answers with: `200`, `Timeout`, `Connection error`. */
export function ruleAnswer(rule: Pick<NetworkMockRule, 'action' | 'status'>): string {
  return rule.action === 'respond' ? String(rule.status) : ACTION_LABELS[rule.action];
}

// ---------------------------------------------------------------------------
// Mock editor
// ---------------------------------------------------------------------------

/** The editor's fields as typed (numbers stay strings until validated). */
export interface MockDraft {
  /** Set when editing an existing rule. */
  id?: string;
  /** null = any method. */
  method: string | null;
  match: MockMatch;
  url: string;
  action: MockAction;
  status: string;
  /** `Name: value`, one per line. */
  headers: string;
  body: string;
  delayMs: string;
  enabled: boolean;
}

export type MockField = 'method' | 'url' | 'status' | 'headers' | 'body' | 'delayMs';
export type MockErrors = Partial<Record<MockField, string>>;

export const EMPTY_DRAFT: MockDraft = {
  method: 'GET',
  match: 'exact',
  url: 'https://',
  action: 'respond',
  status: '200',
  headers: 'Content-Type: application/json',
  body: '',
  delayMs: '0',
  enabled: true,
};

export function formatHeaderLines(headers: readonly HttpHeader[]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join('\n');
}

export function draftFromRule(rule: NetworkMockRule): MockDraft {
  return {
    id: rule.id,
    method: rule.method,
    match: rule.match,
    url: rule.url,
    action: rule.action,
    status: String(rule.status),
    headers: formatHeaderLines(rule.headers),
    body: rule.body,
    delayMs: String(rule.delayMs),
    enabled: rule.enabled,
  };
}

export interface DraftFromExchange {
  draft: MockDraft;
  /** Things the user should know about the pre-filled body, in plain words. */
  note: string | null;
}

/**
 * "Mock this response": the same method and URL (without its query, matched exactly), the status, the response's
 * Content-Type and its captured body. A failed call is mocked as the same failure where there is one.
 */
export function draftFromExchange(
  exchange: HttpExchange,
  detail: HttpExchangeDetail | null,
): DraftFromExchange {
  const action: MockAction =
    exchange.state === 'failed' && exchange.error?.kind === 'timeout'
      ? 'timeout'
      : exchange.state === 'failed' && exchange.error?.kind === 'connection'
        ? 'connection_error'
        : 'respond';
  const contentType =
    (detail === null ? null : headerValue(detail.responseHeaders, 'Content-Type')) ?? exchange.responseType;
  const body = detail?.responseBody ?? null;
  const draft: MockDraft = {
    method: exchange.method,
    match: 'exact',
    url: urlWithoutQuery(exchange.url),
    action,
    status: String(exchange.status ?? 200),
    headers: contentType === null ? '' : `Content-Type: ${contentType}`,
    body: body?.text ?? '',
    delayMs: '0',
    enabled: true,
  };
  return { draft, note: action === 'respond' ? prefillNote(detail, body) : null };
}

function prefillNote(detail: HttpExchangeDetail | null, body: HttpBody | null): string | null {
  if (detail === null) return 'The captured response hasn’t loaded: add the body by hand.';
  if (body === null) return null;
  if (body.truncated) {
    return `The captured body was cut at ${formatBytes(MAX_HTTP_BODY_BYTES)}: the mock answers with that part only.`;
  }
  if (body.text === null && body.size !== 0) {
    const what = [mediaType(body.contentType), sizeFact(body.size)].filter(Boolean).join(', ');
    return `The response body wasn’t captured${what ? ` (${what})` : ''}: add one by hand.`;
  }
  return null;
}

/** HTTP tokens, as the server checks header names (RFC 9110). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD = /^[A-Z][A-Z0-9_-]{0,15}$/;
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

export interface ParsedHeaders {
  headers: HttpHeader[];
  error: string | null;
}

/** `Name: value` lines (blank lines skipped) into headers, with the first problem in plain words. */
export function parseHeaderLines(text: string): ParsedHeaders {
  const headers: HttpHeader[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) return { headers, error: `Line ${i + 1}: write it as Name: value.` };
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!TOKEN.test(name) || name.length > MAX_HTTP_HEADER_NAME_CHARS) {
      return { headers, error: `Line ${i + 1}: “${name}” isn’t a valid header name.` };
    }
    if (value.length > MAX_HTTP_HEADER_VALUE_CHARS || FORBIDDEN.test(value)) {
      return { headers, error: `Line ${i + 1}: the value is too long or has control characters.` };
    }
    headers.push([name, value]);
  }
  if (headers.length > MAX_MOCK_HEADERS) {
    return { headers, error: `At most ${MAX_MOCK_HEADERS} headers.` };
  }
  const bytes = headers.reduce((sum, [n, v]) => sum + utf8Bytes(n) + utf8Bytes(v), 0);
  if (bytes > MAX_MOCK_HEADER_BYTES) {
    return { headers, error: `Headers are limited to ${formatBytes(MAX_MOCK_HEADER_BYTES)} in all.` };
  }
  return { headers, error: null };
}

function parseInteger(text: string): number | null {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : null;
}

export interface DraftCheck {
  /** The rule to send, null while there are errors. */
  input: NetworkMockInput | null;
  errors: MockErrors;
}

/** Validates the draft the way the server will (`networkMockInputSchema`). */
export function validateDraft(draft: MockDraft): DraftCheck {
  const errors: MockErrors = {};
  if (draft.method !== null && !METHOD.test(draft.method)) errors.method = 'Use an upper-case method name.';

  const url = draft.url.trim();
  const starts = draft.match === 'glob' ? /^(https?|\*):\/\/./ : /^https?:\/\/./;
  if (url === '' || /^(https?|\*):\/\/$/.test(url)) errors.url = 'Enter the URL to match.';
  else if (url.length > MAX_MOCK_URL_CHARS) {
    errors.url = `Up to ${formatInteger(MAX_MOCK_URL_CHARS)} characters.`;
  } else if (/\s/.test(url) || FORBIDDEN.test(url)) errors.url = 'A URL has no spaces.';
  else if (!starts.test(url)) {
    errors.url =
      draft.match === 'glob' ? 'Start with http://, https:// or *://.' : 'Start with http:// or https://.';
  } else if (draft.match === 'glob' && url.split('*').length - 1 > MAX_MOCK_GLOB_STARS) {
    errors.url = `A glob takes at most ${MAX_MOCK_GLOB_STARS} *.`;
  }

  const isRespond = draft.action === 'respond';
  const status = parseInteger(draft.status);
  const isStatusValid = status !== null && status >= 100 && status <= 599;
  if (isRespond && !isStatusValid) errors.status = 'A status from 100 to 599.';

  const parsed = isRespond ? parseHeaderLines(draft.headers) : { headers: [], error: null };
  if (parsed.error !== null) errors.headers = parsed.error;
  if (isRespond && utf8Bytes(draft.body) > MAX_MOCK_BODY_BYTES) {
    errors.body = `The body is limited to ${formatBytes(MAX_MOCK_BODY_BYTES)}.`;
  }

  const delay = parseInteger(draft.delayMs);
  if (delay === null || delay > MAX_MOCK_DELAY_MS) {
    errors.delayMs = `0 to ${formatInteger(MAX_MOCK_DELAY_MS)} ms.`;
  }

  if (Object.keys(errors).length > 0) return { input: null, errors };
  const input: NetworkMockInput = {
    method: draft.method,
    match: draft.match,
    url,
    action: draft.action,
    // The server checks the status of every rule; a failure answer ignores it.
    status: isStatusValid ? status : 200,
    headers: parsed.headers,
    body: isRespond ? draft.body : '',
    delayMs: delay ?? 0,
    enabled: draft.enabled,
  };
  return { input: draft.id === undefined ? input : { id: draft.id, ...input }, errors };
}

/** A stored rule as a replacement input (`setNetworkMock` with its id), with `patch` applied. */
export function ruleInput(rule: NetworkMockRule, patch: Partial<NetworkMockInput> = {}): NetworkMockInput {
  const { id, method, match, url, action, status, headers, body, delayMs, enabled } = rule;
  return { id, method, match, url, action, status, headers, body, delayMs, enabled, ...patch };
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export interface MocksIndicatorState {
  /** Enabled rules. */
  count: number;
  /** `applied`: the app confirmed this set; `waiting`: a session runs and the app hasn't yet. */
  state: 'applied' | 'waiting' | 'idle';
}

/** Null while no enabled rule exists (the indicator is hidden). */
export function mocksIndicator(
  mocks: NetworkMocksState | null,
  isSessionActive: boolean,
): MocksIndicatorState | null {
  const count = mocks?.rules.filter((rule) => rule.enabled).length ?? 0;
  if (mocks === null || count === 0) return null;
  if (mocks.appliedRev !== null && mocks.appliedRev === mocks.rev) return { count, state: 'applied' };
  return { count, state: isSessionActive ? 'waiting' : 'idle' };
}

// ---------------------------------------------------------------------------
// Timeline lane
// ---------------------------------------------------------------------------

export interface LaneBar {
  exchange: HttpExchange;
  row: number;
  /** Fractions of the window, 0..1. */
  left: number;
  width: number;
}

/** Calls that found no free row, merged where they touch. */
export interface LaneOverflow {
  left: number;
  width: number;
  count: number;
}

export interface LaneLayout {
  bars: LaneBar[];
  overflow: LaneOverflow[];
  /** Exchanges in the window (bars and overflow). */
  total: number;
  /** Of those, failed calls and 5xx responses. */
  failed: number;
}

/** Bars this narrow still show (px), with this much air before the next bar in a row. */
export const MIN_BAR_PX = 2;
const BAR_GAP_PX = 1;

/**
 * One bar per exchange from start to end (pending ones to `openEnd`), clamped to the window and packed into the
 * first row where it doesn't touch the previous bar (in pixels, so the number of bars per row is bounded by the
 * width). What fits in no row goes to `overflow`.
 */
export function layoutLaneBars(
  exchanges: readonly HttpExchange[],
  fromTs: number,
  toTs: number,
  openEnd: number,
  widthPx: number,
  maxRows: number,
): LaneLayout {
  const range = Math.max(1, toTs - fromTs);
  const pxPerMs = widthPx / range;
  const visible = exchangesInWindow(exchanges, fromTs, toTs, openEnd);
  const rowEnds: number[] = Array.from({ length: maxRows }, () => -Infinity);
  const bars: LaneBar[] = [];
  const overflow: { from: number; to: number; count: number }[] = [];
  let failed = 0;
  for (const exchange of visible) {
    const statusClass = statusClassOf(exchange);
    if (statusClass === 'failed' || statusClass === '5xx') failed++;
    const start = (Math.max(exchange.ts, fromTs) - fromTs) * pxPerMs;
    const end = (Math.min(exchange.endTs ?? openEnd, toTs) - fromTs) * pxPerMs;
    const x0 = Math.min(start, widthPx - MIN_BAR_PX);
    const x1 = Math.max(end, x0 + MIN_BAR_PX);
    const row = rowEnds.findIndex((rowEnd) => rowEnd + BAR_GAP_PX <= x0);
    if (row !== -1) {
      rowEnds[row] = x1;
      bars.push({ exchange, row, left: x0 / widthPx, width: (x1 - x0) / widthPx });
      continue;
    }
    const last = overflow[overflow.length - 1];
    if (last !== undefined && x0 <= last.to + BAR_GAP_PX) {
      last.to = Math.max(last.to, x1);
      last.count++;
    } else {
      overflow.push({ from: x0, to: x1, count: 1 });
    }
  }
  return {
    bars,
    overflow: overflow.map((o) => ({
      left: o.from / widthPx,
      width: (o.to - o.from) / widthPx,
      count: o.count,
    })),
    total: visible.length,
    failed,
  };
}

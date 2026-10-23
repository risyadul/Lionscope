/**
 * The network inspector's shared rules: redaction (the SDK applies the same on the device; the server re-applies it to
 * whatever an SDK sends), status classes and filtering (the dashboard's Network tab and the agent's get_network), and
 * mock rule normalisation, precedence and matching (the server orders rules this way; the SDK takes the first match,
 * with the same matching as `mockMatches`).
 */
import { HTTP_REDACTED } from '../wire.ts';
import type { HttpExchange, HttpHeader, MockMatch, NetworkMockRule } from '../wire.ts';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_NAME = /token|secret|api[-_]?key|auth|session|password/i;

/** A header, query parameter or form field whose value is never kept. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) || SENSITIVE_NAME.test(name);
}

export function redactHeaders(headers: readonly HttpHeader[]): HttpHeader[] {
  return headers.map(([name, value]) => [name, isSensitiveName(name) ? HTTP_REDACTED : value]);
}

/** The name of a `name=value` pair as written (percent- and `+`-decoded when it can be). */
function pairName(pair: string): string {
  const equals = pair.indexOf('=');
  const raw = (equals === -1 ? pair : pair.slice(0, equals)).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `a=1&token=x` with the values of sensitive names replaced; pairs without `=` are kept as they are. */
export function redactPairs(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1 || !isSensitiveName(pairName(pair))) return pair;
      return `${pair.slice(0, equals + 1)}${HTTP_REDACTED}`;
    })
    .join('&');
}

/** The URL with the values of sensitive query parameters replaced (a display string: not re-encoded). */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash);
  const question = beforeHash.indexOf('?');
  if (question === -1) return url;
  return `${beforeHash.slice(0, question + 1)}${redactPairs(beforeHash.slice(question + 1))}${fragment}`;
}

/** `application/x-www-form-urlencoded`, any parameters. */
export function isFormContentType(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

// ---------------------------------------------------------------------------
// Status classes, URL parts and filtering
// ---------------------------------------------------------------------------

export type HttpStatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed' | 'pending';

export const HTTP_STATUS_CLASSES: readonly HttpStatusClass[] = [
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'failed',
  'pending',
];

export function statusClassOf(exchange: Pick<HttpExchange, 'state' | 'status'>): HttpStatusClass {
  if (exchange.state === 'failed') return 'failed';
  if (exchange.state === 'pending' || exchange.status === null) return 'pending';
  if (exchange.status < 200) return '1xx';
  if (exchange.status < 300) return '2xx';
  if (exchange.status < 400) return '3xx';
  if (exchange.status < 500) return '4xx';
  return '5xx';
}

export interface UrlParts {
  /** `https`, lower case. */
  scheme: string;
  /** `api.example.com:8443`, as written. */
  host: string;
  /** `/v1/items` (`/` when empty). */
  path: string;
  /** Without the `?`, `''` when none. */
  query: string;
}

/** Splits an absolute URL without normalising it (works on redacted URLs; never throws). */
export function urlParts(url: string): UrlParts {
  const scheme = url.indexOf('://');
  const rest = scheme === -1 ? url : url.slice(scheme + 3);
  const hash = rest.indexOf('#');
  const withoutHash = hash === -1 ? rest : rest.slice(0, hash);
  const question = withoutHash.indexOf('?');
  const beforeQuery = question === -1 ? withoutHash : withoutHash.slice(0, question);
  const slash = beforeQuery.indexOf('/');
  return {
    scheme: scheme === -1 ? '' : url.slice(0, scheme).toLowerCase(),
    host: slash === -1 ? beforeQuery : beforeQuery.slice(0, slash),
    path: slash === -1 ? '/' : beforeQuery.slice(slash),
    query: question === -1 ? '' : withoutHash.slice(question + 1),
  };
}

export interface HttpFilter {
  /** Case-insensitive substring of the method, URL or status. */
  query: string;
  /** Upper-case method, or null for any. */
  method: string | null;
  /** Null for any. */
  statusClass: HttpStatusClass | null;
  /** true: mocked only, false: real only, null: both. */
  mocked: boolean | null;
}

export const NO_HTTP_FILTER: HttpFilter = { query: '', method: null, statusClass: null, mocked: null };

export function matchesExchange(exchange: HttpExchange, filter: HttpFilter): boolean {
  if (filter.method !== null && exchange.method !== filter.method) return false;
  if (filter.statusClass !== null && statusClassOf(exchange) !== filter.statusClass) return false;
  if (filter.mocked !== null && (exchange.mockId !== null) !== filter.mocked) return false;
  const needle = filter.query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    exchange.url.toLowerCase().includes(needle) ||
    exchange.method.toLowerCase() === needle ||
    (exchange.status !== null && String(exchange.status).startsWith(needle))
  );
}

/** Exchanges that overlap [fromTs, toTs] (a pending one lasts until `now`). */
export function exchangesInWindow<T extends HttpExchange>(
  exchanges: readonly T[],
  fromTs: number,
  toTs: number,
  now: number,
): T[] {
  return exchanges.filter((exchange) => exchange.ts <= toTs && (exchange.endTs ?? now) >= fromTs);
}

// ---------------------------------------------------------------------------
// Mock rules: normalisation, precedence and matching
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: ':80', https: ':443' };

/** Scheme and host in lower case, and a default port dropped, as OkHttp prints request URLs. */
export function normalizeMockUrl(url: string): string {
  const scheme = url.indexOf('://');
  if (scheme === -1) return url;
  const authorityStart = scheme + 3;
  const ends = ['/', '?', '#'].map((char) => url.indexOf(char, authorityStart)).filter((at) => at !== -1);
  const authorityEnd = ends.length > 0 ? Math.min(...ends) : url.length;
  const schemeName = url.slice(0, scheme).toLowerCase();
  let authority = url.slice(authorityStart, authorityEnd).toLowerCase();
  const port = DEFAULT_PORTS[schemeName];
  if (port && authority.endsWith(port)) authority = authority.slice(0, -port.length);
  return `${schemeName}://${authority}${url.slice(authorityEnd)}`;
}

const MATCH_RANK: Readonly<Record<MockMatch, number>> = { exact: 0, prefix: 1, glob: 2 };

/** Characters of the pattern that must match literally. */
function literalLength(rule: Pick<NetworkMockRule, 'match' | 'url'>): number {
  return rule.match === 'glob' ? rule.url.replace(/\*/g, '').length : rule.url.length;
}

/**
 * Precedence: exact before prefix before glob; then the longer literal; then a specific method before any; then the
 * most recently changed. Ties are kept in their order.
 */
export function compareMocks(a: NetworkMockRule, b: NetworkMockRule): number {
  return (
    MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
    literalLength(b) - literalLength(a) ||
    Number(a.method === null) - Number(b.method === null) ||
    b.updatedAt - a.updatedAt
  );
}

export function orderMocks(rules: readonly NetworkMockRule[]): NetworkMockRule[] {
  return [...rules].sort(compareMocks);
}

/** The part of a request URL a pattern is compared with: without `?query` and `#fragment` unless it has a `?`. */
export function mockTarget(pattern: string, requestUrl: string): string {
  const hash = requestUrl.indexOf('#');
  const url = hash === -1 ? requestUrl : requestUrl.slice(0, hash);
  if (pattern.includes('?')) return url;
  const question = url.indexOf('?');
  return question === -1 ? url : url.slice(0, question);
}

/** `*` matches any run of characters (`/` included); everything else is literal. Linear in practice (≤ 8 stars). */
export function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function mockMatches(
  rule: Pick<NetworkMockRule, 'method' | 'match' | 'url'>,
  method: string,
  url: string,
): boolean {
  if (rule.method !== null && rule.method !== method) return false;
  const target = mockTarget(rule.url, url);
  switch (rule.match) {
    case 'exact':
      return target === rule.url;
    case 'prefix':
      return target.startsWith(rule.url);
    case 'glob':
      return globMatches(rule.url, target);
  }
}

/** The rule that answers a request: the first enabled match of rules in precedence order. */
export function findMock<T extends NetworkMockRule>(
  rules: readonly T[],
  method: string,
  url: string,
): T | null {
  return rules.find((rule) => rule.enabled && mockMatches(rule, method, url)) ?? null;
}

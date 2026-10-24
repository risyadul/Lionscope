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

/** Names whose values are never kept, whatever their case. */
const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'key',
  'code',
  'sig',
  'pass',
  'pwd',
]);
/** Anywhere in the name (`X-Auth-Token`, `client_secret`, `X-Amz-Credential`, `X-Firebase-AppCheck`). */
const SENSITIVE_PART =
  /token|secret|api[-_]?key|auth|session|passw(?:or)?d|credential|signature|appcheck|jwt/i;
/** At the end after a separator (`private_key`, `Ocp-Apim-Subscription-Key`, `aws.sig`). */
const SENSITIVE_SUFFIX = /[-_.](?:key|sig|pwd|pass)$/i;
/** At the end of a camelCase name (`accessKey`, `userPwd`); case-sensitive on purpose (not `monkey`). */
const SENSITIVE_CAMEL_SUFFIX = /[a-z0-9](?:Key|Sig|Pwd|Pass)$/;
/** Headers whose values are URLs (`Link`: `<url>; rel=…`): their query, fragment and userinfo are redacted. */
const URL_HEADERS: ReadonlySet<string> = new Set(['location', 'content-location', 'referer', 'link']);

/** A header, query parameter, form field, JSON key or XML element / attribute whose value is never kept. */
export function isSensitiveName(name: string): boolean {
  return (
    SENSITIVE_EXACT.has(name.toLowerCase()) ||
    SENSITIVE_PART.test(name) ||
    SENSITIVE_SUFFIX.test(name) ||
    SENSITIVE_CAMEL_SUFFIX.test(name)
  );
}

/** Sensitive values replaced; URL-valued headers (`Location`, `Referer`, `Link`, …) redacted like URLs. */
export function redactHeaders(headers: readonly HttpHeader[]): HttpHeader[] {
  return headers.map(([name, value]) => {
    if (isSensitiveName(name)) return [name, HTTP_REDACTED];
    if (!URL_HEADERS.has(name.toLowerCase())) return [name, value];
    return [
      name,
      value.includes('<')
        ? value.replace(/<([^<>]*)>/g, (_, url: string) => `<${redactUrl(url)}>`)
        : redactUrl(value),
    ];
  });
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

/**
 * The URL with its userinfo (`user:pass@`) and the values of sensitive query and fragment parameters
 * (`#access_token=…`) replaced. A display string: not re-encoded.
 */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  let beforeHash = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : `#${redactPairs(url.slice(hash + 1))}`;
  const scheme = beforeHash.indexOf('://');
  if (scheme !== -1) {
    const authorityStart = scheme + 3;
    const ends = ['/', '?'].map((char) => beforeHash.indexOf(char, authorityStart)).filter((at) => at !== -1);
    const authorityEnd = ends.length > 0 ? Math.min(...ends) : beforeHash.length;
    const at = beforeHash.lastIndexOf('@', authorityEnd - 1);
    if (at >= authorityStart) {
      beforeHash = `${beforeHash.slice(0, authorityStart)}${HTTP_REDACTED}${beforeHash.slice(at)}`;
    }
  }
  const question = beforeHash.indexOf('?');
  const query = question === -1 ? '' : `?${redactPairs(beforeHash.slice(question + 1))}`;
  return `${question === -1 ? beforeHash : beforeHash.slice(0, question)}${query}${fragment}`;
}

/** The media type of a Content-Type, lower case, without parameters (`application/json`). */
function mediaType(contentType: string | null): string {
  return contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** `application/x-www-form-urlencoded`, any parameters. */
export function isFormContentType(contentType: string | null): boolean {
  return mediaType(contentType) === 'application/x-www-form-urlencoded';
}

export function isJsonContentType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === 'application/json' || type.endsWith('+json');
}

export function isXmlContentType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml');
}

/** Index after the JSON string starting at `start` (a `"`), or `text.length` when it is cut off. */
function jsonStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** Index after the JSON value starting at `start`, or -1 when the text ends inside it. */
function jsonValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    const end = jsonStringEnd(text, start);
    return end === text.length && text[end - 1] !== '"' ? -1 : end;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char === '"') i = jsonStringEnd(text, i) - 1;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) return i + 1;
    }
    return -1;
  }
  for (let i = start; i < text.length; i++) {
    if (',}] \t\r\n'.includes(text[i] ?? '')) return i;
  }
  return -1;
}

const isJsonSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

/**
 * JSON text with the value of every sensitive key (any depth; strings, numbers, objects, arrays alike) replaced by
 * `"‹redacted›"`. Works on text cut short (a captured body's first 64 KB): a sensitive value that runs past the end
 * is dropped. Anything that is not JSON passes through unchanged, except a `"name": value` that looks like one.
 */
export function redactJsonText(text: string): string {
  let out = '';
  const stack: string[] = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? '';
    if (char !== '"') {
      if (char === '{') {
        stack.push('{');
        expectKey = true;
      } else if (char === '[') {
        stack.push('[');
      } else if (char === '}' || char === ']') {
        stack.pop();
        expectKey = false;
      } else if (char === ',') {
        expectKey = stack.at(-1) === '{';
      }
      out += char;
      i++;
      continue;
    }
    const end = jsonStringEnd(text, i);
    const token = text.slice(i, end);
    out += token;
    i = end;
    if (!expectKey) continue;
    expectKey = false;
    let colon = i;
    while (isJsonSpace(text[colon])) colon++;
    if (text[colon] !== ':' || !isSensitiveName(jsonKey(token))) continue;
    let value = colon + 1;
    while (isJsonSpace(text[value])) value++;
    out += text.slice(i, value);
    // Cut right after the colon: nothing of the value was captured.
    if (value >= text.length) break;
    const valueEnd = jsonValueEnd(text, value);
    out += JSON.stringify(HTTP_REDACTED);
    i = valueEnd === -1 ? text.length : valueEnd;
  }
  return out;
}

/** A JSON string token's text (`"a\u0062"` → `ab`); the raw characters when it doesn't decode. */
function jsonKey(token: string): string {
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === 'string' ? value : token;
  } catch {
    return token.slice(1, token.endsWith('"') && token.length > 1 ? -1 : undefined);
  }
}

const XML_ELEMENT = /<([A-Za-z_][\w.:-]*)(\s[^<>]*)?>([^<]*)<\/\1\s*>/g;
const XML_ATTRIBUTE = /(\s)([A-Za-z_][\w.:-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/** XML text with the text of sensitive elements (`<password>…</password>`) and sensitive attribute values replaced. */
export function redactXmlText(text: string): string {
  return text
    .replace(XML_ELEMENT, (match: string, name: string, attributes: string | undefined) =>
      isSensitiveName(localName(name)) ? `<${name}${attributes ?? ''}>${HTTP_REDACTED}</${name}>` : match,
    )
    .replace(XML_ATTRIBUTE, (match: string, space: string, name: string, equals: string, value: string) =>
      isSensitiveName(localName(name))
        ? `${space}${name}${equals}${value[0]}${HTTP_REDACTED}${value[0]}`
        : match,
    );
}

/** A captured body's text with sensitive values replaced: form fields, JSON keys, XML elements and attributes. */
export function redactBodyText(contentType: string | null, text: string): string {
  if (isFormContentType(contentType)) return redactPairs(text);
  if (isJsonContentType(contentType)) return redactJsonText(text);
  if (isXmlContentType(contentType)) return redactXmlText(text);
  return text;
}

const FREE_TEXT_URL = /https?:\/\/[^\s"'<>]+/gi;
const FREE_TEXT_PAIR = /([\w.-]+)=([^\s&;,"']+)/g;
const FREE_TEXT_AUTH = /\b(Bearer|Basic|Token)\s+[^\s,;"']+/gi;

/** Free text (an exception message): URLs, sensitive `name=value` pairs and `Bearer …` credentials redacted. */
export function redactFreeText(text: string): string {
  return text
    .replace(FREE_TEXT_URL, (url) => redactUrl(url))
    .replace(FREE_TEXT_PAIR, (match: string, name: string) =>
      isSensitiveName(name) ? `${name}=${HTTP_REDACTED}` : match,
    )
    .replace(FREE_TEXT_AUTH, (_, scheme: string) => `${scheme} ${HTTP_REDACTED}`);
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

/** Scheme and host in lower case, a default port dropped and a bare origin's `/` added, as OkHttp prints request URLs. */
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
  // OkHttp prints a bare origin with its `/` (`https://api.example.com/`).
  const rest = url[authorityEnd] === '/' ? url.slice(authorityEnd) : `/${url.slice(authorityEnd)}`;
  return `${schemeName}://${authority}${rest}`;
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

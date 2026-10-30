import { MAX_HTTP_SUMMARY_URL_CHARS } from '@lionscope/protocol';
import { redactBodyText, redactFreeText, redactHeaders, redactUrl } from '@lionscope/protocol/insights';
import type {
  DeviceMessage,
  HttpBody,
  HttpExchange,
  HttpExchangeDetail,
  HttpFailure,
  HttpHeader,
  ServerMessage,
} from '@lionscope/protocol';
import { ErrorThrottle } from '../errors.ts';
import { log } from '../log.ts';

export type SdkHttpRequest = Extract<DeviceMessage, { type: 'httpRequest' }>;
export type SdkHttpResponse = Extract<DeviceMessage, { type: 'httpResponse' }>;

export const MAX_HTTP_EXCHANGES = 5000;
/** UTF-8 bytes of the kept URLs, headers and body texts. */
export const MAX_HTTP_STORE_BYTES = 32 * 1024 * 1024;
export const LOST_LINK_MESSAGE = 'SDK link closed before the response';

/** The last server id handed out: ids increase and stay unique for the process's lifetime, across sessions. */
let lastExchangeId = 0;

interface Entry {
  detail: HttpExchangeDetail;
  /** sizeOf(detail), as counted in `NetworkStore.bytes`. */
  bytes: number;
  link: object;
  sdkId: number;
}

export interface NetworkStoreOptions {
  windowMs: number;
  emit: (message: ServerMessage) => void;
  now: () => number;
  /** The top screen at a laptop time (the session's screen spans). */
  topScreenAt: (ts: number) => string | null;
  maxExchanges?: number;
  maxBytes?: number;
}

const utf8Bytes = (text: string | null | undefined): number => (text ? Buffer.byteLength(text) : 0);

function headersBytes(headers: readonly HttpHeader[]): number {
  return headers.reduce((sum, [name, value]) => sum + utf8Bytes(name) + utf8Bytes(value), 0);
}

function sizeOf(detail: HttpExchangeDetail): number {
  return (
    utf8Bytes(detail.url) +
    headersBytes(detail.requestHeaders) +
    headersBytes(detail.responseHeaders) +
    utf8Bytes(detail.requestBody?.text) +
    utf8Bytes(detail.responseBody?.text)
  );
}

/** Sensitive form fields, JSON keys and XML elements are redacted again (an older or foreign SDK may not have). */
function redactBody(body: HttpBody | null): HttpBody | null {
  if (!body) return null;
  const { size, contentType, text, truncated, omitted } = body;
  return {
    size,
    contentType,
    text: text === null ? null : redactBodyText(contentType, text),
    truncated,
    omitted,
  };
}

/** An exception message can quote a URL or a credential. */
function redactError(error: HttpFailure | null): HttpFailure | null {
  if (error === null) return null;
  return { kind: error.kind, message: error.message === null ? null : redactFreeText(error.message) };
}

/** A summary's URL: at most MAX_HTTP_SUMMARY_URL_CHARS, ending in `…` when cut (never inside a surrogate pair). */
export function summaryUrl(url: string): string {
  if (url.length <= MAX_HTTP_SUMMARY_URL_CHARS) return url;
  let end = MAX_HTTP_SUMMARY_URL_CHARS - 1;
  const last = url.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${url.slice(0, end)}…`;
}

function headerValue(headers: readonly HttpHeader[], name: string): string | null {
  return headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1] ?? null;
}

export function summaryOf(detail: HttpExchangeDetail): HttpExchange {
  const {
    protocol: _protocol,
    requestHeaders: _requestHeaders,
    responseHeaders: _responseHeaders,
    requestBody: _requestBody,
    responseBody: _responseBody,
    ...summary
  } = detail;
  return { ...summary, url: summaryUrl(summary.url) };
}

/**
 * The HTTP exchanges of one profiling session, as the SDK's OkHttp interceptor reports them (device protocol v7):
 * an `httpRequest` opens a pending exchange under a new server id, the `httpResponse` with the same SDK id on the
 * same link completes or fails it. Redaction (headers, URLs, form / JSON / XML bodies, error messages) is applied
 * again to whatever arrives; summaries carry the URL cut to MAX_HTTP_SUMMARY_URL_CHARS, details whole. Bounded like the other streams: the window (by start), MAX_HTTP_EXCHANGES and MAX_HTTP_STORE_BYTES,
 * oldest first. Every change is announced as an `http` message (the summary); details are read on demand.
 */
export class NetworkStore {
  /** By server id, in arrival order. */
  private readonly entries = new Map<number, Entry>();
  /** Per link, SDK id → server id of the exchanges still kept. */
  private readonly links = new Map<object, Map<number, number>>();
  private readonly warnings: ErrorThrottle;
  private readonly maxExchanges: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private seen = 0;
  private orphans = 0;
  private duplicates = 0;
  private ended = false;

  constructor(private readonly options: NetworkStoreOptions) {
    this.warnings = new ErrorThrottle(options.now);
    this.maxExchanges = options.maxExchanges ?? MAX_HTTP_EXCHANGES;
    this.maxBytes = options.maxBytes ?? MAX_HTTP_STORE_BYTES;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Exchanges kept, pruned against the clock first (no summaries built). */
  count(): number {
    this.prune();
    return this.entries.size;
  }

  /** Exchanges that started in this session, kept or pruned. */
  get totalSeen(): number {
    return this.seen;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  /** Responses without a known request, and repeated requests or responses: dropped. */
  get dropped(): { orphans: number; duplicates: number } {
    return { orphans: this.orphans, duplicates: this.duplicates };
  }

  /** A call started at `ts` (laptop clock, already clamped into the session). */
  request(link: object, ts: number, message: SdkHttpRequest): void {
    if (this.ended) return;
    let ids = this.links.get(link);
    if (ids?.has(message.id)) return this.duplicate('httpRequest');
    this.seen += 1;
    const detail: HttpExchangeDetail = {
      id: ++lastExchangeId,
      ts,
      endTs: null,
      method: message.method,
      url: redactUrl(message.url),
      state: 'pending',
      status: null,
      headersMs: null,
      durationMs: null,
      requestSize: message.body?.size ?? null,
      responseSize: null,
      responseType: null,
      mockId: message.mockId,
      error: null,
      screen: this.options.topScreenAt(ts),
      protocol: null,
      requestHeaders: redactHeaders(message.headers),
      responseHeaders: [],
      requestBody: redactBody(message.body),
      responseBody: null,
    };
    if (!ids) {
      ids = new Map();
      this.links.set(link, ids);
    }
    ids.set(message.id, detail.id);
    const entry: Entry = { detail, bytes: sizeOf(detail), link, sdkId: message.id };
    this.entries.set(detail.id, entry);
    this.bytes += entry.bytes;
    this.prune();
    if (this.entries.has(detail.id)) this.announce(detail);
  }

  /** The call ended: completed (a status), or failed (`error`). */
  response(link: object, message: SdkHttpResponse): void {
    if (this.ended) return;
    const id = this.links.get(link)?.get(message.id);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (!entry) {
      this.orphans += 1;
      if (this.warnings.shouldReport('orphan')) {
        log.warn(`Network: dropped an SDK httpResponse without its request, ${this.orphans} so far`);
      }
      return;
    }
    if (entry.detail.state !== 'pending') return this.duplicate('httpResponse');
    const headers = redactHeaders(message.headers);
    const body = redactBody(message.body);
    // The SDK's duration is kept as reported; its end can't lie in the future.
    this.replace(entry, {
      ...entry.detail,
      endTs: Math.min(entry.detail.ts + message.durationMs, Math.max(entry.detail.ts, this.options.now())),
      state: message.error ? 'failed' : 'complete',
      status: message.status,
      headersMs: message.headersMs,
      durationMs: message.durationMs,
      responseSize: body?.size ?? null,
      responseType: body?.contentType ?? headerValue(headers, 'content-type'),
      error: redactError(message.error),
      protocol: message.protocol,
      responseHeaders: headers,
      responseBody: body,
    });
  }

  /** A link is gone: its exchanges still waiting for a response failed (`lost`). */
  linkClosed(link: object): void {
    const ids = this.links.get(link);
    if (!ids) return;
    this.links.delete(link);
    for (const id of ids.values()) {
      const entry = this.entries.get(id);
      if (entry?.detail.state === 'pending') this.lose(entry);
    }
  }

  /** The session stopped: every pending exchange is lost, and nothing more is recorded. */
  end(): void {
    if (this.ended) return;
    for (const link of [...this.links.keys()]) this.linkClosed(link);
    this.ended = true;
  }

  /** Summaries, oldest first (pruned against the clock first). */
  summaries(): HttpExchange[] {
    this.prune();
    return [...this.entries.values()].map((entry) => summaryOf(entry.detail));
  }

  /** Headers and bodies of one exchange; null when it is not (or no longer) kept. */
  detail(id: number): HttpExchangeDetail | null {
    this.prune();
    return this.entries.get(id)?.detail ?? null;
  }

  private lose(entry: Entry): void {
    const endTs = Math.max(entry.detail.ts, this.options.now());
    this.replace(entry, {
      ...entry.detail,
      endTs,
      state: 'failed',
      durationMs: endTs - entry.detail.ts,
      error: { kind: 'lost', message: LOST_LINK_MESSAGE },
    });
  }

  private replace(entry: Entry, detail: HttpExchangeDetail): void {
    const bytes = sizeOf(detail);
    this.bytes += bytes - entry.bytes;
    entry.detail = detail;
    entry.bytes = bytes;
    this.prune();
    if (this.entries.get(detail.id) === entry) this.announce(detail);
  }

  private announce(detail: HttpExchangeDetail): void {
    this.options.emit({ type: 'http', exchange: summaryOf(detail) });
  }

  private duplicate(type: SdkHttpRequest['type'] | SdkHttpResponse['type']): void {
    this.duplicates += 1;
    if (this.warnings.shouldReport('duplicate')) {
      log.warn(`Network: dropped a repeated SDK ${type} id, ${this.duplicates} so far`);
    }
  }

  /** Oldest first: out of the window (by start), or over the count or byte cap. */
  private prune(): void {
    const cutoff = this.options.now() - this.options.windowMs;
    for (const [id, entry] of this.entries) {
      const over = this.entries.size > this.maxExchanges || this.bytes > this.maxBytes;
      if (!over && entry.detail.ts >= cutoff) return;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
      this.links.get(entry.link)?.delete(entry.sdkId);
    }
  }
}

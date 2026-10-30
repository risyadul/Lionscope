import { HTTP_REDACTED, MAX_HTTP_SUMMARY_URL_CHARS } from '@lionscope/protocol';
import type { HttpExchange, ServerMessage } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { LOST_LINK_MESSAGE, NetworkStore, summaryUrl } from '../src/store/networkStore.ts';
import type { SdkHttpRequest, SdkHttpResponse } from '../src/store/networkStore.ts';
import { SessionStore } from '../src/store/sessionStore.ts';

const T0 = 1_800_000_000_000;
const WINDOW_MS = 10 * 60_000;

function request(id: number, overrides: Partial<SdkHttpRequest> = {}): SdkHttpRequest {
  return {
    type: 'httpRequest',
    id,
    ts: 0,
    method: 'GET',
    url: `https://api.example.com/v1/items/${id}`,
    headers: [['Accept', 'application/json']],
    body: null,
    mockId: null,
    dropped: 0,
    ...overrides,
  };
}

function response(id: number, overrides: Partial<SdkHttpResponse> = {}): SdkHttpResponse {
  return {
    type: 'httpResponse',
    id,
    ts: 0,
    status: 200,
    protocol: 'h2',
    headers: [['Content-Type', 'application/json; charset=utf-8']],
    body: {
      size: 2,
      contentType: 'application/json; charset=utf-8',
      text: '[]',
      truncated: false,
      omitted: null,
    },
    headersMs: 80.5,
    durationMs: 120.25,
    error: null,
    ...overrides,
  };
}

function setup(limits: { maxExchanges?: number; maxBytes?: number } = {}) {
  let clock = T0;
  const messages: ServerMessage[] = [];
  const store = new NetworkStore({
    windowMs: WINDOW_MS,
    emit: (message) => messages.push(message),
    now: () => clock,
    topScreenAt: (ts) => (ts >= T0 + 1000 ? 'Cart' : 'Home'),
    ...limits,
  });
  const announced = () =>
    messages.flatMap((message): HttpExchange[] => (message.type === 'http' ? [message.exchange] : []));
  return {
    store,
    messages,
    announced,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('NetworkStore', () => {
  it('opens a pending exchange on a request and completes it on its response, announcing both', () => {
    const { store, announced, advance } = setup();
    advance(5000);
    const link = {};
    store.request(
      link,
      T0 + 2000,
      request(7, {
        body: { size: 9, contentType: 'text/plain', text: 'hello sdk', truncated: false, omitted: null },
      }),
    );
    const [pending] = announced();
    expect(pending).toMatchObject({
      ts: T0 + 2000,
      endTs: null,
      method: 'GET',
      url: 'https://api.example.com/v1/items/7',
      state: 'pending',
      status: null,
      durationMs: null,
      requestSize: 9,
      responseSize: null,
      mockId: null,
      error: null,
      screen: 'Cart',
    });
    store.response(link, response(7));
    const completed = announced()[1];
    expect(completed).toEqual({
      ...pending,
      endTs: T0 + 2000 + 120.25,
      state: 'complete',
      status: 200,
      headersMs: 80.5,
      durationMs: 120.25,
      responseSize: 2,
      responseType: 'application/json; charset=utf-8',
    });
    expect(store.summaries()).toEqual([completed]);
    expect(store.detail(completed?.id ?? -1)).toMatchObject({
      protocol: 'h2',
      requestHeaders: [['Accept', 'application/json']],
      responseHeaders: [['Content-Type', 'application/json; charset=utf-8']],
      requestBody: { text: 'hello sdk' },
      responseBody: { text: '[]' },
    });
    expect(store.detail(123_456)).toBeNull();
  });

  it('marks a failed call, taking the response type from the header when there is no body', () => {
    const { store, announced } = setup();
    const link = {};
    store.request(link, T0, request(1));
    store.response(link, {
      ...response(1),
      status: null,
      protocol: null,
      headers: [],
      body: null,
      headersMs: null,
      durationMs: 10_003.5,
      error: { kind: 'timeout', message: 'SocketTimeoutException: timeout' },
    });
    expect(announced()[1]).toMatchObject({
      state: 'failed',
      status: null,
      responseType: null,
      error: { kind: 'timeout', message: 'SocketTimeoutException: timeout' },
    });
    store.request(link, T0, request(2));
    store.response(link, response(2, { body: null, headers: [['content-type', 'image/png']] }));
    expect(announced()[3]).toMatchObject({
      state: 'complete',
      responseType: 'image/png',
      responseSize: null,
    });
  });

  it('gives server ids that increase across stores, mapping SDK ids per link', () => {
    const { store } = setup();
    const other = setup().store;
    const [a, b] = [{}, {}];
    store.request(a, T0, request(1));
    store.request(b, T0, request(1)); // the same SDK id on another link (a restarted app) is another exchange
    other.request(a, T0, request(1));
    const ids = [...store.summaries(), ...other.summaries()].map((exchange) => exchange.id);
    expect(ids[1]).toBeGreaterThan(ids[0] ?? Infinity);
    expect(ids[2]).toBeGreaterThan(ids[1] ?? Infinity);
    store.response(b, response(1, { status: 404 }));
    expect(store.summaries().map((exchange) => exchange.status)).toEqual([null, 404]);
  });

  it('drops orphan responses and repeated requests or responses, counting them', () => {
    const { store, announced } = setup();
    const link = {};
    store.response(link, response(9));
    store.request(link, T0, request(1));
    store.request(link, T0, request(1, { url: 'https://api.example.com/other' }));
    store.response(link, response(1));
    store.response(link, response(1, { status: 500 }));
    store.response({}, response(1)); // another link's id 1
    expect(store.dropped).toEqual({ orphans: 2, duplicates: 2 });
    expect(announced()).toHaveLength(2);
    expect(store.summaries()).toMatchObject([{ url: 'https://api.example.com/v1/items/1', status: 200 }]);
  });

  it('re-applies redaction to headers, URLs, form / JSON / XML bodies and error messages', () => {
    const { store } = setup();
    const link = {};
    const form = 'user=ada&password=hunter2&api_key=k-123&note=a+b';
    store.request(
      link,
      T0,
      request(1, {
        method: 'POST',
        url: 'https://api.example.com/login?next=%2Fhome&access_token=abc#top',
        headers: [
          ['Authorization', 'Bearer abc'],
          ['X-Session-Id', 's-1'],
          ['Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8'],
        ],
        body: {
          size: form.length,
          contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
          text: form,
          truncated: false,
          omitted: null,
        },
      }),
    );
    store.response(
      link,
      response(1, {
        headers: [
          ['Set-Cookie', 'sid=1'],
          ['Location', 'https://ada:pw@example.com/next?code=c-1'],
        ],
        body: {
          size: 13,
          contentType: 'application/json',
          text: '{"token":"t","user":{"accessKey":[1,2]},"n":1}',
          truncated: false,
          omitted: null,
        },
      }),
    );
    const [summary] = store.summaries();
    expect(summary?.url).toBe(`https://api.example.com/login?next=%2Fhome&access_token=${HTTP_REDACTED}#top`);
    const detail = store.detail(summary?.id ?? -1);
    expect(detail?.requestHeaders).toEqual([
      ['Authorization', HTTP_REDACTED],
      ['X-Session-Id', HTTP_REDACTED],
      ['Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8'],
    ]);
    expect(detail?.requestBody?.text).toBe(
      `user=ada&password=${HTTP_REDACTED}&api_key=${HTTP_REDACTED}&note=a+b`,
    );
    expect(detail?.responseHeaders).toEqual([
      ['Set-Cookie', HTTP_REDACTED],
      ['Location', `https://${HTTP_REDACTED}@example.com/next?code=${HTTP_REDACTED}`],
    ]);
    expect(detail?.responseBody?.text).toBe(
      `{"token":"${HTTP_REDACTED}","user":{"accessKey":"${HTTP_REDACTED}"},"n":1}`,
    );

    const xml = '<login><user>ada</user><password>hunter2</password></login>';
    const xmlBody = { size: xml.length, contentType: 'text/xml', text: xml, truncated: false, omitted: null };
    store.request(link, T0, request(2, { method: 'POST', body: xmlBody }));
    store.response(
      link,
      response(2, {
        status: null,
        body: null,
        error: {
          kind: 'connection',
          message: 'SSLHandshakeException: https://api.example.com/x?token=t-9 failed, Bearer abc.def',
        },
      }),
    );
    const failed = store.summaries()[1];
    expect(store.detail(failed?.id ?? -1)?.requestBody?.text).toBe(
      `<login><user>ada</user><password>${HTTP_REDACTED}</password></login>`,
    );
    expect(failed?.error).toEqual({
      kind: 'connection',
      message: `SSLHandshakeException: https://api.example.com/x?token=${HTTP_REDACTED} failed, Bearer ${HTTP_REDACTED}`,
    });
  });

  it('keeps the reported duration but never ends an exchange in the future', () => {
    const { store, announced, advance } = setup();
    const link = {};
    store.request(link, T0, request(1));
    advance(100);
    store.response(link, response(1, { durationMs: 60_000 }));
    expect(announced().at(-1)).toMatchObject({ ts: T0, endTs: T0 + 100, durationMs: 60_000 });
  });

  it(`cuts summary URLs to ${MAX_HTTP_SUMMARY_URL_CHARS} characters, keeping the whole URL in the detail`, () => {
    const { store, announced } = setup();
    const url = `https://api.example.com/${'a'.repeat(MAX_HTTP_SUMMARY_URL_CHARS)}`;
    store.request({}, T0, request(1, { url }));
    const [summary] = store.summaries();
    expect(summary?.url).toHaveLength(MAX_HTTP_SUMMARY_URL_CHARS);
    expect(summary?.url).toBe(`${url.slice(0, MAX_HTTP_SUMMARY_URL_CHARS - 1)}…`);
    expect(announced()[0]?.url).toBe(summary?.url);
    expect(store.detail(summary?.id ?? -1)?.url).toBe(url);
    // Exactly at the limit: whole; a cut never splits a surrogate pair.
    const exact = 'h'.repeat(MAX_HTTP_SUMMARY_URL_CHARS);
    expect(summaryUrl(exact)).toBe(exact);
    const emoji = `${'h'.repeat(MAX_HTTP_SUMMARY_URL_CHARS - 2)}😀😀`;
    expect(summaryUrl(emoji)).toBe(`${'h'.repeat(MAX_HTTP_SUMMARY_URL_CHARS - 2)}…`);
  });

  it('counts the kept exchanges against the clock', () => {
    const { store, advance } = setup();
    store.request({}, T0, request(1));
    store.request({}, T0 + 1000, request(2));
    expect(store.count()).toBe(2);
    advance(WINDOW_MS + 500);
    expect(store.count()).toBe(1);
  });

  it('counts every exchange the session saw, pruned ones too, but not repeated requests', () => {
    const { store, advance } = setup();
    const link = {};
    store.request(link, T0, request(1));
    store.request(link, T0, request(1));
    store.request(link, T0 + 1000, request(2));
    advance(WINDOW_MS * 2);
    expect(store.count()).toBe(0);
    expect(store.totalSeen).toBe(2);
  });

  it('keeps the window by start time, evicting the oldest first', () => {
    const { store, advance } = setup();
    const link = {};
    store.request(link, T0, request(1));
    advance(60_000);
    store.request(link, T0 + 60_000, request(2));
    advance(WINDOW_MS - 30_000);
    expect(store.summaries().map((exchange) => exchange.url)).toEqual(['https://api.example.com/v1/items/2']);
    // An evicted exchange's response is an orphan.
    store.response(link, response(1));
    expect(store.dropped.orphans).toBe(1);
  });

  it('caps the count and the UTF-8 bytes of URLs, headers and bodies', () => {
    const counted = setup({ maxExchanges: 3 });
    for (let id = 1; id <= 5; id += 1) counted.store.request({}, T0, request(id));
    expect(counted.store.summaries().map((exchange) => exchange.url.at(-1))).toEqual(['3', '4', '5']);

    const sized = setup({ maxBytes: 1000 });
    const link = {};
    const text = 'é'.repeat(200); // 400 bytes
    const body = { size: 400, contentType: 'text/plain', text, truncated: false, omitted: null };
    sized.store.request(link, T0, request(1, { headers: [], url: 'https://a.example.com/', body }));
    expect(sized.store.totalBytes).toBe(400 + 'https://a.example.com/'.length);
    sized.store.request(link, T0, request(2, { headers: [], url: 'https://b.example.com/', body }));
    expect(sized.store.size).toBe(2);
    // The response body pushes the first exchange over: the oldest goes.
    sized.store.response(link, response(2, { headers: [], body }));
    expect(sized.store.summaries().map((exchange) => exchange.url)).toEqual(['https://b.example.com/']);
    expect(sized.store.totalBytes).toBe(800 + 'https://b.example.com/'.length);
  });

  it('fails the pending exchanges of a closed link as lost, and everything pending when the session ends', () => {
    const { store, advance, announced } = setup();
    const [a, b] = [{}, {}];
    store.request(a, T0, request(1));
    store.request(a, T0, request(2));
    store.response(a, response(2));
    store.request(b, T0, request(1));
    advance(1500);
    store.linkClosed(a);
    expect(announced().at(-1)).toMatchObject({
      url: 'https://api.example.com/v1/items/1',
      state: 'failed',
      endTs: T0 + 1500,
      durationMs: 1500,
      error: { kind: 'lost', message: LOST_LINK_MESSAGE },
    });
    store.response(a, response(1));
    expect(store.summaries().map((exchange) => exchange.state)).toEqual(['failed', 'complete', 'pending']);
    store.end();
    expect(store.summaries().map((exchange) => exchange.state)).toEqual(['failed', 'complete', 'failed']);
    store.request(b, T0, request(3));
    expect(store.size).toBe(3);
  });

  it('is part of the session snapshot (summaries only), empty in a new store', () => {
    const messages: ServerMessage[] = [];
    const store = new SessionStore({
      windowMs: WINDOW_MS,
      emit: (message) => messages.push(message),
      now: () => T0,
    });
    expect(store.snapshot().http).toEqual([]);
    store.http.request({}, T0, request(1));
    const [exchange] = store.snapshot().http;
    expect(exchange).toMatchObject({ state: 'pending', screen: null });
    expect(exchange).not.toHaveProperty('requestHeaders');
    expect(messages).toEqual([{ type: 'http', exchange }]);
  });
});

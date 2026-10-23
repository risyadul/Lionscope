import { describe, expect, it } from 'vitest';
import {
  compareMocks,
  exchangesInWindow,
  findMock,
  globMatches,
  isSensitiveName,
  matchesExchange,
  mockMatches,
  NO_HTTP_FILTER,
  normalizeMockUrl,
  orderMocks,
  redactBodyText,
  redactFreeText,
  redactHeaders,
  redactJsonText,
  redactPairs,
  redactUrl,
  redactXmlText,
  statusClassOf,
  urlParts,
} from '../src/insights/index.ts';
import { HTTP_REDACTED } from '../src/wire.ts';
import type { HttpExchange, NetworkMockRule } from '../src/wire.ts';

const R = HTTP_REDACTED;

describe('redaction', () => {
  it('knows the sensitive names', () => {
    for (const name of [
      'Authorization',
      'proxy-authorization',
      'Cookie',
      'Set-Cookie',
      'X-Auth-Token',
      'x-api-key',
      'X-API_KEY',
      'apikey',
      'client_secret',
      'SESSION',
      'password',
      'access_token',
      'key',
      'code',
      'sig',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'jwt',
      'pwd',
      'passwd',
      'Ocp-Apim-Subscription-Key',
      'X-Firebase-AppCheck',
      'private_key',
      'accessKey',
      'credentials',
    ]) {
      expect(isSensitiveName(name), name).toBe(true);
    }
    for (const name of [
      'Accept',
      'Content-Type',
      'page',
      'X-Request-Id',
      'monkey',
      'keyboard',
      'zipcode',
      'Location',
    ]) {
      expect(isSensitiveName(name), name).toBe(false);
    }
  });

  it('redacts header values and keeps their names and order', () => {
    expect(
      redactHeaders([
        ['Accept', 'application/json'],
        ['Authorization', 'Bearer abc'],
        ['Set-Cookie', 'sid=1'],
        ['Set-Cookie', 'theme=dark'],
      ]),
    ).toEqual([
      ['Accept', 'application/json'],
      ['Authorization', R],
      ['Set-Cookie', R],
      ['Set-Cookie', R],
    ]);
  });

  it('redacts query parameter values by name, decoded, and keeps the rest of the URL', () => {
    expect(redactUrl('https://api.example.com/v1/items?page=2&token=abc&api%5Fkey=k&x#top')).toBe(
      `https://api.example.com/v1/items?page=2&token=${R}&api%5Fkey=${R}&x#top`,
    );
    expect(redactUrl('https://api.example.com/v1/items')).toBe('https://api.example.com/v1/items');
    expect(redactUrl(`https://a.example.com/?token=${R}`)).toBe(`https://a.example.com/?token=${R}`);
    expect(redactUrl('https://a.example.com/?%E0%A4%A=1')).toBe('https://a.example.com/?%E0%A4%A=1');
  });

  it('redacts userinfo and fragment parameters', () => {
    expect(redactUrl('https://ana:hunter2@api.example.com/v1?page=1#access_token=abc&state=x')).toBe(
      `https://${R}@api.example.com/v1?page=1#access_token=${R}&state=x`,
    );
    expect(redactUrl('https://api.example.com/a@b')).toBe('https://api.example.com/a@b');
  });

  it('redacts URLs inside URL-valued headers', () => {
    expect(
      redactHeaders([
        ['Location', 'app://callback?code=abc&state=1'],
        ['Link', '<https://api.example.com/p?sig=1>; rel="next"'],
        ['X-Other', 'https://api.example.com/?token=kept-in-a-non-url-header'],
      ]),
    ).toEqual([
      ['Location', `app://callback?code=${R}&state=1`],
      ['Link', `<https://api.example.com/p?sig=${R}>; rel="next"`],
      ['X-Other', 'https://api.example.com/?token=kept-in-a-non-url-header'],
    ]);
  });

  it('redacts JSON keys at any depth, whatever the value, also in text cut short', () => {
    expect(
      redactJsonText(
        '{"user":"ana","password":"hunter2","nested":{"refresh_token":{"v":1},"list":[{"apiKey":42}]},"ok":true}',
      ),
    ).toBe(
      `{"user":"ana","password":"${R}","nested":{"refresh_token":"${R}","list":[{"apiKey":"${R}"}]},"ok":true}`,
    );
    expect(redactJsonText('{"a" : "x", "secret" :  "s\\"q"}')).toBe(`{"a" : "x", "secret" :  "${R}"}`);
    expect(redactJsonText('[{"token":"abc')).toBe(`[{"token":"${R}"`);
    expect(redactJsonText('{"token":')).toBe('{"token":');
    expect(redactJsonText('{"items":["token","x"],"note":"password: kept"}')).toBe(
      '{"items":["token","x"],"note":"password: kept"}',
    );
    expect(redactJsonText('not json')).toBe('not json');
  });

  it('redacts XML elements and attributes', () => {
    expect(
      redactXmlText(
        '<login user="ana" auth:token=\'t\'><ns:password>hunter2</ns:password><name>Ana</name></login>',
      ),
    ).toBe(`<login user="ana" auth:token='${R}'><ns:password>${R}</ns:password><name>Ana</name></login>`);
  });

  it('picks the body redaction by content type', () => {
    expect(redactBodyText('application/json; charset=utf-8', '{"jwt":"x"}')).toBe(`{"jwt":"${R}"}`);
    expect(redactBodyText('application/problem+json', '{"code":"x"}')).toBe(`{"code":"${R}"}`);
    expect(redactBodyText('text/xml', '<pwd>x</pwd>')).toBe(`<pwd>${R}</pwd>`);
    expect(redactBodyText('application/x-www-form-urlencoded', 'pass=x')).toBe(`pass=${R}`);
    expect(redactBodyText('text/plain', 'password=x')).toBe('password=x');
  });

  it('redacts free text: URLs, pairs and bearer credentials', () => {
    expect(
      redactFreeText(
        'IOException: failed https://u:p@api.example.com/x?token=abc with token=def, Bearer xyz',
      ),
    ).toBe(`IOException: failed https://${R}@api.example.com/x?token=${R} with token=${R}, Bearer ${R}`);
  });

  it('redacts form fields the same way', () => {
    expect(redactPairs('user=ana&password=hunter2&remember+me=1')).toBe(
      `user=ana&password=${R}&remember+me=1`,
    );
  });
});

const exchange = (changes: Partial<HttpExchange>): HttpExchange => ({
  id: 1,
  ts: 1000,
  endTs: 1200,
  method: 'GET',
  url: 'https://api.example.com/v1/items?page=2',
  state: 'complete',
  status: 200,
  headersMs: 100,
  durationMs: 200,
  requestSize: null,
  responseSize: 58,
  responseType: 'application/json',
  mockId: null,
  error: null,
  screen: null,
  ...changes,
});

describe('status classes and filters', () => {
  it('classifies by state, then status', () => {
    expect(statusClassOf(exchange({ status: 101 }))).toBe('1xx');
    expect(statusClassOf(exchange({ status: 204 }))).toBe('2xx');
    expect(statusClassOf(exchange({ status: 304 }))).toBe('3xx');
    expect(statusClassOf(exchange({ status: 404 }))).toBe('4xx');
    expect(statusClassOf(exchange({ status: 503 }))).toBe('5xx');
    expect(statusClassOf(exchange({ status: 900 }))).toBe('5xx');
    expect(statusClassOf(exchange({ state: 'failed', status: null }))).toBe('failed');
    expect(statusClassOf(exchange({ state: 'pending', status: null }))).toBe('pending');
  });

  it('splits URLs', () => {
    expect(urlParts('HTTPS://api.example.com:8443/v1/items?page=2#x')).toEqual({
      scheme: 'https',
      host: 'api.example.com:8443',
      path: '/v1/items',
      query: 'page=2',
    });
    expect(urlParts('http://10.0.2.2:8745')).toEqual({
      scheme: 'http',
      host: '10.0.2.2:8745',
      path: '/',
      query: '',
    });
  });

  it('filters by text, method, status class and mocked', () => {
    const items = exchange({});
    const failedPost = exchange({
      id: 2,
      method: 'POST',
      state: 'failed',
      status: null,
      url: 'https://api.example.com/v1/cart',
    });
    const mocked = exchange({ id: 3, status: 503, mockId: 'm1' });
    const all = [items, failedPost, mocked];
    const run = (filter: Partial<typeof NO_HTTP_FILTER>) =>
      all.filter((e) => matchesExchange(e, { ...NO_HTTP_FILTER, ...filter })).map((e) => e.id);
    expect(run({})).toEqual([1, 2, 3]);
    expect(run({ query: 'CART' })).toEqual([2]);
    expect(run({ query: 'post' })).toEqual([2]);
    expect(run({ query: '50' })).toEqual([3]);
    expect(run({ method: 'GET' })).toEqual([1, 3]);
    expect(run({ statusClass: 'failed' })).toEqual([2]);
    expect(run({ mocked: true })).toEqual([3]);
    expect(run({ mocked: false })).toEqual([1, 2]);
  });

  it('windows by overlap; pending exchanges last until now', () => {
    const early = exchange({ id: 1, ts: 0, endTs: 500 });
    const pending = exchange({ id: 2, ts: 100, endTs: null, state: 'pending' });
    const late = exchange({ id: 3, ts: 2000, endTs: 2100 });
    expect(exchangesInWindow([early, pending, late], 1000, 1500, 1800).map((e) => e.id)).toEqual([2]);
  });
});

const rule = (changes: Partial<NetworkMockRule>): NetworkMockRule => ({
  id: 'm1',
  method: 'GET',
  match: 'prefix',
  url: 'https://api.example.com/v1',
  action: 'respond',
  status: 200,
  headers: [],
  body: '',
  delayMs: 0,
  enabled: true,
  origin: 'user',
  updatedAt: 1,
  ...changes,
});

describe('mock rules', () => {
  it('normalises scheme, host and default ports like OkHttp prints URLs', () => {
    expect(normalizeMockUrl('HTTPS://API.Example.com:443/V1/Items?Q=A')).toBe(
      'https://api.example.com/V1/Items?Q=A',
    );
    expect(normalizeMockUrl('http://Example.com:80')).toBe('http://example.com/');
    expect(normalizeMockUrl('https://api.example.com?x=1')).toBe('https://api.example.com/?x=1');
    expect(normalizeMockUrl('http://example.com:8080/a')).toBe('http://example.com:8080/a');
    expect(normalizeMockUrl('*://*.Example.com/*')).toBe('*://*.example.com/*');
  });

  it('globs: * is any run of characters', () => {
    expect(globMatches('https://*.example.com/v1/*', 'https://api.example.com/v1/items/42')).toBe(true);
    expect(globMatches('https://*.example.com/v1/*', 'https://api.example.com/v2/items')).toBe(false);
    expect(globMatches('*', '')).toBe(true);
    expect(globMatches('a*b*c', 'axxbyyc')).toBe(true);
    expect(globMatches('a*b*c', 'axxbyy')).toBe(false);
    expect(globMatches('abc', 'abcd')).toBe(false);
    expect(globMatches(`${'*a'.repeat(8)}b`, 'a'.repeat(4000))).toBe(false);
  });

  it('matches without the query unless the pattern has one', () => {
    const url = 'https://api.example.com/v1/items?page=2#top';
    expect(mockMatches(rule({ match: 'exact', url: 'https://api.example.com/v1/items' }), 'GET', url)).toBe(
      true,
    );
    expect(
      mockMatches(rule({ match: 'exact', url: 'https://api.example.com/v1/items?page=2' }), 'GET', url),
    ).toBe(true);
    expect(
      mockMatches(rule({ match: 'exact', url: 'https://api.example.com/v1/items?page=3' }), 'GET', url),
    ).toBe(false);
    expect(mockMatches(rule({}), 'GET', url)).toBe(true);
    expect(mockMatches(rule({}), 'POST', url)).toBe(false);
    expect(mockMatches(rule({ method: null }), 'POST', url)).toBe(true);
  });

  it('orders exact > prefix > glob, longer literal, specific method, newest', () => {
    const glob = rule({ id: 'm1', match: 'glob', url: 'https://api.example.com/*' });
    const shortPrefix = rule({ id: 'm2', url: 'https://api.example.com/' });
    const longPrefix = rule({ id: 'm3', url: 'https://api.example.com/v1/items' });
    const exact = rule({ id: 'm4', match: 'exact', url: 'https://api.example.com/v1/items' });
    const anyMethod = rule({ id: 'm5', method: null, url: 'https://api.example.com/v1/items' });
    const newer = rule({ id: 'm6', url: 'https://api.example.com/v1/items', updatedAt: 5 });
    expect(orderMocks([glob, shortPrefix, longPrefix, exact, anyMethod, newer]).map((r) => r.id)).toEqual([
      'm4',
      'm6',
      'm3',
      'm5',
      'm2',
      'm1',
    ]);
    expect(compareMocks(longPrefix, longPrefix)).toBe(0);
  });

  it('finds the first enabled match', () => {
    const rules = orderMocks([
      rule({ id: 'm1', match: 'exact', url: 'https://api.example.com/v1/items', enabled: false }),
      rule({ id: 'm2' }),
    ]);
    expect(findMock(rules, 'GET', 'https://api.example.com/v1/items')?.id).toBe('m2');
    expect(findMock(rules, 'GET', 'https://other.example.com/')).toBeNull();
  });
});

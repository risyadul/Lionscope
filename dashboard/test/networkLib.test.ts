import { describe, expect, it } from 'vitest';
import { MAX_MOCK_BODY_BYTES, MAX_MOCK_DELAY_MS } from '@lionscope/protocol/wire';
import {
  bodyNote,
  draftFromExchange,
  draftFromRule,
  EMPTY_DRAFT,
  formatBodyText,
  formatBytes,
  layoutLaneBars,
  listExchanges,
  mocksIndicator,
  NO_LIST_FILTER,
  parseHeaderLines,
  ruleInput,
  truncatedNote,
  validateDraft,
  type MockDraft,
} from '../src/lib/network.ts';
import { body, exchange, exchangeDetail, mockRule, T0 } from './fixtures.ts';

const draft = (overrides: Partial<MockDraft> = {}): MockDraft => ({
  ...EMPTY_DRAFT,
  url: 'https://api.example.com/v1/items',
  ...overrides,
});

describe('display helpers', () => {
  it('formats sizes in B, KB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(4300)).toBe('4.2 KB');
    expect(formatBytes(48_128)).toBe('47 KB');
    expect(formatBytes(1_468_006)).toBe('1.4 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('pretty-prints JSON (also +json and text that looks like it) and leaves the rest alone', () => {
    expect(formatBodyText('{"a":1}', 'application/json')).toEqual({ text: '{\n  "a": 1\n}', isJson: true });
    expect(formatBodyText('[1]', 'application/problem+json; charset=utf-8').isJson).toBe(true);
    expect(formatBodyText('{"a":1}', 'text/plain').isJson).toBe(true);
    // Cut or malformed: shown as it came.
    expect(formatBodyText('{"a":', 'application/json')).toEqual({ text: '{"a":', isJson: false });
    expect(formatBodyText('<b>hi</b>', 'text/html')).toEqual({ text: '<b>hi</b>', isJson: false });
  });

  it('says in plain words why a body has no text', () => {
    expect(bodyNote(body({ text: null, omitted: 'type', contentType: 'image/png', size: 48_128 }))).toBe(
      'Not captured: binary content (image/png, 47 KB).',
    );
    expect(
      bodyNote(body({ text: null, omitted: 'type', contentType: 'multipart/form-data; boundary=x' })),
    ).toMatch(/^Not captured: multipart content/);
    expect(bodyNote(body({ text: null, omitted: 'encoding', contentType: null, size: null }), 'br')).toBe(
      'Not captured: compressed as br Lionscope can’t decode.',
    );
    expect(bodyNote(body({ text: null, omitted: 'streaming' }))).toMatch(/streaming body/);
    expect(bodyNote(body({ text: null, omitted: 'one_shot' }))).toMatch(/one-shot request body/);
    expect(bodyNote(null)).toBe('No body.');
    expect(bodyNote(body({ text: '', size: 0 }))).toBe('Empty body.');
    expect(bodyNote(body())).toBeNull();
  });

  it('notes a cut body with its real size', () => {
    expect(truncatedNote(body({ truncated: true, size: 210 * 1024 }))).toBe(
      'Truncated: the first 64 KB of 210 KB are shown.',
    );
    expect(truncatedNote(body())).toBeNull();
  });
});

describe('list filter', () => {
  const list = [
    exchange(1, T0, { method: 'POST', url: 'https://api.example.com/v1/cart' }),
    exchange(2, T0 + 1000, { status: 404 }),
    exchange(3, T0 + 2000, { state: 'failed', status: null, error: { kind: 'timeout', message: null } }),
    exchange(4, T0 + 3000, { mockId: 'm1' }),
  ];
  const ids = (filter = {}) =>
    listExchanges(list, T0, T0 + 10_000, T0 + 10_000, { ...NO_LIST_FILTER, ...filter }).map((e) => e.id);

  it('filters by text, method, status class and mocked', () => {
    expect(ids()).toEqual([1, 2, 3, 4]);
    expect(ids({ query: 'cart' })).toEqual([1]);
    expect(ids({ query: '404' })).toEqual([2]);
    expect(ids({ method: 'POST' })).toEqual([1]);
    expect(ids({ status: '4xx' })).toEqual([2]);
    expect(ids({ status: 'failed' })).toEqual([3]);
    expect(ids({ mockedOnly: true })).toEqual([4]);
  });

  it('keeps only exchanges that overlap the window', () => {
    expect(listExchanges(list, T0 + 1500, T0 + 2500, T0 + 10_000, NO_LIST_FILTER).map((e) => e.id)).toEqual([
      3,
    ]);
  });
});

describe('mock drafts', () => {
  it('turns a valid draft into the rule to send', () => {
    const check = validateDraft(draft({ body: '[]', delayMs: '800' }));
    expect(check.errors).toEqual({});
    expect(check.input).toEqual({
      method: 'GET',
      match: 'exact',
      url: 'https://api.example.com/v1/items',
      action: 'respond',
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: '[]',
      delayMs: 800,
      enabled: true,
    });
  });

  it('keeps the id of a rule being replaced', () => {
    expect(validateDraft(draftFromRule(mockRule('m4'))).input).toMatchObject({ id: 'm4', match: 'prefix' });
  });

  it('mirrors the server bounds with inline messages', () => {
    expect(validateDraft(draft({ url: 'https://' })).errors.url).toBe('Enter the URL to match.');
    expect(validateDraft(draft({ url: 'api.example.com/v1' })).errors.url).toBe(
      'Start with http:// or https://.',
    );
    expect(validateDraft(draft({ match: 'glob', url: '*://api.example.com/*' })).errors.url).toBeUndefined();
    expect(validateDraft(draft({ url: '*://api.example.com/*' })).errors.url).toMatch(/^Start with/);
    expect(
      validateDraft(draft({ match: 'glob', url: 'https://api.example.com/*/*/*/*/*/*/*/*/*' })).errors.url,
    ).toBe('A glob takes at most 8 *.');
    expect(validateDraft(draft({ url: 'https://api.example.com/a b' })).errors.url).toBe(
      'A URL has no spaces.',
    );
    expect(validateDraft(draft({ status: '99' })).errors.status).toBe('A status from 100 to 599.');
    expect(validateDraft(draft({ delayMs: String(MAX_MOCK_DELAY_MS + 1) })).errors.delayMs).toBe(
      '0 to 30,000 ms.',
    );
    expect(validateDraft(draft({ body: 'x'.repeat(MAX_MOCK_BODY_BYTES + 1) })).errors.body).toBe(
      'The body is limited to 256 KB.',
    );
    expect(validateDraft(draft({ headers: 'Content-Type application/json' })).errors.headers).toBe(
      'Line 1: write it as Name: value.',
    );
  });

  it('a failure answer ignores the response fields and still sends a valid status', () => {
    const check = validateDraft(draft({ action: 'timeout', status: '', headers: 'broken', body: 'x' }));
    expect(check.errors).toEqual({});
    expect(check.input).toMatchObject({ action: 'timeout', status: 200, headers: [], body: '' });
  });

  it('parses header lines, skipping blank ones', () => {
    expect(parseHeaderLines('Content-Type: application/json\n\nX-Trace:  abc ')).toEqual({
      headers: [
        ['Content-Type', 'application/json'],
        ['X-Trace', 'abc'],
      ],
      error: null,
    });
    expect(parseHeaderLines('Bad Name: x').error).toBe('Line 1: “Bad Name” isn’t a valid header name.');
  });

  it('pre-fills from an exchange: method, the URL without its query, status, content type and body', () => {
    const summary = exchange(3, T0, {
      url: 'https://api.example.com/v1/items?page=2&token=‹redacted›',
      status: 201,
    });
    const { draft: filled, note } = draftFromExchange(summary, exchangeDetail(summary));
    expect(filled).toMatchObject({
      method: 'GET',
      match: 'exact',
      url: 'https://api.example.com/v1/items',
      action: 'respond',
      status: '201',
      headers: 'Content-Type: application/json; charset=utf-8',
      body: '{"items":[1,2,3]}',
    });
    expect(note).toBeNull();
  });

  it('says when the captured body was cut or not captured', () => {
    const summary = exchange(3, T0);
    const cut = exchangeDetail(summary, { responseBody: body({ truncated: true, size: 100_000 }) });
    expect(draftFromExchange(summary, cut).note).toMatch(/cut at 64 KB/);
    const image = exchangeDetail(summary, {
      responseBody: body({ text: null, omitted: 'type', contentType: 'image/png', size: 48_128 }),
    });
    expect(draftFromExchange(summary, image).note).toBe(
      'The response body wasn’t captured (image/png, 47 KB): add one by hand.',
    );
    expect(draftFromExchange(summary, null).note).toMatch(/hasn’t loaded/);
  });

  it('mocks a timed-out call as a timeout', () => {
    const failed = exchange(3, T0, {
      state: 'failed',
      status: null,
      error: { kind: 'timeout', message: null },
    });
    expect(draftFromExchange(failed, null)).toEqual({
      draft: expect.objectContaining({ action: 'timeout', status: '200' }),
      note: null,
    });
  });

  it('a stored rule becomes a replacement input without its server fields', () => {
    expect(ruleInput(mockRule('m2', { origin: 'agent' }), { enabled: false })).toEqual({
      id: 'm2',
      method: 'GET',
      match: 'prefix',
      url: 'https://api.example.com/v1/items',
      action: 'respond',
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body: '[]',
      delayMs: 0,
      enabled: false,
    });
  });
});

describe('mocks indicator', () => {
  it('counts enabled rules and tells applied from waiting', () => {
    expect(mocksIndicator(null, true)).toBeNull();
    expect(
      mocksIndicator({ rules: [mockRule('m1', { enabled: false })], rev: 1, appliedRev: 1 }, true),
    ).toBeNull();
    const rules = [mockRule('m1'), mockRule('m2'), mockRule('m3', { enabled: false })];
    expect(mocksIndicator({ rules, rev: 3, appliedRev: 3 }, true)).toEqual({ count: 2, state: 'applied' });
    expect(mocksIndicator({ rules, rev: 3, appliedRev: 2 }, true)).toEqual({ count: 2, state: 'waiting' });
    expect(mocksIndicator({ rules, rev: 3, appliedRev: null }, true)).toEqual({ count: 2, state: 'waiting' });
    expect(mocksIndicator({ rules, rev: 3, appliedRev: null }, false)).toEqual({ count: 2, state: 'idle' });
  });
});

describe('network lane layout', () => {
  it('stacks overlapping calls in rows and collapses what does not fit', () => {
    // Five calls over the same second of a 10 s window, 1000 px wide: four rows, one overflow.
    const list = [1, 2, 3, 4, 5].map((id) => exchange(id, T0 + 1000, { endTs: T0 + 2000 }));
    const layout = layoutLaneBars(list, T0, T0 + 10_000, T0 + 10_000, 1000, 4);
    expect(layout.bars.map((bar) => bar.row)).toEqual([0, 1, 2, 3]);
    expect(layout.bars[0]).toMatchObject({ left: 0.1, width: 0.1 });
    expect(layout.overflow).toEqual([{ left: 0.1, width: 0.1, count: 1 }]);
    expect(layout.total).toBe(5);
  });

  it('reuses a row once the previous bar ended, grows pending calls to now and counts failures', () => {
    const list = [
      exchange(1, T0, { endTs: T0 + 1000 }),
      exchange(2, T0 + 2000, { state: 'pending', status: null, endTs: null, durationMs: null }),
      exchange(3, T0 + 3000, { endTs: T0 + 3500, status: 503 }),
    ];
    const layout = layoutLaneBars(list, T0, T0 + 10_000, T0 + 6000, 1000, 4);
    expect(layout.bars.map((bar) => [bar.exchange.id, bar.row])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
    expect(layout.bars[1]).toMatchObject({ left: 0.2, width: 0.4 });
    expect(layout.failed).toBe(1);
  });
});

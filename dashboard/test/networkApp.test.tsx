import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  DeviceInfo,
  HttpExchange,
  NetworkMocksState,
  SdkStatus,
  ServerMessage,
} from '@lionscope/protocol/wire';
import {
  MAX_HTTP_SUMMARY_URL_CHARS,
  MAX_MOCK_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { DETAIL_REQUEST_GAP_MS } from '../src/hooks/useHttpDetail.ts';
import { createSignal } from '../src/lib/signal.ts';
import * as networkLib from '../src/lib/network.ts';
import { createStore, SET_NETWORK_MOCK_FAILED_CODE, type ConnectionState } from '../src/lib/store.ts';
import { body, exchange, exchangeDetail, frame, mockRule, SDK_V3, SDK_V7, session } from './fixtures.ts';
import { resetPlots } from './uplotMock.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));
// The Network tab filters its rows through listExchanges: counting calls counts its renders.
vi.mock('../src/lib/network.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof networkLib>();
  return { ...actual, listExchanges: vi.fn(actual.listExchanges) };
});

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  resetPlots();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const EMULATOR: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.7.0',
  bufferWindowMs: 600_000,
};
const NO_MOCKS: NetworkMocksState = { rules: [], rev: 0, appliedRev: 0 };

function setup(messages: ServerMessage[]) {
  const store = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const sent: ClientMessage[] = [];
  const services: DashboardServices = {
    store,
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    probeTs: createSignal<number | null>(null),
    cursorX: createSignal<number | null>(null),
  };
  store.dispatch({ kind: 'connection', connection: OPEN });
  for (const msg of messages) store.dispatch({ kind: 'server', msg });
  store.flush();
  render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  const push = (...msgs: ServerMessage[]) =>
    act(() => {
      for (const msg of msgs) store.dispatch({ kind: 'server', msg });
      store.flush();
    });
  return { sent, push };
}

function running(sdk: SdkStatus, now: number, extra: ServerMessage[] = []): ServerMessage[] {
  return [
    hello,
    { type: 'devices', devices: [EMULATOR] },
    { type: 'session', session: session({ startedAt: now - 60_000, sdk }) },
    { type: 'networkMocks', mocks: NO_MOCKS },
    { type: 'frames', sample: frame(now - 1000, { source: 'sdk' }) },
    ...extra,
  ];
}

const http = (...exchanges: HttpExchange[]): ServerMessage[] =>
  exchanges.map((e) => ({ type: 'http', exchange: e }));

/** Four calls: a 200, a POST 404, a timeout and a mocked 200. */
function traffic(now: number): HttpExchange[] {
  return [
    exchange(1, now - 40_000),
    exchange(2, now - 30_000, { method: 'POST', url: 'https://api.example.com/v1/cart', status: 404 }),
    exchange(3, now - 20_000, {
      state: 'failed',
      status: null,
      headersMs: null,
      error: { kind: 'timeout', message: 'SocketTimeoutException: timeout' },
    }),
    exchange(4, now - 10_000, { url: 'https://api.example.com/v1/items?page=2', mockId: 'm1' }),
  ];
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });
const openNetwork = () => fireEvent.click(tab(/Network/));
const netPanel = () => screen.getByRole('tabpanel', { name: /Network/ });
const list = () => within(netPanel()).getByRole('listbox', { name: /Requests/ });
const rows = () => within(list()).getAllByRole('option');
const rowIds = () => rows().map((row) => Number(row.dataset.id));
const row = (id: number) => rows().find((el) => el.dataset.id === String(id))!;
const detailRequests = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'getHttpExchange');
const mockMessages = (sent: ClientMessage[]) =>
  sent.filter((m) => m.type === 'setNetworkMock' || m.type === 'clearNetworkMocks');
const detailTab = (name: string) => within(netPanel()).getByRole('tab', { name });
const dialog = () => screen.getByRole('dialog');

describe('Network tab: the list', () => {
  it('counts the calls in the window on its tab and lists them oldest first', () => {
    const now = Date.now();
    setup(running(SDK_V7, now, http(...traffic(now))));
    expect(tab(/Network/).textContent).toBe('Network4');
    openNetwork();
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(row(2).getAttribute('aria-label')).toBe(
      'POST api.example.com/v1/cart, status 404, 120 ms, 2.0 KB',
    );
    expect(within(row(3)).getByText('timeout').dataset.class).toBe('failed');
    expect(within(row(4)).getByText('Mocked')).toBeTruthy();
    expect(within(netPanel()).getByText('4 requests')).toBeTruthy();
  });

  it('filters by text, method, status class and mocked', () => {
    const now = Date.now();
    setup(running(SDK_V7, now, http(...traffic(now))));
    openNetwork();
    const search = within(netPanel()).getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'cart' } });
    expect(rowIds()).toEqual([2]);
    expect(within(netPanel()).getByText('1 of 4')).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.change(within(netPanel()).getByRole('combobox', { name: 'Method' }), {
      target: { value: 'POST' },
    });
    expect(rowIds()).toEqual([2]);
    fireEvent.change(within(netPanel()).getByRole('combobox', { name: 'Method' }), {
      target: { value: '*' },
    });
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Failed' }));
    expect(rowIds()).toEqual([3]);
    fireEvent.click(within(netPanel()).getByRole('radio', { name: '5xx' }));
    expect(within(netPanel()).getByText('Nothing matches: clear the search or pick All.')).toBeTruthy();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'All' }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Mocked' }));
    expect(rowIds()).toEqual([4]);
  });

  it('follows the newest call, stops while scrolled up and jumps back', async () => {
    const now = Date.now();
    const { push } = setup(running(SDK_V7, now, http(...traffic(now))));
    openNetwork();
    const box = list();
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 0 });
    await push(...http(exchange(5, now - 5000)));
    // Following: the list is kept scrolled to the bottom.
    expect(box.scrollTop).toBe(2000);
    box.scrollTop = 100;
    fireEvent.scroll(box);
    expect(within(netPanel()).getByRole('button', { name: /Jump to latest/ })).toBeTruthy();
    await push(...http(exchange(6, now - 4000)));
    expect(box.scrollTop).toBe(100);
    expect(within(netPanel()).getByRole('button', { name: /Jump to latest/ }).textContent).toContain('+1');
    fireEvent.click(within(netPanel()).getByRole('button', { name: /Jump to latest/ }));
    expect(box.scrollTop).toBe(2000);
    expect(within(netPanel()).queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('renders only the rows in view of a long list', () => {
    const now = Date.now();
    const many = Array.from({ length: 2000 }, (_, i) => exchange(i + 1, now - 100_000 + i * 40));
    setup(running(SDK_V7, now, http(...many)));
    openNetwork();
    expect(rows().length).toBeLessThan(40);
    // The newest are in view (following the tail), with their position in the whole list.
    expect(rows().at(-1)?.dataset.id).toBe('2000');
    expect(rows().at(-1)?.getAttribute('aria-posinset')).toBe('2000');
    expect(rows().at(-1)?.getAttribute('aria-setsize')).toBe('2000');
  });

  it('↑ / ↓ move the selection and focus, Home / End jump to the ends', () => {
    const now = Date.now();
    setup(running(SDK_V7, now, http(...traffic(now))));
    openNetwork();
    // One tab stop: the newest row until something is selected.
    expect(
      rows()
        .filter((el) => el.tabIndex === 0)
        .map((el) => el.dataset.id),
    ).toEqual(['4']);
    // Nothing selected yet: ↑ starts from the newest.
    fireEvent.keyDown(row(4), { key: 'ArrowUp' });
    expect(row(4).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(row(2));
    expect(row(2).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(row(2), { key: 'ArrowDown' });
    expect(row(3).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(row(3));
    expect(row(3).tabIndex).toBe(0);
    fireEvent.keyDown(row(3), { key: 'Home' });
    expect(row(1).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(row(1));
    fireEvent.keyDown(row(1), { key: 'End' });
    expect(row(4).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Network tab: the detail', () => {
  it('asks for the selected call’s detail, and again when its summary changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = Date.now();
    const pending = exchange(7, now - 2000, {
      state: 'pending',
      status: null,
      endTs: null,
      headersMs: null,
      durationMs: null,
      responseSize: null,
    });
    const { sent, push } = setup(running(SDK_V7, now, http(exchange(6, now - 3000), pending)));
    openNetwork();
    fireEvent.click(row(7));
    expect(detailRequests(sent)).toEqual([{ type: 'getHttpExchange', id: 7 }]);
    expect(within(netPanel()).getByRole('tabpanel', { name: 'Overview' }).textContent).toContain(
      'Pending: waiting for the response',
    );
    await push(...http(exchange(7, now - 2000, { status: 201 })));
    // Spaced out: the socket is rate-limited.
    expect(detailRequests(sent)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(DETAIL_REQUEST_GAP_MS));
    expect(detailRequests(sent)).toEqual([
      { type: 'getHttpExchange', id: 7 },
      { type: 'getHttpExchange', id: 7 },
    ]);
  });

  it('shows headers with redacted values marked, and bodies pretty-printed', async () => {
    const now = Date.now();
    const summary = exchange(1, now - 5000);
    const { push } = setup(running(SDK_V7, now, http(summary)));
    openNetwork();
    fireEvent.click(row(1));
    fireEvent.click(detailTab('Headers'));
    expect(within(netPanel()).getByText('Loading headers and bodies…')).toBeTruthy();
    await push({ type: 'httpExchange', id: 1, exchange: exchangeDetail(summary) });
    const redacted = within(netPanel()).getByText('‹redacted›');
    expect(redacted.hasAttribute('data-redacted')).toBe(true);
    expect(redacted.previousElementSibling?.textContent).toBe('Authorization');
    fireEvent.click(detailTab('Response'));
    const pre = netPanel().querySelector('.net-body-text')!;
    expect(pre.textContent).toBe('{\n  "items": [\n    1,\n    2,\n    3\n  ]\n}');
    expect(pre.hasAttribute('data-json')).toBe(true);
    fireEvent.click(detailTab('Request'));
    expect(within(netPanel()).getByText('No body.')).toBeTruthy();
    fireEvent.click(detailTab('Timing'));
    expect(within(netPanel()).getByText('80 ms')).toBeTruthy();
    expect(within(netPanel()).getByText('40 ms')).toBeTruthy();
  });

  it('says when a body was cut or not captured, in plain words', async () => {
    const now = Date.now();
    const cut = exchange(1, now - 5000);
    const image = exchange(2, now - 4000, { responseType: 'image/png', responseSize: 48_128 });
    const { push } = setup(running(SDK_V7, now, http(cut, image)));
    openNetwork();
    fireEvent.click(row(1));
    fireEvent.click(detailTab('Response'));
    await push({
      type: 'httpExchange',
      id: 1,
      exchange: exchangeDetail(cut, {
        responseBody: body({ text: '{"items":[1,', truncated: true, size: 210 * 1024 }),
      }),
    });
    expect(within(netPanel()).getByText('Truncated: the first 64 KB of 210 KB are shown.')).toBeTruthy();
    expect(netPanel().querySelector('.net-body-text')?.textContent).toBe('{"items":[1,');
    fireEvent.click(row(2));
    await push({
      type: 'httpExchange',
      id: 2,
      exchange: exchangeDetail(image, {
        responseBody: body({ text: null, omitted: 'type', contentType: 'image/png', size: 48_128 }),
      }),
    });
    expect(within(netPanel()).getByText('Not captured: binary content (image/png, 47 KB).')).toBeTruthy();
  });

  it('says so when the server no longer keeps the call', async () => {
    const now = Date.now();
    const { push } = setup(running(SDK_V7, now, http(exchange(1, now - 5000))));
    openNetwork();
    fireEvent.click(row(1));
    fireEvent.click(detailTab('Headers'));
    await push({ type: 'httpExchange', id: 1, exchange: null });
    expect(
      within(netPanel()).getByText('The server no longer keeps this request’s headers and bodies.'),
    ).toBeTruthy();
  });

  it('names the rule that mocked a call, and closes with Esc', async () => {
    const now = Date.now();
    setup(
      running(SDK_V7, now, [
        ...http(exchange(4, now - 5000, { mockId: 'm1' })),
        { type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 1 } },
      ]),
    );
    openNetwork();
    fireEvent.click(row(4));
    const overview = within(netPanel()).getByRole('tabpanel', { name: 'Overview' });
    expect(overview.textContent).toContain('rule m1: GET · Prefix · https://api.example.com/v1/items → 200');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(netPanel()).queryByRole('article', { name: 'Selected request' })).toBeNull();
  });
});

describe('Network tab: empty states', () => {
  it('without a session', () => {
    setup([hello, { type: 'devices', devices: [EMULATOR] }]);
    openNetwork();
    expect(within(netPanel()).getByText('Start a session to capture requests')).toBeTruthy();
  });

  it('with an SDK older than 0.7.0: no lane, and how to get capture', () => {
    setup(running(SDK_V3, Date.now()));
    expect(screen.queryByRole('figure', { name: 'Network' })).toBeNull();
    openNetwork();
    expect(within(netPanel()).getByText('Network capture needs the SDK')).toBeTruthy();
    expect(netPanel().textContent).toContain('It needs Lionscope SDK 0.7.0 (the app runs v0.4.0)');
    expect(netPanel().textContent).toContain('Lionscope.okHttpInterceptor()');
  });

  it('with a 0.7.0 SDK and no call yet: the lane is there and the tab points at the interceptor', () => {
    setup(running(SDK_V7, Date.now()));
    expect(screen.getByRole('figure', { name: 'Network' })).toBeTruthy();
    openNetwork();
    expect(within(netPanel()).getByText('No requests yet')).toBeTruthy();
    expect(netPanel().querySelector('.net-snippet')?.textContent).toContain('addInterceptor');
  });
});

describe('Network tab: an unverified link', () => {
  it('says capture is off and why, with no lane', () => {
    setup(running({ ...SDK_V7, network: 'unverified' }, Date.now()));
    expect(screen.queryByRole('figure', { name: 'Network' })).toBeNull();
    openNetwork();
    expect(within(netPanel()).getByText('Network capture is off')).toBeTruthy();
    expect(netPanel().textContent).toContain('couldn’t hand the app its link key over adb');
    expect(netPanel().textContent).toContain('Restart the session');
    expect(netPanel().textContent).toContain('LinkKeyReceiver');
  });

  it('SdkStatus.network wins over the protocol version', () => {
    setup(running({ ...SDK_V7, network: 'needs_sdk' }, Date.now()));
    openNetwork();
    expect(within(netPanel()).getByText('Network capture needs the SDK')).toBeTruthy();
  });
});

describe('Mock editor', () => {
  it('“Mock this response” pre-fills from the call and sends the rule; it closes on the next networkMocks', async () => {
    const now = Date.now();
    const summary = exchange(4, now - 5000, { url: 'https://api.example.com/v1/items?page=2', status: 201 });
    const { sent, push } = setup(running(SDK_V7, now, http(summary)));
    openNetwork();
    fireEvent.click(row(4));
    await push({ type: 'httpExchange', id: 4, exchange: exchangeDetail(summary) });
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Mock this response' }));
    expect(within(dialog()).getByRole('heading').textContent).toBe('New mock');
    expect((within(dialog()).getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://api.example.com/v1/items',
    );
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('URL'));
    fireEvent.change(within(dialog()).getByLabelText('Delay (ms)'), { target: { value: '800' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save mock' }));
    expect(mockMessages(sent)).toEqual([
      {
        type: 'setNetworkMock',
        rule: {
          method: 'GET',
          match: 'exact',
          url: 'https://api.example.com/v1/items',
          action: 'respond',
          status: 201,
          headers: [['Content-Type', 'application/json; charset=utf-8']],
          body: '{"items":[1,2,3]}',
          delayMs: 800,
          enabled: true,
        },
      },
    ]);
    expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeTruthy();
    await push({ type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 0 } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the detail’s whole URL where the summary’s was cut, to mock and to copy', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const now = Date.now();
      const whole = `https://api.example.com/v1/${'p'.repeat(MAX_HTTP_SUMMARY_URL_CHARS)}`;
      const summary = exchange(4, now - 5000, { url: `${whole.slice(0, MAX_HTTP_SUMMARY_URL_CHARS - 1)}…` });
      const { push } = setup(running(SDK_V7, now, http(summary)));
      openNetwork();
      fireEvent.click(row(4));
      await push({ type: 'httpExchange', id: 4, exchange: exchangeDetail(summary, { url: whole }) });
      expect(netPanel().querySelector('.net-full-url')?.textContent).toBe(whole);
      fireEvent.click(within(netPanel()).getByRole('button', { name: 'Copy URL' }));
      expect(writeText).toHaveBeenCalledWith(whole);
      fireEvent.click(within(netPanel()).getByRole('button', { name: 'Mock this response' }));
      expect((within(dialog()).getByLabelText('URL') as HTMLInputElement).value).toBe(whole);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('a re-open while open starts from the new draft', async () => {
    const now = Date.now();
    const first = exchange(4, now - 5000, { url: 'https://api.example.com/v1/items' });
    const second = exchange(5, now - 4000, { url: 'https://api.example.com/v1/cart', method: 'POST' });
    const { push } = setup(running(SDK_V7, now, http(first, second)));
    openNetwork();
    fireEvent.click(row(4));
    await push({ type: 'httpExchange', id: 4, exchange: exchangeDetail(first) });
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Mock this response' }));
    fireEvent.change(within(dialog()).getByLabelText('Delay (ms)'), { target: { value: '800' } });
    fireEvent.click(row(5));
    await push({ type: 'httpExchange', id: 5, exchange: exchangeDetail(second) });
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Mock this response' }));
    expect((within(dialog()).getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://api.example.com/v1/cart',
    );
    expect((within(dialog()).getByLabelText('Method') as HTMLSelectElement).value).toBe('POST');
    expect((within(dialog()).getByLabelText('Delay (ms)') as HTMLInputElement).value).toBe('0');
  });

  it('refuses a body too large once JSON-escaped, inline', () => {
    const { sent } = setup(running(SDK_V7, Date.now()));
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Mocks' }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'New mock' }));
    fireEvent.change(within(dialog()).getByLabelText('URL'), {
      target: { value: 'https://api.example.com/v1/promo' },
    });
    fireEvent.change(within(dialog()).getByLabelText('Body'), {
      target: { value: '\u0001'.repeat(Math.ceil(MAX_MOCK_CLIENT_MESSAGE_BYTES / 6) + 1) },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save mock' }));
    expect(within(dialog()).getByText(/^Too large to send: JSON-escaped/)).toBeTruthy();
    expect(within(dialog()).getByLabelText('Body').getAttribute('aria-invalid')).toBe('true');
    expect(mockMessages(sent)).toEqual([]);
  });

  it('formats a JSON body and counts its bytes', () => {
    setup(running(SDK_V7, Date.now()));
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Mocks' }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'New mock' }));
    const textarea = within(dialog()).getByLabelText('Body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"a":[1]}' } });
    expect(within(dialog()).getByText('9 B of 256 KB')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Format JSON' }));
    expect(textarea.value).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  it('validates before sending and shows the server’s refusal', async () => {
    const { sent, push } = setup(running(SDK_V7, Date.now()));
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Mocks' }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'New mock' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save mock' }));
    expect(within(dialog()).getByText('Enter the URL to match.')).toBeTruthy();
    expect(within(dialog()).getByLabelText('URL').getAttribute('aria-invalid')).toBe('true');
    expect(mockMessages(sent)).toEqual([]);
    fireEvent.change(within(dialog()).getByLabelText('URL'), {
      target: { value: 'https://api.example.com/v1/promo' },
    });
    fireEvent.change(within(dialog()).getByLabelText('Status'), { target: { value: '700' } });
    expect(within(dialog()).getByText('A status from 100 to 599.')).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText('Status'), { target: { value: '503' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save mock' }));
    expect(mockMessages(sent)).toHaveLength(1);
    await push({ type: 'error', message: 'At most 32 mock rules', code: SET_NETWORK_MOCK_FAILED_CODE });
    expect(within(dialog()).getByRole('alert').textContent).toBe('At most 32 mock rules');
    expect(within(dialog()).getByRole('button', { name: 'Save mock' })).toBeTruthy();
  });

  it('Edit replaces the rule with its id; Escape cancels', () => {
    const { sent } = setup(
      running(SDK_V7, Date.now(), [
        { type: 'networkMocks', mocks: { rules: [mockRule('m3')], rev: 3, appliedRev: 3 } },
      ]),
    );
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: /Mocks/ }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Edit m3' }));
    expect(within(dialog()).getByRole('heading').textContent).toBe('Edit mock m3');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Timeout' }));
    expect(within(dialog()).queryByLabelText('Body')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save mock' }));
    expect(mockMessages(sent)).toEqual([
      {
        type: 'setNetworkMock',
        rule: expect.objectContaining({ id: 'm3', action: 'timeout', status: 200, headers: [], body: '' }),
      },
    ]);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Mocks list', () => {
  const rules = [mockRule('m1'), mockRule('m2', { origin: 'agent', enabled: false, action: 'timeout' })];

  it('toggles, deletes and (after a confirmation) clears rules; agent rules are marked', () => {
    const { sent } = setup(
      running(SDK_V7, Date.now(), [{ type: 'networkMocks', mocks: { rules, rev: 2, appliedRev: 2 } }]),
    );
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Mocks 2' }));
    const items = within(netPanel()).getAllByRole('listitem');
    expect(within(items[1]!).getByText('AI')).toBeTruthy();
    expect(within(items[0]!).queryByText('AI')).toBeNull();
    expect(within(items[1]!).getByText('→ Timeout')).toBeTruthy();
    fireEvent.click(within(items[0]!).getByRole('switch'));
    fireEvent.click(within(items[1]!).getByRole('switch'));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Delete m2' }));
    fireEvent.click(within(netPanel()).getByRole('button', { name: 'Clear all' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('2 rules will be removed');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear all' }));
    expect(mockMessages(sent)).toEqual([
      { type: 'setNetworkMock', rule: expect.objectContaining({ id: 'm1', enabled: false }) },
      { type: 'setNetworkMock', rule: expect.objectContaining({ id: 'm2', enabled: true }) },
      { type: 'clearNetworkMocks', id: 'm2' },
      { type: 'clearNetworkMocks' },
    ]);
    const toggled = mockMessages(sent)[0] as Extract<ClientMessage, { type: 'setNetworkMock' }>;
    expect(Object.keys(toggled.rule).sort()).toEqual(
      ['action', 'body', 'delayMs', 'enabled', 'headers', 'id', 'match', 'method', 'status', 'url'].sort(),
    );
  });

  it('can’t change rules without a session', () => {
    setup([hello, { type: 'devices', devices: [EMULATOR] }, { type: 'networkMocks', mocks: NO_MOCKS }]);
    openNetwork();
    fireEvent.click(within(netPanel()).getByRole('radio', { name: 'Mocks' }));
    expect(within(netPanel()).getByRole('button', { name: 'New mock' }).hasAttribute('disabled')).toBe(true);
    expect(netPanel().textContent).toContain('Start a session to add mocks');
  });
});

describe('Mocks indicator', () => {
  const indicator = () => screen.queryByRole('button', { name: /mocks? active/ });

  it('shows while enabled rules exist, applied or waiting for the app', async () => {
    const { push } = setup(running(SDK_V7, Date.now()));
    expect(indicator()).toBeNull();
    await push({ type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 0 } });
    expect(indicator()?.textContent).toBe('1 mock activewaiting for the app');
    await push({
      type: 'networkMocks',
      mocks: {
        rules: [mockRule('m1'), mockRule('m2'), mockRule('m3', { enabled: false })],
        rev: 2,
        appliedRev: 2,
      },
    });
    expect(indicator()?.textContent).toBe('2 mocks activeapplied');
    expect(indicator()?.dataset.state).toBe('applied');
    await push({ type: 'networkMocks', mocks: NO_MOCKS });
    expect(indicator()).toBeNull();
  });

  it('says the rules can’t reach the app while the link is unverified', () => {
    setup(
      running({ ...SDK_V7, network: 'unverified' }, Date.now(), [
        { type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 0 } },
      ]),
    );
    expect(indicator()?.textContent).toBe('1 mock activenot reaching the app');
    expect(indicator()?.dataset.state).toBe('unreachable');
    expect(indicator()?.getAttribute('title')).toMatch(/^The rules can’t reach the app/);
  });

  it('stays in the Device view, and opens Profiler → Network → Mocks', () => {
    setup(
      running(SDK_V7, Date.now(), [
        { type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 1 } },
      ]),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Device' }));
    expect(document.querySelector<HTMLElement>('.workspace')?.dataset.view).toBe('device');
    fireEvent.click(indicator()!);
    expect(document.querySelector<HTMLElement>('.workspace')?.dataset.view).toBe('profile');
    expect(tab(/Network/).getAttribute('aria-selected')).toBe('true');
    expect(within(netPanel()).getByRole('radio', { name: 'Mocks 1' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('stays in the Inspector view, where the side panel shows only the Inspector', () => {
    setup(
      running(SDK_V7, Date.now(), [
        { type: 'networkMocks', mocks: { rules: [mockRule('m1')], rev: 1, appliedRev: 1 } },
      ]),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Inspector' }));
    expect(screen.queryByRole('tab', { name: /Network/ })).toBeNull();
    expect(indicator()).toBeTruthy();
  });
});

describe('Network lane', () => {
  it('draws a bar per call colored by status class, mocked ones marked; a click opens the call', () => {
    const now = Date.now();
    const calls = [
      ...traffic(now),
      exchange(5, now - 3000, { state: 'pending', status: null, endTs: null, durationMs: null }),
    ];
    setup(running(SDK_V7, now, http(...calls)));
    const lane = screen.getByRole('figure', { name: 'Network' });
    const bars = [...lane.querySelectorAll<HTMLElement>('.net-bar')];
    expect(bars.map((bar) => [bar.dataset.id, bar.dataset.class, bar.dataset.mocked ?? null])).toEqual([
      ['1', '2xx', null],
      ['2', '4xx', null],
      ['3', '5xx', null],
      ['4', '2xx', 'true'],
      ['5', 'pending', null],
    ]);
    fireEvent.mouseEnter(bars[1]!);
    const tip = lane.querySelector('.net-tip')!;
    expect(tip.textContent).toContain('POST');
    expect(tip.textContent).toContain('/v1/cart');
    expect(tip.textContent).toContain('404');
    expect(tip.textContent).toContain('120 ms');
    fireEvent.click(bars[1]!);
    expect(tab(/Network/).getAttribute('aria-selected')).toBe('true');
    expect(row(2).getAttribute('aria-selected')).toBe('true');
    expect(within(netPanel()).getByRole('article', { name: 'Selected request' })).toBeTruthy();
  });
});

describe('Network tab while hidden', () => {
  it('does not re-render on new calls while another tab is shown', async () => {
    const now = Date.now();
    const { push } = setup(running(SDK_V7, now, http(...traffic(now))));
    const listCalls = vi.mocked(networkLib.listExchanges);
    listCalls.mockClear();
    await push(...http(exchange(5, now - 2000)), ...http(exchange(6, now - 1000)));
    expect(listCalls).not.toHaveBeenCalled();
    openNetwork();
    expect(listCalls).toHaveBeenCalled();
    expect(rowIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

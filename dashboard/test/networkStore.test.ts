import { describe, expect, it } from 'vitest';
import type { HttpExchange, ServerMessage } from '@lionscope/protocol/wire';
import {
  applyServerMessageAt,
  createInitialState,
  FUTURE_SLACK_MS,
  MAX_HTTP,
  normalizeExchanges,
  pruneExchangesBefore,
  SET_NETWORK_MOCK_FAILED_CODE,
  upsertExchange,
  type DashboardState,
} from '../src/lib/store.ts';
import { captureView } from '../src/lib/viewState.ts';
import { cpu, exchange, exchangeDetail, mockRule, T0 } from './fixtures.ts';

const MIN = 60_000;
const NOW = T0 + 10 * MIN;

function apply(state: DashboardState, ...msgs: ServerMessage[]): DashboardState {
  return msgs.reduce((s, msg) => applyServerMessageAt(s, msg, NOW), state);
}

const snapshot = (http: HttpExchange[]): ServerMessage => ({
  type: 'snapshot',
  snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [], http },
});

describe('HTTP exchanges in the store', () => {
  it('appends new exchanges by start and replaces a later report of the same id in place', () => {
    const pending = exchange(2, NOW - 2000, {
      state: 'pending',
      status: null,
      endTs: null,
      durationMs: null,
    });
    let state = apply(
      createInitialState(),
      { type: 'http', exchange: exchange(1, NOW - 3000) },
      { type: 'http', exchange: pending },
      { type: 'http', exchange: exchange(3, NOW - 2500) },
    );
    expect(state.http.map((e) => e.id)).toEqual([1, 3, 2]);
    const done = exchange(2, NOW - 2000, { status: 404 });
    state = apply(state, { type: 'http', exchange: done });
    expect(state.http.map((e) => e.id)).toEqual([1, 3, 2]);
    expect(state.http[2]).toBe(done);
    expect(state.latestTs).toBe(NOW - 2000);
  });

  it('drops an exchange that claims to start in the future', () => {
    const state = apply(createInitialState(), {
      type: 'http',
      exchange: exchange(1, NOW + FUTURE_SLACK_MS + 1),
    });
    expect(state.http).toEqual([]);
  });

  it('a snapshot replaces the list (sorted, one per id) and tolerates servers without the stream', () => {
    const before = apply(createInitialState(), { type: 'http', exchange: exchange(9, NOW - 1000) });
    const next = apply(
      before,
      snapshot([exchange(5, NOW - 1000), exchange(4, NOW - 2000), exchange(5, NOW - 1000, { status: 500 })]),
    );
    expect(next.http.map((e) => [e.id, e.status])).toEqual([
      [4, 200],
      [5, 500],
    ]);
    const old = apply(before, {
      type: 'snapshot',
      snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [] },
    });
    expect(old.http).toEqual([]);
  });

  it('keeps a detail answer across a snapshot only while its exchange is still listed', () => {
    const summary = exchange(7, NOW - 1000);
    const answered = apply(
      createInitialState(),
      { type: 'http', exchange: summary },
      { type: 'httpExchange', id: 7, exchange: exchangeDetail(summary) },
    );
    expect(answered.httpDetail?.id).toBe(7);
    expect(apply(answered, snapshot([summary])).httpDetail?.id).toBe(7);
    expect(apply(answered, snapshot([exchange(8, NOW - 500)])).httpDetail).toBeNull();
  });

  it('records an answer for an exchange the server no longer keeps', () => {
    const state = apply(createInitialState(), { type: 'httpExchange', id: 3, exchange: null });
    expect(state.httpDetail).toEqual({ id: 3, exchange: null });
  });

  it('prunes exchanges that ended before the window, but never a pending one', () => {
    const state = apply(
      { ...createInitialState(), bufferWindowMs: 5 * MIN },
      { type: 'http', exchange: exchange(1, NOW - 9 * MIN) },
      {
        type: 'http',
        exchange: exchange(2, NOW - 8 * MIN, {
          state: 'pending',
          status: null,
          endTs: null,
          durationMs: null,
        }),
      },
      { type: 'http', exchange: exchange(3, NOW - 7 * MIN) },
      { type: 'cpu', sample: cpu(NOW) },
    );
    // 1 ended before the window; 2 is still running, so it and everything after it stay.
    expect(state.http.map((e) => e.id)).toEqual([2, 3]);
  });

  it('a laptop clock step back clears the exchanges with the rest of the timeline', () => {
    const state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(NOW) },
      { type: 'http', exchange: exchange(1, NOW - 1000) },
      { type: 'cpu', sample: cpu(NOW - MIN) },
    );
    expect(state.http).toEqual([]);
  });

  it('networkMocks replaces the rules; a refused setNetworkMock is kept for the editor', () => {
    const mocks = { rules: [mockRule('m1')], rev: 2, appliedRev: null };
    let state = apply(createInitialState(), { type: 'networkMocks', mocks });
    expect(state.networkMocks).toEqual(mocks);
    state = apply(state, {
      type: 'error',
      message: 'No session is running',
      code: SET_NETWORK_MOCK_FAILED_CODE,
    });
    expect(state.mockError).toEqual({
      id: 1,
      message: 'No session is running',
      code: SET_NETWORK_MOCK_FAILED_CODE,
    });
    expect(state.lastError?.id).toBe(1);
    state = apply(state, { type: 'error', message: 'adb went away' });
    expect(state.mockError?.id).toBe(1);
  });

  it('a paused view holds the exchanges too', () => {
    const state = apply(createInitialState(), { type: 'http', exchange: exchange(1, NOW - 1000) });
    expect(captureView(state, NOW).http).toBe(state.http);
  });
});

describe('exchange helpers', () => {
  it('upsertExchange caps the list, dropping the oldest', () => {
    let list = normalizeExchanges(Array.from({ length: MAX_HTTP }, (_, i) => exchange(i + 1, T0 + i)));
    list = upsertExchange(list, exchange(MAX_HTTP + 1, T0 + MAX_HTTP));
    expect(list).toHaveLength(MAX_HTTP);
    expect(list[0]?.id).toBe(2);
  });

  it('pruneExchangesBefore returns the same array when nothing ended before the cutoff', () => {
    const list = [exchange(1, T0)];
    expect(pruneExchangesBefore(list, T0 - 1)).toBe(list);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ServerMessage } from '@lionscope/protocol/wire';
import {
  ADB_UNAVAILABLE_CODE,
  appendSample,
  appendSpan,
  applyServerMessageAt,
  FUTURE_SLACK_MS,
  insertByTs,
  MAX_SCREEN_SPANS,
  MAX_STALLS,
  MAX_STRICT_MODE,
  normalizeStalls,
  pruneStallsBefore,
  normalizeSpans,
  SDK_LINK_UNAVAILABLE_CODE,
  pruneSpans,
  applyServerMessage,
  createInitialState,
  createStore,
  dismissError,
  isProtocolMismatch,
  MAX_LOGS,
  pruneBefore,
  setConnection,
  type DashboardState,
  type FlushScheduler,
} from '../src/lib/store.ts';
import { breakdown, cpu, frame, log, memory, session, span, stall, T0, violation } from './fixtures.ts';

const MIN = 60_000;

function apply(state: DashboardState, ...msgs: ServerMessage[]): DashboardState {
  return msgs.reduce(applyServerMessage, state);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('applyServerMessage', () => {
  it('hello stores server info and the buffer window', () => {
    const next = apply(createInitialState(), {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      bufferWindowMs: 5 * MIN,
    });
    expect(next.server).toEqual({ protocolVersion: PROTOCOL_VERSION, serverVersion: '0.1.0' });
    expect(next.bufferWindowMs).toBe(5 * MIN);
    expect(isProtocolMismatch(next)).toBe(false);
  });

  it('hello with a non-positive window keeps the default and flags a protocol mismatch', () => {
    const next = apply(createInitialState(), {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION + 1,
      serverVersion: '9',
      bufferWindowMs: 0,
    });
    expect(next.bufferWindowMs).toBe(10 * MIN);
    expect(isProtocolMismatch(next)).toBe(true);
  });

  it('flags a 0.2 server (protocol 1) as a mismatch: the versions must match exactly', () => {
    expect(PROTOCOL_VERSION).toBe(7);
    const next = apply(createInitialState(), {
      type: 'hello',
      protocolVersion: 1,
      serverVersion: '0.2.0',
      bufferWindowMs: 5 * MIN,
    });
    expect(isProtocolMismatch(next)).toBe(true);
  });

  it('emulators replaces the AVD list (null until the first message)', () => {
    expect(createInitialState().emulators).toBeNull();
    const avd = {
      avdName: 'Pixel_9a',
      displayName: 'Pixel 9a',
      state: 'off' as const,
      serial: null,
      managed: false,
      canMirror: false,
      renderer: 'unknown' as const,
    };
    const once = apply(createInitialState(), { type: 'emulators', emulators: [avd] });
    expect(once.emulators).toEqual([avd]);
    const twice = apply(once, { type: 'emulators', emulators: [] });
    expect(twice.emulators).toEqual([]);
    expect(twice.emulators).not.toBe(once.emulators);
  });

  it('hello with a shorter window prunes existing buffers', () => {
    const filled = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0) },
      { type: 'cpu', sample: cpu(T0 + 5 * MIN) },
    );
    const next = apply(filled, {
      type: 'hello',
      protocolVersion: 1,
      serverVersion: 'x',
      bufferWindowMs: MIN,
    });
    expect(next.cpu.map((s) => s.ts)).toEqual([T0 + 5 * MIN]);
  });

  it('devices, apps and session replace their slices', () => {
    const devices = [{ serial: 'emulator-5554', state: 'device' as const, model: 'sdk_gphone64' }];
    const apps = [{ packageName: 'com.example.shop', pid: 99, thirdParty: true }];
    const next = apply(
      createInitialState(),
      { type: 'devices', devices },
      { type: 'apps', serial: 'emulator-5554', apps },
      { type: 'session', session: session() },
    );
    expect(next.devices).toEqual(devices);
    expect(next.devices).not.toBe(devices);
    expect(next.apps).toEqual({ serial: 'emulator-5554', apps });
    expect(next.session.status).toBe('running');
  });

  it('snapshot replaces all buffers, sorts them and assigns log sequence numbers', () => {
    const prior = apply(createInitialState(), { type: 'cpu', sample: cpu(T0 - 1000) });
    const next = apply(prior, {
      type: 'snapshot',
      snapshot: {
        cpu: [cpu(T0 + 2000), cpu(T0 + 1000)],
        memory: [memory(T0)],
        frames: [frame(T0 + 1000)],
        logs: [log(T0 + 2000), log(T0 + 1000)],
        events: [{ ts: T0, kind: 'process_start', pid: 1234 }],
      },
    });
    expect(next.cpu.map((s) => s.ts)).toEqual([T0 + 1000, T0 + 2000]);
    expect(next.memory).toHaveLength(1);
    expect(next.frames).toHaveLength(1);
    expect(next.logs.map((l) => [l.ts, l.seq])).toEqual([
      [T0 + 1000, 0],
      [T0 + 2000, 1],
    ]);
    expect(next.nextLogSeq).toBe(2);
    expect(next.events).toHaveLength(1);
    expect(next.latestTs).toBe(T0 + 2000);
  });

  it('snapshot prunes samples older than the buffer window', () => {
    const next = apply(createInitialState(), {
      type: 'snapshot',
      snapshot: { cpu: [cpu(T0), cpu(T0 + 11 * MIN)], memory: [], frames: [], logs: [], events: [] },
    });
    expect(next.cpu.map((s) => s.ts)).toEqual([T0 + 11 * MIN]);
  });

  it('appends cpu, memory and frame samples and advances latestTs', () => {
    const next = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0) },
      { type: 'memory', sample: memory(T0 + 500) },
      { type: 'frames', sample: frame(T0 + 1000) },
    );
    expect(next.cpu).toHaveLength(1);
    expect(next.memory).toHaveLength(1);
    expect(next.frames).toHaveLength(1);
    expect(next.latestTs).toBe(T0 + 1000);
  });

  it('drops out-of-order and duplicate samples without changing state', () => {
    const state = apply(createInitialState(), { type: 'cpu', sample: cpu(T0 + 1000) });
    expect(apply(state, { type: 'cpu', sample: cpu(T0) })).toBe(state);
    expect(apply(state, { type: 'cpu', sample: cpu(T0 + 1000) })).toBe(state);
    const withMem = apply(state, { type: 'memory', sample: memory(T0 + 1000) });
    expect(apply(withMem, { type: 'memory', sample: memory(T0) })).toBe(withMem);
    const withFrames = apply(state, { type: 'frames', sample: frame(T0 + 1000) });
    expect(apply(withFrames, { type: 'frames', sample: frame(T0) })).toBe(withFrames);
  });

  it('prunes every buffer relative to the newest timestamp', () => {
    let state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0) },
      { type: 'memory', sample: memory(T0) },
      { type: 'frames', sample: frame(T0) },
      { type: 'logs', entries: [log(T0)] },
      { type: 'event', event: { ts: T0, kind: 'process_start', pid: 1 } },
    );
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 10 * MIN + 1) });
    expect(state.cpu.map((s) => s.ts)).toEqual([T0 + 10 * MIN + 1]);
    expect(state.memory).toEqual([]);
    expect(state.frames).toEqual([]);
    expect(state.logs).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('appends logs with increasing sequence numbers and ignores empty batches', () => {
    const state = apply(createInitialState(), { type: 'logs', entries: [log(T0), log(T0 + 1)] });
    const next = apply(state, { type: 'logs', entries: [log(T0 + 2, { level: 'E' })] });
    expect(next.logs.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(next.logs[2]?.level).toBe('E');
    expect(apply(next, { type: 'logs', entries: [] })).toBe(next);
  });

  it(`caps logs at ${MAX_LOGS}, keeping the newest`, () => {
    const entries = Array.from({ length: MAX_LOGS + 25 }, (_, i) => log(T0 + i));
    const next = apply(createInitialState(), { type: 'logs', entries });
    expect(next.logs).toHaveLength(MAX_LOGS);
    expect(next.logs[0]?.ts).toBe(T0 + 25);
    expect(next.logs[MAX_LOGS - 1]?.seq).toBe(MAX_LOGS + 24);
  });

  it('keeps events sorted even when they arrive out of order', () => {
    const next = apply(
      createInitialState(),
      { type: 'event', event: { ts: T0 + 1000, kind: 'process_died', pid: 1 } },
      { type: 'event', event: { ts: T0, kind: 'process_start', pid: 1 } },
    );
    expect(next.events.map((e) => e.kind)).toEqual(['process_start', 'process_died']);
  });

  it('error records the latest message with an incrementing id', () => {
    const first = apply(createInitialState(), {
      type: 'error',
      message: 'adb not found',
      code: 'ADB_MISSING',
    });
    const second = apply(first, { type: 'error', message: 'device gone' });
    expect(first.lastError).toEqual({ id: 1, message: 'adb not found', code: 'ADB_MISSING' });
    expect(second.lastError).toEqual({ id: 2, message: 'device gone' });
    expect(dismissError(second, 1)).toBe(second);
    expect(dismissError(second, 2).lastError).toBeNull();
  });

  it('never mutates the previous state', () => {
    const base = deepFreeze(
      apply(
        createInitialState(),
        { type: 'cpu', sample: cpu(T0) },
        { type: 'logs', entries: [log(T0)] },
        { type: 'devices', devices: [{ serial: 'a', state: 'device' }] },
      ),
    );
    const snapshot = JSON.stringify(base);
    const msgs: ServerMessage[] = [
      { type: 'hello', protocolVersion: 1, serverVersion: '1', bufferWindowMs: MIN },
      { type: 'devices', devices: [] },
      { type: 'apps', serial: 'a', apps: [] },
      { type: 'session', session: session() },
      { type: 'snapshot', snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [] } },
      { type: 'cpu', sample: cpu(T0 + 1000) },
      { type: 'memory', sample: memory(T0 + 1000) },
      { type: 'frames', sample: frame(T0 + 1000) },
      { type: 'logs', entries: [log(T0 + 1000)] },
      { type: 'event', event: { ts: T0 + 1000, kind: 'process_restart', pid: 2 } },
      { type: 'error', message: 'x' },
    ];
    for (const msg of msgs) expect(() => applyServerMessage(base, msg)).not.toThrow();
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('clocks', () => {
  it('logs never move the pruning reference', () => {
    const state = apply(createInitialState(), { type: 'cpu', sample: cpu(T0) });
    const next = apply(state, { type: 'logs', entries: [log(T0 + 60 * MIN)] });
    expect(next.latestTs).toBe(T0);
    expect(next.cpu).toHaveLength(1);
  });

  it('a device clock jump in logs does not wipe the metric buffers', () => {
    const state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0) },
      { type: 'memory', sample: memory(T0) },
      { type: 'logs', entries: [log(T0 + 24 * 60 * MIN)] },
      { type: 'cpu', sample: cpu(T0 + 1000) },
    );
    expect(state.cpu).toHaveLength(2);
    expect(state.memory).toHaveLength(1);
    expect(state.logs).toHaveLength(1);
  });

  it('logs are pruned against the laptop-clock reference', () => {
    const state = apply(
      createInitialState(),
      { type: 'logs', entries: [log(T0)] },
      { type: 'cpu', sample: cpu(T0 + 11 * MIN) },
    );
    expect(state.logs).toEqual([]);
  });

  it('snapshot ignores log timestamps when picking the reference', () => {
    const next = apply(createInitialState(), {
      type: 'snapshot',
      snapshot: { cpu: [cpu(T0)], memory: [], frames: [], logs: [log(T0 + 99 * MIN)], events: [] },
    });
    expect(next.latestTs).toBe(T0);
    expect(next.cpu).toHaveLength(1);
  });

  it('a laptop clock step back of more than 5 s restarts the timeline instead of dropping forever', () => {
    let state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0 + 60_000) },
      { type: 'memory', sample: memory(T0 + 60_000) },
      { type: 'event', event: { ts: T0 + 59_000, kind: 'process_start', pid: 1 } },
    );
    expect(apply(state, { type: 'cpu', sample: cpu(T0 + 56_000) })).toBe(state);
    state = apply(state, { type: 'cpu', sample: cpu(T0) });
    expect(state.cpu.map((s) => s.ts)).toEqual([T0]);
    expect(state.memory).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.latestTs).toBe(T0);
    state = apply(
      state,
      { type: 'memory', sample: memory(T0 + 500) },
      { type: 'cpu', sample: cpu(T0 + 1000) },
    );
    expect(state.cpu).toHaveLength(2);
    expect(state.memory).toHaveLength(1);
  });

  it('appendSample reports append / drop / reset', () => {
    expect(appendSample([], { ts: 1 })).toEqual({ kind: 'append', items: [{ ts: 1 }] });
    expect(appendSample([{ ts: 10_000 }], { ts: 9000 })).toEqual({ kind: 'drop' });
    expect(appendSample([{ ts: 10_000 }], { ts: 1000 })).toEqual({ kind: 'reset', items: [{ ts: 1000 }] });
  });
});

describe('request bookkeeping', () => {
  it('counts session messages and errors so the UI can tell a request was answered', () => {
    const state = apply(
      createInitialState(),
      { type: 'session', session: session() },
      { type: 'session', session: session({ status: 'idle' }) },
      { type: 'error', message: 'a' },
    );
    expect(state.sessionSeq).toBe(2);
    expect(state.errorSeq).toBe(1);
    const dismissed = dismissError(state, 1);
    expect(apply(dismissed, { type: 'error', message: 'b' }).lastError?.id).toBe(2);
  });

  it('adb_unavailable is sticky until a device is listed', () => {
    let state = apply(createInitialState(), {
      type: 'error',
      code: ADB_UNAVAILABLE_CODE,
      message: 'adb is not available',
    });
    expect(state.adbUnavailable).toBe('adb is not available');
    state = dismissError(apply(state, { type: 'devices', devices: [] }), state.errorSeq);
    expect(state.adbUnavailable).toBe('adb is not available');
    state = apply(state, { type: 'devices', devices: [{ serial: 'emulator-5554', state: 'device' }] });
    expect(state.adbUnavailable).toBeNull();
  });
});

describe('pruneBefore', () => {
  it('returns the same array when nothing is older than the cutoff', () => {
    const items = [{ ts: 5 }, { ts: 6 }];
    expect(pruneBefore(items, 5)).toBe(items);
    expect(pruneBefore(items, 6)).toEqual([{ ts: 6 }]);
    expect(pruneBefore(items, 7)).toEqual([]);
  });
});

describe('setConnection', () => {
  it('returns the same state for an identical connection', () => {
    const state = createInitialState();
    expect(setConnection(state, { status: 'connecting', attempt: 0, retryAt: null, closeReason: null })).toBe(
      state,
    );
    const next = setConnection(state, {
      status: 'reconnecting',
      attempt: 2,
      retryAt: 123,
      closeReason: 'rate-limited',
    });
    expect(next.connection).toEqual({
      status: 'reconnecting',
      attempt: 2,
      retryAt: 123,
      closeReason: 'rate-limited',
    });
  });
});

describe('createStore', () => {
  function manualScheduler() {
    const pending: Array<() => void> = [];
    const scheduler: FlushScheduler = (flush) => {
      pending.push(flush);
      return vi.fn();
    };
    return { scheduler, run: () => pending.splice(0).forEach((f) => f()), pending };
  }

  it('batches many messages into one notification per flush', () => {
    const { scheduler, run, pending } = manualScheduler();
    const store = createStore(scheduler);
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0) } });
    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0 + 1000) } });
    store.dispatch({
      kind: 'connection',
      connection: { status: 'open', attempt: 0, retryAt: null, closeReason: null },
    });
    expect(pending).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().cpu).toHaveLength(0);

    run();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().cpu).toHaveLength(2);
    expect(store.getState().connection.status).toBe('open');
  });

  it('does not notify when the batch leaves state unchanged', () => {
    const { scheduler, run } = manualScheduler();
    const store = createStore(scheduler);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ kind: 'server', msg: { type: 'logs', entries: [] } });
    run();
    expect(listener).not.toHaveBeenCalled();
  });

  it('flush applies immediately; unsubscribe stops notifications', () => {
    const { scheduler } = manualScheduler();
    const store = createStore(scheduler);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0) } });
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0 + 1000) } });
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().cpu).toHaveLength(2);
  });

  it('a message that throws is skipped without losing the rest of the batch', () => {
    const { scheduler, run } = manualScheduler();
    const store = createStore(scheduler);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0) } });
    // Malformed on the wire: `devices` is not an array, so the reducer throws.
    store.dispatch({ kind: 'server', msg: { type: 'devices', devices: null } as unknown as ServerMessage });
    store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0 + 1000) } });
    run();
    expect(store.getState().cpu).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('default frame scheduler flushes on the next animation frame or the fallback timeout', () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      store.dispatch({ kind: 'server', msg: { type: 'cpu', sample: cpu(T0) } });
      expect(store.getState().cpu).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(store.getState().cpu).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('screens and breakdown', () => {
  const screen = (start: number, name: string | null): ServerMessage => ({
    type: 'screen',
    span: span(start, null, name),
  });

  it('a new top screen closes the open span at its start and advances latestTs', () => {
    const next = apply(createInitialState(), screen(T0, 'MainActivity'), screen(T0 + 4000, 'list'));
    expect(next.screens.map((s) => [s.start, s.end, s.screen?.name])).toEqual([
      [T0, T0 + 4000, 'MainActivity'],
      [T0 + 4000, null, 'list'],
    ]);
    expect(next.latestTs).toBe(T0 + 4000);
  });

  it('the server re-sending the open span closed (same start, end set) replaces it', () => {
    const open = apply(createInitialState(), screen(T0, 'a'), screen(T0 + 2000, 'b'));
    const closed = apply(open, { type: 'screen', span: span(T0 + 2000, T0 + 5000, 'b') });
    expect(closed.screens.map((s) => [s.start, s.end])).toEqual([
      [T0, T0 + 2000],
      [T0 + 2000, T0 + 5000],
    ]);
    // The next screen after a gap keeps the explicit end.
    const next = apply(closed, screen(T0 + 9000, 'c'));
    expect(next.screens.map((s) => s.end)).toEqual([T0 + 2000, T0 + 5000, null]);
  });

  it('a background span (null screen) is kept as its own span', () => {
    const next = apply(createInitialState(), screen(T0, 'list'), screen(T0 + 1000, null));
    expect(next.screens.at(-1)?.screen).toBeNull();
    expect(next.screens[0]?.end).toBe(T0 + 1000);
  });

  it('same-start reports replace; small step backs drop; large ones reset the timeline', () => {
    const base = apply(createInitialState(), { type: 'cpu', sample: cpu(T0 + 9000) }, screen(T0 + 9000, 'a'));
    expect(apply(base, screen(T0 + 9000, 'b')).screens.map((s) => s.screen?.name)).toEqual(['b']);
    expect(apply(base, screen(T0 + 8000, 'b'))).toBe(base);

    const reset = apply(base, screen(T0, 'b'));
    expect(reset.screens.map((s) => s.screen?.name)).toEqual(['b']);
    expect(reset.cpu).toEqual([]);
    expect(reset.latestTs).toBe(T0);
  });

  it('a metric clock reset carries the open screen over, re-based to the reset', () => {
    const base = apply(
      createInitialState(),
      screen(T0 + 10 * MIN, 'list'),
      { type: 'breakdown', sample: breakdown(T0 + 10 * MIN, 'list') },
      { type: 'cpu', sample: cpu(T0 + 10 * MIN) },
    );
    const reset = apply(base, { type: 'cpu', sample: cpu(T0) });
    expect(reset.screens).toEqual([span(T0, null, 'list')]);
    expect(reset.breakdown).toEqual([]);
  });

  it('prunes ended spans out of the window but never the open one', () => {
    const next = apply(
      createInitialState(),
      { type: 'hello', protocolVersion: 1, serverVersion: 'x', bufferWindowMs: MIN },
      screen(T0, 'old'),
      screen(T0 + 10_000, 'straddles'),
      screen(T0 + 30_000, 'current'),
      { type: 'cpu', sample: cpu(T0 + 80_000) },
    );
    // Cutoff is T0 + 20 s: 'old' ended at +10 s, 'straddles' ends inside the window.
    expect(next.screens.map((s) => s.screen?.name)).toEqual(['straddles', 'current']);
    const later = apply(next, { type: 'cpu', sample: cpu(T0 + 10 * MIN) });
    expect(later.screens.map((s) => s.screen?.name)).toEqual(['current']);
  });

  it('appends breakdown samples in order, drops reorders and prunes with the window', () => {
    const next = apply(
      createInitialState(),
      { type: 'hello', protocolVersion: 1, serverVersion: 'x', bufferWindowMs: MIN },
      { type: 'breakdown', sample: breakdown(T0, 'a') },
      { type: 'breakdown', sample: breakdown(T0 + 500, 'a') },
    );
    expect(next.breakdown.map((b) => b.ts)).toEqual([T0, T0 + 500]);
    expect(next.latestTs).toBe(T0 + 500);
    expect(apply(next, { type: 'breakdown', sample: breakdown(T0 + 200, 'a') })).toBe(next);
    const pruned = apply(next, { type: 'cpu', sample: cpu(T0 + 2 * MIN) });
    expect(pruned.breakdown).toEqual([]);
  });

  it('snapshot replaces both streams, normalizes span shape and tolerates older servers', () => {
    const filled = apply(createInitialState(), screen(T0, 'x'), {
      type: 'breakdown',
      sample: breakdown(T0, 'x'),
    });
    const snap = apply(filled, {
      type: 'snapshot',
      snapshot: {
        cpu: [],
        memory: [],
        frames: [],
        logs: [],
        events: [],
        screens: [span(T0 + 5000, null, 'b'), span(T0 + 1000, null, 'a')],
        breakdown: [breakdown(T0 + 6000, 'b'), breakdown(T0 + 2000, 'a')],
      },
    });
    expect(snap.screens.map((s) => [s.start, s.end, s.screen?.name])).toEqual([
      [T0 + 1000, T0 + 5000, 'a'],
      [T0 + 5000, null, 'b'],
    ]);
    expect(snap.breakdown.map((b) => b.ts)).toEqual([T0 + 2000, T0 + 6000]);
    expect(snap.latestTs).toBe(T0 + 6000);

    const old = apply(snap, {
      type: 'snapshot',
      snapshot: { cpu: [cpu(T0)], memory: [], frames: [], logs: [], events: [] },
    });
    expect(old.screens).toEqual([]);
    expect(old.breakdown).toEqual([]);
  });

  it('never mutates the previous state', () => {
    const base = deepFreeze(apply(createInitialState(), screen(T0, 'a')));
    expect(() =>
      apply(base, screen(T0 + 1000, 'b'), { type: 'breakdown', sample: breakdown(T0 + 1000, 'b') }),
    ).not.toThrow();
    expect(base.screens[0]?.end).toBeNull();
  });
});

describe('span helpers', () => {
  it('pruneSpans keeps the open span and returns the same array when nothing drops', () => {
    const spans = [span(T0, T0 + 1000, 'a'), span(T0 + 1000, null, 'b')];
    expect(pruneSpans(spans, T0, T0 + 5000)).toBe(spans);
    expect(pruneSpans(spans, T0 + 4000, T0 + 5000)).toEqual([spans[1]]);
  });

  it('normalizeSpans drops empty closed spans and keeps the last report per start', () => {
    const fixed = normalizeSpans([
      span(T0, T0, 'zero'),
      span(T0 + 1000, T0 + 500, 'negative'),
      span(T0 + 2000, null, 'first report'),
      span(T0 + 2000, T0 + 3000, 'closed re-send'),
      span(T0 + 4000, null, 'open'),
    ]);
    expect(fixed.map((s) => [s.start - T0, s.end === null ? null : s.end - T0, s.screen?.name])).toEqual([
      [2000, 3000, 'closed re-send'],
      [4000, null, 'open'],
    ]);
  });

  it(`caps the span buffer at ${MAX_SCREEN_SPANS}, dropping the oldest`, () => {
    const many = Array.from({ length: MAX_SCREEN_SPANS + 5 }, (_, i) => span(T0 + i * 10, null, `s${i}`));
    const fixed = normalizeSpans(many);
    expect(fixed).toHaveLength(MAX_SCREEN_SPANS);
    expect(fixed[0]?.screen?.name).toBe('s5');
    const appended = appendSpan(fixed, span(T0 + 10_000_000, null, 'next'));
    expect(appended.kind === 'append' && appended.spans.length).toBe(MAX_SCREEN_SPANS);
  });

  it('normalizeSpans closes overlapping and open spans at the next start', () => {
    const fixed = normalizeSpans([
      span(T0, T0 + 9000, 'a'),
      span(T0 + 2000, null, 'b'),
      span(T0 + 4000, null, 'c'),
    ]);
    expect(fixed.map((s) => s.end)).toEqual([T0 + 2000, T0 + 4000, null]);
  });

  it('appendSpan keeps an earlier explicit end (a gap between spans)', () => {
    const result = appendSpan([span(T0, T0 + 1000, 'a')], span(T0 + 3000, null, 'b'));
    expect(result.kind === 'append' && result.spans.map((s) => s.end)).toEqual([T0 + 1000, null]);
  });
});

describe('SDK link and clock tolerance', () => {
  const linkError: ServerMessage = {
    type: 'error',
    code: SDK_LINK_UNAVAILABLE_CODE,
    message: 'adb reverse tcp:8700 failed: device offline',
  };

  it('keeps an adb reverse failure until the SDK connects', () => {
    const failed = apply(createInitialState(), { type: 'session', session: session() }, linkError);
    expect(failed.sdkLinkError).toBe('adb reverse tcp:8700 failed: device offline');
    // Other errors and same-session updates leave it in place.
    const still = apply(
      failed,
      { type: 'error', message: 'other' },
      { type: 'session', session: session({ pid: 99 }) },
    );
    expect(still.sdkLinkError).not.toBeNull();
    const sdk = { connected: true, sdkVersion: '0.1.0', processName: 'p', apiLevel: 34, framesActive: false };
    expect(apply(still, { type: 'session', session: session({ sdk }) }).sdkLinkError).toBeNull();
  });

  it('a new session clears the adb reverse failure', () => {
    const failed = apply(createInitialState(), { type: 'session', session: session() }, linkError);
    const next = apply(failed, { type: 'session', session: session({ startedAt: T0 + MIN }) });
    expect(next.sdkLinkError).toBeNull();
  });

  it('SDK frames that follow gfxinfo frames with a later ts are all kept (handover)', () => {
    const next = apply(
      createInitialState(),
      { type: 'frames', sample: frame(T0) },
      { type: 'frames', sample: frame(T0 + 1000) },
      { type: 'frames', sample: frame(T0 + 1001, { source: 'sdk' }) },
      { type: 'frames', sample: frame(T0 + 1500, { source: 'sdk' }) },
    );
    expect(next.frames.map((f) => [f.ts - T0, f.source ?? 'gfxinfo'])).toEqual([
      [0, 'gfxinfo'],
      [1000, 'gfxinfo'],
      [1001, 'sdk'],
      [1500, 'sdk'],
    ]);
  });

  it('a far-future screen start cannot drag latestTs past now + 5 s', () => {
    const now = T0 + MIN;
    const base = applyServerMessageAt(createInitialState(), { type: 'cpu', sample: cpu(now - 1000) }, now);
    const next = applyServerMessageAt(
      base,
      { type: 'screen', span: span(now + 3_600_000, null, 'future') },
      now,
    );
    expect(next.latestTs).toBe(now + FUTURE_SLACK_MS);
    expect(next.screens.at(-1)?.screen?.name).toBe('future');
    const near = applyServerMessageAt(base, { type: 'screen', span: span(now + 1000, null, 'soon') }, now);
    expect(near.latestTs).toBe(now + 1000);
  });
});

describe('stalls and StrictMode', () => {
  const at = (state: DashboardState, msg: ServerMessage, now = T0 + 60_000) =>
    applyServerMessageAt(state, msg, now);
  const base = () => apply(createInitialState(), { type: 'cpu', sample: cpu(T0 + 30_000) });

  it('slots a late-reported stall in by its start, without moving older samples', () => {
    let state = base();
    state = at(state, { type: 'stall', sample: stall(T0 + 29_000, 400) });
    state = at(state, { type: 'stall', sample: stall(T0 + 10_000, 30_000) });
    state = at(state, { type: 'stall', sample: stall(T0 + 31_000, 200) });
    expect(state.stalls.map((s) => s.ts - T0)).toEqual([10_000, 29_000, 31_000]);
    expect(state.latestTs).toBe(T0 + 31_000);
    // A 30 s step back is a stall's normal lag, not a laptop clock reset.
    expect(state.cpu).toHaveLength(1);
  });

  it('a re-sent stall (same start) replaces the stored one', () => {
    let state = at(base(), { type: 'stall', sample: stall(T0 + 1000, 400) });
    state = at(state, { type: 'stall', sample: stall(T0 + 1000, 450, { truncated: true }) });
    expect(state.stalls).toHaveLength(1);
    expect(state.stalls[0]).toMatchObject({ durationMs: 450, truncated: true });
  });

  it('keeps every violation, sorted, even with equal timestamps', () => {
    let state = at(base(), { type: 'strictmode', sample: violation(T0 + 2000) });
    state = at(state, { type: 'strictmode', sample: violation(T0 + 1000) });
    state = at(state, {
      type: 'strictmode',
      sample: violation(T0 + 2000, { violation: 'NetworkViolation' }),
    });
    expect(state.strictMode.map((v) => `${v.ts - T0}:${v.violation}`)).toEqual([
      '1000:DiskReadViolation',
      '2000:DiskReadViolation',
      '2000:NetworkViolation',
    ]);
  });

  it('prunes both streams with the window and caps them, oldest first', () => {
    let state = at(base(), { type: 'stall', sample: stall(T0, 300) });
    state = at(state, { type: 'strictmode', sample: violation(T0) });
    // The stall ends at T0 + 300: it leaves once the window's left edge passes its end.
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 10 * MIN + 301) });
    expect(state.stalls).toEqual([]);
    expect(state.strictMode).toEqual([]);
    const many = Array.from({ length: MAX_STALLS + 5 }, (_, i) => ({ ts: i }));
    const capped = insertByTs(many.slice(0, MAX_STALLS), { ts: MAX_STALLS }, MAX_STALLS, true);
    expect(capped).toHaveLength(MAX_STALLS);
    expect(capped[0]?.ts).toBe(1);
    expect(MAX_STRICT_MODE).toBe(2000);
  });

  it('drops stalls and violations that claim to start past now + 5 s', () => {
    const now = T0 + 40_000;
    let state = at(base(), { type: 'stall', sample: stall(now + FUTURE_SLACK_MS + 1, 300) }, now);
    state = at(state, { type: 'strictmode', sample: violation(now + 3_600_000) }, now);
    expect(state.stalls).toEqual([]);
    expect(state.strictMode).toEqual([]);
    expect(state.latestTs).toBe(T0 + 30_000);
    // Within the slack they are kept.
    state = at(state, { type: 'stall', sample: stall(now + FUTURE_SLACK_MS, 300) }, now);
    expect(state.stalls).toHaveLength(1);
    const snap = applyServerMessageAt(
      base(),
      {
        type: 'snapshot',
        snapshot: {
          cpu: [cpu(T0 + 30_000)],
          memory: [],
          frames: [],
          logs: [],
          events: [],
          stalls: [stall(T0 + 1000, 300), stall(now + 60_000, 300)],
          strictMode: [violation(now + 60_000)],
        },
      },
      now,
    );
    expect(snap.stalls.map((s) => s.ts)).toEqual([T0 + 1000]);
    expect(snap.strictMode).toEqual([]);
  });

  it('prunes a stall by its end: one still running into the window stays', () => {
    let state = at(base(), { type: 'stall', sample: stall(T0, 20_000) });
    state = at(state, { type: 'stall', sample: stall(T0 + 21_000, 300) });
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 10 * MIN + 10_000) });
    expect(state.stalls.map((s) => s.ts)).toEqual([T0, T0 + 21_000]);
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 10 * MIN + 21_000) });
    expect(state.stalls.map((s) => s.ts)).toEqual([T0 + 21_000]);
    expect(pruneStallsBefore(state.stalls, 0)).toBe(state.stalls);
  });

  it('snapshots replace both streams (sorted, one stall per start) and tolerate older servers', () => {
    let state = at(base(), { type: 'stall', sample: stall(T0 + 5000, 300) });
    state = apply(state, {
      type: 'snapshot',
      snapshot: {
        cpu: [cpu(T0 + 40_000)],
        memory: [],
        frames: [],
        logs: [],
        events: [],
        stalls: [stall(T0 + 3000, 700), stall(T0 + 1000, 300), stall(T0 + 3000, 800)],
        strictMode: [violation(T0 + 2000), violation(T0 + 500)],
      },
    });
    expect(state.stalls.map((s) => [s.ts - T0, s.durationMs])).toEqual([
      [1000, 300],
      [3000, 800],
    ]);
    expect(state.strictMode.map((v) => v.ts - T0)).toEqual([500, 2000]);
    const older = apply(state, {
      type: 'snapshot',
      snapshot: { cpu: [cpu(T0 + 50_000)], memory: [], frames: [], logs: [], events: [] },
    });
    expect(older.stalls).toEqual([]);
    expect(older.strictMode).toEqual([]);
    expect(normalizeStalls(Array.from({ length: MAX_STALLS + 1 }, (_, i) => stall(i, 200)))).toHaveLength(
      MAX_STALLS,
    );
  });

  it('a laptop clock reset clears both streams with the rest of the timeline', () => {
    let state = at(base(), { type: 'stall', sample: stall(T0 + 20_000, 300) });
    state = at(state, { type: 'strictmode', sample: violation(T0 + 20_000) });
    state = apply(state, { type: 'cpu', sample: cpu(T0 - MIN) });
    expect(state.stalls).toEqual([]);
    expect(state.strictMode).toEqual([]);
    expect(state.latestTs).toBe(T0 - MIN);
  });

  it('never mutates the previous state', () => {
    const before = deepFreeze(at(base(), { type: 'stall', sample: stall(T0 + 1000, 300) }));
    expect(() => at(before, { type: 'stall', sample: stall(T0 + 500, 300) })).not.toThrow();
    expect(() => at(before, { type: 'strictmode', sample: violation(T0 + 500) })).not.toThrow();
    expect(before.stalls).toHaveLength(1);
  });
});

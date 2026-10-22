import { MAX_STACK_FRAMES } from '@lionscope/protocol';
import type {
  ScreenRef,
  ServerMessage,
  StackFrame,
  StallSample,
  StrictModeSample,
} from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_BUFFERED_BYTES } from '../src/http/wsGateway.ts';
import {
  emptySnapshot,
  MAX_EVENT_STREAM_BYTES,
  SAMPLE_STREAMS,
  SessionStore,
} from '../src/store/sessionStore.ts';

const HOME: ScreenRef = { name: 'home', className: 'com.example.HomeFragment', kind: 'fragment' };
const PROMO: ScreenRef = { name: 'Promo', className: 'com.example.PromoSheet', kind: 'dialog' };

function setup(windowMs = 10_000, start = 100_000) {
  let now = start;
  const messages: ServerMessage[] = [];
  const store = new SessionStore({ windowMs, emit: (message) => messages.push(message), now: () => now });
  return {
    store,
    messages,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('SessionStore', () => {
  it('keeps the worst-case snapshot below the ws client buffer limit with every stream full', () => {
    const { store } = setup(3_600_000, 1_000_000);
    const frame: StackFrame = {
      className: 'c'.repeat(200),
      method: 'm'.repeat(200),
      file: 'f'.repeat(128),
      line: 1,
      inApp: true,
    };
    const frames = Array.from({ length: MAX_STACK_FRAMES }, () => frame);
    const fill = (count: number, make: (ts: number) => void) => {
      for (let i = 0; i < count; i += 1) make(900_000 + i);
    };
    fill(6000, (ts) => store.append('cpu', { ts, percent: 100, percentSingleCore: 400, threads: 999 }));
    fill(6000, (ts) =>
      store.append('memory', {
        ts,
        totalPssKb: 9e9,
        javaHeapKb: 9e9,
        nativeHeapKb: 9e9,
        codeKb: 9e9,
        stackKb: 9e9,
        graphicsKb: 9e9,
        privateOtherKb: 9e9,
        systemKb: 9e9,
      }),
    );
    fill(6000, (ts) => store.append('events', { ts, kind: 'process_start', pid: 999_999 }));
    fill(6000, (ts) =>
      store.append('logs', {
        ts,
        pid: 99_999,
        tid: 99_999,
        level: 'I',
        tag: 't'.repeat(64),
        message: 'm'.repeat(4000),
      }),
    );
    fill(3000, (ts) =>
      store.append('stalls', {
        ts,
        durationMs: 60_000,
        frames,
        samples: 1,
        truncated: true,
        screen: 's'.repeat(200),
        debugger: true,
      }),
    );
    fill(3000, (ts) =>
      store.append('strictMode', {
        ts,
        policy: 'thread',
        violation: 'v'.repeat(128),
        message: 'm'.repeat(256),
        frames,
        count: 1,
        screen: 's'.repeat(200),
      }),
    );
    fill(3000, (ts) =>
      store.append('inflates', {
        ts,
        layout: 'l'.repeat(200),
        label: null,
        library: false,
        nested: false,
        screen: 's'.repeat(200),
        count: 1,
        totalMs: 1,
        maxMs: 1,
        views: 1,
      }),
    );
    const path = Array.from({ length: 64 }, () => ({ className: 'c'.repeat(200), id: 'i'.repeat(200) }));
    fill(1000, (ts) =>
      store.append('viewTrees', {
        ts,
        screen: 's'.repeat(200),
        window: 'w'.repeat(200),
        views: 1,
        viewGroups: 1,
        maxDepth: 64,
        deepestPath: path,
        topClasses: [],
      }),
    );
    const snapshot = store.snapshot();
    expect(snapshot.inflates.length).toBeGreaterThan(0);
    expect(snapshot.viewTrees.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify({ type: 'snapshot', snapshot }))).toBeLessThan(
      MAX_CLIENT_BUFFERED_BYTES,
    );
  });

  it('has an empty snapshot with every stream, including the Phase 2 and 3 ones', () => {
    expect(emptySnapshot()).toEqual({
      cpu: [],
      memory: [],
      frames: [],
      logs: [],
      events: [],
      breakdown: [],
      stalls: [],
      strictMode: [],
      inflates: [],
      viewTrees: [],
      screens: [],
    });
    expect(setup().store.snapshot()).toEqual(emptySnapshot());
    expect(SAMPLE_STREAMS).toContain('breakdown');
    expect(SAMPLE_STREAMS).toContain('stalls');
  });

  it('buffers then announces each appended item with its stream message', () => {
    const { store, messages } = setup();
    const cpu = { ts: 99_000, percent: 1, percentSingleCore: 4, threads: 3 };
    store.append('cpu', cpu);
    store.append('events', { ts: 99_100, kind: 'process_start', pid: 7 });
    store.append(
      'logs',
      { ts: 99_200, pid: 7, tid: 7, level: 'I', tag: 'A', message: 'a' },
      { ts: 99_201, pid: 7, tid: 7, level: 'W', tag: 'B', message: 'b' },
    );
    store.append('logs');
    expect(messages.map((message) => message.type)).toEqual(['cpu', 'event', 'logs']);
    expect(messages[0]).toEqual({ type: 'cpu', sample: cpu });
    expect(messages[2]?.type === 'logs' && messages[2].entries).toHaveLength(2);
    const snapshot = store.snapshot();
    expect(snapshot.cpu).toEqual([cpu]);
    expect(snapshot.logs).toHaveLength(2);
    expect(snapshot.events).toHaveLength(1);
  });

  it('keeps frames and breakdown strictly increasing in time, dropping overlaps', () => {
    const { store, messages } = setup();
    const frame = (ts: number) => ({
      ts,
      frameCount: 1,
      jankCount: 0,
      slowCount: 0,
      fps: 2,
      p50Ms: 5,
      p90Ms: 5,
      p99Ms: 5,
      maxMs: 5,
      frameIntervalMs: 16.67,
      frameIntervalSource: 'reported' as const,
      durationsMs: [5],
    });
    store.append('frames', frame(99_000), frame(98_000), frame(99_000), frame(99_500));
    store.append('frames', frame(99_500));
    expect(store.snapshot().frames.map((sample) => sample.ts)).toEqual([99_000, 99_500]);
    expect(messages.map((message) => message.type === 'frames' && message.sample.ts)).toEqual([
      99_000, 99_500,
    ]);
    expect(store.last('frames')?.ts).toBe(99_500);
    // Other streams keep whatever order their producer uses (e.g. logcat history).
    const entry = (ts: number) => ({ ts, pid: 1, tid: 1, level: 'I' as const, tag: 'T', message: 'm' });
    store.append('logs', entry(99_200), entry(99_100));
    expect(store.snapshot().logs).toHaveLength(2);
  });

  it('buffers and announces stalls and StrictMode violations', () => {
    const { store, messages } = setup();
    const frames: StackFrame[] = [{ className: 'a.B', method: 'c', file: null, line: -2, inApp: false }];
    const stall: StallSample = {
      ts: 99_000,
      durationMs: 342,
      frames,
      samples: 6,
      truncated: false,
      screen: 'home',
      debugger: false,
    };
    const violation: StrictModeSample = {
      ts: 99_500,
      policy: 'vm',
      violation: 'LeakedClosableViolation',
      message: 'leak',
      frames,
      count: 2,
      screen: null,
    };
    store.append('stalls', stall);
    store.append('strictMode', violation);
    expect(messages).toEqual([
      { type: 'stall', sample: stall },
      { type: 'strictmode', sample: violation },
    ]);
    expect(store.snapshot()).toMatchObject({ stalls: [stall], strictMode: [violation] });
  });

  it('caps the stall and StrictMode streams by count and by serialised size', () => {
    const { store } = setup(60_000);
    const stall = (ts: number): StallSample => ({
      ts,
      durationMs: 200,
      frames: [],
      samples: 4,
      truncated: false,
      screen: null,
      debugger: false,
    });
    for (let i = 0; i < 2100; i += 1) store.append('stalls', stall(50_000 + i));
    expect(store.snapshot().stalls).toHaveLength(2000);
    expect(store.snapshot().stalls[0]?.ts).toBe(50_100);

    // 2000 maximal items (a full stack of maximal strings, ~47 KB serialised each): what is kept still fits.
    const big: StackFrame = {
      className: 'c'.repeat(256),
      method: 'm'.repeat(256),
      file: 'f'.repeat(128),
      line: -2,
      inApp: true,
    };
    const frames = Array.from({ length: MAX_STACK_FRAMES }, () => big);
    for (let i = 0; i < 2000; i += 1) {
      store.append('stalls', { ...stall(60_000 + i), frames, truncated: true, screen: 's'.repeat(256) });
      store.append('strictMode', {
        ts: 60_000 + i,
        policy: 'thread',
        violation: 'v'.repeat(128),
        message: 'é'.repeat(256), // two bytes each in UTF-8
        frames,
        count: 1_000_000,
        screen: 's'.repeat(256),
      });
    }
    const snapshot = store.snapshot();
    for (const kept of [snapshot.stalls, snapshot.strictMode]) {
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(MAX_EVENT_STREAM_BYTES);
      expect(kept.length).toBeGreaterThan(30);
      expect(kept.at(-1)?.ts).toBe(61_999);
    }
  });

  it('prunes timestamped streams against the clock when taking a snapshot', () => {
    const { store, setNow } = setup(1000);
    store.append('cpu', { ts: 100_000, percent: 1, percentSingleCore: 1, threads: 1 });
    setNow(100_900);
    expect(store.snapshot().cpu).toHaveLength(1);
    setNow(101_100);
    expect(store.snapshot().cpu).toEqual([]);
  });

  it('chains screen spans: a new screen closes the open span at its start', () => {
    const { store, messages } = setup(10_000, 2000);
    store.appendScreen(1000, HOME);
    store.appendScreen(1500, PROMO);
    store.appendScreen(1400, null); // out of order: never starts before the previous span
    expect(messages).toEqual([
      { type: 'screen', span: { start: 1000, end: null, screen: HOME } },
      { type: 'screen', span: { start: 1500, end: null, screen: PROMO } },
      { type: 'screen', span: { start: 1500, end: null, screen: null } },
    ]);
    expect(store.snapshot().screens).toEqual([
      { start: 1000, end: 1500, screen: HOME },
      { start: 1500, end: 1500, screen: PROMO },
      { start: 1500, end: null, screen: null },
    ]);
  });

  it('ignores a repeat of the screen that is already on top', () => {
    const { store, messages } = setup(10_000, 5000);
    store.appendScreen(1000, HOME);
    store.appendScreen(1100, { ...HOME });
    store.appendScreen(1200, null);
    store.appendScreen(1300, null);
    store.appendScreen(1400, HOME);
    store.closeScreen(1500);
    store.appendScreen(1600, HOME); // the previous span is closed: this is a new one
    expect(
      messages.map((message) => message.type === 'screen' && [message.span.start, message.span.end]),
    ).toEqual([
      [1000, null],
      [1200, null],
      [1400, null],
      [1400, 1500],
      [1600, null],
    ]);
    store.appendScreen(1700, { ...HOME, kind: 'activity' }); // same name, different kind: a change
    expect(store.snapshot().screens).toHaveLength(5);
  });

  it('closes the open span by re-sending it with an end, once', () => {
    const { store, messages } = setup(10_000, 3000);
    store.closeScreen(500); // nothing open yet
    store.appendScreen(1000, HOME);
    store.closeScreen(2000);
    store.closeScreen(3000);
    expect(messages).toEqual([
      { type: 'screen', span: { start: 1000, end: null, screen: HOME } },
      { type: 'screen', span: { start: 1000, end: 2000, screen: HOME } },
    ]);
    expect(store.snapshot().screens).toEqual([{ start: 1000, end: 2000, screen: HOME }]);
  });

  it('keeps an old span that is still open, but drops closed spans outside the window', () => {
    const { store, setNow } = setup(1000);
    store.appendScreen(100_000, HOME);
    setNow(200_000);
    expect(store.snapshot().screens).toEqual([{ start: 100_000, end: null, screen: HOME }]);
    store.closeScreen(150_000);
    expect(store.snapshot().screens).toEqual([]);
  });

  it('names the top screen at a point in time', () => {
    const { store } = setup();
    expect(store.topScreenAt(1000)).toBeNull();
    store.appendScreen(1000, HOME);
    store.appendScreen(2000, PROMO);
    store.appendScreen(3000, null);
    store.appendScreen(4000, HOME);
    store.closeScreen(5000);
    expect(store.topScreenAt(999)).toBeNull();
    expect(store.topScreenAt(1000)).toBe('home');
    expect(store.topScreenAt(2500)).toBe('Promo');
    expect(store.topScreenAt(3500)).toBeNull();
    expect(store.topScreenAt(4999)).toBe('home');
    expect(store.topScreenAt(5000)).toBeNull();
  });
});

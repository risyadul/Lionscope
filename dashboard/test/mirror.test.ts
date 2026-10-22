import { describe, expect, it } from 'vitest';
import type { MirrorSpan, ServerMessage } from '@lionscope/protocol/wire';
import {
  MAX_MIRROR_SPANS,
  normalizeMirrorSpans,
  pruneMirrorSpans,
  upsertMirrorSpan,
  visibleMirrorRuns,
} from '../src/lib/mirror.ts';
import { applyServerMessage, createInitialState, type DashboardState } from '../src/lib/store.ts';
import { captureView } from '../src/lib/viewState.ts';
import { cpu, T0 } from './fixtures.ts';

const MIN = 60_000;
const SERIAL = 'R58M123ABC';

function mirror(start: number, end: number | null, serial = SERIAL): MirrorSpan {
  return { serial, start, end };
}

function apply(state: DashboardState, ...msgs: ServerMessage[]): DashboardState {
  return msgs.reduce(applyServerMessage, state);
}

const snapshotWith = (spans: MirrorSpan[]): ServerMessage => ({
  type: 'snapshot',
  snapshot: { cpu: [cpu(T0 + 5 * MIN)], memory: [], frames: [], logs: [], events: [], mirror: spans },
});

describe('mirror span helpers', () => {
  it('upsert replaces the span with the same start and serial, else inserts by start', () => {
    const open = upsertMirrorSpan([], mirror(T0, null));
    const closed = upsertMirrorSpan(open, mirror(T0, T0 + 1000));
    expect(closed).toEqual([mirror(T0, T0 + 1000)]);
    const later = upsertMirrorSpan(closed, mirror(T0 + 5000, null));
    const earlier = upsertMirrorSpan(later, mirror(T0 - 5000, T0 - 1000));
    expect(earlier.map((s) => s.start)).toEqual([T0 - 5000, T0, T0 + 5000]);
    // Another serial with the same start is another span.
    expect(upsertMirrorSpan(closed, mirror(T0, null, 'emulator-5554'))).toHaveLength(2);
    expect(open).toEqual([mirror(T0, null)]);
  });

  it('normalize sorts, keeps the last report per start, drops inverted spans and caps', () => {
    const spans = normalizeMirrorSpans([
      mirror(T0 + 2000, null),
      mirror(T0, null),
      mirror(T0, T0 + 1000),
      mirror(T0 + 500, T0),
    ]);
    expect(spans).toEqual([mirror(T0, T0 + 1000), mirror(T0 + 2000, null)]);
    const many = Array.from({ length: MAX_MIRROR_SPANS + 5 }, (_, i) => mirror(T0 + i * 10, T0 + i * 10 + 5));
    const capped = normalizeMirrorSpans(many);
    expect(capped).toHaveLength(MAX_MIRROR_SPANS);
    expect(capped[0]?.start).toBe(T0 + 50);
  });

  it('prune drops spans that ended before the cutoff and keeps an open one', () => {
    const spans = [mirror(T0, T0 + 1000), mirror(T0 + 2000, T0 + 9000), mirror(T0 + 10_000, null)];
    expect(pruneMirrorSpans(spans, T0 + 5000, T0 + 20_000)).toEqual(spans.slice(1));
    expect(pruneMirrorSpans(spans, T0, T0 + 20_000)).toBe(spans);
    expect(pruneMirrorSpans(spans, T0 + 15_000, T0 + 20_000)).toEqual([spans[2]]);
  });

  it('visible runs are clipped to the window, merged when they overlap, open at the right edge', () => {
    const runs = visibleMirrorRuns(
      [
        mirror(T0 - 5000, T0 + 1000),
        mirror(T0 + 2000, T0 + 4000),
        mirror(T0 + 3000, null, 'emulator-5554'),
        mirror(T0 + 20_000, T0 + 30_000),
      ],
      T0,
      T0 + 10_000,
      T0 + 10_000,
    );
    expect(runs).toEqual([
      { from: T0, to: T0 + 1000, isOpen: false, key: `${SERIAL}-${T0 - 5000}` },
      { from: T0 + 2000, to: T0 + 10_000, isOpen: true, key: `${SERIAL}-${T0 + 2000}` },
    ]);
  });
});

describe('mirror spans in the store', () => {
  it('a mirror message opens a span and a later one with the same start closes it', () => {
    let state = apply(createInitialState(), { type: 'mirror', span: mirror(T0, null) });
    expect(state.mirror).toEqual([mirror(T0, null)]);
    state = apply(state, { type: 'mirror', span: mirror(T0, T0 + 30_000) });
    expect(state.mirror).toEqual([mirror(T0, T0 + 30_000)]);
    // A decoration: it never moves the pruning reference.
    expect(state.latestTs).toBe(0);
  });

  it('snapshot replaces the spans, normalized, and older servers without the field clear them', () => {
    let state = apply(createInitialState(), { type: 'mirror', span: mirror(T0 - 99 * MIN, null) });
    state = apply(state, snapshotWith([mirror(T0 + MIN, null), mirror(T0, T0 + 1000)]));
    expect(state.mirror).toEqual([mirror(T0, T0 + 1000), mirror(T0 + MIN, null)]);
    state = apply(state, {
      type: 'snapshot',
      snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [] },
    });
    expect(state.mirror).toEqual([]);
  });

  it('spans that ended before the buffer window are pruned like stalls; an open one stays', () => {
    let state = apply(
      createInitialState(),
      { type: 'mirror', span: mirror(T0, T0 + MIN) },
      { type: 'mirror', span: mirror(T0 + 2 * MIN, null) },
      { type: 'cpu', sample: cpu(T0 + 5 * MIN) },
    );
    expect(state.mirror).toHaveLength(2);
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 11.5 * MIN) });
    expect(state.mirror).toEqual([mirror(T0 + 2 * MIN, null)]);
  });

  it('a new span closes the serial’s open one; other serials’ spans stay open', () => {
    let spans = upsertMirrorSpan([], mirror(T0, null));
    spans = upsertMirrorSpan(spans, mirror(T0, null, 'emulator-5554'));
    spans = upsertMirrorSpan(spans, mirror(T0 + 5000, null));
    expect(spans).toEqual([
      mirror(T0, T0 + 5000),
      mirror(T0, null, 'emulator-5554'),
      mirror(T0 + 5000, null),
    ]);
  });

  it('ignores a mirror message without a numeric start or a serial', () => {
    const state = createInitialState();
    const bad = [{ serial: SERIAL }, { start: T0 }, null, { serial: SERIAL, start: String(T0) }];
    for (const span of bad) {
      expect(apply(state, { type: 'mirror', span } as unknown as ServerMessage)).toBe(state);
    }
  });

  it('after a clock reset, the original span’s closing update ends the re-based one', () => {
    let state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0 + MIN) },
      { type: 'mirror', span: mirror(T0, null) },
      { type: 'cpu', sample: cpu(T0 - 10 * MIN) },
    );
    expect(state.mirror).toEqual([mirror(T0 - 10 * MIN, null)]);
    state = apply(state, { type: 'mirror', span: mirror(T0, T0 + 30_000) });
    expect(state.mirror.every((span) => span.end !== null)).toBe(true);
    expect(state.mirror[0]).toEqual(mirror(T0 - 10 * MIN, T0 + 30_000));
  });

  it('a laptop clock reset keeps an open mirror span, re-based, and drops closed ones', () => {
    const state = apply(
      createInitialState(),
      { type: 'cpu', sample: cpu(T0 + MIN) },
      { type: 'mirror', span: mirror(T0, T0 + 1000) },
      { type: 'mirror', span: mirror(T0 + 2000, null) },
      { type: 'cpu', sample: cpu(T0 - 10 * MIN) },
    );
    expect(state.mirror).toEqual([mirror(T0 - 10 * MIN, null)]);
  });

  it('a paused view freezes the spans with the rest of the timeline', () => {
    const state = apply(createInitialState(), { type: 'mirror', span: mirror(T0, null) });
    expect(captureView(state, T0).mirror).toBe(state.mirror);
  });
});

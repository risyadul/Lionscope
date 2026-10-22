import { describe, expect, it } from 'vitest';
import type { ServerMessage, Snapshot } from '@lionscope/protocol/wire';
import {
  applyServerMessageAt,
  createInitialState,
  MAX_INFLATES,
  type DashboardState,
} from '../src/lib/store.ts';
import { cpu, inflate, T0, viewTree } from './fixtures.ts';

const NOW = T0 + 10 * 60_000;
const apply = (state: DashboardState, msg: ServerMessage) => applyServerMessageAt(state, msg, NOW);
const snapshot = (extra: Partial<Snapshot>): ServerMessage => ({
  type: 'snapshot',
  snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [], ...extra },
});

describe('inflate / viewtree messages', () => {
  it('slot in by time and advance the window reference', () => {
    let state = createInitialState();
    state = apply(state, { type: 'inflate', sample: inflate(T0 + 2000) });
    state = apply(state, { type: 'inflate', sample: inflate(T0 + 1000, { layout: 'a' }) });
    state = apply(state, { type: 'viewtree', sample: viewTree(T0 + 3000) });
    expect(state.inflates.map((s) => s.ts)).toEqual([T0 + 1000, T0 + 2000]);
    expect(state.viewTrees).toHaveLength(1);
    expect(state.latestTs).toBe(T0 + 3000);
  });

  it('keeps samples that share a timestamp (different layouts in one window)', () => {
    let state = createInitialState();
    state = apply(state, { type: 'inflate', sample: inflate(T0, { layout: 'a' }) });
    state = apply(state, { type: 'inflate', sample: inflate(T0, { layout: 'b' }) });
    expect(state.inflates.map((s) => s.layout)).toEqual(['a', 'b']);
  });

  it('drops one that claims to start far in the future', () => {
    const state = createInitialState();
    expect(apply(state, { type: 'inflate', sample: inflate(NOW + 60_000) })).toBe(state);
    expect(apply(state, { type: 'viewtree', sample: viewTree(NOW + 60_000) })).toBe(state);
  });

  it('are pruned with the buffer window and capped', () => {
    let state = apply(createInitialState(), {
      type: 'hello',
      protocolVersion: 3,
      serverVersion: '0.4.0',
      bufferWindowMs: 60_000,
    });
    state = apply(state, { type: 'inflate', sample: inflate(T0) });
    state = apply(state, { type: 'viewtree', sample: viewTree(T0) });
    state = apply(state, { type: 'cpu', sample: cpu(T0 + 120_000) });
    expect(state.inflates).toEqual([]);
    expect(state.viewTrees).toEqual([]);

    let busy = createInitialState();
    for (let i = 0; i < MAX_INFLATES + 5; i++) {
      busy = apply(busy, { type: 'inflate', sample: inflate(T0 + i, { layout: `l${i}` }) });
    }
    expect(busy.inflates).toHaveLength(MAX_INFLATES);
    expect(busy.inflates[0]?.layout).toBe('l5');
  });

  it('are cleared when the laptop clock steps back', () => {
    let state = apply(createInitialState(), { type: 'cpu', sample: cpu(T0 + 60_000) });
    state = apply(state, { type: 'inflate', sample: inflate(T0 + 59_000) });
    state = apply(state, { type: 'cpu', sample: cpu(T0) });
    expect(state.inflates).toEqual([]);
  });
});

describe('snapshot', () => {
  it('replaces both streams, sorted', () => {
    const state = apply(
      createInitialState(),
      snapshot({
        inflates: [inflate(T0 + 5), inflate(T0 + 1, { layout: 'a' })],
        viewTrees: [viewTree(T0 + 2)],
      }),
    );
    expect(state.inflates.map((s) => s.ts)).toEqual([T0 + 1, T0 + 5]);
    expect(state.viewTrees).toHaveLength(1);
    expect(state.latestTs).toBe(T0 + 5);
  });

  it('from an older server (no fields) leaves empty buffers', () => {
    const before = apply(createInitialState(), { type: 'inflate', sample: inflate(T0) });
    const state = apply(before, snapshot({}));
    expect(state.inflates).toEqual([]);
    expect(state.viewTrees).toEqual([]);
  });

  it('drops future-dated samples', () => {
    const state = apply(createInitialState(), snapshot({ inflates: [inflate(NOW + 60_000), inflate(T0)] }));
    expect(state.inflates).toHaveLength(1);
  });
});

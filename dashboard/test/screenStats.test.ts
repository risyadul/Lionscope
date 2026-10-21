import { describe, expect, it } from 'vitest';
import { aggregateScreens, dominantStage, sortScreenRows, weightedMedian } from '../src/lib/screenStats.ts';
import { breakdown, STAGES_ZERO, T0 } from './fixtures.ts';

describe('aggregateScreens', () => {
  const samples = [
    breakdown(T0, 'list', {
      frameCount: 30,
      jankCount: 3,
      slowCount: 6,
      p90TotalMs: 12,
      stages: { draw: 4 },
    }),
    breakdown(T0 + 500, 'list', {
      frameCount: 10,
      jankCount: 1,
      slowCount: 1,
      p90TotalMs: 30,
      stages: { draw: 8, layout: 1 },
    }),
    breakdown(T0 + 1000, 'detail', { frameCount: 20, jankCount: 0, slowCount: 0, stages: { layout: 9 } }),
    breakdown(T0 + 1500, null, { frameCount: 5, jankCount: 0, slowCount: 0 }),
    breakdown(T0 + 2000, 'list', { frameCount: 0, jankCount: 0, slowCount: 0, p90TotalMs: 99 }),
    breakdown(T0 + 9000, 'outside', { frameCount: 50 }),
  ];

  it('groups by screen within the window, ignoring buckets that drew nothing', () => {
    const rows = aggregateScreens(samples, T0, T0 + 5000);
    expect(rows.map((r) => r.name)).toEqual(['list', 'detail', null]);
    const list = rows[0]!;
    expect(list.frames).toBe(40);
    expect(list.jankFrames).toBe(4);
    expect(list.slowFrames).toBe(7);
    expect(list.jankPercent).toBeCloseTo(10);
    expect(list.slowPercent).toBeCloseTo(17.5);
    // The zero-frame bucket's p90 of 99 must not count.
    expect(list.worstP90Ms).toBe(30);
    // Typical p90: 30 frames at 12 ms outweigh 10 frames at 30 ms.
    expect(list.typicalP90Ms).toBe(12);
  });

  it('weights stage means by frames and picks the dominant stage', () => {
    const [list, detail] = aggregateScreens(samples, T0, T0 + 5000);
    // draw: (4 × 30 + 8 × 10) / 40 = 5; layout: (2 × 30 + 1 × 10) / 40 = 1.75
    expect(list!.stageMs.draw).toBeCloseTo(5);
    expect(list!.stageMs.layout).toBeCloseTo(1.75);
    expect(list!.dominant).toEqual({ stage: 'draw', ms: expect.closeTo(5) as number });
    expect(detail!.dominant?.stage).toBe('layout');
  });

  it('never counts slow below janky (older samples)', () => {
    const [row] = aggregateScreens([breakdown(T0, 'a', { jankCount: 4, slowCount: 1 })], T0, T0);
    expect(row!.slowFrames).toBe(4);
  });

  it('returns no rows for an empty window', () => {
    expect(aggregateScreens(samples, T0 + 3000, T0 + 4000)).toEqual([]);
  });
});

describe('dominantStage', () => {
  it('is null when nothing was measured and prefers the earlier stage on ties', () => {
    expect(dominantStage(STAGES_ZERO)).toBeNull();
    expect(dominantStage({ ...STAGES_ZERO, layout: 2, draw: 2 })).toEqual({ stage: 'layout', ms: 2 });
    expect(dominantStage({ ...STAGES_ZERO, gpu: Number.NaN, swap: 1 })).toEqual({ stage: 'swap', ms: 1 });
  });
});

describe('sortScreenRows', () => {
  const rows = aggregateScreens(
    [
      breakdown(T0, 'a', { frameCount: 100, jankCount: 5 }),
      breakdown(T0, 'b', { frameCount: 10, jankCount: 2 }),
      breakdown(T0, 'c', { frameCount: 20, jankCount: 1 }),
      breakdown(T0, 'd', { frameCount: 40, jankCount: 2 }),
    ],
    T0,
    T0,
  );

  it('sorts by jank % descending, ties broken by more frames', () => {
    expect(sortScreenRows(rows, 'jankPercent', 'desc').map((r) => r.name)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortScreenRows(rows, 'jankPercent', 'asc').map((r) => r.name)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('sorts by name and frames without mutating the input', () => {
    const before = rows.map((r) => r.name);
    expect(sortScreenRows(rows, 'name', 'desc').map((r) => r.name)).toEqual(['d', 'c', 'b', 'a']);
    expect(sortScreenRows(rows, 'frames', 'desc').map((r) => r.name)).toEqual(['a', 'd', 'c', 'b']);
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

describe('typical p90', () => {
  it('is the frame-weighted median of bucket p90s, ignoring buckets under 3 frames', () => {
    const rows = aggregateScreens(
      [
        breakdown(T0, 'a', { frameCount: 10, p90TotalMs: 10 }),
        breakdown(T0 + 500, 'a', { frameCount: 12, p90TotalMs: 20 }),
        breakdown(T0 + 1000, 'a', { frameCount: 2, p90TotalMs: 400 }),
        breakdown(T0 + 1500, 'b', { frameCount: 1, p90TotalMs: 50 }),
      ],
      T0,
      T0 + 2000,
    );
    const a = rows.find((r) => r.name === 'a')!;
    expect(a.typicalP90Ms).toBe(20);
    expect(a.worstP90Ms).toBe(400);
    // Only tiny buckets: no typical value, the worst is still reported.
    const b = rows.find((r) => r.name === 'b')!;
    expect(b.typicalP90Ms).toBeNull();
    expect(b.worstP90Ms).toBe(50);
  });

  it('weightedMedian handles ties, bad points and empty input', () => {
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([{ value: Number.NaN, weight: 3 }])).toBeNull();
    expect(
      weightedMedian([
        { value: 5, weight: 1 },
        { value: 1, weight: 1 },
      ]),
    ).toBe(1);
    expect(
      weightedMedian([
        { value: 9, weight: 5 },
        { value: 1, weight: 1 },
        { value: 4, weight: 0 },
      ]),
    ).toBe(9);
  });

  it('rows without a typical p90 sort last in both directions', () => {
    const rows = aggregateScreens(
      [
        breakdown(T0, 'tiny', { frameCount: 1 }),
        breakdown(T0, 'slow', { frameCount: 10, p90TotalMs: 30 }),
        breakdown(T0, 'fast', { frameCount: 10, p90TotalMs: 8 }),
      ],
      T0,
      T0,
    );
    expect(sortScreenRows(rows, 'typicalP90Ms', 'desc').map((r) => r.name)).toEqual(['slow', 'fast', 'tiny']);
    expect(sortScreenRows(rows, 'typicalP90Ms', 'asc').map((r) => r.name)).toEqual(['fast', 'slow', 'tiny']);
  });
});

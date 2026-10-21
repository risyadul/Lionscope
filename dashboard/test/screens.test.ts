import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_LABEL,
  firstSpanEndingAfter,
  mergeNarrowSpans,
  hashName,
  SCREEN_COLORS,
  screenColor,
  screenKindLabel,
  spanAt,
  spanEnd,
  spanLabel,
  visibleSpans,
} from '../src/lib/screens.ts';
import { span, T0 } from './fixtures.ts';

describe('screenColor', () => {
  it('is deterministic per name, across calls and independent of order', () => {
    const names = ['MainActivity', 'order_list', 'OrderDetailFragment', 'FilterBottomSheet'];
    const first = names.map(screenColor);
    const reversed = [...names].reverse().map(screenColor).reverse();
    expect(reversed).toEqual(first);
    expect(names.map(screenColor)).toEqual(first);
  });

  it('pins known names to their slot (a regression here would repaint every recording)', () => {
    expect(hashName('')).toBe(0x811c9dc5);
    expect(hashName('a')).toBe(0xe40c292c);
    expect(screenColor('MainActivity')).toBe(SCREEN_COLORS[hashName('MainActivity') % 3]);
  });

  it('only uses the screen slots and spreads names across all of them', () => {
    const used = new Set(Array.from({ length: 60 }, (_, i) => screenColor(`Screen${i}`)));
    expect([...used].sort()).toEqual([...SCREEN_COLORS].sort());
  });
});

describe('span helpers', () => {
  const spans = [
    span(T0, T0 + 10_000, 'MainActivity', 'activity'),
    span(T0 + 10_000, T0 + 20_000, null),
    span(T0 + 25_000, null, 'order_list'),
  ];

  it('an open span ends at openEnd, never before its start', () => {
    expect(spanEnd(spans[2]!, T0 + 40_000)).toBe(T0 + 40_000);
    expect(spanEnd(spans[2]!, T0)).toBe(T0 + 25_000);
    expect(spanEnd(spans[0]!, T0 + 40_000)).toBe(T0 + 10_000);
  });

  it('visibleSpans clips to the window and drops spans outside it', () => {
    const visible = visibleSpans(spans, T0 + 5_000, T0 + 30_000, T0 + 40_000);
    expect(visible.map((v) => [v.key - T0, v.from - T0, v.to - T0, v.isOpen])).toEqual([
      [0, 5_000, 10_000, false],
      [10_000, 10_000, 20_000, false],
      [25_000, 25_000, 30_000, true],
    ]);
    expect(visibleSpans(spans, T0 + 11_000, T0 + 19_000, T0 + 40_000).map((v) => v.key)).toEqual([
      T0 + 10_000,
    ]);
    expect(visibleSpans(spans, T0 - 9_000, T0, T0 + 40_000)).toEqual([]);
  });

  it('spanAt finds the top screen, null in gaps and before the first span', () => {
    expect(spanAt(spans, T0 + 3_000, T0 + 40_000)?.screen?.name).toBe('MainActivity');
    expect(spanAt(spans, T0 + 15_000, T0 + 40_000)?.screen).toBeNull();
    expect(spanAt(spans, T0 + 22_000, T0 + 40_000)).toBeNull();
    expect(spanAt(spans, T0 + 40_000, T0 + 40_000)?.screen?.name).toBe('order_list');
    expect(spanAt(spans, T0 - 1, T0 + 40_000)).toBeNull();
  });

  it('labels background spans and screen kinds', () => {
    expect(spanLabel(spans[1]!)).toBe(BACKGROUND_LABEL);
    expect(spanLabel(spans[0]!)).toBe('MainActivity');
    expect(screenKindLabel('dialog')).toBe('Dialog');
  });
});

describe('windowing large buffers', () => {
  const many = Array.from({ length: 500 }, (_, i) => span(T0 + i * 1000, T0 + (i + 1) * 1000, `s${i}`));

  it('binary-searches the first span still on screen', () => {
    expect(firstSpanEndingAfter(many, T0 - 1, T0)).toBe(0);
    expect(firstSpanEndingAfter(many, T0 + 1000, T0)).toBe(1);
    expect(firstSpanEndingAfter(many, T0 + 250_500, T0)).toBe(250);
    expect(firstSpanEndingAfter(many, T0 + 10_000_000, T0)).toBe(500);
  });

  it('merges runs of two or more sub-minimum spans into one cluster, keeping wide ones', () => {
    const bands = visibleSpans(
      [
        span(T0, T0 + 100, 'a'),
        span(T0 + 100, T0 + 200, 'b'),
        span(T0 + 200, T0 + 300, 'c'),
        span(T0 + 300, T0 + 5000, 'wide'),
        span(T0 + 5000, T0 + 5100, 'lone'),
        span(T0 + 5100, T0 + 9000, 'wide2'),
      ],
      T0,
      T0 + 9000,
      T0 + 9000,
    );
    // 50 ms per px with a 3 px minimum: spans under 150 ms are too narrow to draw apart.
    const items = mergeNarrowSpans(bands, 50, 3);
    expect(
      items.map((item) => (item.kind === 'cluster' ? `cluster×${item.count}` : item.band.span.screen?.name)),
    ).toEqual(['cluster×3', 'wide', 'lone', 'wide2']);
    const cluster = items[0];
    expect(cluster?.kind === 'cluster' && [cluster.from - T0, cluster.to - T0, cluster.key]).toEqual([
      0,
      300,
      T0,
    ]);
    // Unmeasured width (0 ms per unit) never merges.
    expect(mergeNarrowSpans(bands, 0, 3).every((item) => item.kind === 'span')).toBe(true);
  });
});

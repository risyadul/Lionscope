import { describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import {
  createStallLayer,
  type StallItem,
  type ViolationItem,
} from '../src/components/timeline/stallLayer.ts';
import { buildFeed } from '../src/lib/stalls.ts';
import { FALLBACK_COLORS, mixHex, readChartTheme } from '../src/lib/theme.ts';
import { stall, T0, violation } from './fixtures.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

/** Records every fill (with its style) and the points of every path. */
function recordingContext() {
  const fills: { style: string; kind: 'path' | 'rect'; x: number }[] = [];
  const outlines: { style: string; x: number }[] = [];
  let style = '';
  let pathX = 0;
  const ctx = {
    set fillStyle(value: string) {
      style = value;
    },
    get fillStyle() {
      return style;
    },
    strokeStyle: '',
    lineWidth: 1,
    save() {},
    restore() {},
    clip() {},
    beginPath() {},
    closePath() {},
    rect(x: number) {
      pathX = x;
    },
    roundRect(x: number) {
      pathX = x;
    },
    moveTo(x: number) {
      pathX = x;
    },
    lineTo() {},
    stroke() {},
    strokeRect(x: number) {
      outlines.push({ style: ctx.strokeStyle, x });
    },
    setLineDash() {},
    fill() {
      fills.push({ style, kind: 'path', x: pathX });
    },
    fillRect(x: number) {
      fills.push({ style, kind: 'rect', x });
    },
  };
  return { ctx, fills, outlines };
}

describe('createStallLayer', () => {
  const theme = readChartTheme(() => '');
  const window = { fromTs: T0, toTs: T0 + 10_000, filter: 'all' as const, culprit: null };
  const feed = buildFeed(
    [
      stall(T0 + 1000, 300),
      stall(T0 + 3000, 700),
      stall(T0 + 5000, 3000),
      stall(T0 + 8000, 900, { debugger: true }),
    ],
    [violation(T0 + 2000)],
    window,
  ).reverse();
  const stalls = feed.filter((i): i is StallItem => i.kind === 'stall');
  const violations = feed.filter((i): i is ViolationItem => i.kind === 'strictmode');

  // 1 px per 10 ms across a 1000 px plot; y: 0..2000 ms over 100 px.
  const plot = (ctx: unknown) =>
    ({
      ctx,
      bbox: { left: 0, top: 0, width: 1000, height: 114 },
      scales: { y: { max: 2000 } },
      valToPos: (value: number, scale: string) =>
        scale === 'x' ? (value * 1000 - T0) / 10 : 100 - (value / 2000) * 100,
    }) as unknown as uPlot;

  it('paints each stall in its severity color, debugger stalls washed gray, violations as teal', () => {
    const { ctx, fills } = recordingContext();
    createStallLayer({ stalls, violations, selectedKey: null, hoveredKey: null }).draw(plot(ctx), theme);
    const bars = fills.filter(
      (f) => f.kind === 'path' && f.style !== FALLBACK_COLORS.strictMode && f.style !== FALLBACK_COLORS.ink,
    );
    expect(bars.map((f) => [f.x, f.style])).toEqual([
      [100, FALLBACK_COLORS.stall1],
      [300, FALLBACK_COLORS.stall2],
      [500, FALLBACK_COLORS.stall3],
      [800, mixHex(FALLBACK_COLORS.stallDebug, FALLBACK_COLORS.surface, 0.55)],
    ]);
    // One diamond on the rail, and a clip caret over the 3 s bar (past the 2 s scale).
    expect(fills.filter((f) => f.style === FALLBACK_COLORS.strictMode)).toHaveLength(1);
    expect(fills.filter((f) => f.style === FALLBACK_COLORS.ink)).toHaveLength(1);
  });

  it('separates touching bars with a surface gap', () => {
    const { ctx, fills } = recordingContext();
    const close = buildFeed(
      [stall(T0 + 1000, 300), stall(T0 + 1300, 300)],
      [],
      window,
    ).reverse() as StallItem[];
    createStallLayer({ stalls: close, violations: [], selectedKey: null, hoveredKey: null }).draw(
      plot(ctx),
      theme,
    );
    expect(
      fills.filter((f) => f.kind === 'rect' && f.style === FALLBACK_COLORS.surface).map((f) => f.x),
    ).toEqual([130]);
  });

  it('rings the selected bar in ink and the hovered one in secondary ink', () => {
    const { ctx, outlines } = recordingContext();
    const selectedKey = stalls[1]!.key;
    const hoveredKey = stalls[0]!.key;
    createStallLayer({ stalls, violations, selectedKey, hoveredKey }).draw(plot(ctx), theme);
    // Each ring is a surface halo, then the colored stroke.
    expect(outlines.map((o) => o.style)).toEqual([
      FALLBACK_COLORS.surface,
      FALLBACK_COLORS.ink2,
      FALLBACK_COLORS.surface,
      FALLBACK_COLORS.ink,
    ]);
  });
});

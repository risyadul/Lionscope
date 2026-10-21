/** Declarative lane definitions consumed by `TimelineChart`. Kept free of uPlot so they're plain data. */
import { DEFAULT_SDK_OPTIONS } from '@lionscope/protocol/wire';
import { formatTick } from '../../lib/format.ts';
import { STACK_ORDER, STAGE_COLORS, STAGE_LABELS } from '../../lib/stages.ts';
import type { ChartColor } from '../../lib/theme.ts';
import { niceCeil } from '../../lib/series.ts';
import { stallScaleMax } from '../../lib/stalls.ts';

export interface SeriesSpec {
  label: string;
  /** Line color; omitted for fill-only marks (bars, stacked areas). */
  stroke?: ChartColor;
  /** Mix the stroke toward the surface by this amount (0–1) to de-emphasise it. */
  strokeMix?: number;
  /** Stroke in the surface color: the 2px gap separating stacked areas. */
  surfaceGap?: boolean;
  width?: number;
  fill?: ChartColor;
  /** Translucent wash. */
  fillAlpha?: number;
  /** Opaque tint (mix toward surface) — required for painter's-order stacking. */
  fillMix?: number;
  bars?: boolean;
  /** uPlot bar sizing `[factor, maxPx, minPx]` and gap; defaults suit 1 s samples. */
  barSize?: readonly [number, number, number];
  barGap?: number;
  /** Excluded from y auto-ranging (e.g. a spiky max line). */
  auto?: boolean;
  /** Show a ringed hover dot at the cursor. */
  hoverPoint?: boolean;
}

export interface BandSpec {
  /** 1-based series indices (index 0 is x). */
  upper: number;
  lower: number;
  color: ChartColor;
  alpha: number;
}

export interface Threshold {
  value: number;
  label: string;
}

export interface ChartSpec {
  series: readonly SeriesSpec[];
  /** Series 1 is a stack top: mark x positions where it runs past the y range (clipped bars). */
  marksClipped?: boolean;
  bands?: readonly BandSpec[];
  /** `plotHeightPx`: the plot area's CSS height, 0 (or omitted) before the first layout. */
  yRange: (
    dataMax: number | null,
    thresholds: readonly Threshold[],
    plotHeightPx?: number,
  ) => [number, number];
  /** Explicit y ticks (default: uPlot's spacing-based splits). */
  ySplits?: (min: number, max: number) => number[];
  yTick: (value: number) => string;
}

const percentTick = (v: number) => `${formatTick(v)}%`;

export const CPU_SPEC: ChartSpec = {
  series: [{ label: 'CPU', stroke: 'cpu', width: 2, fill: 'cpu', fillAlpha: 0.1, hoverPoint: true }],
  yRange: () => [0, 100],
  yTick: percentTick,
};

export const CPU_SINGLE_CORE_SPEC: ChartSpec = {
  series: CPU_SPEC.series,
  yRange: (max) => [0, Math.max(100, niceCeil((max ?? 0) * 1.1))],
  yTick: percentTick,
};

const STACK_TINT = 0.32;

/** Paint order matches `buildMemoryData`: biggest cumulative first so smaller ones paint over it. */
export const MEMORY_SPEC: ChartSpec = {
  series: [
    { label: 'Other', fill: 'memOther', fillMix: STACK_TINT, surfaceGap: true, width: 1.5 },
    { label: 'Code', fill: 'memCode', fillMix: STACK_TINT, surfaceGap: true, width: 1.5 },
    { label: 'Graphics', fill: 'memGraphics', fillMix: STACK_TINT, surfaceGap: true, width: 1.5 },
    { label: 'Java', fill: 'memJava', fillMix: STACK_TINT, surfaceGap: true, width: 1.5 },
    { label: 'Native', fill: 'memNative', fillMix: STACK_TINT, surfaceGap: true, width: 1.5 },
    { label: 'Total PSS', stroke: 'memTotal', width: 1.5, hoverPoint: true },
  ],
  yRange: (max) => [0, niceCeil((max ?? 0) * 1.08 || 1)],
  yTick: formatTick,
};

/** Slow frames wear the jank hue at reduced strength (opaque, so overlapping bars stay clean). */
export const SLOW_TINT = 0.55;

export const FRAME_RATE_SPEC: ChartSpec = {
  series: [
    // Slow ⊇ janky: the light slow bar shows behind, the janky part paints over it.
    { label: 'Slow frames/s', fill: 'jank', fillMix: SLOW_TINT, bars: true },
    { label: 'Janky frames/s', fill: 'jank', bars: true },
    { label: 'FPS', stroke: 'fps', width: 2, hoverPoint: true },
  ],
  yRange: (max) => [0, Math.max(60, Math.ceil(((max ?? 0) * 1.05) / 30) * 30)],
  yTick: formatTick,
};

export const FRAME_TIME_SPEC: ChartSpec = {
  series: [
    { label: 'p50', stroke: 'frameTime', strokeMix: 0.45, width: 1 },
    { label: 'p90', stroke: 'frameTime', width: 2, hoverPoint: true },
    { label: 'max', stroke: 'frameMax', width: 1, auto: false },
  ],
  bands: [{ upper: 2, lower: 1, color: 'frameTime', alpha: 0.14 }],
  yRange: (max, thresholds) => {
    const budget = thresholds[0]?.value ?? 16.7;
    return [0, Math.max(budget * 2.5, niceCeil((max ?? 0) * 1.15))];
  },
  yTick: (v) => `${formatTick(v)}`,
};

export const BREAKDOWN_CAP_BUDGETS = 3;

/**
 * Paint order matches `buildBreakdownData`: the full stack (topped by GPU) first, then each
 * shorter cumulative bar over it, down to delay. Opaque fills keep the slices clean.
 */
export const BREAKDOWN_SPEC: ChartSpec = {
  series: [...STACK_ORDER].reverse().map((stage) => ({
    label: STAGE_LABELS[stage],
    fill: STAGE_COLORS[stage],
    bars: true,
    // 0.5 s buckets are dense: columns touch at wide windows instead of dissolving into gaps.
    barSize: [0.86, 14, 1] as const,
    barGap: 0,
  })),
  marksClipped: true,
  // Capped at 3× budget: one first-draw frame must not flatten every other bar. Taller bars clip;
  // the legend still reports their values.
  yRange: (max, thresholds) => {
    const budget = thresholds[0]?.value ?? 16.7;
    const cap = Math.round((budget * BREAKDOWN_CAP_BUDGETS) / 10) * 10;
    return [0, Math.max(budget * 1.5, Math.min(cap, niceCeil((max ?? 0) * 1.1)))];
  },
  yTick: (v) => `${formatTick(v)}`,
};

/** Height of the StrictMode rail under the stall baseline, CSS px. */
export const STALL_RAIL_PX = 14;
const FALLBACK_PLOT_HEIGHT_PX = 72;

/** `250`, `500`, `1s`, `1.5s`: the lane's subtitle carries the unit. */
export function stallTick(value: number): string {
  if (value >= 1000) return `${formatTick(value / 1000)}s`;
  return formatTick(value);
}

/**
 * Main thread lane. The single series only feeds y auto-ranging (stall lengths); the bars and
 * the StrictMode glyphs are drawn by the lane's mark layer. The scale is linear and capped
 * (`stallScaleMax`); below 0 sits a fixed-height rail for StrictMode violations.
 */
export const STALL_SPEC: ChartSpec = {
  series: [{ label: 'Stall', width: 0 }],
  yRange: (max, thresholds, plotHeightPx = 0) => {
    const cap = stallScaleMax(max, thresholds[0]?.value ?? DEFAULT_SDK_OPTIONS.stallThresholdMs);
    const height = plotHeightPx > STALL_RAIL_PX * 3 ? plotHeightPx : FALLBACK_PLOT_HEIGHT_PX;
    return [-(STALL_RAIL_PX * cap) / (height - STALL_RAIL_PX), cap];
  },
  ySplits: (_min, max) => [0, max / 2, max],
  yTick: stallTick,
};

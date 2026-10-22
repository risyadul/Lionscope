/**
 * Pure transforms from protocol samples to uPlot's column-oriented AlignedData.
 * x is in epoch seconds (uPlot's default time unit). Gaps longer than a few sample
 * intervals become a null row so lines break instead of bridging a dead process.
 */
import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  FrameSource,
  FrameStage,
  MemorySample,
} from '@lionscope/protocol/wire';
import { slowCountOf } from '@lionscope/protocol/insights';
import { kbToMb } from './format.ts';
import { STACK_ORDER } from './stages.ts';

export type Column = (number | null)[];
export type Aligned = [xs: number[], ...columns: Column[]];

export const CPU_INTERVAL_MS = 1000;
export const MEMORY_INTERVAL_MS = 3000;
export const FRAMES_INTERVAL_MS = 1000;
/** SDK FrameMetrics are bucketed by the server every 500 ms. */
export const BREAKDOWN_INTERVAL_MS = 500;
/** A gap longer than this many sample intervals breaks the line. */
const GAP_FACTOR = 3.5;
export const DEFAULT_FRAME_INTERVAL_MS = 1000 / 60;

interface Timestamped {
  ts: number;
}

/**
 * Builds aligned columns from samples, inserting a null row in the middle of any gap
 * longer than `GAP_FACTOR` × `intervalMs`.
 */
export function buildAligned<T extends Timestamped>(
  samples: readonly T[],
  intervalMs: number,
  pick: ReadonlyArray<(sample: T) => number | null>,
): Aligned {
  const maxGapSec = (intervalMs * GAP_FACTOR) / 1000;
  const xs: number[] = [];
  const columns: Column[] = pick.map(() => []);
  let prevX: number | null = null;
  for (const sample of samples) {
    const x = sample.ts / 1000;
    if (prevX !== null && x - prevX > maxGapSec) {
      xs.push((prevX + x) / 2);
      for (const column of columns) column.push(null);
    }
    xs.push(x);
    pick.forEach((fn, i) => columns[i]?.push(fn(sample)));
    prevX = x;
  }
  return [xs, ...columns];
}

export type CpuMode = 'normalized' | 'singleCore';

/** [x, cpu%] — normalized to all cores (0–100) or relative to one core. */
export function buildCpuData(samples: readonly CpuSample[], mode: CpuMode): Aligned {
  return buildAligned(samples, CPU_INTERVAL_MS, [
    (s) => (mode === 'normalized' ? s.percent : s.percentSingleCore),
  ]);
}

/** "Other" in the memory stack: private other + stack + system. */
export function memoryOtherKb(s: MemorySample): number {
  return s.privateOtherKb + s.stackKb + s.systemKb;
}

/** Stack order, bottom → top. */
export const MEMORY_LAYERS = ['native', 'java', 'graphics', 'code', 'other'] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export function memoryLayerKb(s: MemorySample, layer: MemoryLayer): number {
  switch (layer) {
    case 'native':
      return s.nativeHeapKb;
    case 'java':
      return s.javaHeapKb;
    case 'graphics':
      return s.graphicsKb;
    case 'code':
      return s.codeKb;
    case 'other':
      return memoryOtherKb(s);
  }
}

export interface MemoryData {
  /**
   * Drawn columns, in paint order: [x, other↑, code↑, graphics↑, java↑, native, total].
   * `↑` columns are cumulative (MB) so each opaque area paints over the larger one beneath it.
   */
  data: Aligned;
  /** Raw per-layer MB aligned with `data[0]`, for the legend: [native, java, graphics, code, other, total]. */
  raw: Column[];
}

export function buildMemoryData(samples: readonly MemorySample[]): MemoryData {
  const cumulative = (upTo: number) => (s: MemorySample) => {
    let sum = 0;
    for (let i = 0; i <= upTo; i++) {
      const layer = MEMORY_LAYERS[i];
      if (layer !== undefined) sum += memoryLayerKb(s, layer);
    }
    return kbToMb(sum);
  };
  const raw = (layer: MemoryLayer) => (s: MemorySample) => kbToMb(memoryLayerKb(s, layer));
  const total = (s: MemorySample) => kbToMb(s.totalPssKb);

  const drawn = buildAligned(samples, MEMORY_INTERVAL_MS, [
    cumulative(4),
    cumulative(3),
    cumulative(2),
    cumulative(1),
    cumulative(0),
    total,
  ]);
  const [, ...rawColumns] = buildAligned(samples, MEMORY_INTERVAL_MS, [...MEMORY_LAYERS.map(raw), total]);
  return { data: drawn, raw: rawColumns };
}

export { slowCountOf };

/** Scales a per-sample frame count to frames per second, using the same elapsed time as `fps`. */
function perSecond(count: number, s: FrameSample): number {
  if (s.frameCount <= 0 || count <= 0) return 0;
  return (count * s.fps) / s.frameCount;
}

/** Janky frames (missed their deadline) per second. */
export function jankPerSecond(s: FrameSample): number {
  return perSecond(s.jankCount, s);
}

/** Slow frames (longer than one vsync) per second; always ≥ janky/s. */
export function slowPerSecond(s: FrameSample): number {
  return perSecond(Math.max(slowCountOf(s), s.jankCount), s);
}

/**
 * [x, slow frames/s, janky frames/s, fps] — one axis, all in frames per second. Paint order:
 * the lighter slow bars first, janky bars over them (janky ⊆ slow), the FPS line on top.
 */
export function buildFrameRateData(samples: readonly FrameSample[]): Aligned {
  return buildAligned(samples, FRAMES_INTERVAL_MS, [slowPerSecond, jankPerSecond, (s) => s.fps]);
}

/** [x, p50, p90, max] in ms; null where no frame was rendered (percentiles are meaningless). */
export function buildFrameTimeData(samples: readonly FrameSample[]): Aligned {
  const when = (fn: (s: FrameSample) => number) => (s: FrameSample) => (s.frameCount > 0 ? fn(s) : null);
  return buildAligned(samples, FRAMES_INTERVAL_MS, [
    when((s) => s.p50Ms),
    when((s) => s.p90Ms),
    when((s) => s.maxMs),
  ]);
}

/** Where the newest frame sample came from; servers that predate `source` only had gfxinfo. */
export function frameSourceOf(samples: readonly FrameSample[]): FrameSource {
  return samples[samples.length - 1]?.source ?? 'gfxinfo';
}

/** Matches the server's gfxinfo resume delay: this long without SDK frames reads as idle. */
export const SDK_IDLE_AFTER_MS = 3000;

export interface FrameFeed {
  /** Who owns frame accounting right now. */
  source: FrameSource;
  /** The SDK is linked but its windows drew nothing (gfxinfo may be filling in meanwhile). */
  isSdkIdle: boolean;
}

/**
 * While the SDK is linked it owns frame accounting, even when the app is idle and the newest
 * sample is an empty SDK bucket or a gfxinfo fallback: the source must not flap between the two.
 */
export function frameFeed(samples: readonly FrameSample[], isSdkConnected: boolean): FrameFeed {
  if (!isSdkConnected) return { source: frameSourceOf(samples), isSdkIdle: false };
  // Idle only after a quiet stretch, so one empty bucket mid-scroll doesn't flip the label.
  const since = (samples[samples.length - 1]?.ts ?? 0) - SDK_IDLE_AFTER_MS;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (sample === undefined || sample.ts < since) break;
    if (sample.source === 'sdk' && sample.frameCount > 0) return { source: 'sdk', isSdkIdle: false };
  }
  return { source: 'sdk', isSdkIdle: true };
}

function stageMs(s: FrameBreakdownSample, stage: FrameStage): number {
  const value = s.meanStageMs[stage];
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface BreakdownData {
  /**
   * Drawn columns, in paint order: [x, Σ delay…gpu, Σ delay…swap, …, delay] (`STACK_ORDER`). Each
   * bar is cumulative so the opaque taller bar paints first and the next stage down paints over it.
   */
  data: Aligned;
  /** Per-stage mean ms in `STACK_ORDER`, then the stacked total, aligned with `data[0]`. */
  raw: Column[];
}

/** Stacked mean ms per frame for each 500 ms bucket; null where the bucket drew no frame. */
export function buildBreakdownData(samples: readonly FrameBreakdownSample[]): BreakdownData {
  const when = (fn: (s: FrameBreakdownSample) => number) => (s: FrameBreakdownSample) =>
    s.frameCount > 0 ? fn(s) : null;
  const cumulative = (upTo: number) =>
    when((s) => {
      let sum = 0;
      for (let i = 0; i <= upTo; i++) {
        const stage = STACK_ORDER[i];
        if (stage !== undefined) sum += stageMs(s, stage);
      }
      return sum;
    });
  const topDown = STACK_ORDER.map((_, i) => cumulative(STACK_ORDER.length - 1 - i));
  const data = buildAligned(samples, BREAKDOWN_INTERVAL_MS, topDown);
  const [, ...raw] = buildAligned(samples, BREAKDOWN_INTERVAL_MS, [
    ...STACK_ORDER.map((stage) => when((s) => stageMs(s, stage))),
    cumulative(STACK_ORDER.length - 1),
  ]);
  return { data, raw };
}

/** Vsync budget from the newest breakdown bucket, else the 60 Hz default. */
export function latestBreakdownInterval(samples: readonly FrameBreakdownSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const interval = samples[i]?.frameIntervalMs;
    if (interval !== undefined && interval > 0) return interval;
  }
  return DEFAULT_FRAME_INTERVAL_MS;
}

/** Vsync budget from the newest sample that reports one. */
export function latestFrameInterval(samples: readonly FrameSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const interval = samples[i]?.frameIntervalMs;
    if (interval !== undefined && interval > 0) return interval;
  }
  return DEFAULT_FRAME_INTERVAL_MS;
}

/**
 * True when the budget is a guess: no samples yet, or the newest sample says the server fell
 * back to the 60 Hz default. Older servers don't send a source; their interval isn't flagged.
 */
export function isFrameIntervalAssumed(samples: readonly FrameSample[]): boolean {
  const last = samples[samples.length - 1];
  if (last === undefined) return true;
  return (last as Partial<FrameSample>).frameIntervalSource === 'default';
}

export function budgetLabel(intervalMs: number, isAssumed: boolean): string {
  return `${intervalMs.toFixed(1)} ms budget${isAssumed ? ' (assumed)' : ''}`;
}

/** Index of the last x ≤ `x` (binary search), or -1. */
export function lastIndexAtOrBefore(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = xs[mid];
    if (value !== undefined && value <= x) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Last non-null value of `column` at or before index `from`, scanning back at most `maxBack` rows. */
export function lastValueFrom(column: Column | undefined, from: number, maxBack = 2): number | null {
  if (column === undefined) return null;
  for (let i = from; i >= 0 && i >= from - maxBack; i--) {
    const value = column[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Rounds up to a "nice" axis ceiling: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value - 1e-9) return candidate;
  }
  return 10 * magnitude;
}

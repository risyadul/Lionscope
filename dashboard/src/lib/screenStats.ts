/** Per-screen aggregation of SDK frame breakdown samples for the screens table. */
import type { FrameBreakdownSample, FrameStage, ViewTreeSample } from '@lionscope/protocol/wire';
import { FRAME_STAGES } from '@lionscope/protocol/wire';
import type { ScreenInflate } from './layouts.ts';

export interface StageShare {
  stage: FrameStage;
  /** Mean ms per frame spent in this stage. */
  ms: number;
}

export interface ScreenRow {
  /** null = frames drawn while no screen was reported on top. */
  name: string | null;
  frames: number;
  jankFrames: number;
  slowFrames: number;
  jankPercent: number;
  slowPercent: number;
  /**
   * Typical p90: the frame-weighted median of the 0.5 s bucket p90s (buckets of at least
   * `MIN_P90_BUCKET_FRAMES` frames). The samples carry per-bucket percentiles, not raw frames, so
   * this approximates — it is not — the p90 of every frame. Null when no bucket qualifies.
   */
  typicalP90Ms: number | null;
  /** Worst bucket p90 in the window. */
  worstP90Ms: number;
  /** Mean ms per frame for each stage (frame-weighted). */
  stageMs: Record<FrameStage, number>;
  dominant: StageShare | null;
  /** Main-thread stalls on this screen in the window (debugger stalls excluded); 0 until attached. */
  stallCount: number;
  stallMs: number;
  /** Layout inflation on this screen in the window (0 / null until attached). */
  inflateMs: number;
  inflateCount: number;
  slowestInflate: { name: string; ms: number } | null;
  /** The screen's latest view tree; null when none was taken. */
  viewTree: ViewTreeSample | null;
}

export type ScreenSortKey =
  'name' | 'frames' | 'jankPercent' | 'slowPercent' | 'typicalP90Ms' | 'stallCount' | 'inflateMs' | 'views';

/** Buckets with fewer frames than this say little about a p90 and are left out of the typical one. */
export const MIN_P90_BUCKET_FRAMES = 3;

/** Weighted median: the smallest value whose cumulative weight reaches half the total. */
export function weightedMedian(points: readonly { value: number; weight: number }[]): number | null {
  const valid = points.filter((p) => Number.isFinite(p.value) && p.weight > 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, p) => sum + p.weight, 0) / 2;
  let cumulative = 0;
  for (const point of sorted) {
    cumulative += point.weight;
    if (cumulative >= half) return point.value;
  }
  return sorted[sorted.length - 1]?.value ?? null;
}
export type SortDirection = 'asc' | 'desc';

function zeroStages(): Record<FrameStage, number> {
  return Object.fromEntries(FRAME_STAGES.map((stage) => [stage, 0])) as Record<FrameStage, number>;
}

/** The stage with the largest value (first wins ties); null when every stage is zero. */
export function dominantStage(stageMs: Readonly<Record<FrameStage, number>>): StageShare | null {
  let best: StageShare | null = null;
  for (const stage of FRAME_STAGES) {
    const ms = stageMs[stage];
    if (Number.isFinite(ms) && ms > 0 && (best === null || ms > best.ms)) best = { stage, ms };
  }
  return best;
}

interface Accumulator {
  frames: number;
  jank: number;
  slow: number;
  worstP90: number;
  /** Bucket p90s weighted by frames, for the typical p90. */
  p90s: { value: number; weight: number }[];
  /** Σ mean × frames per stage. */
  stageTotals: Record<FrameStage, number>;
}

/** Aggregates samples with `fromTs ≤ ts ≤ toTs` into one row per screen name. */
export function aggregateScreens(
  samples: readonly FrameBreakdownSample[],
  fromTs: number,
  toTs: number,
): ScreenRow[] {
  const groups = new Map<string | null, Accumulator>();
  for (const sample of samples) {
    if (sample.ts < fromTs || sample.ts > toTs || sample.frameCount <= 0) continue;
    const acc = groups.get(sample.screen) ?? {
      frames: 0,
      jank: 0,
      slow: 0,
      worstP90: 0,
      p90s: [],
      stageTotals: zeroStages(),
    };
    acc.frames += sample.frameCount;
    acc.jank += sample.jankCount;
    acc.slow += Math.max(sample.slowCount, sample.jankCount);
    acc.worstP90 = Math.max(acc.worstP90, sample.p90TotalMs);
    if (sample.frameCount >= MIN_P90_BUCKET_FRAMES) {
      acc.p90s.push({ value: sample.p90TotalMs, weight: sample.frameCount });
    }
    for (const stage of FRAME_STAGES) {
      const mean = sample.meanStageMs[stage];
      if (Number.isFinite(mean)) acc.stageTotals[stage] += mean * sample.frameCount;
    }
    groups.set(sample.screen, acc);
  }
  return [...groups].map(([name, acc]) => {
    const stageMs = zeroStages();
    for (const stage of FRAME_STAGES) stageMs[stage] = acc.stageTotals[stage] / acc.frames;
    return {
      name,
      frames: acc.frames,
      jankFrames: acc.jank,
      slowFrames: acc.slow,
      jankPercent: (acc.jank / acc.frames) * 100,
      slowPercent: (acc.slow / acc.frames) * 100,
      typicalP90Ms: weightedMedian(acc.p90s),
      worstP90Ms: acc.worstP90,
      stageMs,
      dominant: dominantStage(stageMs),
      stallCount: 0,
      stallMs: 0,
      inflateMs: 0,
      inflateCount: 0,
      slowestInflate: null,
      viewTree: null,
    };
  });
}

/** Copies of `rows` carrying each screen's stall count and blocked time. */
export function withStallCounts(
  rows: readonly ScreenRow[],
  byScreen: ReadonlyMap<string, { count: number; totalMs: number }>,
): ScreenRow[] {
  return rows.map((row) => {
    const stalls = row.name === null ? undefined : byScreen.get(row.name);
    return { ...row, stallCount: stalls?.count ?? 0, stallMs: stalls?.totalMs ?? 0 };
  });
}

/** Copies of `rows` carrying each screen's inflation totals and latest view tree. */
export function withLayoutStats(
  rows: readonly ScreenRow[],
  inflates: ReadonlyMap<string, ScreenInflate>,
  viewTrees: ReadonlyMap<string, ViewTreeSample>,
): ScreenRow[] {
  return rows.map((row) => {
    if (row.name === null) return row;
    const inflate = inflates.get(row.name);
    return {
      ...row,
      inflateMs: inflate?.totalMs ?? 0,
      inflateCount: inflate?.count ?? 0,
      slowestInflate: inflate?.slowest ?? null,
      viewTree: viewTrees.get(row.name) ?? null,
    };
  });
}

function compareRows(a: ScreenRow, b: ScreenRow, key: ScreenSortKey, sign: number): number {
  if (key === 'name') return sign * (a.name ?? '').localeCompare(b.name ?? '');
  // Equal counts rank by blocked time.
  if (key === 'stallCount') return sign * (a.stallCount - b.stallCount || a.stallMs - b.stallMs);
  if (key === 'inflateMs') return sign * (a.inflateMs - b.inflateMs);
  // Screens without a view tree sort last in either direction.
  if (key === 'views') {
    const aViews = a.viewTree?.views ?? null;
    const bViews = b.viewTree?.views ?? null;
    if (aViews === null || bViews === null) return aViews === bViews ? 0 : aViews === null ? 1 : -1;
    return sign * (aViews - bViews);
  }
  const av = a[key];
  const bv = b[key];
  // Rows without a value sort last in either direction.
  if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
  return sign * (av - bv);
}

/** Sorted copy; ties fall back to more frames first, then name, so the order is stable. */
export function sortScreenRows(
  rows: readonly ScreenRow[],
  key: ScreenSortKey,
  direction: SortDirection,
): ScreenRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort(
    (a, b) =>
      compareRows(a, b, key, sign) || b.frames - a.frames || (a.name ?? '').localeCompare(b.name ?? ''),
  );
}

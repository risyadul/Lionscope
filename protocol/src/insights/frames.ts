/** Frame-rate and jank figures from `FrameSample`s: the dashboard's stat strip and the agent's summary. */
import type { FrameSample, FrameSource } from '../wire.ts';

/** The stat strip's jank / p90 readout covers this much time, ending at the newest frame sample. */
export const JANK_WINDOW_MS = 30_000;
/** Frame readouts older than this describe no live process (it died, the session stopped) and are blanked. */
export const FRAMES_STALE_MS = 5_000;

/** Nearest-rank percentile (p in 0–100). Returns null for an empty input. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}

/**
 * Frames slower than one vsync. Samples from servers that predate `slowCount` only carry
 * `jankCount`, which then meant the same thing.
 */
export function slowCountOf(s: FrameSample): number {
  return (s as Partial<FrameSample>).slowCount ?? s.jankCount;
}

export interface FrameAggregate {
  jankFrames: number;
  slowFrames: number;
  renderedFrames: number;
  p90Ms: number | null;
}

/**
 * Jank and p90 over the 30 s ending at the newest frame sample. Depends on `frames` only,
 * so callers can memoize it instead of re-sorting durations on every clock tick.
 */
export function aggregateFrames(frames: readonly FrameSample[]): FrameAggregate {
  let jankFrames = 0;
  let slowFrames = 0;
  let renderedFrames = 0;
  const durations: number[] = [];
  const since = (frames[frames.length - 1]?.ts ?? 0) - JANK_WINDOW_MS;
  for (let i = frames.length - 1; i >= 0; i--) {
    const sample = frames[i];
    if (sample === undefined || sample.ts < since) break;
    jankFrames += sample.jankCount;
    slowFrames += Math.max(slowCountOf(sample), sample.jankCount);
    renderedFrames += sample.frameCount;
    for (const d of sample.durationsMs) durations.push(d);
  }
  return { jankFrames, slowFrames, renderedFrames, p90Ms: percentile(durations, 90) };
}

export interface FrameSummary {
  /** Frame samples (about one per second) in the window. */
  samples: number;
  renderedFrames: number;
  jankFrames: number;
  slowFrames: number;
  /** Janky / rendered frames in percent; null when nothing was rendered. */
  jankPercent: number | null;
  slowPercent: number | null;
  /** Mean of the samples' frame rates (an idle UI counts as 0 FPS). */
  meanFps: number | null;
  /** Percentiles of the individual frame durations the samples carry (the newest MAX_FRAME_DURATIONS each). */
  p50Ms: number | null;
  p90Ms: number | null;
  /** Slowest frame in the window. */
  maxMs: number | null;
  /** Vsync period of the newest sample. */
  frameIntervalMs: number | null;
  /** Where the newest sample's frames came from. */
  source: FrameSource | null;
}

/** Frame figures over the samples with `fromTs ≤ ts ≤ toTs`. */
export function summarizeFrames(frames: readonly FrameSample[], fromTs: number, toTs: number): FrameSummary {
  let samples = 0;
  let renderedFrames = 0;
  let jankFrames = 0;
  let slowFrames = 0;
  let fpsTotal = 0;
  let maxMs: number | null = null;
  let latest: FrameSample | null = null;
  const durations: number[] = [];
  for (const sample of frames) {
    if (sample.ts < fromTs || sample.ts > toTs) continue;
    samples++;
    renderedFrames += sample.frameCount;
    jankFrames += sample.jankCount;
    slowFrames += Math.max(slowCountOf(sample), sample.jankCount);
    fpsTotal += sample.fps;
    if (sample.frameCount > 0) maxMs = Math.max(maxMs ?? 0, sample.maxMs);
    for (const d of sample.durationsMs) durations.push(d);
    latest = sample;
  }
  const share = (count: number) => (renderedFrames > 0 ? (count / renderedFrames) * 100 : null);
  return {
    samples,
    renderedFrames,
    jankFrames,
    slowFrames,
    jankPercent: share(jankFrames),
    slowPercent: share(slowFrames),
    meanFps: samples > 0 ? fpsTotal / samples : null,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    maxMs,
    frameIntervalMs: latest?.frameIntervalMs ?? null,
    source: latest === null ? null : (latest.source ?? 'gfxinfo'),
  };
}

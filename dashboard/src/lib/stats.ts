/** Live readouts for the stat strip, derived from the newest samples. */
import type { CpuSample, FrameSample, MemorySample } from '@lionscope/protocol/wire';
import { kbToMb } from './format.ts';
import { frameFeed, isFrameIntervalAssumed, latestFrameInterval, slowCountOf } from './series.ts';

export const JANK_WINDOW_MS = 30_000;
/** A jank share at or above this (percent) is flagged, in the stat strip and the screens table. */
export const JANK_FLAG_PERCENT = 1;

/** Shown instead of "0 FPS": the UI renderer drew nothing, which is not a frame-rate drop. */
export const NO_UI_FRAMES = 'no UI frames';
/** The same reading while the SDK is linked: it sees every window, so nothing drawn means idle. */
export const UI_IDLE = 'UI idle';
export const GFXINFO_HINT =
  'gfxinfo only sees frames drawn by the app’s UI renderer; SurfaceView, video, maps in SurfaceView mode and Flutter aren’t counted.';
export const SDK_NO_FRAMES_HINT =
  'The in-app SDK saw no frames: the app’s windows drew nothing (UI idle), or rendering happens outside them (SurfaceView, video, Flutter).';
export const SDK_FRAMES_HINT =
  'Frames reported by the in-app Lionscope SDK (FrameMetrics, every window of the app). While they flow, gfxinfo polling is paused.';
/** A readout older than this is shown as missing (process died, session stopped). */
const STALE_AFTER_MS: Readonly<Record<'cpu' | 'memory' | 'frames', number>> = {
  cpu: 5_000,
  memory: 10_000,
  frames: 5_000,
};

export interface LiveStats {
  cpuPercent: number | null;
  cpuSingleCorePercent: number | null;
  threads: number | null;
  pssMb: number | null;
  javaMb: number | null;
  nativeMb: number | null;
  fps: number | null;
  /** Janky frames / rendered frames over the last 30 s, in percent. */
  jankPercent: number | null;
  jankFrames: number;
  /** Frames slower than one vsync over the last 30 s (⊇ janky frames). */
  slowFrames: number;
  renderedFrames: number;
  /** p90 of every individual frame duration over the last 30 s. */
  p90Ms: number | null;
  frameIntervalMs: number;
  /** The budget is the 60 Hz default, not a measured vsync period. */
  isFrameIntervalAssumed: boolean;
  /** Frames are fresh but the app drew none (UI idle, or rendering outside the UI renderer). */
  hasNoUiFrames: boolean;
  /** Replaces "0" for a zero-frame reading, worded for the current frame source. */
  noFramesLabel: string;
  /** Explains a zero-frame reading for the current frame source. */
  noFramesHint: string;
}

export interface StatsInput {
  cpu: readonly CpuSample[];
  memory: readonly MemorySample[];
  frames: readonly FrameSample[];
}

function fresh<T extends { ts: number }>(samples: readonly T[], now: number, staleAfter: number): T | null {
  const last = samples[samples.length - 1];
  if (last === undefined || now - last.ts > staleAfter) return null;
  return last;
}

/** Nearest-rank percentile (p in 0–100). Returns null for an empty input. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
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

const NO_FRAMES: FrameAggregate = { jankFrames: 0, slowFrames: 0, renderedFrames: 0, p90Ms: null };

export function computeStats(
  input: StatsInput,
  now: number,
  frameAggregate: FrameAggregate = aggregateFrames(input.frames),
  isSdkConnected = false,
): LiveStats {
  const isSdkSource = frameFeed(input.frames, isSdkConnected).source === 'sdk';
  const cpu = fresh(input.cpu, now, STALE_AFTER_MS.cpu);
  const memory = fresh(input.memory, now, STALE_AFTER_MS.memory);
  const frame = fresh(input.frames, now, STALE_AFTER_MS.frames);
  // Frame aggregates describe "now"; once frames go stale they're blanked like the rest.
  const agg = frame ? frameAggregate : NO_FRAMES;

  return {
    cpuPercent: cpu?.percent ?? null,
    cpuSingleCorePercent: cpu?.percentSingleCore ?? null,
    threads: cpu?.threads ?? null,
    pssMb: memory ? kbToMb(memory.totalPssKb) : null,
    javaMb: memory ? kbToMb(memory.javaHeapKb) : null,
    nativeMb: memory ? kbToMb(memory.nativeHeapKb) : null,
    fps: frame?.fps ?? null,
    jankPercent: agg.renderedFrames > 0 ? (agg.jankFrames / agg.renderedFrames) * 100 : null,
    jankFrames: agg.jankFrames,
    slowFrames: agg.slowFrames,
    renderedFrames: agg.renderedFrames,
    p90Ms: agg.p90Ms,
    frameIntervalMs: latestFrameInterval(input.frames),
    isFrameIntervalAssumed: isFrameIntervalAssumed(input.frames),
    hasNoUiFrames: frame !== null && agg.renderedFrames === 0,
    noFramesLabel: isSdkSource ? UI_IDLE : NO_UI_FRAMES,
    noFramesHint: isSdkSource ? SDK_NO_FRAMES_HINT : GFXINFO_HINT,
  };
}

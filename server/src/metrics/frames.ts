import { MAX_FRAME_DURATIONS } from '@lionscope/protocol';
import type { FrameSample } from '@lionscope/protocol';
import { DEFAULT_FRAME_INTERVAL_MS } from '../parsers/gfxinfo.ts';
import type { Framestats, ParsedFrame } from '../parsers/gfxinfo.ts';

type IntervalSource = FrameSample['frameIntervalSource'];
/** Inferred periods from this many recent polls are combined (smallest wins) to smooth sparse frames. */
const INFERENCE_POLLS = 8;

/** Round to 2 decimals; values too large to scale (they have no decimals left anyway) pass through. */
export function round2(value: number): number {
  const scaled = value * 100;
  return Number.isFinite(scaled) ? Math.round(scaled) / 100 : value;
}

/** Nearest-rank percentile of an ascending array (0 for empty input). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** One frame per IntendedVsync (several windows can render on the same vsync); keep the slowest. */
function uniqueByVsync(frames: readonly ParsedFrame[]): ParsedFrame[] {
  const byVsync = new Map<number, ParsedFrame>();
  for (const frame of frames) {
    const existing = byVsync.get(frame.intendedVsyncNs);
    if (!existing || frame.durationMs > existing.durationMs) byVsync.set(frame.intendedVsyncNs, frame);
  }
  return [...byVsync.values()].sort((a, b) => a.intendedVsyncNs - b.intendedVsyncNs);
}

/**
 * Turns successive `gfxinfo framestats reset` polls into FrameSamples. Frames already seen in the
 * previous poll (same IntendedVsync) are dropped, so a frame is never counted twice. Elapsed time
 * comes from the device's uptime clock (read in the same shell call as the dump), so adb latency
 * doesn't distort fps.
 *
 * The vsync period is FrameInterval when the build reports it (API 31+); otherwise it is inferred
 * from IntendedVsync gaps over the last few polls, and until there is evidence it defaults to 60 Hz
 * (in which case fps is not capped, so 90/120 Hz devices aren't clipped to 60).
 */
export class FrameAggregator {
  private previousVsyncs = new Set<number>();
  private lastDeviceSec: number | null = null;
  private interval: { ms: number; source: IntervalSource } = {
    ms: DEFAULT_FRAME_INTERVAL_MS,
    source: 'default',
  };
  private recentInferredMs: number[] = [];

  /** Forget the baseline: the next poll only primes (its frames predate what we're watching). */
  reset(): void {
    this.previousVsyncs = new Set();
    this.lastDeviceSec = null;
  }

  /** Returns null for the priming poll after construction or reset(). */
  ingest(
    poll: Pick<Framestats, 'frames' | 'inferredIntervalMs'>,
    nowMs: number,
    deviceSec: number,
  ): FrameSample | null {
    const { frames } = poll;
    const fresh = uniqueByVsync(frames.filter((frame) => !this.previousVsyncs.has(frame.intendedVsyncNs)));
    this.previousVsyncs = new Set(frames.map((frame) => frame.intendedVsyncNs));
    this.updateInterval(fresh, poll.inferredIntervalMs);
    const previousSec = this.lastDeviceSec;
    this.lastDeviceSec = deviceSec;
    if (previousSec === null) return null;

    const intervalMs = this.interval.ms;
    const durations = fresh.map((frame) => frame.durationMs);
    const sorted = [...durations].sort((a, b) => a - b);
    const slow = fresh.filter((frame) => frame.durationMs > intervalMs);
    // Deadline-based jank where the build reports deadlines (API 31+), else "slower than a vsync".
    const jankCount = fresh.filter((frame) => frame.missedDeadline ?? frame.durationMs > intervalMs).length;

    const elapsedSec = deviceSec - previousSec;
    let fps = elapsedSec > 0 ? fresh.length / elapsedSec : 0;
    if (this.interval.source !== 'default') fps = Math.min(fps, 1000 / intervalMs);
    return {
      ts: nowMs,
      frameCount: fresh.length,
      jankCount,
      slowCount: slow.length,
      fps: round2(fps),
      p50Ms: round2(percentile(sorted, 50)),
      p90Ms: round2(percentile(sorted, 90)),
      p99Ms: round2(percentile(sorted, 99)),
      maxMs: round2(sorted.at(-1) ?? 0),
      frameIntervalMs: round2(intervalMs),
      frameIntervalSource: this.interval.source,
      durationsMs: durations.slice(-MAX_FRAME_DURATIONS).map(round2),
      source: 'gfxinfo',
    };
  }

  /** Reported beats inferred beats the last known value; a poll without evidence changes nothing. */
  private updateInterval(fresh: readonly ParsedFrame[], inferredMs: number | null): void {
    const reported = fresh
      .map((frame) => frame.reportedIntervalMs)
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);
    if (reported.length > 0) {
      this.interval = { ms: percentile(reported, 50), source: 'reported' };
      return;
    }
    if (inferredMs === null) return;
    this.recentInferredMs = [...this.recentInferredMs.slice(-(INFERENCE_POLLS - 1)), inferredMs];
    this.interval = { ms: Math.min(...this.recentInferredMs), source: 'inferred' };
  }
}

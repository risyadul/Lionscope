import { FRAME_STAGES, MAX_FRAME_DURATIONS } from '@lionscope/protocol';
import type { FrameBreakdownSample, FrameSample, FrameStage, SdkFrame } from '@lionscope/protocol';
import { DEFAULT_FRAME_INTERVAL_MS } from '../parsers/gfxinfo.ts';
import { percentile, round2 } from './frames.ts';

export const SDK_BUCKET_MS = 500;
/** Consecutive empty buckets emitted as zero-frame samples before skipping ahead to the next frames. */
export const MAX_EMPTY_BUCKETS = 8;
/** Frames waiting for their bucket to be emitted; more are dropped (a stalled drain must not grow memory). */
export const MAX_PENDING_SDK_FRAMES = 20_000;

/** Per-stage durations except `gpu`, which is only averaged over frames that report it. */
const STAGE_MS: Readonly<Record<Exclude<FrameStage, 'gpu'>, (frame: SdkFrame) => number>> = {
  input: (frame) => frame.inputMs,
  animation: (frame) => frame.animationMs,
  layout: (frame) => frame.layoutMs,
  draw: (frame) => frame.drawMs,
  sync: (frame) => frame.syncMs,
  command: (frame) => frame.commandMs,
  swap: (frame) => frame.swapMs,
  delay: (frame) => frame.delayMs,
};

interface PendingFrame {
  frame: SdkFrame;
  /** Vsync period reported with the frame's batch. */
  intervalMs: number;
}

export interface SdkFrameBucket {
  frames: FrameSample;
  /** null for a bucket without frames (there is nothing to break down). */
  breakdown: FrameBreakdownSample | null;
}

/** The frame's deadline; a missing or non-positive DEADLINE (an OEM quirk) falls back to one vsync. */
function deadlineOf(entry: PendingFrame): number {
  const { deadlineMs } = entry.frame;
  return deadlineMs !== null && deadlineMs > 0 ? deadlineMs : entry.intervalMs;
}

/** One frame per intended vsync (several windows can render on the same vsync); keep the slowest. */
function uniqueByVsync(entries: readonly PendingFrame[]): PendingFrame[] {
  const byTs = new Map<number, PendingFrame>();
  for (const entry of entries) {
    const existing = byTs.get(entry.frame.ts);
    if (!existing || entry.frame.totalMs > existing.frame.totalMs) byTs.set(entry.frame.ts, entry);
  }
  return [...byTs.values()];
}

/**
 * Groups SDK FrameMetrics (already on the laptop clock) into 500 ms buckets by completion time
 * (`ts + totalMs`), each turned into one FrameSample (`source: 'sdk'`) and one FrameBreakdownSample. A
 * bucket is emitted by `drain` once its end has passed; frames arriving for an already emitted bucket count
 * towards the oldest open one.
 *
 * Jank is deadline-based where the SDK reports a usable one (API 31+, > 0), else "slower than a vsync".
 * First-draw frames (a window's first, layout-heavy frame) count in `frameCount` but are otherwise left out:
 * no jank, slow, percentiles, durations or stage means, as gfxinfo leaves out its layout-change rows.
 */
export class SdkFrameAggregator {
  private pending = new Map<number, PendingFrame[]>();
  private pendingCount = 0;
  /** First bucket index not yet emitted; null until the first drain after construction or reset(). */
  private nextIndex: number | null = null;
  /** Frames completing at or before this were already covered by another source (gfxinfo). */
  private floorTs = -Infinity;
  private lastIntervalMs = DEFAULT_FRAME_INTERVAL_MS;

  /** Start over; with `afterTs`, only frames completing after it count and the first bucket ends after it. */
  reset(afterTs = -Infinity): void {
    this.pending = new Map();
    this.pendingCount = 0;
    this.floorTs = afterTs;
    this.nextIndex = Number.isFinite(afterTs) ? Math.floor(afterTs / SDK_BUCKET_MS) : null;
  }

  /** Frames completing at or before the floor, or beyond MAX_PENDING_SDK_FRAMES, are dropped. */
  add(frames: readonly SdkFrame[], intervalMs: number): void {
    for (const frame of frames) {
      const completedAt = frame.ts + frame.totalMs;
      if (completedAt <= this.floorTs || this.pendingCount >= MAX_PENDING_SDK_FRAMES) continue;
      const index = Math.max(Math.floor(completedAt / SDK_BUCKET_MS), this.nextIndex ?? -Infinity);
      const bucket = this.pending.get(index);
      if (bucket) bucket.push({ frame, intervalMs });
      else this.pending.set(index, [{ frame, intervalMs }]);
      this.pendingCount += 1;
    }
  }

  /**
   * Emit, oldest first, every bucket that ended at or before `untilMs` (`Infinity`: every bucket holding
   * frames). Empty buckets in between become zero-frame samples (at most MAX_EMPTY_BUCKETS in a row).
   * `screenAt` names the top screen at a bucket's end.
   */
  drain(untilMs: number, screenAt: (ts: number) => string | null): SdkFrameBucket[] {
    const indices = [...this.pending.keys()].sort((a, b) => a - b);
    const last = Number.isFinite(untilMs) ? Math.floor(untilMs / SDK_BUCKET_MS) - 1 : indices.at(-1);
    const first = this.nextIndex ?? indices[0];
    if (last === undefined || first === undefined || first > last) return [];

    let index = first;
    const buckets: SdkFrameBucket[] = [];
    let emptyRun = 0;
    while (index <= last) {
      const entries = this.pending.get(index);
      if (entries) {
        this.pending.delete(index);
        this.pendingCount -= entries.length;
        buckets.push(this.bucket(index, entries, screenAt));
        emptyRun = 0;
      } else if (emptyRun < MAX_EMPTY_BUCKETS) {
        buckets.push(this.bucket(index, [], screenAt));
        emptyRun += 1;
      } else {
        const from = index;
        const next: number | undefined = indices.find((candidate) => candidate > from);
        if (next === undefined || next > last) break;
        index = next;
        continue;
      }
      index += 1;
    }
    this.nextIndex = last + 1;
    return buckets;
  }

  private bucket(
    index: number,
    received: readonly PendingFrame[],
    screenAt: (ts: number) => string | null,
  ): SdkFrameBucket {
    const ts = (index + 1) * SDK_BUCKET_MS;
    const entries = uniqueByVsync(received);
    const intervalMs = entries.at(-1)?.intervalMs ?? this.lastIntervalMs;
    this.lastIntervalMs = intervalMs;
    const measured = entries.filter((entry) => !entry.frame.firstDraw);
    const totals = measured.map((entry) => entry.frame.totalMs);
    const sorted = [...totals].sort((a, b) => a - b);
    const slowCount = measured.filter((entry) => entry.frame.totalMs > entry.intervalMs).length;
    const jankCount = measured.filter((entry) => entry.frame.totalMs > deadlineOf(entry)).length;
    const fps = Math.min(entries.length / (SDK_BUCKET_MS / 1000), 1000 / intervalMs);

    const frames: FrameSample = {
      ts,
      frameCount: entries.length,
      jankCount,
      slowCount,
      fps: round2(fps),
      p50Ms: round2(percentile(sorted, 50)),
      p90Ms: round2(percentile(sorted, 90)),
      p99Ms: round2(percentile(sorted, 99)),
      maxMs: round2(sorted.at(-1) ?? 0),
      frameIntervalMs: round2(intervalMs),
      frameIntervalSource: 'reported',
      durationsMs: totals.slice(-MAX_FRAME_DURATIONS).map(round2),
      source: 'sdk',
    };
    if (entries.length === 0) return { frames, breakdown: null };

    const mean = (values: readonly number[]) =>
      values.length === 0 ? 0 : round2(values.reduce((sum, value) => sum + value, 0) / values.length);
    const gpu = measured.map((entry) => entry.frame.gpuMs).filter((ms): ms is number => ms !== null);
    const meanStageMs = Object.fromEntries(
      FRAME_STAGES.map((stage) => [
        stage,
        stage === 'gpu' ? mean(gpu) : mean(measured.map((entry) => STAGE_MS[stage](entry.frame))),
      ]),
    ) as Record<FrameStage, number>;
    const breakdown: FrameBreakdownSample = {
      ts,
      screen: screenAt(ts),
      frameCount: entries.length,
      jankCount,
      slowCount,
      meanStageMs,
      p90TotalMs: frames.p90Ms,
      maxTotalMs: frames.maxMs,
      frameIntervalMs: frames.frameIntervalMs,
    };
    return { frames, breakdown };
  }
}

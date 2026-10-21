import { FRAME_STAGES, MAX_FRAME_DURATIONS } from '@lionscope/protocol';
import type { SdkFrame } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_EMPTY_BUCKETS,
  MAX_PENDING_SDK_FRAMES,
  SDK_BUCKET_MS,
  SdkFrameAggregator,
} from '../src/metrics/sdkFrames.ts';

const T0 = 1_000_000; // bucket-aligned
const noScreen = () => null;

function frame(ts: number, totalMs: number, extra: Partial<SdkFrame> = {}): SdkFrame {
  return {
    ts,
    totalMs,
    inputMs: 1,
    animationMs: 2,
    layoutMs: 3,
    drawMs: 4,
    syncMs: 0.5,
    commandMs: 1.5,
    swapMs: 0.25,
    delayMs: 0.75,
    gpuMs: 2,
    deadlineMs: null,
    firstDraw: false,
    ...extra,
  };
}

describe('SdkFrameAggregator', () => {
  it('turns one 500 ms bucket into a FrameSample (source sdk) and a breakdown', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 10, 5), frame(T0 + 20, 12), frame(T0 + 30, 30, { gpuMs: null })], 8.333);
    const buckets = aggregator.drain(T0 + SDK_BUCKET_MS, (ts) => (ts === T0 + 500 ? 'home' : 'other'));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.frames).toEqual({
      ts: T0 + 500,
      frameCount: 3,
      jankCount: 2, // no deadline: slower than one vsync
      slowCount: 2,
      fps: 6,
      p50Ms: 12,
      p90Ms: 30,
      p99Ms: 30,
      maxMs: 30,
      frameIntervalMs: 8.33,
      frameIntervalSource: 'reported',
      durationsMs: [5, 12, 30],
      source: 'sdk',
    });
    expect(buckets[0]?.breakdown).toEqual({
      ts: T0 + 500,
      screen: 'home',
      frameCount: 3,
      jankCount: 2,
      slowCount: 2,
      meanStageMs: {
        input: 1,
        animation: 2,
        layout: 3,
        draw: 4,
        sync: 0.5,
        command: 1.5,
        swap: 0.25,
        delay: 0.75,
        gpu: 2, // averaged over the frames that report a GPU duration
      },
      p90TotalMs: 30,
      maxTotalMs: 30,
      frameIntervalMs: 8.33,
    });
    expect(Object.keys(buckets[0]?.breakdown?.meanStageMs ?? {})).toEqual([...FRAME_STAGES]);
  });

  it('uses the deadline for jank when reported', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add(
      [
        frame(T0 + 1, 12, { deadlineMs: 16.6 }), // slow, but within its deadline
        frame(T0 + 2, 20, { deadlineMs: 16.6 }), // janky and slow
      ],
      8.333,
    );
    const [bucket] = aggregator.drain(T0 + 500, noScreen);
    expect(bucket?.frames).toMatchObject({ frameCount: 2, jankCount: 1, slowCount: 2 });
  });

  it('falls back to one vsync when the deadline is not positive (OEM quirk, clamped to 0 by the SDK)', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add(
      [
        frame(T0 + 1, 10, { deadlineMs: 0 }),
        frame(T0 + 2, 20, { deadlineMs: 0 }),
        frame(T0 + 3, 5, { deadlineMs: -1 }),
      ],
      16.6,
    );
    const [bucket] = aggregator.drain(T0 + 500, noScreen);
    expect(bucket?.frames).toMatchObject({ frameCount: 3, jankCount: 1, slowCount: 1 });
  });

  it('counts first-draw frames but leaves them out of jank, slow, percentiles, durations and stage means', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add(
      [
        frame(T0 + 1, 12, { deadlineMs: 16.6 }),
        frame(T0 + 3, 80, { firstDraw: true, layoutMs: 60, gpuMs: 9 }),
      ],
      8.333,
    );
    const [bucket] = aggregator.drain(T0 + 500, noScreen);
    expect(bucket?.frames).toMatchObject({
      frameCount: 2,
      fps: 4,
      jankCount: 0,
      slowCount: 1,
      p50Ms: 12,
      p99Ms: 12,
      maxMs: 12,
      durationsMs: [12],
    });
    expect(bucket?.breakdown).toMatchObject({ frameCount: 2, p90TotalMs: 12, maxTotalMs: 12 });
    expect(bucket?.breakdown?.meanStageMs).toMatchObject({ layout: 3, gpu: 2 });

    // A bucket holding only a first draw: counted, nothing measured.
    aggregator.add([frame(T0 + 600, 300, { firstDraw: true })], 8.333);
    const [only] = aggregator.drain(Infinity, noScreen);
    expect(only?.frames).toMatchObject({
      frameCount: 1,
      jankCount: 0,
      slowCount: 0,
      maxMs: 0,
      durationsMs: [],
    });
    expect(only?.breakdown?.meanStageMs).toEqual({
      input: 0,
      animation: 0,
      layout: 0,
      draw: 0,
      sync: 0,
      command: 0,
      swap: 0,
      delay: 0,
      gpu: 0,
    });
  });

  it('puts a frame in the bucket where it completed (ts + totalMs)', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 480, 40), frame(T0 + 490, 5)], 16.6);
    const buckets = aggregator.drain(T0 + 1000, noScreen);
    expect(buckets.map((bucket) => [bucket.frames.ts, bucket.frames.frameCount])).toEqual([
      [T0 + 500, 1],
      [T0 + 1000, 1],
    ]);
    expect(buckets[1]?.frames.maxMs).toBe(40);
  });

  it('keeps one frame per vsync (several windows), the slowest', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 10, 4), frame(T0 + 26, 5)], 16.6);
    aggregator.add([frame(T0 + 10, 9, { gpuMs: null })], 16.6); // a dialog window on the same vsync
    const [bucket] = aggregator.drain(T0 + 500, noScreen);
    expect(bucket?.frames).toMatchObject({ frameCount: 2, fps: 4, durationsMs: [9, 5], maxMs: 9 });
    expect(bucket?.breakdown?.meanStageMs.gpu).toBe(2);
  });

  it('reports a GPU mean of 0 when no frame has a GPU duration', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 10, 4, { gpuMs: null })], 16.6);
    expect(aggregator.drain(T0 + 500, noScreen)[0]?.breakdown?.meanStageMs.gpu).toBe(0);
  });

  it('starts after a floor: frames completed by then and earlier buckets are skipped', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.reset(T0 + 700); // the last gfxinfo sample
    aggregator.add([frame(T0 + 600, 50), frame(T0 + 650, 60), frame(T0 + 1100, 5)], 16.6);
    const buckets = aggregator.drain(T0 + 1500, noScreen);
    expect(buckets.map((bucket) => [bucket.frames.ts, bucket.frames.frameCount])).toEqual([
      [T0 + 1000, 1], // 650 + 60 completed after the floor
      [T0 + 1500, 1],
    ]);
    expect(buckets.every((bucket) => bucket.frames.ts > T0 + 700)).toBe(true);
  });

  it(`holds at most ${MAX_PENDING_SDK_FRAMES} pending frames`, () => {
    const aggregator = new SdkFrameAggregator();
    const many = Array.from({ length: MAX_PENDING_SDK_FRAMES + 50 }, (_, i) => frame(T0 + i / 100, 1));
    aggregator.add(many, 16.6);
    const total = aggregator
      .drain(Infinity, noScreen)
      .reduce((sum, bucket) => sum + bucket.frames.frameCount, 0);
    expect(total).toBe(MAX_PENDING_SDK_FRAMES);
    aggregator.add([frame(T0 + 300_000, 1)], 16.6); // room again once drained
    expect(aggregator.drain(Infinity, noScreen).at(-1)?.frames.frameCount).toBe(1);
  });

  it('caps fps at the refresh rate and keeps at most MAX_FRAME_DURATIONS durations', () => {
    const aggregator = new SdkFrameAggregator();
    const frames = Array.from({ length: MAX_FRAME_DURATIONS + 10 }, (_, i) => frame(T0 + i / 1000, 1 + i));
    aggregator.add(frames, 1000 / 60);
    const [bucket] = aggregator.drain(T0 + 500, noScreen);
    expect(bucket?.frames.fps).toBe(60);
    expect(bucket?.frames.durationsMs).toHaveLength(MAX_FRAME_DURATIONS);
    expect(bucket?.frames.durationsMs.at(-1)).toBe(MAX_FRAME_DURATIONS + 10);
  });

  it('only emits buckets that ended, filling short gaps with zero-frame samples', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 100, 5)], 10);
    aggregator.add([frame(T0 + 1600, 5)], 10);
    expect(aggregator.drain(T0 + 499, noScreen)).toEqual([]);
    const buckets = aggregator.drain(T0 + 1500, noScreen);
    expect(buckets.map((bucket) => [bucket.frames.ts, bucket.frames.frameCount])).toEqual([
      [T0 + 500, 1],
      [T0 + 1000, 0],
      [T0 + 1500, 0],
    ]);
    expect(buckets[1]?.breakdown).toBeNull();
    expect(buckets[1]?.frames).toMatchObject({ fps: 0, p90Ms: 0, maxMs: 0, frameIntervalMs: 10 });
    expect(aggregator.drain(T0 + 1500, noScreen)).toEqual([]);
    expect(aggregator.drain(T0 + 2000, noScreen).map((bucket) => bucket.frames.frameCount)).toEqual([1]);
  });

  it('skips long gaps instead of emitting a zero sample for every bucket', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0, 5)], 10);
    aggregator.add([frame(T0 + 60_000, 5)], 10);
    const buckets = aggregator.drain(T0 + 60_500, noScreen);
    expect(buckets).toHaveLength(1 + MAX_EMPTY_BUCKETS + 1);
    expect(buckets.at(-1)?.frames).toMatchObject({ ts: T0 + 60_500, frameCount: 1 });
    // Without later frames the run of empty buckets just ends.
    expect(aggregator.drain(T0 + 120_000, noScreen)).toHaveLength(MAX_EMPTY_BUCKETS);
  });

  it('counts frames for an already emitted bucket towards the oldest open one', () => {
    const aggregator = new SdkFrameAggregator();
    aggregator.add([frame(T0 + 100, 5)], 10);
    aggregator.drain(T0 + 500, noScreen);
    aggregator.add([frame(T0 + 200, 7)], 10); // arrived late
    const [bucket] = aggregator.drain(T0 + 1000, noScreen);
    expect(bucket?.frames).toMatchObject({ ts: T0 + 1000, frameCount: 1, maxMs: 7 });
  });

  it('flushes every pending bucket with Infinity, and starts over after reset()', () => {
    const aggregator = new SdkFrameAggregator();
    expect(aggregator.drain(Infinity, noScreen)).toEqual([]);
    aggregator.add([frame(T0 + 100, 5), frame(T0 + 700, 5)], 10);
    expect(aggregator.drain(Infinity, noScreen).map((bucket) => bucket.frames.ts)).toEqual([
      T0 + 500,
      T0 + 1000,
    ]);
    aggregator.reset();
    aggregator.add([frame(T0 + 100, 9)], 10); // older than what was emitted: fine after a reset
    expect(aggregator.drain(Infinity, noScreen)[0]?.frames).toMatchObject({ ts: T0 + 500, maxMs: 9 });
    aggregator.reset();
    expect(aggregator.drain(T0 + 5000, noScreen)).toEqual([]);
  });
});

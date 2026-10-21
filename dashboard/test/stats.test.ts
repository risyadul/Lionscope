import { describe, expect, it } from 'vitest';
import {
  aggregateFrames,
  computeStats,
  GFXINFO_HINT,
  JANK_WINDOW_MS,
  NO_UI_FRAMES,
  percentile,
  SDK_NO_FRAMES_HINT,
  UI_IDLE,
} from '../src/lib/stats.ts';
import { DEFAULT_FRAME_INTERVAL_MS } from '../src/lib/series.ts';
import { cpu, frame, memory, T0 } from './fixtures.ts';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([], 90)).toBeNull();
  });

  it('does not reorder its input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('computeStats', () => {
  it('returns empty readouts without data', () => {
    const stats = computeStats({ cpu: [], memory: [], frames: [] }, T0);
    expect(stats).toMatchObject({
      cpuPercent: null,
      threads: null,
      pssMb: null,
      fps: null,
      jankPercent: null,
      p90Ms: null,
      renderedFrames: 0,
      frameIntervalMs: DEFAULT_FRAME_INTERVAL_MS,
    });
  });

  it('reads the newest fresh samples', () => {
    const stats = computeStats(
      {
        cpu: [cpu(T0, 5), cpu(T0 + 1000, 12.5)],
        memory: [memory(T0)],
        frames: [frame(T0 + 1000, { fps: 57 })],
      },
      T0 + 1500,
    );
    expect(stats.cpuPercent).toBe(12.5);
    expect(stats.cpuSingleCorePercent).toBe(100);
    expect(stats.threads).toBe(42);
    expect(stats.pssMb).toBe(100);
    expect(stats.javaMb).toBe(30);
    expect(stats.nativeMb).toBe(20);
    expect(stats.fps).toBe(57);
  });

  it('blanks readouts once samples go stale', () => {
    const stats = computeStats({ cpu: [cpu(T0)], memory: [memory(T0)], frames: [frame(T0)] }, T0 + 20_000);
    expect(stats.cpuPercent).toBeNull();
    expect(stats.pssMb).toBeNull();
    expect(stats.fps).toBeNull();
  });

  it('aggregates jank and p90 over the last 30 s only', () => {
    const now = T0 + 60_000;
    const old = frame(now - JANK_WINDOW_MS - 5000, { frameCount: 100, jankCount: 100, durationsMs: [500] });
    const recent = [
      frame(now - 2000, { frameCount: 50, jankCount: 5, durationsMs: [8, 8, 8, 8, 8, 8, 8, 8, 8, 40] }),
      frame(now - 1000, { frameCount: 50, jankCount: 0, durationsMs: [10] }),
    ];
    const stats = computeStats({ cpu: [], memory: [], frames: [old, ...recent] }, now);
    expect(stats.jankFrames).toBe(5);
    expect(stats.renderedFrames).toBe(100);
    expect(stats.jankPercent).toBe(5);
    expect(stats.p90Ms).toBe(10);
  });

  it('aggregates relative to the newest frame, so it can be memoized on frames alone', () => {
    const frames = [
      frame(T0, { jankCount: 2, frameCount: 10 }),
      frame(T0 + 1000, { jankCount: 0, frameCount: 10 }),
    ];
    const agg = aggregateFrames(frames);
    expect(agg).toMatchObject({ jankFrames: 2, renderedFrames: 20 });
    expect(computeStats({ cpu: [], memory: [], frames }, T0 + 1500, agg).jankPercent).toBe(10);
    expect(aggregateFrames([])).toEqual({ jankFrames: 0, slowFrames: 0, renderedFrames: 0, p90Ms: null });
  });

  it('blanks jank and p90 once frames go stale', () => {
    const frames = [frame(T0)];
    const stats = computeStats({ cpu: [], memory: [], frames }, T0 + 60_000);
    expect(stats.jankPercent).toBeNull();
    expect(stats.p90Ms).toBeNull();
    expect(stats.renderedFrames).toBe(0);
  });

  it('counts slow frames (at least the janky ones) and reports no UI frames when nothing drew', () => {
    const frames = [
      frame(T0, { jankCount: 2, slowCount: 7, frameCount: 50 }),
      frame(T0 + 1000, { jankCount: 3, slowCount: 1, frameCount: 50 }),
    ];
    const stats = computeStats({ cpu: [], memory: [], frames }, T0 + 1500);
    expect(stats.jankFrames).toBe(5);
    expect(stats.slowFrames).toBe(10);
    expect(stats.hasNoUiFrames).toBe(false);

    const idle = [frame(T0, { frameCount: 0, jankCount: 0, slowCount: 0, fps: 0, durationsMs: [] })];
    const idleStats = computeStats({ cpu: [], memory: [], frames: idle }, T0 + 500);
    expect(idleStats.fps).toBe(0);
    expect(idleStats.hasNoUiFrames).toBe(true);
    expect(idleStats.jankPercent).toBeNull();
    expect(computeStats({ cpu: [], memory: [], frames: [] }, T0).hasNoUiFrames).toBe(false);
  });

  it('marks the budget as assumed when the server fell back to the default interval', () => {
    const frames = [frame(T0, { frameIntervalSource: 'default' })];
    expect(computeStats({ cpu: [], memory: [], frames }, T0).isFrameIntervalAssumed).toBe(true);
    expect(computeStats({ cpu: [], memory: [], frames: [frame(T0)] }, T0).isFrameIntervalAssumed).toBe(false);
  });
});

describe('zero-frame wording', () => {
  const empty = (ts: number, overrides = {}) =>
    frame(ts, { frameCount: 0, jankCount: 0, slowCount: 0, fps: 0, durationsMs: [], ...overrides });

  it('uses the gfxinfo caveat without an SDK', () => {
    const stats = computeStats({ cpu: [], memory: [], frames: [empty(T0)] }, T0);
    expect([stats.noFramesLabel, stats.noFramesHint]).toEqual([NO_UI_FRAMES, GFXINFO_HINT]);
  });

  it('says UI idle with the SDK hint while the SDK is linked, even for a gfxinfo fallback sample', () => {
    const stats = computeStats({ cpu: [], memory: [], frames: [empty(T0)] }, T0, undefined, true);
    expect([stats.noFramesLabel, stats.noFramesHint]).toEqual([UI_IDLE, SDK_NO_FRAMES_HINT]);
    const sdkOnly = computeStats({ cpu: [], memory: [], frames: [empty(T0, { source: 'sdk' })] }, T0);
    expect(sdkOnly.noFramesLabel).toBe(UI_IDLE);
  });
});

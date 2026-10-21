import { MAX_FRAME_DURATIONS } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { computeCpuUsage } from '../src/metrics/cpu.ts';
import { FrameAggregator, percentile, round2 } from '../src/metrics/frames.ts';
import type { ParsedFrame } from '../src/parsers/gfxinfo.ts';
import { parseFramestats } from '../src/parsers/gfxinfo.ts';
import { api30Framestats, fixture } from './helpers/fakes.ts';

describe('computeCpuUsage', () => {
  const base = { ticks: 1000, atSec: 100, threads: 40 };

  it('returns null without a baseline (first sample)', () => {
    expect(computeCpuUsage(null, base, 100, 4)).toBeNull();
  });

  it('computes single-core and all-core percentages', () => {
    // 50 ticks over 1 s at 100 Hz = 50% of one core = 12.5% of four cores.
    expect(computeCpuUsage(base, { ticks: 1050, atSec: 101, threads: 41 }, 100, 4)).toEqual({
      percent: 12.5,
      percentSingleCore: 50,
      threads: 41,
    });
    expect(computeCpuUsage(base, { ticks: 1300, atSec: 101, threads: 40 }, 100, 4)?.percentSingleCore).toBe(
      300,
    );
  });

  it('clamps negative deltas and impossible values', () => {
    expect(computeCpuUsage(base, { ticks: 900, atSec: 101, threads: 40 }, 100, 4)?.percent).toBe(0);
    expect(computeCpuUsage(base, { ticks: 99_999, atSec: 101, threads: 40 }, 100, 2)).toEqual({
      percent: 100,
      percentSingleCore: 200,
      threads: 40,
    });
  });

  it('returns null when no time elapsed or clkTck is invalid; treats cores < 1 as 1', () => {
    expect(computeCpuUsage(base, { ...base, ticks: 1010 }, 100, 4)).toBeNull();
    expect(computeCpuUsage(base, { ticks: 1010, atSec: 101, threads: 1 }, 0, 4)).toBeNull();
    expect(computeCpuUsage(base, { ticks: 1010, atSec: 101, threads: 1 }, 100, 0)?.percent).toBe(10);
  });
});

interface FrameOptions {
  reportedIntervalMs?: number | null;
  missedDeadline?: boolean | null;
}

/** A frame at `vsyncMs` taking `durationMs`; by default an API 31+ frame at 60 Hz that met its deadline. */
function frame(vsyncMs: number, durationMs: number, options: FrameOptions = {}): ParsedFrame {
  return {
    intendedVsyncNs: Math.round(vsyncMs * 1e6),
    durationMs,
    reportedIntervalMs: options.reportedIntervalMs === undefined ? 16.67 : options.reportedIntervalMs,
    missedDeadline: options.missedDeadline === undefined ? false : options.missedDeadline,
  };
}

/** An API < 31 frame: no FrameInterval, no FrameDeadline. */
function legacyFrame(vsyncMs: number, durationMs: number): ParsedFrame {
  return frame(vsyncMs, durationMs, { reportedIntervalMs: null, missedDeadline: null });
}

function poll(frames: ParsedFrame[], inferredIntervalMs: number | null = null) {
  return { frames, inferredIntervalMs };
}

describe('round2', () => {
  it('rounds to two decimals and passes through values too large to scale', () => {
    expect(round2(1.005 * 1000)).toBe(1005);
    expect(round2(7.6499999)).toBe(7.65);
    expect(round2(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(round2(-Number.MAX_VALUE)).toBe(-Number.MAX_VALUE);
    expect(Number.isFinite(round2(1e307))).toBe(true);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 99)).toBe(10);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 0)).toBe(7);
  });
});

/** An aggregator whose priming poll happened at device uptime `sec`. */
function primed(sec = 100, frames: ParsedFrame[] = [], inferred: number | null = null): FrameAggregator {
  const aggregator = new FrameAggregator();
  expect(aggregator.ingest(poll(frames, inferred), 0, sec)).toBeNull();
  return aggregator;
}

describe('FrameAggregator', () => {
  it('returns null for the priming poll, also after reset()', () => {
    const aggregator = primed();
    expect(aggregator.ingest(poll([]), 1000, 101)).not.toBeNull();
    aggregator.reset();
    expect(aggregator.ingest(poll([frame(0, 5)]), 2000, 102)).toBeNull();
  });

  it('aggregates counts, percentiles and fps over device time', () => {
    const aggregator = primed(100);
    const durations = [5, 6, 7, 8, 9, 10, 11, 12, 30, 50];
    const sample = aggregator.ingest(
      poll(durations.map((duration, i) => frame(i * 16, duration, { missedDeadline: duration > 40 }))),
      3000,
      102, // 2 s of device time, regardless of the laptop clock
    );
    expect(sample).toMatchObject({
      ts: 3000,
      frameCount: 10,
      jankCount: 1, // deadline-based
      slowCount: 2, // slower than one vsync
      fps: 5,
      p50Ms: 9,
      p90Ms: 30,
      p99Ms: 50,
      maxMs: 50,
      frameIntervalMs: 16.67,
      frameIntervalSource: 'reported',
    });
    expect(sample?.durationsMs).toEqual(durations);
  });

  it('counts jank as slow frames when the build has no FrameDeadline', () => {
    const sample = primed(0).ingest(
      poll([legacyFrame(0, 5), legacyFrame(16.67, 20), legacyFrame(33.33, 40)], 16.67),
      1000,
      1,
    );
    expect(sample).toMatchObject({ slowCount: 2, jankCount: 2, frameIntervalSource: 'inferred' });
  });

  it('caps fps at the reported refresh rate', () => {
    const aggregator = primed(100);
    const burst = Array.from({ length: 80 }, (_, i) => frame(i * 8, 5, { reportedIntervalMs: 8.33 }));
    expect(aggregator.ingest(poll(burst), 1000, 100.5)?.fps).toBe(120.05); // clamped from 160
    expect(aggregator.ingest(poll([frame(1000, 5)]), 2000, 100.5)?.fps).toBe(0);
  });

  it('does not cap fps while the interval is only the 60 Hz default', () => {
    const burst = Array.from({ length: 60 }, (_, i) => legacyFrame(i * 8.33, 5));
    const sample = primed(100).ingest(poll(burst, null), 1000, 100.5);
    expect(sample).toMatchObject({ fps: 120, frameIntervalSource: 'default', frameIntervalMs: 16.67 });
  });

  it('gives ~120 fps for a synthetic API 30 dump at 120 Hz (no FrameInterval column)', () => {
    const aggregator = primed(100, [], null);
    const vsyncs = Array.from({ length: 60 }, (_, i) => i);
    const dump = parseFramestats(api30Framestats([vsyncs], 4));
    const sample = aggregator.ingest(dump, 1000, 100.5);
    expect(sample?.frameIntervalSource).toBe('inferred');
    expect(sample?.frameIntervalMs).toBeCloseTo(8.33, 2);
    expect(sample?.fps).toBeCloseTo(120, 0);
    expect(sample).toMatchObject({ slowCount: 0, jankCount: 0 });

    // A later poll that is too sparse to infer from keeps the 120 Hz period.
    const later = aggregator.ingest(parseFramestats(api30Framestats([[100]], 12)), 2000, 101);
    expect(later).toMatchObject({ frameIntervalSource: 'inferred', slowCount: 1, jankCount: 1 });
    expect(later?.frameIntervalMs).toBeCloseTo(8.33, 2);
  });

  it('combines recent inferred periods (sparse frames overestimate one poll)', () => {
    const aggregator = primed(0, [], 8.33);
    expect(aggregator.ingest(poll([legacyFrame(0, 5)], 25), 1000, 1)?.frameIntervalMs).toBe(8.33);
  });

  it('keeps the last known interval and source through polls without frames', () => {
    const aggregator = primed(0);
    aggregator.ingest(poll([frame(0, 5, { reportedIntervalMs: 11.11 })]), 1000, 1);
    expect(aggregator.ingest(poll([]), 2000, 2)).toMatchObject({
      frameCount: 0,
      fps: 0,
      p50Ms: 0,
      maxMs: 0,
      frameIntervalMs: 11.11,
      frameIntervalSource: 'reported',
    });
  });

  it('drops frames already reported by the previous poll', () => {
    const aggregator = primed(0, [frame(0, 5), frame(16, 5)]);
    expect(aggregator.ingest(poll([frame(16, 5), frame(32, 6)]), 1000, 1)?.frameCount).toBe(1);
    expect(aggregator.ingest(poll([frame(32, 6), frame(48, 7), frame(64, 8)]), 2000, 2)?.frameCount).toBe(2);
  });

  it('counts one frame per vsync across windows, keeping the slowest', () => {
    const sample = primed(0).ingest(
      poll([frame(0, 5), frame(0, 25, { missedDeadline: true }), frame(16, 4)]),
      1000,
      1,
    );
    expect(sample).toMatchObject({ frameCount: 2, jankCount: 1, slowCount: 1, maxMs: 25 });
  });

  it('caps durationsMs to MAX_FRAME_DURATIONS most recent frames', () => {
    const frames = Array.from({ length: MAX_FRAME_DURATIONS + 10 }, (_, i) => frame(i * 16, i));
    const sample = primed(0).ingest(poll(frames), 1000, 10);
    expect(sample?.frameCount).toBe(MAX_FRAME_DURATIONS + 10);
    expect(sample?.durationsMs).toHaveLength(MAX_FRAME_DURATIONS);
    expect(sample?.durationsMs[0]).toBe(10);
  });

  it('uses real API 36 deadlines (16.67–416 ms past IntendedVsync) for jank', () => {
    const text = fixture('gfxinfo-framestats.txt');
    // Independent reference computation straight from the CSV.
    const header =
      text
        .split('\n')
        .find((line) => line.startsWith('Flags,'))
        ?.split(',') ?? [];
    const col = (name: string) => header.indexOf(name);
    const rows = text
      .split('\n')
      .filter((line) => /^0,\d/.test(line))
      .map((line) => line.split(',').map(Number))
      .filter((cells) => (cells[col('FrameCompleted')] ?? 0) > 0);
    const slowestPerVsync = new Map<number, number[]>();
    for (const cells of rows) {
      const vsync = cells[col('IntendedVsync')] ?? 0;
      const duration = (cells[col('FrameCompleted')] ?? 0) - vsync;
      const existing = slowestPerVsync.get(vsync);
      if (!existing || duration > (existing[col('FrameCompleted')] ?? 0) - vsync)
        slowestPerVsync.set(vsync, cells);
    }
    const deadlinesMs = rows.map(
      (cells) => ((cells[col('FrameDeadline')] ?? 0) - (cells[col('IntendedVsync')] ?? 0)) / 1e6,
    );
    expect(Math.min(...deadlinesMs)).toBeCloseTo(16.67, 1);
    expect(Math.max(...deadlinesMs)).toBeGreaterThan(400);
    const expectedJank = [...slowestPerVsync.values()].filter(
      (cells) => (cells[col('FrameCompleted')] ?? 0) > (cells[col('FrameDeadline')] ?? 0),
    ).length;

    const sample = primed(0).ingest(parseFramestats(text), 1000, 300);
    expect(sample?.frameIntervalSource).toBe('reported');
    expect(sample?.jankCount).toBe(expectedJank);
    expect(sample?.slowCount).toBeGreaterThan(sample?.jankCount ?? Infinity);
    expect(sample?.frameCount).toBe(slowestPerVsync.size);
  });

  it('handles real fixtures: before-reset stale dump primes, after-reset dump produces the sample', () => {
    const aggregator = primed(300.44, parseFramestats(fixture('gfxinfo-framestats.txt')).frames);
    const sample = aggregator.ingest(
      parseFramestats(fixture('gfxinfo-framestats-after-reset.txt')),
      1000,
      300.83,
    );
    // 7 rows, but vsyncs 300513501023 / 300663501017 / 300696834349 are rendered by both windows.
    expect(sample?.frameCount).toBe(4);
    expect(sample?.frameIntervalMs).toBe(16.67);
    expect(sample?.slowCount).toBe(4);
    expect(sample?.fps).toBeCloseTo(4 / 0.39, 1);
    expect(sample?.maxMs).toBeCloseTo((300733887392 - 300513501023) / 1e6, 2);
  });
});

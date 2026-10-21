import { describe, expect, it } from 'vitest';
import {
  buildAligned,
  buildBreakdownData,
  frameFeed,
  frameSourceOf,
  latestBreakdownInterval,
  buildCpuData,
  buildFrameRateData,
  buildFrameTimeData,
  budgetLabel,
  buildMemoryData,
  DEFAULT_FRAME_INTERVAL_MS,
  isFrameIntervalAssumed,
  jankPerSecond,
  lastIndexAtOrBefore,
  lastValueFrom,
  latestFrameInterval,
  memoryOtherKb,
  niceCeil,
  slowCountOf,
  slowPerSecond,
} from '../src/lib/series.ts';
import { breakdown, cpu, frame, memory, T0 } from './fixtures.ts';

const sec = (ms: number) => ms / 1000;

describe('buildAligned', () => {
  it('converts timestamps to seconds and picks one column per accessor', () => {
    const data = buildAligned([{ ts: T0 }, { ts: T0 + 1000 }], 1000, [(s) => s.ts % 7, () => null]);
    expect(data[0]).toEqual([sec(T0), sec(T0 + 1000)]);
    expect(data[1]).toEqual([T0 % 7, (T0 + 1000) % 7]);
    expect(data[2]).toEqual([null, null]);
  });

  it('inserts a null row in the middle of gaps longer than 3.5 intervals', () => {
    const data = buildAligned([{ ts: T0 }, { ts: T0 + 3000 }, { ts: T0 + 10_000 }], 1000, [() => 1]);
    expect(data[0]).toEqual([sec(T0), sec(T0 + 3000), sec(T0 + 6500), sec(T0 + 10_000)]);
    expect(data[1]).toEqual([1, 1, null, 1]);
  });

  it('returns empty columns for no samples', () => {
    expect(buildAligned([], 1000, [() => 1])).toEqual([[], []]);
  });
});

describe('buildCpuData', () => {
  it('uses normalized or single-core percent', () => {
    const samples = [cpu(T0, 12.5)];
    expect(buildCpuData(samples, 'normalized')[1]).toEqual([12.5]);
    expect(buildCpuData(samples, 'singleCore')[1]).toEqual([100]);
  });
});

describe('buildMemoryData', () => {
  it('produces cumulative paint-order columns in MB plus raw legend columns', () => {
    const s = memory(T0);
    const { data, raw } = buildMemoryData([s]);
    const mb = (kb: number) => kb / 1024;
    const native = mb(s.nativeHeapKb);
    const java = mb(s.javaHeapKb);
    const graphics = mb(s.graphicsKb);
    const code = mb(s.codeKb);
    const other = mb(memoryOtherKb(s));
    expect(data[0]).toEqual([sec(T0)]);
    expect(data[1]).toEqual([native + java + graphics + code + other]);
    expect(data[2]).toEqual([native + java + graphics + code]);
    expect(data[3]).toEqual([native + java + graphics]);
    expect(data[4]).toEqual([native + java]);
    expect(data[5]).toEqual([native]);
    expect(data[6]).toEqual([mb(s.totalPssKb)]);
    expect(raw).toEqual([[native], [java], [graphics], [code], [other], [mb(s.totalPssKb)]]);
  });

  it('counts private other, stack and system as Other', () => {
    expect(memoryOtherKb(memory(T0, { privateOtherKb: 1, stackKb: 2, systemKb: 3 }))).toBe(6);
  });

  it('breaks memory lines on gaps longer than 3.5 × 3 s', () => {
    const { data, raw } = buildMemoryData([memory(T0), memory(T0 + 30_000)]);
    expect(data[0]).toHaveLength(3);
    expect(data[1]?.[1]).toBeNull();
    expect(raw[0]?.[1]).toBeNull();
  });
});

describe('frames', () => {
  it('scales jank count to janky frames per second', () => {
    expect(jankPerSecond(frame(T0, { frameCount: 30, jankCount: 3, fps: 60 }))).toBe(6);
    expect(jankPerSecond(frame(T0, { frameCount: 0, jankCount: 0, fps: 0 }))).toBe(0);
    expect(jankPerSecond(frame(T0, { jankCount: 0 }))).toBe(0);
  });

  it('builds [x, slow/s, jank/s, fps] in paint order (slow under janky under the line)', () => {
    const data = buildFrameRateData([frame(T0, { fps: 58, frameCount: 58, jankCount: 2, slowCount: 5 })]);
    expect(data).toEqual([[sec(T0)], [5], [2], [58]]);
  });

  it('tolerates samples from servers without slowCount, and never shows slow < janky', () => {
    const legacy = { ...frame(T0, { jankCount: 4 }) } as Partial<ReturnType<typeof frame>>;
    delete legacy.slowCount;
    const sample = legacy as ReturnType<typeof frame>;
    expect(slowCountOf(sample)).toBe(4);
    expect(slowPerSecond(sample)).toBe(jankPerSecond(sample));
    expect(slowPerSecond(frame(T0, { jankCount: 6, slowCount: 2, frameCount: 60, fps: 60 }))).toBe(6);
    expect(slowPerSecond(frame(T0, { frameCount: 0 }))).toBe(0);
  });

  it('flags the budget as assumed only when the server says it used the default', () => {
    expect(isFrameIntervalAssumed([])).toBe(true);
    expect(isFrameIntervalAssumed([frame(T0)])).toBe(false);
    expect(isFrameIntervalAssumed([frame(T0, { frameIntervalSource: 'inferred' })])).toBe(false);
    expect(isFrameIntervalAssumed([frame(T0, { frameIntervalSource: 'default' })])).toBe(true);
    const legacy = { ...frame(T0) } as Partial<ReturnType<typeof frame>>;
    delete legacy.frameIntervalSource;
    expect(isFrameIntervalAssumed([legacy as ReturnType<typeof frame>])).toBe(false);
    expect(budgetLabel(16.667, true)).toBe('16.7 ms budget (assumed)');
    expect(budgetLabel(8.33, false)).toBe('8.3 ms budget');
  });

  it('builds percentiles and nulls them when no frame was drawn', () => {
    const data = buildFrameTimeData([frame(T0), frame(T0 + 1000, { frameCount: 0 })]);
    expect(data[1]).toEqual([8, null]);
    expect(data[2]).toEqual([14, null]);
    expect(data[3]).toEqual([40, null]);
  });

  it('reads the newest positive frame interval, defaulting to 60 Hz', () => {
    expect(latestFrameInterval([])).toBe(DEFAULT_FRAME_INTERVAL_MS);
    expect(
      latestFrameInterval([frame(T0, { frameIntervalMs: 8.33 }), frame(T0 + 1, { frameIntervalMs: 0 })]),
    ).toBe(8.33);
  });
});

describe('lookup helpers', () => {
  it('lastIndexAtOrBefore binary-searches ascending xs', () => {
    const xs = [1, 2, 4, 8];
    expect(lastIndexAtOrBefore(xs, 0)).toBe(-1);
    expect(lastIndexAtOrBefore(xs, 1)).toBe(0);
    expect(lastIndexAtOrBefore(xs, 5)).toBe(2);
    expect(lastIndexAtOrBefore(xs, 100)).toBe(3);
    expect(lastIndexAtOrBefore([], 1)).toBe(-1);
  });

  it('lastValueFrom skips a few trailing nulls', () => {
    expect(lastValueFrom([1, null, null], 2)).toBe(1);
    expect(lastValueFrom([1, null, null, null], 3)).toBeNull();
    expect(lastValueFrom(undefined, 0)).toBeNull();
    expect(lastValueFrom([5], -1)).toBeNull();
  });

  it('niceCeil rounds up to 1 / 2 / 2.5 / 5 steps', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.3)).toBe(2);
    expect(niceCeil(2.2)).toBe(2.5);
    expect(niceCeil(37)).toBe(50);
    expect(niceCeil(86)).toBe(100);
    expect(niceCeil(512)).toBe(1000);
  });
});

describe('frame breakdown', () => {
  it('builds cumulative columns in paint order (full stack first, delay last) plus raw stages', () => {
    const { data, raw } = buildBreakdownData([
      breakdown(T0, 'a', {
        stages: {
          input: 1,
          animation: 0.5,
          layout: 2,
          draw: 3,
          sync: 0.25,
          command: 1,
          swap: 0.5,
          delay: 0.25,
          gpu: 4,
        },
      }),
    ]);
    expect(data).toHaveLength(1 + 9);
    expect(data[0]).toEqual([sec(T0)]);
    // Stack bottom → top is delay, input … swap, gpu: Σ all nine first, then without gpu, …, delay alone.
    expect(data.slice(1).map((c) => c[0])).toEqual([12.5, 8.5, 8, 7, 6.75, 3.75, 1.75, 1.25, 0.25]);
    expect(raw.map((c) => c[0])).toEqual([0.25, 1, 0.5, 2, 3, 0.25, 1, 0.5, 4, 12.5]);
  });

  it('nulls buckets without frames, clamps bad stage values and breaks on gaps over 1.75 s', () => {
    const { data, raw } = buildBreakdownData([
      breakdown(T0, 'a', { stages: { draw: -1, layout: Number.NaN, command: 2 } }),
      breakdown(T0 + 500, 'a', { frameCount: 0 }),
      breakdown(T0 + 3000, 'a'),
    ]);
    expect(data[0]).toEqual([sec(T0), sec(T0 + 500), sec(T0 + 1750), sec(T0 + 3000)]);
    expect(raw[9]).toEqual([2, null, null, 6]);
    expect(data[9]?.[1]).toBeNull();
  });

  it('reads the frame source and the breakdown budget', () => {
    expect(frameSourceOf([])).toBe('gfxinfo');
    expect(frameSourceOf([frame(T0)])).toBe('gfxinfo');
    expect(frameSourceOf([frame(T0), frame(T0 + 1000, { source: 'sdk' })])).toBe('sdk');
    expect(latestBreakdownInterval([])).toBe(DEFAULT_FRAME_INTERVAL_MS);
    expect(latestBreakdownInterval([breakdown(T0, 'a', { frameIntervalMs: 8.33 })])).toBe(8.33);
  });
});

describe('frameFeed', () => {
  const sdkFrame = (ts: number, frameCount = 30) => frame(ts, { source: 'sdk', frameCount });

  it('follows the newest sample while no SDK is linked', () => {
    expect(frameFeed([frame(T0)], false)).toEqual({ source: 'gfxinfo', isSdkIdle: false });
    expect(frameFeed([sdkFrame(T0)], false)).toEqual({ source: 'sdk', isSdkIdle: false });
  });

  it('stays on the SDK while linked: idle after 3 s of empty buckets or a gfxinfo fallback', () => {
    expect(frameFeed([sdkFrame(T0)], true)).toEqual({ source: 'sdk', isSdkIdle: false });
    // One empty bucket right after frames is not idle yet: no flapping mid-scroll.
    expect(frameFeed([sdkFrame(T0), sdkFrame(T0 + 500, 0)], true)).toEqual({
      source: 'sdk',
      isSdkIdle: false,
    });
    expect(frameFeed([sdkFrame(T0), sdkFrame(T0 + 3500, 0)], true)).toEqual({
      source: 'sdk',
      isSdkIdle: true,
    });
    expect(frameFeed([sdkFrame(T0), frame(T0 + 4000, { frameCount: 0 })], true)).toEqual({
      source: 'sdk',
      isSdkIdle: true,
    });
    expect(frameFeed([], true)).toEqual({ source: 'sdk', isSdkIdle: true });
  });
});

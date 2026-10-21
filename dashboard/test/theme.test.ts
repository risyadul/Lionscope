import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_SPEC,
  CPU_SINGLE_CORE_SPEC,
  CPU_SPEC,
  FRAME_RATE_SPEC,
  FRAME_TIME_SPEC,
  MEMORY_SPEC,
  SLOW_TINT,
  STALL_RAIL_PX,
  STALL_SPEC,
  stallTick,
} from '../src/components/timeline/chartSpec.ts';
import { eventLabel, identityColor, placeLabels } from '../src/components/timeline/marks.ts';
import {
  buildBreakdownData,
  buildCpuData,
  buildFrameRateData,
  buildFrameTimeData,
  buildMemoryData,
} from '../src/lib/series.ts';
import { breakdown, cpu, frame, memory } from './fixtures.ts';
import { FALLBACK_COLORS, mixHex, readChartTheme, withAlpha } from '../src/lib/theme.ts';

describe('color helpers', () => {
  it('mixHex interpolates in sRGB and clamps t', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#fff', '#000', 0)).toBe('#ffffff');
    expect(mixHex('#2a78d6', '#fbfbfc', 2)).toBe('#fbfbfc');
    expect(mixHex('rgb(0,0,0)', '#fff', 0.5)).toBe('rgb(0,0,0)');
  });

  it('withAlpha converts hex to rgba', () => {
    expect(withAlpha('#2a78d6', 0.1)).toBe('rgba(42, 120, 214, 0.1)');
    expect(withAlpha('red', 0.1)).toBe('red');
  });

  it('readChartTheme reads tokens and falls back for missing ones', () => {
    const theme = readChartTheme((token) => (token === '--viz-cpu' ? ' #123456 ' : ''));
    expect(theme.colors.cpu).toBe('#123456');
    expect(theme.colors.surface).toBe(FALLBACK_COLORS.surface);
    expect(theme.fontMono).toContain('IBM Plex Mono');
  });

  it('reads the screen wash opacity, rejecting values outside 0–1', () => {
    expect(readChartTheme((t) => (t === '--viz-screen-wash' ? ' 0.085 ' : '')).screenWash).toBe(0.085);
    expect(readChartTheme(() => '').screenWash).toBe(0.06);
    expect(readChartTheme((t) => (t === '--viz-screen-wash' ? '4' : '')).screenWash).toBe(0.06);
  });
});

describe('chart specs', () => {
  it('CPU is pinned to 0–100 % unless shown per core', () => {
    expect(CPU_SPEC.yRange(null, [])).toEqual([0, 100]);
    expect(CPU_SINGLE_CORE_SPEC.yRange(50, [])).toEqual([0, 100]);
    expect(CPU_SINGLE_CORE_SPEC.yRange(310, [])).toEqual([0, 500]);
    expect(CPU_SPEC.yTick(50)).toBe('50%');
  });

  it('memory ceilings are nice numbers', () => {
    expect(MEMORY_SPEC.yRange(null, [])).toEqual([0, 1]);
    expect(MEMORY_SPEC.yRange(180, [])).toEqual([0, 200]);
  });

  it('frame rate keeps at least a 60 fps ceiling and snaps to 30', () => {
    expect(FRAME_RATE_SPEC.yRange(null, [])).toEqual([0, 60]);
    expect(FRAME_RATE_SPEC.yRange(118, [])).toEqual([0, 150]);
  });

  it('frame time always leaves room above the vsync budget', () => {
    expect(FRAME_TIME_SPEC.yRange(5, [{ value: 16.67, label: '' }])).toEqual([0, 16.67 * 2.5]);
    expect(FRAME_TIME_SPEC.yRange(90, [{ value: 16.67, label: '' }])).toEqual([0, 200]);
    expect(FRAME_TIME_SPEC.yRange(null, [])[1]).toBeCloseTo(41.75);
  });

  it('memory paint order matches the cumulative columns and jank uses its own hue', () => {
    expect(MEMORY_SPEC.series.map((s) => s.label)).toEqual([
      'Other',
      'Code',
      'Graphics',
      'Java',
      'Native',
      'Total PSS',
    ]);
    const theme = readChartTheme(() => '');
    expect(identityColor(FRAME_RATE_SPEC.series[0]!, theme)).toBe(FALLBACK_COLORS.jank);
    expect(identityColor(CPU_SPEC.series[0]!, theme)).toBe(FALLBACK_COLORS.cpu);
    expect(identityColor({ label: 'x' }, theme)).toBe(FALLBACK_COLORS.ink);
  });

  it('frame breakdown leaves headroom over the budget but caps outliers at 3× budget', () => {
    const budget = [{ value: 16.67, label: '' }];
    expect(BREAKDOWN_SPEC.yRange(4, budget)).toEqual([0, 16.67 * 1.5]);
    expect(BREAKDOWN_SPEC.yRange(30, budget)).toEqual([0, 50]);
    expect(BREAKDOWN_SPEC.yRange(400, budget)).toEqual([0, 50]);
    expect(BREAKDOWN_SPEC.series.map((s) => s.label)[0]).toBe('GPU');
    // Delay happens before the frame starts, so it sits at the bottom of the stack (painted last).
    expect(BREAKDOWN_SPEC.series.at(-1)?.label).toBe('Delay');
    expect(BREAKDOWN_SPEC.marksClipped).toBe(true);
  });

  it('labels timeline events', () => {
    expect(eventLabel({ ts: 0, kind: 'process_start', pid: 42 })).toBe('START 42');
    expect(eventLabel({ ts: 0, kind: 'process_restart', pid: 43 })).toBe('RESTART 43');
    expect(eventLabel({ ts: 0, kind: 'process_died', pid: null })).toBe('DIED');
  });
});

describe('spec ↔ data contract', () => {
  it('each spec has one series per data column, with jank as the bar series', () => {
    const frames = [frame(0)];
    expect(CPU_SPEC.series).toHaveLength(buildCpuData([cpu(0)], 'normalized').length - 1);
    expect(MEMORY_SPEC.series).toHaveLength(buildMemoryData([memory(0)]).data.length - 1);
    expect(FRAME_RATE_SPEC.series).toHaveLength(buildFrameRateData(frames).length - 1);
    expect(FRAME_TIME_SPEC.series).toHaveLength(buildFrameTimeData(frames).length - 1);
    expect(BREAKDOWN_SPEC.series).toHaveLength(buildBreakdownData([breakdown(0, 'a')]).data.length - 1);
    const [, slowColumn, jankColumn] = buildFrameRateData([
      frame(0, { frameCount: 10, jankCount: 2, slowCount: 5, fps: 10 }),
    ]);
    expect(FRAME_RATE_SPEC.series[0]).toMatchObject({ bars: true, fill: 'jank', fillMix: SLOW_TINT });
    expect(slowColumn).toEqual([5]);
    expect(FRAME_RATE_SPEC.series[1]).toMatchObject({ bars: true, fill: 'jank' });
    expect(FRAME_RATE_SPEC.series[1]?.fillMix).toBeUndefined();
    expect(jankColumn).toEqual([2]);
  });
});

describe('placeLabels', () => {
  it('stacks overlapping labels into rows and flips at the right edge', () => {
    const boxes = placeLabels(
      [
        { x: 10, width: 50 },
        { x: 40, width: 50 },
        { x: 70, width: 20 },
        { x: 95, width: 20 },
        { x: 190, width: 30 },
      ],
      200,
      4,
    );
    expect(boxes).toEqual([
      { left: 10, row: 0 },
      { left: 40, row: 1 },
      { left: 70, row: 0 },
      { left: 95, row: 0 },
      { left: 160, row: 0 },
    ]);
  });

  it('reuses the last row once maxRows is reached', () => {
    const boxes = placeLabels(
      [0, 1, 2, 3].map((x) => ({ x, width: 50 })),
      500,
      0,
      2,
    );
    expect(boxes.map((b) => b.row)).toEqual([0, 1, 1, 1]);
  });
});

describe('stall lane spec', () => {
  const threshold = [{ value: 150, label: '' }];

  it('caps the scale and reserves a fixed-height rail under the baseline', () => {
    const [min, max] = STALL_SPEC.yRange(342, threshold, 100);
    expect(max).toBe(500);
    // Value 0 sits STALL_RAIL_PX above the bottom of a 100 px plot.
    expect(((0 - min) / (max - min)) * 100).toBeCloseTo(STALL_RAIL_PX);
    expect(STALL_SPEC.yRange(null, [], 0)[1]).toBe(500);
    expect(STALL_SPEC.yRange(40_000, threshold)[1]).toBe(2000);
  });

  it('ticks only at 0, half and the top, with seconds from 1 s', () => {
    expect(STALL_SPEC.ySplits?.(-80, 2000)).toEqual([0, 1000, 2000]);
    expect([0, 250, 1000, 1500].map(stallTick)).toEqual(['0', '250', '1s', '1.5s']);
  });
});

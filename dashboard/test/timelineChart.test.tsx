import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CPU_SPEC } from '../src/components/timeline/chartSpec.ts';
import { TimelineChart } from '../src/components/timeline/TimelineChart.tsx';
import type { Aligned } from '../src/lib/series.ts';
import { createSignal } from '../src/lib/signal.ts';
import { readChartTheme } from '../src/lib/theme.ts';
import { plots, resetPlots } from './uplotMock.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});
beforeEach(() => resetPlots());
afterEach(() => cleanup());

const theme = readChartTheme(() => '');
const probeTs = createSignal<number | null>(null);

function chart(data: Aligned, xMin: number, xMax: number, themeOverride = theme, showTimeAxis = true) {
  return (
    <TimelineChart
      spec={CPU_SPEC}
      theme={themeOverride}
      data={data}
      xMin={xMin}
      xMax={xMax}
      events={[]}
      showTimeAxis={showTimeAxis}
      showEventLabels={false}
      probeTs={probeTs}
      onCursor={() => {}}
    />
  );
}

describe('TimelineChart', () => {
  it('creates the plot once, pushes data with setData and destroys it on unmount', () => {
    const view = render(chart([[1], [10]], 0, 60));
    expect(plots).toHaveLength(1);
    const plot = plots[0]!;
    expect(plot.data).toEqual([[1], [10]]);
    expect(plot.xRange()).toEqual([0, 60]);

    view.rerender(
      chart(
        [
          [1, 2],
          [10, 20],
        ],
        30,
        90,
      ),
    );
    expect(plots).toHaveLength(1);
    expect(plot.setDataCalls).toBeGreaterThanOrEqual(1);
    expect(plot.data).toEqual([
      [1, 2],
      [10, 20],
    ]);
    expect(plot.xRange()).toEqual([30, 90]);

    view.unmount();
    expect(plot.destroyed).toBe(true);
  });

  it('moving the time axis re-lays out the same plot instead of re-creating it', () => {
    const view = render(chart([[1], [10]], 0, 60));
    const plot = plots[0]!;
    let resized = 0;
    const setSize = plot.setSize.bind(plot);
    plot.setSize = (size) => {
      resized++;
      setSize(size);
    };
    view.rerender(chart([[1], [10]], 0, 60, theme, false));
    expect(plots).toHaveLength(1);
    expect(plot.destroyed).toBe(false);
    expect(resized).toBe(1);
    view.rerender(chart([[1], [10]], 0, 60, theme, false));
    expect(resized).toBe(1);
  });

  it('recreates the plot when the theme changes (color-scheme flip)', () => {
    const view = render(chart([[1], [10]], 0, 60));
    const dark = readChartTheme((token) => (token === '--surface' ? '#13161b' : ''));
    view.rerender(chart([[1], [10]], 0, 60, dark));
    expect(plots).toHaveLength(2);
    expect(plots[0]?.destroyed).toBe(true);
    expect(plots[1]?.destroyed).toBe(false);
  });
});

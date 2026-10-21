/**
 * Stand-in for uPlot (jsdom has no canvas). Records lifecycle calls so tests can assert on
 * creation, data pushes, destruction and the x window the chart would draw.
 * Use with: vi.mock('uplot', () => import('./uplotMock.ts')).
 */
type RangeFn = (self: unknown, min: number, max: number, key: string) => [number, number];

interface FakeOptions {
  width: number;
  height: number;
  scales?: { x?: { range?: RangeFn } };
}

export const plots: FakePlot[] = [];

export function resetPlots(): void {
  plots.length = 0;
}

export default class FakePlot {
  static paths = { bars: () => () => null };
  static pxRatio = 1;

  readonly over = document.createElement('div');
  readonly hooks: { draw: Array<() => void> } = { draw: [] };
  readonly opts: FakeOptions;
  data: unknown;
  width: number;
  height: number;
  setDataCalls = 0;
  destroyed = false;

  constructor(opts: FakeOptions, data: unknown, host: HTMLElement) {
    this.opts = opts;
    this.data = data;
    this.width = opts.width;
    this.height = opts.height;
    host.appendChild(this.over);
    plots.push(this);
  }

  setData(data: unknown): void {
    this.data = data;
    this.setDataCalls++;
  }

  setSize(size: { width: number; height: number }): void {
    this.width = size.width;
    this.height = size.height;
  }

  redraw(): void {}

  valToPos(): number {
    return 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.over.remove();
  }

  /** The x window (epoch seconds) the real chart would draw right now. */
  xRange(): [number, number] {
    const range = this.opts.scales?.x?.range;
    if (!range) throw new Error('chart has no x range function');
    return range(this, 0, 0, 'x');
  }
}

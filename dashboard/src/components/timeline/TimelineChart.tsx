import { useLayoutEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TimelineEvent } from '@lionscope/protocol/wire';
import type { Aligned } from '../../lib/series.ts';
import type { Signal } from '../../lib/signal.ts';
import type { ChartTheme } from '../../lib/theme.ts';
import type { ChartSpec, Threshold } from './chartSpec.ts';
import { buildOptions, type Backdrop, type LiveInputs } from './uplotOptions.ts';

const FALLBACK_SIZE = { width: 480, height: 120 };
const NO_THRESHOLDS: readonly Threshold[] = [];

type Props = {
  spec: ChartSpec;
  theme: ChartTheme;
  data: Aligned;
  /** Visible x range, epoch seconds. */
  xMin: number;
  xMax: number;
  /** Active-screen tint behind the data. */
  backdrop?: Backdrop | null;
  events: readonly TimelineEvent[];
  thresholds?: readonly Threshold[];
  showTimeAxis: boolean;
  showEventLabels: boolean;
  /** Epoch ms to mark with a probe line (log row hover). */
  probeTs: Signal<number | null>;
  onCursor: (idx: number | null, x: number | null) => void;
};

function hostSize(host: HTMLElement): { width: number; height: number } {
  const width = Math.floor(host.clientWidth);
  const height = Math.floor(host.clientHeight);
  return width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE;
}

/**
 * A canvas lane on the shared timeline. The uPlot instance is created once per spec/theme;
 * data and the x window are pushed with `setData`, so React never re-creates the canvas.
 */
export function TimelineChart({
  spec,
  theme,
  data,
  xMin,
  xMax,
  backdrop = null,
  events,
  thresholds = NO_THRESHOLDS,
  showTimeAxis,
  showEventLabels,
  probeTs,
  onCursor,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef<Aligned>(data);
  const liveRef = useRef<LiveInputs>({
    xMin,
    xMax,
    backdrop,
    events,
    thresholds,
    showTimeAxis,
    showEventLabels,
    onCursor,
  });

  // Push new inputs into the existing plot. Declared before the creation effect so the
  // refs are current when the plot is first built.
  useLayoutEffect(() => {
    const axisMoved = liveRef.current.showTimeAxis !== showTimeAxis;
    liveRef.current = { xMin, xMax, backdrop, events, thresholds, showTimeAxis, showEventLabels, onCursor };
    dataRef.current = data;
    const plot = plotRef.current;
    if (!plot) return;
    // setSize re-runs uPlot's axis/padding layout, which reads `showTimeAxis` from the live ref.
    if (axisMoved) plot.setSize({ width: plot.width, height: plot.height });
    plot.setData(data);
  }, [data, xMin, xMax, backdrop, events, thresholds, showTimeAxis, showEventLabels, onCursor]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { width, height } = hostSize(host);
    const plot = new uPlot(
      buildOptions({ spec, theme, width, height, live: liveRef }),
      dataRef.current,
      host,
    );
    plotRef.current = plot;

    const probe = document.createElement('div');
    probe.className = 'lane-probe';
    plot.over.appendChild(probe);
    const placeProbe = () => {
      const ts = probeTs.get();
      const left = ts === null ? -1 : plot.valToPos(ts / 1000, 'x');
      const visible = ts !== null && left >= 0 && left <= plot.over.clientWidth;
      probe.style.opacity = visible ? '1' : '0';
      if (visible) probe.style.transform = `translateX(${Math.round(left)}px)`;
    };
    plot.hooks.draw?.push(placeProbe);
    const unsubscribeProbe = probeTs.subscribe(placeProbe);

    const resize = new ResizeObserver(() => {
      const next = hostSize(host);
      if (next.width !== plot.width || next.height !== plot.height) plot.setSize(next);
    });
    resize.observe(host);

    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) plot.redraw(false, true);
    });

    return () => {
      disposed = true;
      resize.disconnect();
      unsubscribeProbe();
      plot.destroy();
      plotRef.current = null;
    };
  }, [spec, theme, probeTs]);

  return <div ref={hostRef} className="lane-plot" aria-hidden="true" />;
}

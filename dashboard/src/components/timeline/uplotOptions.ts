/** Builds uPlot options from a `ChartSpec` + theme. Mutable inputs are read through `live` at draw time. */
import uPlot from 'uplot';
import type { ScreenSpan, TimelineEvent } from '@lionscope/protocol/wire';
import { formatClockShort } from '../../lib/format.ts';
import { firstSpanEndingAfter, screenColor, spanEnd } from '../../lib/screens.ts';
import { mixHex, withAlpha, type ChartTheme } from '../../lib/theme.ts';
import type { ChartSpec, SeriesSpec, Threshold } from './chartSpec.ts';
import { eventLabel, identityColor, placeLabels } from './marks.ts';

export const SYNC_KEY = 'lionscope-timeline';
/** Fixed y-axis gutter so every lane's plot area starts at the same x. */
export const Y_AXIS_WIDTH = 52;
export const RIGHT_PAD = 14;
const TIME_AXIS_HEIGHT = 26;

/** Active-screen tint painted behind a lane's data, so a spike lines up with its screen. */
export interface Backdrop {
  spans: readonly ScreenSpan[];
  /** Where the open (current) span ends, epoch ms. */
  openEnd: number;
  /** Selected screen name: its spans tint stronger, the rest recede. */
  selected: string | null;
}

/** Selected spans tint this much stronger; the others keep this share of the wash. */
const SELECTED_WASH_GAIN = 2.2;
const UNSELECTED_WASH_SHARE = 0.4;

export interface LiveInputs {
  xMin: number;
  xMax: number;
  backdrop: Backdrop | null;
  events: readonly TimelineEvent[];
  thresholds: readonly Threshold[];
  /** Read at layout time, so moving the time axis to another lane never re-creates a plot. */
  showTimeAxis: boolean;
  showEventLabels: boolean;
  onCursor: (idx: number | null, x: number | null) => void;
}

function strokeOf(spec: SeriesSpec, theme: ChartTheme): string | undefined {
  const c = theme.colors;
  if (spec.surfaceGap) return c.surface;
  if (!spec.stroke) return undefined;
  const base = c[spec.stroke];
  return spec.strokeMix ? mixHex(base, c.surface, spec.strokeMix) : base;
}

function fillOf(spec: SeriesSpec, theme: ChartTheme): string | undefined {
  if (!spec.fill) return undefined;
  const base = theme.colors[spec.fill];
  if (spec.fillMix !== undefined) return mixHex(base, theme.colors.surface, spec.fillMix);
  if (spec.fillAlpha !== undefined) return withAlpha(base, spec.fillAlpha);
  return base;
}

function buildSeries(spec: SeriesSpec, theme: ChartTheme): uPlot.Series {
  const stroke = strokeOf(spec, theme);
  const fill = fillOf(spec, theme);
  const series: uPlot.Series = {
    label: spec.label,
    width: stroke ? (spec.width ?? 1.5) : 0,
    points: { show: false },
    spanGaps: false,
    auto: spec.auto ?? true,
  };
  if (stroke) series.stroke = stroke;
  if (fill) series.fill = fill;
  if (spec.bars) {
    const bars = uPlot.paths.bars;
    if (bars) {
      const [factor, maxPx, minPx] = spec.barSize ?? [0.72, 12, 1];
      series.paths = bars({ size: [factor, maxPx, minPx], radius: [0.3, 0], gap: spec.barGap ?? 1 });
    }
  }
  return series;
}

function drawEvents(u: uPlot, live: LiveInputs, theme: ChartTheme): void {
  if (live.events.length === 0) return;
  const { ctx, bbox } = u;
  const px = uPlot.pxRatio;
  ctx.save();
  ctx.strokeStyle = theme.colors.event;
  ctx.lineWidth = Math.max(1, Math.round(px));
  ctx.font = `600 ${Math.round(9.5 * px)}px ${theme.fontMono}`;
  // uPlot leaves axis text state on the context; reset it explicitly.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const visible: { x: number; text: string; width: number }[] = [];
  const padX = 4 * px;
  for (const event of live.events) {
    const x = Math.round(u.valToPos(event.ts / 1000, 'x', true)) + 0.5;
    if (x < bbox.left || x > bbox.left + bbox.width) continue;
    ctx.beginPath();
    ctx.moveTo(x, bbox.top);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
    const text = eventLabel(event);
    visible.push({ x, text, width: ctx.measureText(text).width + padX * 2 });
  }
  if (live.showEventLabels) {
    const h = 14 * px;
    const boxes = placeLabels(visible, bbox.left + bbox.width, 3 * px);
    visible.forEach((label, i) => {
      const box = boxes[i];
      if (!box) return;
      const top = bbox.top + box.row * (h + 2 * px);
      ctx.fillStyle = theme.colors.event;
      ctx.fillRect(box.left, top, label.width, h);
      ctx.fillStyle = theme.colors.surface;
      ctx.fillText(label.text, box.left + padX, top + 2.5 * px);
    });
  }
  ctx.restore();
}

interface WashRun {
  x0: number;
  x1: number;
  fill: string;
}

function drawBackdrop(u: uPlot, live: LiveInputs, theme: ChartTheme): void {
  const backdrop = live.backdrop;
  if (backdrop === null || backdrop.spans.length === 0) return;
  const { ctx, bbox } = u;
  const px = uPlot.pxRatio;
  const right = bbox.left + bbox.width;
  const toTs = live.xMax * 1000;
  const edges: { x: number; color: string }[] = [];
  // Held in an object: TypeScript doesn't track assignments made inside `flush`.
  const pending: { run: WashRun | null } = { run: null };
  const flush = () => {
    const run = pending.run;
    if (run) ctx.fillRect(run.x0, bbox.top, run.x1 - run.x0, bbox.height);
    pending.run = null;
  };
  ctx.save();
  const first = firstSpanEndingAfter(backdrop.spans, live.xMin * 1000, backdrop.openEnd);
  for (let i = first; i < backdrop.spans.length; i++) {
    const span = backdrop.spans[i];
    if (span === undefined || span.start >= toTs) break;
    const name = span.screen?.name;
    if (name === undefined) {
      flush();
      continue;
    }
    const raw0 = u.valToPos(span.start / 1000, 'x', true);
    const raw1 = u.valToPos(spanEnd(span, backdrop.openEnd) / 1000, 'x', true);
    const x0 = Math.max(bbox.left, raw0);
    const x1 = Math.min(right, raw1);
    if (x1 <= x0) continue;
    const color = theme.colors[screenColor(name)];
    const isSelected = backdrop.selected === name;
    const gain = backdrop.selected === null ? 1 : isSelected ? SELECTED_WASH_GAIN : UNSELECTED_WASH_SHARE;
    const fill = withAlpha(color, Math.min(1, theme.screenWash * gain));
    const current = pending.run;
    if (current !== null && x0 - current.x1 < 0.5 && (current.fill === fill || x1 - x0 < px)) {
      // Same wash continues, or a sub-pixel span: extend the run instead of painting slivers.
      current.x1 = Math.max(current.x1, x1);
    } else {
      flush();
      ctx.fillStyle = fill;
      pending.run = { x0, x1, fill };
    }
    if (isSelected) {
      // Hairline edges line the selected screen up across lanes; a clipped edge isn't a boundary.
      const edgeColor = withAlpha(color, 0.55);
      if (raw0 >= bbox.left) edges.push({ x: Math.round(raw0), color: edgeColor });
      if (raw1 <= right) edges.push({ x: Math.round(raw1) - Math.max(1, Math.round(px)), color: edgeColor });
    }
  }
  flush();
  const w = Math.max(1, Math.round(px));
  for (const edge of edges) {
    ctx.fillStyle = edge.color;
    ctx.fillRect(edge.x, bbox.top, w, bbox.height);
  }
  ctx.restore();
}

/** A small ink caret at the top edge over every bar that runs past the y range. */
function drawClipMarks(u: uPlot, theme: ChartTheme): void {
  const xs = u.data[0];
  const top = u.data[1];
  const max = u.scales.y?.max;
  if (!top || max === undefined || max === null) return;
  const { ctx, bbox } = u;
  const px = uPlot.pxRatio;
  const half = 3 * px;
  const depth = 4 * px;
  ctx.save();
  ctx.fillStyle = theme.colors.ink;
  ctx.strokeStyle = theme.colors.surface;
  ctx.lineWidth = px;
  for (let i = 0; i < xs.length; i++) {
    const value = top[i];
    const x0 = xs[i];
    if (value === null || value === undefined || x0 === undefined || value <= max) continue;
    const x = u.valToPos(x0, 'x', true);
    if (x < bbox.left || x > bbox.left + bbox.width) continue;
    ctx.beginPath();
    ctx.moveTo(x - half, bbox.top);
    ctx.lineTo(x + half, bbox.top);
    ctx.lineTo(x, bbox.top + depth);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}

function drawThresholds(u: uPlot, live: LiveInputs, theme: ChartTheme): void {
  if (live.thresholds.length === 0) return;
  const { ctx, bbox } = u;
  const px = uPlot.pxRatio;
  ctx.save();
  ctx.strokeStyle = theme.colors.threshold;
  ctx.lineWidth = Math.max(1, Math.round(px));
  ctx.setLineDash([4 * px, 3 * px]);
  ctx.font = `500 ${Math.round(9.5 * px)}px ${theme.fontMono}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  for (const threshold of live.thresholds) {
    const y = Math.round(u.valToPos(threshold.value, 'y', true)) + 0.5;
    if (y < bbox.top || y > bbox.top + bbox.height) continue;
    ctx.beginPath();
    ctx.moveTo(bbox.left, y);
    ctx.lineTo(bbox.left + bbox.width, y);
    ctx.stroke();
    const text = threshold.label;
    const w = ctx.measureText(text).width;
    const right = bbox.left + bbox.width - 4 * px;
    ctx.fillStyle = theme.colors.surface;
    ctx.fillRect(right - w - 3 * px, y - 13 * px, w + 6 * px, 12 * px);
    ctx.fillStyle = theme.colors.ink2;
    ctx.fillText(text, right, y - 2 * px);
  }
  ctx.restore();
}

export interface BuildOptionsInput {
  spec: ChartSpec;
  theme: ChartTheme;
  width: number;
  height: number;
  live: { current: LiveInputs };
}

export function buildOptions({ spec, theme, width, height, live }: BuildOptionsInput): uPlot.Options {
  const c = theme.colors;
  // Integer px only: uPlot rescales the size for HiDPI with /(\d+)px/, which breaks on "10.5px".
  const font = `500 11px ${theme.fontMono}`;
  const finite = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    width,
    height,
    legend: { show: false },
    padding: [10, RIGHT_PAD, () => (live.current.showTimeAxis ? 0 : 6), 0],
    series: [{}, ...spec.series.map((s) => buildSeries(s, theme))],
    bands: (spec.bands ?? []).map((b) => ({
      series: [b.upper, b.lower],
      fill: withAlpha(c[b.color], b.alpha),
    })),
    scales: {
      x: { time: true, range: () => [live.current.xMin, live.current.xMax] },
      y: {
        range: (_u, _min, max) => spec.yRange(finite(max), live.current.thresholds),
      },
    },
    axes: [
      {
        stroke: c.muted,
        font,
        size: () => (live.current.showTimeAxis ? TIME_AXIS_HEIGHT : 0),
        gap: 6,
        space: 96,
        grid: { stroke: c.grid, width: 1 },
        ticks: {
          stroke: c.axis,
          width: 1,
          size: 4,
          filter: (_u, splits) => (live.current.showTimeAxis ? splits : splits.map(() => null)),
        },
        border: { show: true, stroke: c.axis, width: 1 },
        values: (_u, splits) =>
          splits.map((v) => (live.current.showTimeAxis ? formatClockShort(v * 1000) : '')),
      },
      {
        stroke: c.muted,
        font,
        size: Y_AXIS_WIDTH,
        gap: 6,
        space: 22,
        grid: { stroke: c.grid, width: 1 },
        ticks: { show: false },
        values: (_u, splits) => splits.map((v) => spec.yTick(v)),
      },
    ],
    cursor: {
      y: false,
      sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] },
      drag: { x: false, y: false, setScale: false },
      focus: { prox: -1 },
      points: {
        size: (_u, i) => (spec.series[i - 1]?.hoverPoint ? 9 : 0),
        width: (_u, _i, size) => (size > 0 ? 2 : 0),
        stroke: () => c.surface,
        fill: (_u, i) => {
          const s = spec.series[i - 1];
          return s ? identityColor(s, theme) : c.ink;
        },
      },
    },
    hooks: {
      drawClear: [(u) => drawBackdrop(u, live.current, theme)],
      setCursor: [
        (u) => {
          const idx = u.cursor.idx ?? null;
          const left = u.cursor.left ?? -1;
          live.current.onCursor(idx, left >= 0 ? u.posToVal(left, 'x') : null);
        },
      ],
      draw: [
        (u) => {
          drawThresholds(u, live.current, theme);
          if (spec.marksClipped) drawClipMarks(u, theme);
          drawEvents(u, live.current, theme);
        },
      ],
    },
  };
}

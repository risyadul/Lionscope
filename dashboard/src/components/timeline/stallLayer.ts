/** Canvas marks for the Main thread lane: one bar per stall, StrictMode diamonds on the rail below. */
import uPlot from 'uplot';
import type { InflateSample } from '@lionscope/protocol/wire';
import { inflateKey } from '../../lib/layouts.ts';
import { MIN_BAR_PX, stallColor, type FeedItem } from '../../lib/stalls.ts';
import { mixHex, type ChartTheme } from '../../lib/theme.ts';
import { drawClipCaret, type MarkLayer } from './uplotOptions.ts';

export type StallItem = Extract<FeedItem, { kind: 'stall' }>;
export type ViolationItem = Extract<FeedItem, { kind: 'strictmode' }>;

export interface StallLayerInput {
  /** Ascending by `ts`. */
  stalls: readonly StallItem[];
  violations: readonly ViolationItem[];
  selectedKey: string | null;
  hoveredKey: string | null;
  /** Slow layout inflations (`maxMs` ≥ SLOW_INFLATE_MS), ascending by `ts`. */
  inflates: readonly InflateSample[];
  hoveredInflateKey: string | null;
}

/** Debugger stalls: a washed-out gray with 45° hatching, so a breakpoint never reads as app work. */
const DEBUG_FILL_MIX = 0.55;
const HATCH_SPACING_PX = 4;
const BAR_RADIUS_PX = 2;
const DIAMOND_RADIUS_PX = 4;
/** Inflation pills: a thin bar just under the baseline, drawn at least this wide. */
const INFLATE_PILL_PX = 5;
const INFLATE_PILL_OFFSET_PX = 3;
const INFLATE_MIN_WIDTH_PX = 4;

interface Box {
  x: number;
  top: number;
  width: number;
  height: number;
}

function fillBar(ctx: CanvasRenderingContext2D, box: Box, radius: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function' && radius > 0) {
    ctx.roundRect(box.x, box.top, box.width, box.height, [radius, radius, 0, 0]);
  } else {
    ctx.rect(box.x, box.top, box.width, box.height);
  }
  ctx.fill();
}

function hatch(ctx: CanvasRenderingContext2D, box: Box, color: string, px: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.top, box.width, box.height);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = px;
  ctx.beginPath();
  const bottom = box.top + box.height;
  for (let d = -box.height; d < box.width; d += HATCH_SPACING_PX * px) {
    ctx.moveTo(box.x + d, bottom);
    ctx.lineTo(box.x + d + box.height, box.top);
  }
  ctx.stroke();
  ctx.restore();
}

function outline(
  ctx: CanvasRenderingContext2D,
  box: Box,
  color: string,
  width: number,
  surface: string,
): void {
  ctx.save();
  ctx.lineWidth = width;
  // A surface halo first, so the ring stays legible against a neighbouring bar.
  ctx.strokeStyle = surface;
  ctx.strokeRect(box.x - width * 1.5, box.top - width * 1.5, box.width + width * 3, box.height + width * 1.5);
  ctx.strokeStyle = color;
  ctx.strokeRect(box.x - width / 2, box.top - width / 2, box.width + width, box.height + width / 2);
  ctx.restore();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function drawStalls(u: uPlot, input: StallLayerInput, theme: ChartTheme, base: number): void {
  const { ctx, bbox } = u;
  const c = theme.colors;
  const px = uPlot.pxRatio;
  const right = bbox.left + bbox.width;
  const yMax = u.scales.y?.max ?? Infinity;
  const minWidth = Math.round(MIN_BAR_PX * px);
  const gap = Math.max(1, Math.round(px));
  const highlights: { box: Box; isSelected: boolean }[] = [];
  const carets: number[] = [];
  let prevRight = -Infinity;

  for (const item of input.stalls) {
    const { ts, durationMs } = item.sample;
    const x0 = Math.round(u.valToPos(ts / 1000, 'x', true));
    const x1 = Math.round(u.valToPos((ts + durationMs) / 1000, 'x', true));
    const width = Math.max(minWidth, x1 - x0);
    if (x0 + width < bbox.left || x0 > right) continue;
    const isClipped = durationMs > yMax;
    const top = isClipped ? bbox.top : Math.round(u.valToPos(durationMs, 'y', true));
    const box: Box = { x: x0, top, width, height: Math.max(px, base - top) };
    const color = c[stallColor(item.sample)];
    const radius = Math.min(BAR_RADIUS_PX * px, width / 2);
    if (item.sample.debugger) {
      ctx.fillStyle = mixHex(color, c.surface, DEBUG_FILL_MIX);
      fillBar(ctx, box, radius);
      hatch(ctx, box, color, px);
    } else {
      ctx.fillStyle = color;
      fillBar(ctx, box, radius);
    }
    // Touching bars keep a surface gap between them instead of merging into one block.
    if (x0 <= prevRight) {
      ctx.fillStyle = c.surface;
      ctx.fillRect(x0, top, gap, box.height);
    }
    prevRight = x0 + width;
    if (isClipped) carets.push(x0 + width / 2);
    if (item.key === input.selectedKey) highlights.push({ box, isSelected: true });
    else if (item.key === input.hoveredKey) highlights.push({ box, isSelected: false });
  }
  for (const x of carets) drawClipCaret(ctx, x, bbox.top, theme);
  for (const { box, isSelected } of highlights) {
    outline(ctx, box, isSelected ? c.ink : c.ink2, (isSelected ? 1.5 : 1) * px, c.surface);
    if (isSelected) drawGuide(ctx, box, bbox.top, c.ink, px);
  }
}

/** A dashed ink guide above the selected bar, so a short one is still easy to find. */
function drawGuide(ctx: CanvasRenderingContext2D, box: Box, top: number, color: string, px: number): void {
  const x = Math.round(box.x + box.width / 2) + 0.5;
  const end = box.top - 4 * px;
  if (end <= top) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = px;
  ctx.setLineDash([2 * px, 2 * px]);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, end);
  ctx.stroke();
  ctx.restore();
}

function drawViolations(u: uPlot, input: StallLayerInput, theme: ChartTheme): void {
  const { ctx, bbox } = u;
  const c = theme.colors;
  const px = uPlot.pxRatio;
  const bottom = bbox.top + bbox.height;
  const r = DIAMOND_RADIUS_PX * px;
  // The lower row of the rail, under the inflation pills.
  const y = Math.round(bottom - r - 3 * px);
  const marked: { x: number; isSelected: boolean }[] = [];
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = c.surface;
  ctx.fillStyle = c.strictMode;
  for (const item of input.violations) {
    const x = Math.round(u.valToPos(item.ts / 1000, 'x', true));
    if (x < bbox.left - r || x > bbox.left + bbox.width + r) continue;
    diamond(ctx, x, y, r);
    ctx.stroke();
    ctx.fill();
    if (item.key === input.selectedKey) marked.push({ x, isSelected: true });
    else if (item.key === input.hoveredKey) marked.push({ x, isSelected: false });
  }
  for (const { x, isSelected } of marked) {
    ctx.lineWidth = (isSelected ? 1.5 : 1) * px;
    ctx.strokeStyle = isSelected ? c.ink : c.ink2;
    diamond(ctx, x, y, r + 2.5 * px);
    ctx.stroke();
  }
}

/** Slow inflations: gold pills spanning start..start+duration, on the rail row right under the baseline. */
function drawInflates(u: uPlot, input: StallLayerInput, theme: ChartTheme, base: number): void {
  const { ctx, bbox } = u;
  const c = theme.colors;
  const px = uPlot.pxRatio;
  const right = bbox.left + bbox.width;
  const top = base + Math.round(INFLATE_PILL_OFFSET_PX * px);
  const height = Math.round(INFLATE_PILL_PX * px);
  const minWidth = Math.round(INFLATE_MIN_WIDTH_PX * px);
  const gap = Math.max(1, Math.round(px));
  let prevRight = -Infinity;
  let hovered: Box | null = null;
  ctx.fillStyle = c.inflate;
  for (const item of input.inflates) {
    const x0 = Math.round(u.valToPos(item.ts / 1000, 'x', true));
    const x1 = Math.round(u.valToPos((item.ts + item.maxMs) / 1000, 'x', true));
    const width = Math.max(minWidth, x1 - x0);
    if (x0 + width < bbox.left || x0 > right) continue;
    // Touching pills keep a surface gap between them instead of merging into one bar.
    const x = x0 <= prevRight ? x0 + gap : x0;
    const box: Box = { x, top, width: Math.max(px, x0 + width - x), height };
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(box.x, box.top, box.width, box.height, 2 * px);
    else ctx.rect(box.x, box.top, box.width, box.height);
    ctx.fill();
    prevRight = x0 + width;
    if (inflateKey(item) === input.hoveredInflateKey) hovered = box;
  }
  if (hovered !== null) outline(ctx, hovered, c.ink2, px, c.surface);
}

export function createStallLayer(input: StallLayerInput): MarkLayer {
  return {
    draw(u, theme) {
      const { ctx, bbox } = u;
      const base = Math.round(u.valToPos(0, 'y', true));
      ctx.save();
      ctx.beginPath();
      ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
      ctx.clip();
      drawStalls(u, input, theme, base);
      drawInflates(u, input, theme, base);
      drawViolations(u, input, theme);
      ctx.restore();
    },
  };
}

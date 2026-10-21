/** Pure helpers shared by the chart options and the legend (no uPlot import, so testable in jsdom). */
import type { TimelineEvent } from '@lionscope/protocol/wire';
import type { ChartTheme } from '../../lib/theme.ts';
import type { SeriesSpec } from './chartSpec.ts';

const EVENT_LABELS: Record<TimelineEvent['kind'], string> = {
  process_start: 'START',
  process_restart: 'RESTART',
  process_died: 'DIED',
};

export function eventLabel(event: TimelineEvent): string {
  const name = EVENT_LABELS[event.kind];
  return event.pid === null ? name : `${name} ${event.pid}`;
}

export interface LabelBox {
  left: number;
  row: number;
}

/**
 * Places marker labels left→right so they never overlap: each label sits right of its line
 * (or left of it at the plot's right edge) in the first row with room, up to `maxRows`.
 * `items` must be sorted by x.
 */
export function placeLabels(
  items: readonly { x: number; width: number }[],
  plotRight: number,
  gap: number,
  maxRows = 3,
): LabelBox[] {
  const rowEnds: number[] = [];
  return items.map(({ x, width }) => {
    const left = x + width > plotRight ? x - width : x;
    let row = rowEnds.findIndex((end) => left >= end + gap);
    if (row < 0) row = Math.min(rowEnds.length, maxRows - 1);
    rowEnds[row] = Math.max(rowEnds[row] ?? -Infinity, left + width);
    return { left, row };
  });
}

/** The color identifying a series (legend key, hover dot). */
export function identityColor(spec: SeriesSpec, theme: ChartTheme): string {
  if (spec.fill) return theme.colors[spec.fill];
  if (spec.stroke) return theme.colors[spec.stroke];
  return theme.colors.ink;
}

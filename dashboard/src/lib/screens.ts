/** Pure helpers for top-screen spans: identity color, windowing and lookup. */
import type { ScreenKind, ScreenSpan } from '@lionscope/protocol/wire';
import type { ChartColor } from './theme.ts';

/**
 * Screen hues, in slot order. Three is the all-pairs cap of the validated palette once jank
 * amber, event violet and red (critical) are excluded; the band label carries identity.
 */
export const SCREEN_COLORS = ['screen1', 'screen2', 'screen3'] as const satisfies readonly ChartColor[];
export type ScreenColor = (typeof SCREEN_COLORS)[number];

export const BACKGROUND_LABEL = 'background';

const KIND_LABELS: Record<ScreenKind, string> = {
  activity: 'Activity',
  fragment: 'Fragment',
  dialog: 'Dialog',
  destination: 'Destination',
};

export function screenKindLabel(kind: ScreenKind): string {
  return KIND_LABELS[kind];
}

/** FNV-1a (32-bit): stable across sessions and reloads, so a screen keeps its color. */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The color token for a screen name: follows the name, never its position or rank. */
export function screenColor(name: string): ScreenColor {
  return SCREEN_COLORS[hashName(name) % SCREEN_COLORS.length] ?? 'screen1';
}

/** End of a span; the open (current) span ends at `openEnd`. */
export function spanEnd(span: ScreenSpan, openEnd: number): number {
  return span.end ?? Math.max(span.start, openEnd);
}

/**
 * Index of the first span still on screen at or after `ts` (its end is past `ts`). Spans are
 * ascending and non-overlapping (the store normalizes them), so ends are ascending too.
 */
export function firstSpanEndingAfter(spans: readonly ScreenSpan[], ts: number, openEnd: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (span !== undefined && spanEnd(span, openEnd) <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface VisibleSpan {
  span: ScreenSpan;
  /** `span.start`: unique per span in the store, so a stable key across pruning and resyncs. */
  key: number;
  /** Clipped to the window, epoch ms. */
  from: number;
  to: number;
  isOpen: boolean;
}

/** Spans overlapping [fromTs, toTs], clipped to it. `spans` must be ascending by start. */
export function visibleSpans(
  spans: readonly ScreenSpan[],
  fromTs: number,
  toTs: number,
  openEnd: number,
): VisibleSpan[] {
  const result: VisibleSpan[] = [];
  for (let i = firstSpanEndingAfter(spans, fromTs, openEnd); i < spans.length; i++) {
    const span = spans[i];
    if (span === undefined || span.start >= toTs) break;
    const end = spanEnd(span, openEnd);
    if (end <= fromTs) continue;
    result.push({
      span,
      key: span.start,
      from: Math.max(span.start, fromTs),
      to: Math.min(end, toTs),
      isOpen: span.end === null,
    });
  }
  return result;
}

export type TrackItem =
  | { kind: 'span'; band: VisibleSpan }
  /** Two or more neighbouring spans too narrow to draw apart, shown as one hatched cluster. */
  | { kind: 'cluster'; key: number; from: number; to: number; count: number };

/**
 * Collapses runs of at least two consecutive spans narrower than `minWidth` (in `msPerUnit`
 * units, e.g. px) into clusters, so a burst of quick screen changes reads as one mark.
 */
export function mergeNarrowSpans(
  bands: readonly VisibleSpan[],
  msPerUnit: number,
  minWidth: number,
): TrackItem[] {
  const minMs = msPerUnit * minWidth;
  const items: TrackItem[] = [];
  let run: VisibleSpan[] = [];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first && last && run.length >= 2) {
      items.push({ kind: 'cluster', key: first.key, from: first.from, to: last.to, count: run.length });
    } else if (first) {
      items.push({ kind: 'span', band: first });
    }
    run = [];
  };
  for (const band of bands) {
    if (band.to - band.from < minMs) {
      run.push(band);
      continue;
    }
    flush();
    items.push({ kind: 'span', band });
  }
  flush();
  return items;
}

/** The span on top at `ts`, or null (before the first span or in a gap). */
export function spanAt(spans: readonly ScreenSpan[], ts: number, openEnd: number): ScreenSpan | null {
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span === undefined || span.start > ts) continue;
    return ts < spanEnd(span, openEnd) || (span.end === null && ts <= openEnd) ? span : null;
  }
  return null;
}

/** Display name; null spans are the app in background. */
export function spanLabel(span: ScreenSpan): string {
  return span.screen?.name ?? BACKGROUND_LABEL;
}

/** Layout inflation figures (0.4.0): the Layouts tab rows and the per-screen Inflate / Views columns. */
import type { InflateSample, ViewTreeSample } from '../wire.ts';
import type { SortDirection } from './screens.ts';

export const UNKNOWN_LAYOUT = '(unknown layout)';

/** Inflated inside another layout's inflation. Samples from before the field existed count as top-level. */
export function isNested(sample: Pick<InflateSample, 'nested'>): boolean {
  return sample.nested === true;
}

/** Row identity: a tuple, so a layout literally named `label:X` can't collide with the label `X`. */
export function layoutRowKey(sample: Pick<InflateSample, 'layout' | 'label'>): string {
  return JSON.stringify([sample.layout, sample.layout === null ? sample.label : null]);
}

/** What the table calls a layout: its resource name, else the SDK's `<View>:<line>` label. */
export function layoutName(sample: Pick<InflateSample, 'layout' | 'label'>): string {
  return sample.layout ?? sample.label ?? UNKNOWN_LAYOUT;
}

export interface LayoutRow {
  /** `layout` or `label:` prefixed label; unique per row. */
  key: string;
  name: string;
  /** The XML name was unavailable: `name` is the SDK's fallback label (first view and line). */
  isLabel: boolean;
  library: boolean;
  count: number;
  /** Inflations among `count` that ran inside another layout's inflation (their time is part of that one's). */
  nestedCount: number;
  totalMs: number;
  /** `totalMs / count`. */
  meanMs: number;
  maxMs: number;
  /** Views created by the slowest inflation seen (nested includes included). */
  views: number;
  /** Screens it was inflated on, most time first; null (unknown) is left out. */
  screens: string[];
}

export type LayoutSortKey = 'name' | 'count' | 'totalMs' | 'meanMs' | 'maxMs' | 'views' | 'screenCount';

interface Accumulator {
  row: Omit<LayoutRow, 'meanMs' | 'screens'>;
  /** Screen → ms, for the ordering. */
  screenMs: Map<string, number>;
  /** `views` follows the slowest inflation, not the largest view count. */
  slowestMs: number;
}

function inWindow(sample: InflateSample, fromTs: number, toTs: number): boolean {
  return sample.ts >= fromTs && sample.ts <= toTs;
}

/** Samples inside the window, optionally without library / framework layouts. */
export function inflatesInWindow(
  inflates: readonly InflateSample[],
  fromTs: number,
  toTs: number,
  includeLibrary = true,
): InflateSample[] {
  return inflates.filter((s) => inWindow(s, fromTs, toTs) && (includeLibrary || !s.library));
}

/** One row per layout over the window. Samples are per (layout, screen, window); this merges them. */
export function aggregateLayouts(
  inflates: readonly InflateSample[],
  fromTs: number,
  toTs: number,
  includeLibrary: boolean,
): LayoutRow[] {
  const groups = new Map<string, Accumulator>();
  for (const sample of inflatesInWindow(inflates, fromTs, toTs, includeLibrary)) {
    const isLabel = sample.layout === null;
    const key = layoutRowKey(sample);
    const acc = groups.get(key) ?? {
      row: {
        key,
        name: layoutName(sample),
        isLabel,
        library: sample.library,
        count: 0,
        nestedCount: 0,
        totalMs: 0,
        maxMs: 0,
        views: 0,
      },
      screenMs: new Map(),
      slowestMs: -1,
    };
    acc.row.count += sample.count;
    if (isNested(sample)) acc.row.nestedCount += sample.count;
    acc.row.totalMs += sample.totalMs;
    if (sample.maxMs > acc.slowestMs) {
      acc.slowestMs = sample.maxMs;
      acc.row.views = sample.views;
    }
    acc.row.maxMs = Math.max(acc.row.maxMs, sample.maxMs);
    if (sample.screen !== null) {
      acc.screenMs.set(sample.screen, (acc.screenMs.get(sample.screen) ?? 0) + sample.totalMs);
    }
    groups.set(key, acc);
  }
  return [...groups.values()].map(({ row, screenMs }) => ({
    ...row,
    meanMs: row.count > 0 ? row.totalMs / row.count : 0,
    screens: [...screenMs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
  }));
}

function compareLayouts(a: LayoutRow, b: LayoutRow, key: LayoutSortKey, sign: number): number {
  if (key === 'name') return sign * a.name.localeCompare(b.name);
  if (key === 'screenCount') return sign * (a.screens.length - b.screens.length);
  return sign * (a[key] - b[key]);
}

/** Sorted copy; ties fall back to more total time, then name, so the order is stable. */
export function sortLayoutRows(
  rows: readonly LayoutRow[],
  key: LayoutSortKey,
  direction: SortDirection,
): LayoutRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort(
    (a, b) => compareLayouts(a, b, key, sign) || b.totalMs - a.totalMs || a.name.localeCompare(b.name),
  );
}

/** Inflation time attributed to one screen in the window. */
export interface ScreenInflate {
  count: number;
  totalMs: number;
  slowest: { name: string; ms: number };
}

/**
 * Per-screen inflate totals over the window. Library layouts count: they are real main-thread time on that
 * screen (a dialog's `abc_` layouts, a list's `mtrl_` rows). Nested inflations (an `<include>`, a compound
 * view's own layout) are left out: their time is already part of the enclosing inflation, so each one is
 * counted once.
 */
export function inflateByScreen(
  inflates: readonly InflateSample[],
  fromTs: number,
  toTs: number,
): Map<string, ScreenInflate> {
  const byScreen = new Map<string, ScreenInflate>();
  for (const sample of inflatesInWindow(inflates, fromTs, toTs)) {
    if (sample.screen === null || isNested(sample)) continue;
    const entry = byScreen.get(sample.screen) ?? {
      count: 0,
      totalMs: 0,
      slowest: { name: layoutName(sample), ms: -1 },
    };
    entry.count += sample.count;
    entry.totalMs += sample.totalMs;
    if (sample.maxMs > entry.slowest.ms) entry.slowest = { name: layoutName(sample), ms: sample.maxMs };
    byScreen.set(sample.screen, entry);
  }
  return byScreen;
}

/** The latest view tree of each screen at or before `toTs` (a paused view must not show later ones). */
export function latestViewTrees(
  viewTrees: readonly ViewTreeSample[],
  toTs: number,
): Map<string, ViewTreeSample> {
  const latest = new Map<string, ViewTreeSample>();
  for (const tree of viewTrees) {
    if (tree.screen === null || tree.ts > toTs) continue;
    const prev = latest.get(tree.screen);
    if (prev === undefined || tree.ts >= prev.ts) latest.set(tree.screen, tree);
  }
  return latest;
}

/** `deepestPath` as `A › B › C`, for a tooltip. */
export function pathLabel(tree: ViewTreeSample): string {
  return tree.deepestPath
    .map((node) => (node.id === null ? node.className : `${node.className}#${node.id}`))
    .join(' › ');
}

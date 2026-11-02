/** Pure helpers of the State tab (0.12.0): saved-state reports and TransactionTooLarge failures. */
import type { SavedStateEntry, SavedStateSample } from '@lionscope/protocol/wire';

/** `583 KB` / `1.2 MB` / `812 B`, binary units like Android's own limits. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `com.example.OrdersFragment` → `OrdersFragment`. */
export function simpleName(className: string | null): string | null {
  if (className === null) return null;
  return className.slice(className.lastIndexOf('.') + 1);
}

/** Reports whose save happened in [fromTs, toTs], largest first (newest first among equals). */
export function reportsInWindow(
  reports: readonly SavedStateSample[],
  fromTs: number,
  toTs: number,
): SavedStateSample[] {
  return reports
    .filter((report) => report.ts >= fromTs && report.ts <= toTs)
    .sort((a, b) => b.totalBytes - a.totalBytes || b.ts - a.ts);
}

/** One row of a report's key tree, in display order. */
export type EntryRow = {
  /** Keys from the Activity's bundle down. */
  path: readonly string[];
  /** The listed key, or null for a key that isn't listed but holds listed ones (shown so they keep their place). */
  entry: SavedStateEntry | null;
  /** Nesting under the listed (or stand-in) rows above it, from 0. */
  depth: number;
  /** Levels between this stand-in and the row above it in the tree that weren't listed either (0: none). */
  skipped: number;
  /** 1-based number among sibling Fragments of the same class when there are several, else null. */
  instance: number | null;
};

type Node = {
  path: readonly string[];
  entry: SavedStateEntry | null;
  skipped: number;
  /** Sibling order: the entry's size, a stand-in's largest child. */
  weight: number;
  children: Node[];
};

const pathKey = (path: readonly string[]) => path.join('\u0000');

/**
 * The SDK's flat, largest-first entries as a tree, depth first, siblings largest first. An entry whose parent isn't
 * listed hangs under a stand-in for that parent (itself under its nearest listed ancestor), never under whichever row
 * happens to precede it.
 */
export function entryRows(entries: readonly SavedStateEntry[]): EntryRow[] {
  const listed = new Map<string, Node>();
  for (const entry of entries) {
    const key = pathKey(entry.path);
    if (entry.path.length > 0 && !listed.has(key)) {
      listed.set(key, { path: entry.path, entry, skipped: 0, weight: entry.bytes, children: [] });
    }
  }
  const standIns = new Map<string, Node>();
  const roots: Node[] = [];
  /** The listed ancestor nearest to [path] (exclusive), or null at the top. */
  const listedAncestor = (path: readonly string[]): Node | null => {
    for (let length = path.length - 1; length > 0; length--) {
      const node = listed.get(pathKey(path.slice(0, length)));
      if (node !== undefined) return node;
    }
    return null;
  };
  for (const node of listed.values()) {
    if (node.path.length === 1) {
      roots.push(node);
      continue;
    }
    const parentPath = node.path.slice(0, -1);
    const parent = listed.get(pathKey(parentPath));
    if (parent !== undefined) {
      parent.children.push(node);
      continue;
    }
    let standIn = standIns.get(pathKey(parentPath));
    if (standIn === undefined) {
      const above = listedAncestor(parentPath);
      standIn = {
        path: parentPath,
        entry: null,
        skipped: parentPath.length - (above?.path.length ?? 0) - 1,
        weight: 0,
        children: [],
      };
      standIns.set(pathKey(parentPath), standIn);
      (above?.children ?? roots).push(standIn);
    }
    standIn.weight = Math.max(standIn.weight, node.weight);
    standIn.children.push(node);
  }
  const bySize = (a: Node, b: Node) =>
    b.weight - a.weight ||
    (pathKey(a.path) < pathKey(b.path) ? -1 : pathKey(a.path) > pathKey(b.path) ? 1 : 0);
  const rows: EntryRow[] = [];
  const visit = (siblings: Node[], depth: number) => {
    siblings.sort(bySize);
    const perClass = new Map<string, number>();
    for (const node of siblings) {
      const fragment = node.entry?.kind === 'fragment' ? node.entry.fragment : null;
      if (fragment !== null) perClass.set(fragment, (perClass.get(fragment) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const node of siblings) {
      const fragment = node.entry?.kind === 'fragment' ? node.entry.fragment : null;
      let instance: number | null = null;
      if (fragment !== null && (perClass.get(fragment) ?? 0) > 1) {
        instance = (seen.get(fragment) ?? 0) + 1;
        seen.set(fragment, instance);
      }
      rows.push({ path: node.path, entry: node.entry, depth, skipped: node.skipped, instance });
      visit(node.children, depth + 1);
    }
  };
  visit(roots, 0);
  return rows;
}

/** Share of the report's total, 0..100 (an entry includes everything nested in it). */
export function share(entry: SavedStateEntry, total: number): number {
  return total > 0 ? Math.min(100, (entry.bytes / total) * 100) : 0;
}

/** The unit `formatBytes` gives `bytes` (`B`, `KB`, `MB`). */
function unitOf(bytes: number): string {
  return formatBytes(bytes).split(' ')[1] ?? '';
}

/**
 * A chain's saves in the window: `125 → 163 KB · 3 saves`, `980 KB → 1.2 MB · 2 saves` (each side its own unit when
 * they differ), `1 save` (its size is the row's own), or `no save`.
 */
export function formatTrend(trend: {
  saves: number;
  firstBytes: number | null;
  lastBytes: number | null;
}): string {
  const { saves, firstBytes, lastBytes } = trend;
  if (saves === 0 || firstBytes === null || lastBytes === null) return 'no save';
  const count = `${saves} ${saves === 1 ? 'save' : 'saves'}`;
  if (saves === 1) return count;
  const first =
    unitOf(firstBytes) === unitOf(lastBytes)
      ? formatBytes(firstBytes).split(' ')[0]
      : formatBytes(firstBytes);
  return `${first} → ${formatBytes(lastBytes)} · ${count}`;
}

/** `+38 KB` / `−2 KB` / `±0 B` against the previous save; null for the first. */
export function formatDelta(bytes: number, previous: number | undefined): string | null {
  if (previous === undefined) return null;
  const delta = bytes - previous;
  if (delta === 0) return '±0 B';
  return `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`;
}

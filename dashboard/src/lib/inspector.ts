/**
 * Layout Inspector (0.5.0): pure helpers over an `InspectorSnapshot` — the node index, hit-testing against
 * the frozen screenshot, overlay geometry, the hierarchy tree's rows and its keyboard navigation.
 */
import type { InspectorNode, InspectorSnapshot, InspectorWindow, PixelRect } from '@lionscope/protocol/wire';

export interface InspectorIndex {
  byId: ReadonlyMap<number, InspectorNode>;
  /** Children in pre-order (= paint order: later siblings are on top). */
  children: ReadonlyMap<number, readonly number[]>;
  /** Root node ids per window id. */
  roots: ReadonlyMap<number, readonly number[]>;
  depth: ReadonlyMap<number, number>;
  /** Visible itself and through every ancestor. */
  isShown: ReadonlyMap<number, boolean>;
}

export function buildIndex(snapshot: InspectorSnapshot): InspectorIndex {
  const byId = new Map<number, InspectorNode>();
  for (const node of snapshot.nodes) byId.set(node.id, node);
  const children = new Map<number, number[]>();
  const roots = new Map<number, number[]>();
  const depth = new Map<number, number>();
  const isShown = new Map<number, boolean>();
  // Pre-order ids: a parent always precedes its children.
  for (const node of snapshot.nodes) {
    const parent = node.parent === null ? undefined : byId.get(node.parent);
    if (parent === undefined) {
      const list = roots.get(node.window) ?? [];
      list.push(node.id);
      roots.set(node.window, list);
      depth.set(node.id, 0);
      isShown.set(node.id, node.visibility === 'visible');
    } else {
      const list = children.get(parent.id) ?? [];
      list.push(node.id);
      children.set(parent.id, list);
      depth.set(node.id, (depth.get(parent.id) ?? 0) + 1);
      isShown.set(node.id, node.visibility === 'visible' && isShown.get(parent.id) === true);
    }
  }
  return { byId, children, roots, depth, isShown };
}

/** Root → parent, excluding the node itself. */
export function ancestorsOf(index: InspectorIndex, id: number): number[] {
  const path: number[] = [];
  let parent = index.byId.get(id)?.parent ?? null;
  while (parent !== null && path.length < 1000) {
    path.unshift(parent);
    parent = index.byId.get(parent)?.parent ?? null;
  }
  return path;
}

function contains(rect: PixelRect, x: number, y: number): boolean {
  return x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3];
}

export function hasArea(rect: PixelRect | null): rect is PixelRect {
  return rect !== null && rect[2] > rect[0] && rect[3] > rect[1];
}

function hitIn(index: InspectorIndex, id: number, x: number, y: number): number | null {
  const node = index.byId.get(id);
  // A fully transparent view (and everything in it) can't be seen, so it can't be picked either.
  if (
    node === undefined ||
    node.visibility !== 'visible' ||
    node.alpha === 0 ||
    !hasArea(node.visibleBounds)
  ) {
    return null;
  }
  // Visible bounds are clipped to the ancestors, so a miss rules out the whole subtree.
  if (!contains(node.visibleBounds, x, y)) return null;
  const kids = index.children.get(id) ?? [];
  // Children arrive in drawing order (the SDK sorts by elevation / Z), so pre-order is the z-order: later
  // siblings paint over earlier ones and win.
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i];
    const hit = kid === undefined ? null : hitIn(index, kid, x, y);
    if (hit !== null) return hit;
  }
  return id;
}

/** The deepest visible node under a device-pixel point; the top-most window that has one wins. */
export function hitTest(
  snapshot: InspectorSnapshot,
  index: InspectorIndex,
  x: number,
  y: number,
): number | null {
  for (let w = snapshot.windows.length - 1; w >= 0; w--) {
    const window = snapshot.windows[w];
    if (window === undefined) continue;
    for (const root of index.roots.get(window.id) ?? []) {
      const hit = hitIn(index, root, x, y);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `com.google.android.material.button.MaterialButton` → `MaterialButton` (`Outer$Inner` → `Inner`). */
export function shortClass(className: string): string {
  const tail = className.slice(className.lastIndexOf('.') + 1);
  const inner = tail.slice(tail.lastIndexOf('$') + 1);
  return inner === '' ? className : inner;
}

/** The entry name of a resource id: `btn_share` stays, `android:id/content` becomes `content`. */
export function idName(resourceId: string): string {
  const slash = resourceId.lastIndexOf('/');
  return slash === -1 ? resourceId : resourceId.slice(slash + 1);
}

/** `MaterialButton#btn_share`, the label of the highlight and the tree row. */
export function nodeLabel(node: InspectorNode): string {
  return node.resourceId === null
    ? shortClass(node.className)
    : `${shortClass(node.className)}#${idName(node.resourceId)}`;
}

export function rectSize(rect: PixelRect): { width: number; height: number } {
  return { width: Math.max(0, rect[2] - rect[0]), height: Math.max(0, rect[3] - rect[1]) };
}

/** `layout.xml:33`: the line is where the start tag ends. */
export function sourceLabel(node: InspectorNode): string | null {
  return node.source === null ? null : `${node.source.layout}.xml:${node.source.line}`;
}

const FALLBACK_REASONS: Record<string, string> = {
  no_sdk: 'no SDK',
  compose: 'Compose screen',
  old_sdk: 'SDK too old',
  background: 'app in the background',
  no_window: 'no app window',
  sdk_disabled: 'SDK inspection off',
  sdk_timeout: 'SDK did not answer',
  sdk_failed: 'SDK failed',
  sdk_too_large: 'view tree too large for the SDK',
};

/** Why the snapshot came from uiautomator, in words. */
export function fallbackLabel(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  return FALLBACK_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export function windowTitle(window: InspectorWindow): string {
  const { type } = window;
  if (type === 1) return 'Activity';
  if (type === 2) return 'Dialog';
  if (type !== null && type >= 1000 && type < 2000) return 'Popup';
  return `Window ${window.id + 1}`;
}

// ---------------------------------------------------------------------------
// Overlay geometry (percent of the displayed screenshot, so it scales with it)
// ---------------------------------------------------------------------------

export interface PercentBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

export function percentBox(rect: PixelRect, display: { width: number; height: number }): PercentBox {
  const w = display.width > 0 ? display.width : 1;
  const h = display.height > 0 ? display.height : 1;
  return {
    left: pct(rect[0] / w),
    top: pct(rect[1] / h),
    width: pct((rect[2] - rect[0]) / w),
    height: pct((rect[3] - rect[1]) / h),
  };
}

export function growRect(rect: PixelRect, by: PixelRect): PixelRect {
  return [rect[0] - by[0], rect[1] - by[1], rect[2] + by[2], rect[3] + by[3]];
}

export function shrinkRect(rect: PixelRect, by: PixelRect): PixelRect {
  return [
    rect[0] + by[0],
    rect[1] + by[1],
    Math.max(rect[0] + by[0], rect[2] - by[2]),
    Math.max(rect[1] + by[1], rect[3] - by[3]),
  ];
}

/**
 * `clip-path` for a box at `outer` that shows only the ring around `inner` (even-odd), in the outer box's own
 * percent coordinates. Draws padding (outer = bounds, inner = content) and margin (outer = margin box).
 */
export function ringClip(outer: PixelRect, inner: PixelRect): string {
  const { width, height } = rectSize(outer);
  if (width === 0 || height === 0) return 'none';
  const x = (value: number) => pct((value - outer[0]) / width);
  const y = (value: number) => pct((value - outer[1]) / height);
  return (
    `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ` +
    `${x(inner[0])} ${y(inner[1])}, ${x(inner[0])} ${y(inner[3])}, ${x(inner[2])} ${y(inner[3])}, ` +
    `${x(inner[2])} ${y(inner[1])}, ${x(inner[0])} ${y(inner[1])})`
  );
}

export function isZeroRect(rect: PixelRect | null): boolean {
  return rect === null || (rect[0] === 0 && rect[1] === 0 && rect[2] === 0 && rect[3] === 0);
}

// ---------------------------------------------------------------------------
// Hierarchy tree
// ---------------------------------------------------------------------------

export type TreeRow =
  | { kind: 'window'; window: InspectorWindow; key: string }
  | {
      kind: 'node';
      key: string;
      node: InspectorNode;
      depth: number;
      hasChildren: boolean;
      isExpanded: boolean;
      isMatch: boolean;
    };

/** What a search query looks at: class, resource id, text and content description. */
export function nodeMatches(node: InspectorNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  return [node.className, node.resourceId, node.text, node.contentDescription].some(
    (field) => field !== null && field.toLowerCase().includes(q),
  );
}

/** Roots and one level below: what a fresh snapshot shows before anything is opened. */
export function defaultExpanded(index: InspectorIndex): Set<number> {
  const open = new Set<number>();
  for (const [id, depth] of index.depth) {
    if (depth < 2 && (index.children.get(id)?.length ?? 0) > 0) open.add(id);
  }
  return open;
}

/** The ids a search keeps: every match and the path down to it. */
function searchVisible(snapshot: InspectorSnapshot, index: InspectorIndex, query: string) {
  const matches = new Set<number>();
  const visible = new Set<number>();
  for (const node of snapshot.nodes) {
    if (!nodeMatches(node, query)) continue;
    matches.add(node.id);
    visible.add(node.id);
    for (const id of ancestorsOf(index, node.id)) visible.add(id);
  }
  return { matches, visible };
}

/**
 * The visible rows, top-most window first. A search keeps matches and their ancestors and opens the path,
 * whatever was collapsed.
 */
export function treeRows(
  snapshot: InspectorSnapshot,
  index: InspectorIndex,
  expanded: ReadonlySet<number>,
  query: string,
): TreeRow[] {
  const searching = query.trim() !== '';
  const found = searching ? searchVisible(snapshot, index, query) : null;
  const rows: TreeRow[] = [];
  const walk = (id: number) => {
    const node = index.byId.get(id);
    if (node === undefined || (found !== null && !found.visible.has(id))) return;
    const kids = (index.children.get(id) ?? []).filter((kid) => found === null || found.visible.has(kid));
    const isExpanded = found !== null ? kids.length > 0 : expanded.has(id);
    rows.push({
      kind: 'node',
      key: `n${id}`,
      node,
      depth: index.depth.get(id) ?? 0,
      hasChildren: kids.length > 0,
      isExpanded,
      isMatch: found?.matches.has(id) ?? false,
    });
    if (isExpanded) for (const kid of kids) walk(kid);
  };
  const showHeaders = snapshot.windows.length > 1;
  for (let w = snapshot.windows.length - 1; w >= 0; w--) {
    const window = snapshot.windows[w];
    if (window === undefined) continue;
    const rootIds = (index.roots.get(window.id) ?? []).filter(
      (id) => found === null || found.visible.has(id),
    );
    if (rootIds.length === 0) continue;
    if (showHeaders) rows.push({ kind: 'window', window, key: `w${window.id}` });
    for (const id of rootIds) walk(id);
  }
  return rows;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export interface TreeMove {
  /** The node that takes focus. */
  focus: number;
  /** Expand or collapse a node. */
  toggle?: { id: number; open: boolean };
}

export function isTreeKey(key: string): key is TreeKey {
  return ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key);
}

/** WAI-ARIA tree keys over the visible rows: ↑↓ move, → opens or steps in, ← closes or steps out. */
export function treeMove(rows: readonly TreeRow[], focusId: number | null, key: TreeKey): TreeMove | null {
  const nodes = rows.filter((row): row is Extract<TreeRow, { kind: 'node' }> => row.kind === 'node');
  if (nodes.length === 0) return null;
  const at = Math.max(
    0,
    nodes.findIndex((row) => row.node.id === focusId),
  );
  const current = nodes[at];
  if (current === undefined) return null;
  const go = (i: number): TreeMove | null => {
    const row = nodes[Math.min(nodes.length - 1, Math.max(0, i))];
    return row === undefined ? null : { focus: row.node.id };
  };
  switch (key) {
    case 'ArrowDown':
      return go(at + 1);
    case 'ArrowUp':
      return go(at - 1);
    case 'Home':
      return go(0);
    case 'End':
      return go(nodes.length - 1);
    case 'ArrowRight': {
      if (current.hasChildren && !current.isExpanded) {
        return { focus: current.node.id, toggle: { id: current.node.id, open: true } };
      }
      const next = nodes[at + 1];
      return current.isExpanded && next !== undefined && next.depth > current.depth
        ? { focus: next.node.id }
        : { focus: current.node.id };
    }
    case 'ArrowLeft': {
      if (current.hasChildren && current.isExpanded) {
        return { focus: current.node.id, toggle: { id: current.node.id, open: false } };
      }
      const parent = current.node.parent;
      return {
        focus: parent !== null && nodes.some((row) => row.node.id === parent) ? parent : current.node.id,
      };
    }
  }
}

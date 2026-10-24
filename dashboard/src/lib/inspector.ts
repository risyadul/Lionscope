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

/** Pushes the deepest picks of one branch under the point, top-most first (pre-order is paint order). */
function stackIn(index: InspectorIndex, id: number, x: number, y: number, out: number[]): boolean {
  const node = index.byId.get(id);
  if (
    node === undefined ||
    node.visibility !== 'visible' ||
    node.alpha === 0 ||
    !hasArea(node.visibleBounds) ||
    !contains(node.visibleBounds, x, y)
  ) {
    return false;
  }
  const kids = index.children.get(id) ?? [];
  let isCovered = false;
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i];
    if (kid !== undefined && stackIn(index, kid, x, y, out)) isCovered = true;
  }
  if (!isCovered) out.push(id);
  return true;
}

/**
 * Every view under a device-pixel point, one per branch (the deepest one there), from the top-most down: what a
 * click picks first and what clicking again on the same spot steps through. Top-most window first.
 */
export function hitStack(snapshot: InspectorSnapshot, index: InspectorIndex, x: number, y: number): number[] {
  const stack: number[] = [];
  for (let w = snapshot.windows.length - 1; w >= 0; w--) {
    const window = snapshot.windows[w];
    if (window === undefined) continue;
    const roots = index.roots.get(window.id) ?? [];
    for (let r = roots.length - 1; r >= 0; r--) {
      const root = roots[r];
      if (root !== undefined) stackIn(index, root, x, y, stack);
    }
  }
  return stack;
}

/**
 * A composable that shows nothing of its own where it sits: no text, description, test tag or click, and (per the
 * SDK) no painting; for SDKs that don't say, an empty one with no children. Full-size overlays like an idle toast or
 * snackbar host are this: picking on the screen looks through them (they stay in the tree, and clicking again on
 * the same spot still reaches them).
 */
export function isSeeThrough(index: InspectorIndex, node: InspectorNode): boolean {
  if (node.composable === undefined || node.clickable) return false;
  if (node.text !== null || node.contentDescription !== null || node.resourceId !== null) return false;
  if (node.composable.draws !== undefined) return !node.composable.draws;
  return (index.children.get(node.id)?.length ?? 0) === 0;
}

/** What a click on the frozen screen picks: the top-most view under the point that isn't see-through. */
export function pickFrom(index: InspectorIndex, stack: readonly number[]): number | null {
  for (const id of stack) {
    const node = index.byId.get(id);
    if (node !== undefined && !isSeeThrough(index, node)) return id;
  }
  return stack[0] ?? null;
}

/** The view a click picks under a device-pixel point (see `hitStack` and `pickFrom`). */
export function hitTest(
  snapshot: InspectorSnapshot,
  index: InspectorIndex,
  x: number,
  y: number,
): number | null {
  return pickFrom(index, hitStack(snapshot, index, x, y));
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

/** A composable read from the composition (SDK 0.6.0+): its name is its class, its testTag its id. */
export function isComposable(node: InspectorNode): boolean {
  return node.composable !== undefined;
}

/** What follows `#`: a view's id entry name, a composable's whole testTag. */
export function idLabel(node: InspectorNode): string | null {
  if (node.resourceId === null) return null;
  return isComposable(node) ? node.resourceId : idName(node.resourceId);
}

/** `MaterialButton#btn_share` (or `Button#checkout` for a composable), the label of the highlight and the tree row. */
export function nodeLabel(node: InspectorNode): string {
  const id = idLabel(node);
  return id === null ? shortClass(node.className) : `${shortClass(node.className)}#${id}`;
}

export function rectSize(rect: PixelRect): { width: number; height: number } {
  return { width: Math.max(0, rect[2] - rect[0]), height: Math.max(0, rect[3] - rect[1]) };
}

/**
 * `layout.xml:33` for a view (the line is where the start tag ends); `HomeScreen.kt:42` for a composable (the line it
 * is called on), just the file when no line was recorded.
 */
export function sourceLabel(node: InspectorNode): string | null {
  if (node.composable) {
    const { file, line } = node.composable;
    if (file === null) return null;
    return line === null ? file : `${file}:${line}`;
  }
  return node.source === null ? null : `${node.source.layout}.xml:${node.source.line}`;
}

const COMPOSITION_NOTES: Readonly<Record<string, string>> = {
  disabled:
    'Composed before Lionscope turned Compose inspection on, or the app opted out: restart the app to read it',
  no_source: 'Built without Compose source information: composables cannot be named',
  failed: 'Lionscope could not read this composition',
};

/** Why an AndroidComposeView's composables are missing, null when they were read (or the SDK predates 0.6.0). */
export function compositionNote(node: InspectorNode): string | null {
  const status = node.composition;
  if (status === undefined || status === 'read') return null;
  return COMPOSITION_NOTES[status] ?? status.replace(/_/g, ' ');
}

const FALLBACK_REASONS: Record<string, string> = {
  no_sdk: 'no SDK',
  compose: 'Compose screen',
  compose_disabled: 'Compose inspection off (restart the app)',
  compose_no_source: 'Compose without source information',
  compose_failed: 'Compose could not be read',
  old_sdk: 'SDK too old',
  background: 'app in the background',
  no_window: 'no app window',
  sdk_disabled: 'SDK inspection off',
  sdk_timeout: 'SDK did not answer',
  sdk_failed: 'SDK failed',
  sdk_too_large: 'view tree too large for the SDK',
  sdk_linking: 'SDK connecting',
  sdk_needs_session: 'SDK needs a session',
  sdk_link_busy: 'SDK link busy',
};

/** The longer explanation behind a label, for a tooltip; only reasons that call for an action have one. */
const FALLBACK_HINTS: Record<string, string> = {
  sdk_linking: 'SDK connecting — inspect again',
  sdk_needs_session: 'SDK too old for inspecting without a session: update to 0.9.0, or Start a session',
  sdk_link_busy: 'another Lionscope server holds the SDK link',
};

/** Why the snapshot came from uiautomator, in words. */
export function fallbackLabel(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  return FALLBACK_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export function fallbackHint(reason: string | null): string | undefined {
  return reason === null ? undefined : FALLBACK_HINTS[reason];
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

/** What a search query looks at: class, resource id, text, content description, a composable's file and destination. */
export function nodeMatches(node: InspectorNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  return [
    node.className,
    node.resourceId,
    node.text,
    node.contentDescription,
    node.composable?.file ?? null,
    node.destination ?? null,
  ].some((field) => field !== null && field.toLowerCase().includes(q));
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

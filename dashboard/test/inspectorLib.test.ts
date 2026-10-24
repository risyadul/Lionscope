import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  compositionNote,
  defaultExpanded,
  fallbackLabel,
  hitStack,
  hitTest,
  isComposable,
  isSeeThrough,
  pickFrom,
  nodeLabel,
  nodeMatches,
  percentBox,
  ringClip,
  shortClass,
  sourceLabel,
  treeMove,
  treeRows,
  type TreeRow,
} from '../src/lib/inspector.ts';
import { inspectorSnapshot, node } from './inspectorFixtures.ts';

const snap = inspectorSnapshot();
const index = buildIndex(snap);
const hit = (x: number, y: number) => hitTest(snap, index, x, y);

describe('hitTest', () => {
  it('finds the deepest visible node', () => {
    expect(hit(900, 1900)).toBe(1);
    expect(hit(50, 50)).toBe(1);
  });

  it('lets a later sibling paint over an earlier one', () => {
    expect(hit(300, 250)).toBe(3);
  });

  it('skips invisible nodes and their subtree', () => {
    expect(hit(100, 1050)).toBe(1);
  });

  it('prefers the top-most window', () => {
    expect(hit(400, 1250)).toBe(7);
    expect(hit(250, 900)).toBe(6);
    // Outside the dialog the activity behind is hit.
    expect(hit(100, 900)).toBe(1);
  });

  it('ignores nodes with nothing on screen and points off the screen', () => {
    const hidden = inspectorSnapshot({
      nodes: [node(0, null, [0, 0, 100, 100], { visibleBounds: null })],
      windows: [{ id: 0, type: 1, bounds: [0, 0, 100, 100] }],
    });
    expect(hitTest(hidden, buildIndex(hidden), 10, 10)).toBeNull();
    expect(hit(-1, 10)).toBeNull();
    expect(hit(1080, 10)).toBeNull();
  });

  it('skips fully transparent nodes and what is inside them', () => {
    const faded = inspectorSnapshot({
      nodes: [
        node(0, null, [0, 0, 1000, 1000]),
        node(1, 0, [0, 0, 500, 500], { alpha: 0 }),
        node(2, 1, [0, 0, 100, 100]),
        node(3, 0, [600, 0, 900, 500], { alpha: 0.01 }),
      ],
      windows: [{ id: 0, type: 1, bounds: [0, 0, 1000, 1000] }],
    });
    const i = buildIndex(faded);
    expect(hitTest(faded, i, 50, 50)).toBe(0);
    expect(hitTest(faded, i, 700, 100)).toBe(3);
  });

  it('clips children to their visible bounds', () => {
    const clipped = inspectorSnapshot({
      nodes: [
        node(0, null, [0, 0, 1000, 1000]),
        node(1, 0, [0, 0, 500, 500], { visibleBounds: [0, 0, 500, 250] }),
      ],
      windows: [{ id: 0, type: 1, bounds: [0, 0, 1000, 1000] }],
    });
    const i = buildIndex(clipped);
    expect(hitTest(clipped, i, 100, 100)).toBe(1);
    expect(hitTest(clipped, i, 100, 400)).toBe(0);
  });
});

/**
 * A Compose screen with an idle toast host drawn over everything: AndroidComposeView > [Scaffold > Card > Text,
 * ToastHost > Box (full size, empty)].
 */
function composeOverlay(box: Partial<Parameters<typeof node>[3]> = {}) {
  const at = { file: 'Home.kt', line: 10 };
  return inspectorSnapshot({
    nodes: [
      node(0, null, [0, 0, 1080, 2400], { className: 'androidx.compose.ui.platform.AndroidComposeView' }),
      node(1, 0, [0, 0, 1080, 2400], { className: 'Scaffold', composable: at }),
      node(2, 1, [0, 500, 1080, 900], { className: 'Card', composable: at, clickable: true }),
      node(3, 2, [100, 600, 500, 700], { className: 'Text', composable: at, text: 'Track' }),
      node(4, 0, [0, 0, 1080, 2400], { className: 'ToastHost', composable: at }),
      node(5, 4, [53, 21, 1027, 2340], { className: 'Box', composable: at, ...box }),
    ],
    windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
  });
}

describe('picking through stacked views', () => {
  it('lists every view under the point, one per branch, from the top down', () => {
    const s = composeOverlay();
    const i = buildIndex(s);
    expect(hitStack(s, i, 300, 650)).toEqual([5, 3]);
    expect(hitStack(s, i, 300, 1000)).toEqual([5, 1]);
    expect(hitStack(s, i, 10, 10)).toEqual([4, 1]);
  });

  it('looks through an empty full-size composable that shows nothing (an idle toast host)', () => {
    const s = composeOverlay();
    const i = buildIndex(s);
    expect(hitTest(s, i, 300, 650)).toBe(3);
    expect(hitTest(s, i, 800, 800)).toBe(2);
    expect(isSeeThrough(i, i.byId.get(5)!)).toBe(true);
  });

  it('keeps a composable that paints, says something or can be clicked', () => {
    for (const box of [
      { composable: { file: 'Home.kt', line: 10, draws: true } },
      { text: 'Saved' },
      { contentDescription: 'Close' },
      { resourceId: 'toast' },
      { clickable: true },
    ]) {
      const s = composeOverlay(box);
      expect(hitTest(s, buildIndex(s), 300, 650)).toBe(5);
    }
  });

  it("trusts the SDK's draws flag over the empty-leaf guess", () => {
    // A container that paints nothing is see-through even with children elsewhere.
    const s = composeOverlay({ composable: { file: 'Home.kt', line: 10, draws: false } });
    const i = buildIndex(s);
    expect(isSeeThrough(i, i.byId.get(4)!)).toBe(false);
    const host = inspectorSnapshot({
      ...s,
      nodes: s.nodes.map((n) =>
        n.id === 4 ? { ...n, composable: { file: 'Home.kt', line: 9, draws: false } } : n,
      ),
    });
    expect(isSeeThrough(buildIndex(host), buildIndex(host).byId.get(4)!)).toBe(true);
  });

  it('never treats a View as see-through, and falls back to the top-most when everything is', () => {
    const s = composeOverlay();
    const i = buildIndex(s);
    expect(isSeeThrough(i, i.byId.get(0)!)).toBe(false);
    expect(pickFrom(i, [5])).toBe(5);
    expect(pickFrom(i, [])).toBeNull();
  });
});

describe('labels and geometry', () => {
  it('shortens classes and labels with the id entry name', () => {
    expect(shortClass('com.google.android.material.button.MaterialButton')).toBe('MaterialButton');
    expect(shortClass('a.b.Outer$Inner')).toBe('Inner');
    expect(nodeLabel(snap.nodes[2]!)).toBe('MaterialButton#btn_checkout');
    expect(nodeLabel(snap.nodes[3]!)).toBe('TextView#price');
    expect(nodeLabel(snap.nodes[4]!)).toBe('View');
  });

  it('writes the source as layout.xml:line', () => {
    expect(sourceLabel(snap.nodes[2]!)).toBe('fragment_cart.xml:33');
    expect(sourceLabel(snap.nodes[3]!)).toBeNull();
  });

  it('labels composables by name and testTag and writes their call site as File.kt:line', () => {
    const button = node(9, 1, [0, 0, 10, 10], {
      className: 'Button',
      resourceId: 'nav/checkout',
      composable: { file: 'CartScreen.kt', line: 87 },
      destination: 'cart',
    });
    expect(isComposable(button)).toBe(true);
    expect(isComposable(snap.nodes[2]!)).toBe(false);
    expect(nodeLabel(button)).toBe('Button#nav/checkout'); // A testTag is kept whole.
    expect(sourceLabel(button)).toBe('CartScreen.kt:87');
    expect(sourceLabel({ ...button, composable: { file: 'CartScreen.kt', line: null } })).toBe(
      'CartScreen.kt',
    );
    expect(sourceLabel({ ...button, composable: { file: null, line: null } })).toBeNull();
    expect(nodeMatches(button, 'cartscreen')).toBe(true);
    expect(nodeMatches(button, 'CART')).toBe(true);
    expect(nodeMatches(snap.nodes[2]!, 'cartscreen')).toBe(false);
  });

  it('says why a composition was not read', () => {
    const composeView = node(9, 1, [0, 0, 10, 10], {
      className: 'androidx.compose.ui.platform.AndroidComposeView',
    });
    expect(compositionNote(composeView)).toBeNull();
    expect(compositionNote({ ...composeView, composition: 'read' })).toBeNull();
    expect(compositionNote({ ...composeView, composition: 'disabled' })).toContain('restart the app');
    expect(compositionNote({ ...composeView, composition: 'no_source' })).toContain('source information');
    expect(fallbackLabel('compose_disabled')).toContain('restart the app');
  });

  it('explains a fallback', () => {
    expect(fallbackLabel('no_sdk')).toBe('no SDK');
    expect(fallbackLabel('weird_reason')).toBe('weird reason');
    expect(fallbackLabel(null)).toBeNull();
  });

  it('scales rects to percent of the display, so the overlay follows the image size', () => {
    expect(percentBox([108, 240, 540, 480], { width: 1080, height: 2400 })).toEqual({
      left: '10.000%',
      top: '10.000%',
      width: '40.000%',
      height: '10.000%',
    });
  });

  it('cuts the inner rect out of the outer one', () => {
    expect(ringClip([0, 0, 100, 100], [10, 20, 90, 80])).toContain('10.000% 20.000%');
    expect(ringClip([0, 0, 0, 0], [0, 0, 0, 0])).toBe('none');
  });
});

describe('treeRows', () => {
  const rows = (expanded: Set<number>, query = '') => treeRows(snap, index, expanded, query);
  const nodeIds = (list: TreeRow[]) => list.flatMap((r) => (r.kind === 'node' ? [r.node.id] : []));

  it('lists the top-most window first, under window headers, and honours collapsed nodes', () => {
    const all = rows(defaultExpanded(index));
    expect(all[0]).toMatchObject({ kind: 'window', window: { id: 1 } });
    expect(nodeIds(all)).toEqual([6, 7, 0, 1, 2, 3, 4]);
    expect(nodeIds(rows(new Set([0, 1, 4, 6])))).toEqual([6, 7, 0, 1, 2, 3, 4, 5]);
  });

  it('search keeps matches and their ancestors and opens the path', () => {
    const found = rows(new Set(), 'checkout');
    expect(nodeIds(found)).toEqual([0, 1, 2]);
    expect(found.find((r) => r.kind === 'node' && r.node.id === 2)).toMatchObject({ isMatch: true });
    expect(nodeIds(rows(new Set(), '$12'))).toEqual([0, 1, 3]);
    expect(nodeIds(rows(new Set(), 'nothing like this'))).toEqual([]);
  });
});

describe('treeMove', () => {
  const open = treeRows(snap, index, new Set([0, 1, 4, 6]), '');
  const collapsed = treeRows(snap, index, new Set([0, 1]), '');

  it('moves with the arrows and clamps at the ends', () => {
    expect(treeMove(open, 6, 'ArrowDown')).toEqual({ focus: 7 });
    expect(treeMove(open, 7, 'ArrowDown')).toEqual({ focus: 0 });
    expect(treeMove(open, 6, 'ArrowUp')).toEqual({ focus: 6 });
    expect(treeMove(open, 2, 'End')).toEqual({ focus: 5 });
    expect(treeMove(open, 5, 'Home')).toEqual({ focus: 6 });
  });

  it('right opens a closed node, then steps into it', () => {
    expect(treeMove(collapsed, 4, 'ArrowRight')).toEqual({ focus: 4, toggle: { id: 4, open: true } });
    expect(treeMove(open, 4, 'ArrowRight')).toEqual({ focus: 5 });
    expect(treeMove(open, 2, 'ArrowRight')).toEqual({ focus: 2 });
  });

  it('left closes an open node, then steps out to the parent', () => {
    expect(treeMove(open, 4, 'ArrowLeft')).toEqual({ focus: 4, toggle: { id: 4, open: false } });
    expect(treeMove(open, 2, 'ArrowLeft')).toEqual({ focus: 1 });
    expect(treeMove(open, 7, 'ArrowLeft')).toEqual({ focus: 6 });
    expect(treeMove(treeRows(snap, index, new Set(), ''), 0, 'ArrowLeft')).toEqual({ focus: 0 });
  });

  it('does nothing without rows', () => {
    expect(treeMove([], null, 'ArrowDown')).toBeNull();
  });
});

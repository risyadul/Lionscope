/**
 * The UI tree of a `uiautomator dump` as agent-friendly elements: one per node in dump order (the index is
 * stable for one dump), bounds in device pixels of the current rotation, and selectors that find an element
 * by text, content description or resource id.
 */
import type { Size } from '../emulator/screenInput.ts';
import type { RawUiHierarchy, RawUiNode } from './uiXml.ts';

export type Bounds = [x1: number, y1: number, x2: number, y2: number];

export interface UiElement {
  /** Position in dump order (pre-order over every node), stable for one dump. */
  index: number;
  /** Index of the parent element, null for a root. */
  parent: number | null;
  depth: number;
  /** Simple class name (`Button`, `TextView`, `ComposeView`). */
  className: string;
  package: string;
  /** Null for a password field: its text is never returned. */
  text: string | null;
  desc: string | null;
  /** Entry name (`block_main`) for the app's own ids, the full id otherwise (`android:id/title`, a Compose test tag). */
  id: string | null;
  /** The resource id as dumped (`com.example.shop:id/cart`). */
  resourceId: string | null;
  hint: string | null;
  bounds: Bounds;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  editable: boolean;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  password: boolean;
}

export interface UiTree {
  elements: UiElement[];
  /** The display in device pixels, as currently rotated (from `wm size` and the dump's rotation). */
  screen: Size;
  rotation: number;
  /** Package of the window on top. */
  package: string | null;
  truncated: boolean;
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;
/** App strings are cut to this length in the tree. */
export const MAX_UI_TEXT_CHARS = 200;

function parseBounds(raw: string | undefined): Bounds {
  const match = BOUNDS.exec(raw ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : [0, 0, 0, 0];
}

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value.slice(0, MAX_UI_TEXT_CHARS);

/** `com.example.shop:id/cart` → `cart` when the id belongs to the node's package; others stay whole. */
export function shortId(resourceId: string, packageName: string): string {
  const prefix = `${packageName}:id/`;
  return resourceId.startsWith(prefix) ? resourceId.slice(prefix.length) : resourceId;
}

function toElement(raw: RawUiNode, index: number, parent: number | null, depth: number): UiElement {
  const a = raw.attributes;
  const flag = (name: string) => a[name] === 'true';
  const className = a.class ?? '';
  const pkg = a.package ?? '';
  const password = flag('password');
  const resourceId = nonEmpty(a['resource-id']);
  return {
    index,
    parent,
    depth,
    className: className.slice(className.lastIndexOf('.') + 1),
    package: pkg,
    text: password ? null : nonEmpty(a.text),
    desc: nonEmpty(a['content-desc']),
    id: resourceId === null ? null : shortId(resourceId, pkg),
    resourceId,
    hint: nonEmpty(a.hint),
    bounds: parseBounds(a.bounds),
    clickable: flag('clickable'),
    longClickable: flag('long-clickable'),
    scrollable: flag('scrollable'),
    checkable: flag('checkable'),
    checked: flag('checked'),
    editable: /EditText|TextField/.test(className),
    enabled: a.enabled !== 'false',
    focused: flag('focused'),
    selected: flag('selected'),
    password,
  };
}

/** `screen`: the display size in the current rotation (display.ts), not a node's bounds. */
export function buildUiTree(hierarchy: RawUiHierarchy, screen: Size): UiTree {
  const elements: UiElement[] = [];
  const visit = (raw: RawUiNode, parent: number | null, depth: number) => {
    const index = elements.length;
    elements.push(toElement(raw, index, parent, depth));
    for (const child of raw.children) visit(child, index, depth + 1);
  };
  for (const root of hierarchy.roots) visit(root, null, 0);
  return {
    elements,
    screen,
    rotation: hierarchy.rotation,
    package: elements[0]?.package || null,
    truncated: hierarchy.truncated,
  };
}

/** Clickable, scrollable, editable or checkable, or carrying text or a description: worth listing. */
export function isActionable(element: UiElement): boolean {
  return (
    element.clickable ||
    element.longClickable ||
    element.scrollable ||
    element.checkable ||
    element.editable ||
    element.text !== null ||
    element.desc !== null
  );
}

/** The part of `bounds` on the screen, or null when none is. */
export function visibleBounds(bounds: Bounds, screen: Size): Bounds | null {
  const x1 = Math.max(0, bounds[0]);
  const y1 = Math.max(0, bounds[1]);
  const x2 = Math.min(screen.width, bounds[2]);
  const y2 = Math.min(screen.height, bounds[3]);
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

/** Where a tap lands: the center of the element's on-screen part. */
export function tapPoint(bounds: Bounds, screen: Size): { x: number; y: number } | null {
  const visible = visibleBounds(bounds, screen);
  if (!visible) return null;
  return { x: Math.floor((visible[0] + visible[2]) / 2), y: Math.floor((visible[1] + visible[3]) / 2) };
}

/** Share of the element's area that is inside `area`. */
export function visibleFraction(bounds: Bounds, area: Bounds): number {
  const size = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
  if (size <= 0) return 0;
  const width = Math.min(bounds[2], area[2]) - Math.max(bounds[0], area[0]);
  const height = Math.min(bounds[3], area[3]) - Math.max(bounds[1], area[1]);
  return width > 0 && height > 0 ? (width * height) / size : 0;
}

export interface UiSelector {
  /** Visible text, or the content description (what a screen reader says for an icon). */
  text?: string | undefined;
  id?: string | undefined;
  desc?: string | undefined;
  /** Whole-value, case-sensitive matches instead of case-insensitive substrings. */
  exact?: boolean | undefined;
}

export function hasSelector(selector: UiSelector): boolean {
  return selector.text !== undefined || selector.id !== undefined || selector.desc !== undefined;
}

function matchesValue(value: string | null, wanted: string | undefined, exact: boolean): boolean {
  if (wanted === undefined) return true;
  if (value === null) return false;
  return exact ? value === wanted : value.toLowerCase().includes(wanted.toLowerCase());
}

/**
 * Elements matching every given field that show on the screen, in dump order. An id matches the entry name
 * (`cart`) or the full resource id (`com.example.shop:id/cart`), exactly.
 */
export function findElements(tree: UiTree, selector: UiSelector): UiElement[] {
  const exact = selector.exact === true;
  return tree.elements.filter(
    (element) =>
      (matchesValue(element.text, selector.text, exact) ||
        (selector.text !== undefined && matchesValue(element.desc, selector.text, exact))) &&
      matchesValue(element.desc, selector.desc, exact) &&
      (selector.id === undefined || element.id === selector.id || element.resourceId === selector.id) &&
      visibleBounds(element.bounds, tree.screen) !== null,
  );
}

/**
 * Matches reduced to one per element that takes the tap: a button's label and the button itself (a nav item's
 * content description and its text) are one candidate, not two.
 */
export function distinctTargets(tree: UiTree, matches: readonly UiElement[]): UiElement[] {
  const seen = new Set<number>();
  return matches.filter((element) => {
    const target = clickTarget(tree, element).index;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

/** The nearest element that takes the tap: the element itself or a clickable ancestor. */
export function clickTarget(tree: UiTree, element: UiElement): UiElement {
  for (let current: UiElement | undefined = element; current;) {
    if (current.clickable || current.longClickable) return current;
    current = current.parent === null ? undefined : tree.elements[current.parent];
  }
  return element;
}

/** The first scrollable element with a part on the screen. */
export function firstScrollable(tree: UiTree): UiElement | null {
  return (
    tree.elements.find((element) => element.scrollable && visibleBounds(element.bounds, tree.screen)) ?? null
  );
}

/** Identity of an element across dumps: the same index must name the same element. */
export function elementSignature(element: UiElement): string {
  return JSON.stringify([element.className, element.id, element.text, element.desc, element.bounds]);
}

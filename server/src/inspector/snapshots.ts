/**
 * Inspector snapshot building blocks: the uiautomator fallback mapped onto InspectorNode (SDK-only fields null),
 * the SDK answer as a snapshot, and the checks the service makes on both.
 */
import type { InspectorNode, InspectorSnapshot, InspectorWindow, PixelRect } from '@lionscope/protocol';
import type { SdkInspection } from '../device/sdkLink.ts';
import type { UiTree } from '../agent/uiTree.ts';
import { MAX_INSPECTOR_WINDOWS } from '@lionscope/protocol';

const MAX_CLASS_NAME_CHARS = 200;

/** A snapshot without the server-assigned parts (id, time, serial). */
export type SnapshotBody = Omit<InspectorSnapshot, 'id' | 'ts' | 'serial'>;

function intersect(a: PixelRect, b: PixelRect): PixelRect | null {
  const rect: PixelRect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

export function rectArea(rect: PixelRect | null): number {
  return rect ? Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]) : 0;
}

/**
 * A `uiautomator dump` as a snapshot: one window per root (the dump's order), bounds clipped to the parent and
 * the screen, and null for everything uiautomator does not know (alpha, padding, margins, layout params,
 * source, owners). Roots past MAX_INSPECTOR_WINDOWS are left out (`truncated`).
 */
export function uiautomatorSnapshot(
  tree: UiTree,
  screen: string | null,
  fallbackReason: string,
): SnapshotBody {
  const display: PixelRect = [0, 0, tree.screen.width, tree.screen.height];
  const windows: InspectorWindow[] = [];
  const nodes: InspectorNode[] = [];
  /** Dump index → node id (elements of dropped windows have none). */
  const ids = new Map<number, number>();
  let truncated = tree.truncated;
  for (const element of tree.elements) {
    let window: number;
    let parent: number | null = null;
    if (element.parent === null) {
      if (windows.length >= MAX_INSPECTOR_WINDOWS) {
        truncated = true;
        continue;
      }
      window = windows.length;
      windows.push({ id: window, type: null, bounds: element.bounds });
    } else {
      const parentId = ids.get(element.parent);
      if (parentId === undefined) continue;
      parent = parentId;
      window = nodes[parentId]?.window ?? 0;
    }
    const clip = parent === null ? display : nodes[parent]?.visibleBounds;
    const id = nodes.length;
    ids.set(element.index, id);
    nodes.push({
      id,
      parent,
      window,
      // The full accessibility class (`android.widget.Button`), like the SDK's.
      className: (element.qualifiedClassName || element.className || 'View').slice(0, MAX_CLASS_NAME_CHARS),
      resourceId: element.id,
      text: element.text,
      contentDescription: element.desc,
      bounds: element.bounds,
      visibleBounds: clip ? intersect(element.bounds, clip) : null,
      visibility: 'visible',
      alpha: null,
      enabled: element.enabled,
      clickable: element.clickable,
      focused: element.focused,
      selected: element.selected,
      checked: element.checkable ? element.checked : null,
      padding: null,
      margin: null,
      layoutWidth: null,
      layoutHeight: null,
      source: null,
      fragment: null,
      activity: null,
    });
  }
  return {
    packageName: tree.package,
    source: 'uiautomator',
    screen,
    display: { ...tree.screen, rotation: tree.rotation * 90 },
    windows,
    nodes,
    truncated,
    captureMs: null,
    fallbackReason,
  };
}

export function sdkSnapshot(inspection: SdkInspection, packageName: string): SnapshotBody {
  const { begin, nodes } = inspection;
  return {
    packageName,
    source: 'sdk',
    screen: begin.screen,
    display: begin.display,
    windows: begin.windows,
    nodes,
    truncated: begin.truncated,
    captureMs: begin.captureMs,
    fallbackReason: null,
  };
}

const COMPOSE_VIEW = 'AndroidComposeView';

/** Why an SDK snapshot cannot stand for its Compose top window; the suffix is the SDK's `composition` status. */
export type ComposeFallback = 'compose' | 'compose_disabled' | 'compose_no_source' | 'compose_failed';

const COMPOSE_FALLBACKS: Readonly<
  Record<Exclude<InspectorNode['composition'] & string, 'read'>, ComposeFallback>
> = {
  disabled: 'compose_disabled',
  no_source: 'compose_no_source',
  failed: 'compose_failed',
};

/**
 * The top window is Compose the SDK did not read: an AndroidComposeView covers at least half of it and its
 * composition was not read (`composition` other than `read`; absent from an SDK below 0.6.0, which never reads
 * one). Null when the snapshot shows the top window as it is.
 */
export function composeFallback(inspection: SdkInspection): ComposeFallback | null {
  const { begin, nodes } = inspection;
  const top = begin.windows.at(-1);
  if (!begin.compose || !top) return null;
  const half = rectArea(top.bounds) / 2;
  const unread = nodes.find(
    (node) =>
      node.window === top.id &&
      node.className.endsWith(COMPOSE_VIEW) &&
      node.visibility === 'visible' &&
      rectArea(node.visibleBounds) >= half &&
      node.composition !== 'read',
  );
  if (!unread) return null;
  const status = unread.composition;
  return status === undefined || status === 'read' ? 'compose' : COMPOSE_FALLBACKS[status];
}

/** How far each edge of an element may move between snapshots and still be the same one (by position). */
export const CARRY_TOLERANCE_PX = 24;

/**
 * The same element in another snapshot: the only node with its class, resource id and (when it has one) text;
 * else the only node of its class whose edges are each within CARRY_TOLERANCE_PX of its own; else null.
 */
export function matchingNode(node: InspectorNode, snapshot: InspectorSnapshot): InspectorNode | null {
  const byIdentity = snapshot.nodes.filter(
    (candidate) =>
      candidate.className === node.className &&
      candidate.resourceId === node.resourceId &&
      (node.text === null || candidate.text === node.text),
  );
  if (byIdentity.length === 1) return byIdentity[0] ?? null;
  const byPosition = snapshot.nodes.filter(
    (candidate) =>
      candidate.className === node.className &&
      candidate.bounds.every((value, i) => Math.abs(value - (node.bounds[i] ?? 0)) <= CARRY_TOLERANCE_PX),
  );
  return byPosition.length === 1 ? (byPosition[0] ?? null) : null;
}

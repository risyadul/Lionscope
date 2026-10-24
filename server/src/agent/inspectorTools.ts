/**
 * The Layout Inspector for agents: what the user selected in the dashboard (get_inspector_selection, with a
 * cropped screenshot of the element), a fresh snapshot (inspect_screen, device control) and pointing at an
 * element in the dashboard (select_inspector_node). Same snapshots and selection the dashboard shows.
 */
import { z } from 'zod';
import { MAX_INSPECTOR_NODES } from '@lionscope/protocol';
import type { InspectorNode, InspectorSnapshot, PixelRect } from '@lionscope/protocol';
import { optionalSerial, targetSerial } from './deviceTools.ts';
import { cropPng, pngSize } from './png.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext, PngImage } from './tool.ts';
import { iso } from './views.ts';

/** The element crop: this much screen around it, then scaled to at most CROP_MAX_EDGE px on its long edge. */
const CROP_PADDING_PX = 16;
export const CROP_MAX_EDGE = 512;
const MAX_CHILDREN_LISTED = 20;
const MAX_LISTED_NODES = 500;
export const SOURCE_LINE_NOTE =
  'line is where the start tag ends (its `>`, as aapt2 records it), not the `<Tag` line: look a few lines up for multi-line tags';
export const AGENT_SELECTION_NOTE =
  'You selected this element yourself (select_inspector_node), so its text, content description and image are left out: ask the user to click it in the dashboard to share them.';
export const LARGE_ELEMENT_NOTE =
  'No image: the element is a window root or covers more than half of the screen. Ask about a smaller element.';
/** Elements covering more of the display than this are never cropped (they would be a screenshot). */
const MAX_CROP_SHARE = 0.5;
export const NOTHING_SELECTED =
  'Nothing is selected in the Inspector. Ask the user to press Inspect in the dashboard and click the element, or call inspect_screen (device control) and select_inspector_node.';

function simpleName(className: string): string {
  return className.slice(className.lastIndexOf('.') + 1);
}

/** `MaterialButton#btn_checkout`, the way the dashboard labels a node. */
export function nodeLabel(node: InspectorNode): string {
  return node.resourceId === null
    ? simpleName(node.className)
    : `${simpleName(node.className)}#${node.resourceId}`;
}

function sourceView(node: InspectorNode) {
  if (!node.source) return null;
  return {
    file: `${node.source.layout}.xml`,
    layout: node.source.layout,
    line: node.source.line,
    note: SOURCE_LINE_NOTE,
  };
}

function snapshotView(snapshot: InspectorSnapshot, ctx: AgentContext) {
  return {
    id: snapshot.id,
    serial: snapshot.serial,
    packageName: snapshot.packageName,
    source: snapshot.source,
    fallbackReason: snapshot.fallbackReason,
    screen: snapshot.screen,
    capturedAt: iso(snapshot.ts),
    ageMs: Math.max(0, ctx.now() - snapshot.ts),
    display: snapshot.display,
    nodes: snapshot.nodes.length,
    truncated: snapshot.truncated,
    captureMs: snapshot.captureMs,
  };
}

function ancestorsOf(snapshot: InspectorSnapshot, node: InspectorNode): string[] {
  const path: string[] = [];
  for (let parent = node.parent; parent !== null;) {
    const ancestor = snapshot.nodes[parent];
    if (!ancestor) break;
    path.unshift(nodeLabel(ancestor));
    parent = ancestor.parent;
  }
  return path;
}

/** `withText`: the user picked it; else (the agent's own pick) its text and content description are left out. */
function elementView(snapshot: InspectorSnapshot, node: InspectorNode, withText: boolean) {
  const window = snapshot.windows[node.window];
  return {
    nodeId: node.id,
    label: nodeLabel(node),
    className: node.className,
    resourceId: node.resourceId,
    ...(withText ? { text: node.text, contentDescription: node.contentDescription } : {}),
    bounds: node.bounds,
    visibleBounds: node.visibleBounds,
    size: { width: node.bounds[2] - node.bounds[0], height: node.bounds[3] - node.bounds[1] },
    visibility: node.visibility,
    alpha: node.alpha,
    enabled: node.enabled,
    clickable: node.clickable,
    focused: node.focused,
    selected: node.selected,
    checked: node.checked,
    padding: node.padding,
    margin: node.margin,
    layoutWidth: node.layoutWidth,
    layoutHeight: node.layoutHeight,
    window: window ? { id: window.id, type: window.type } : { id: node.window, type: null },
    source: sourceView(node),
    fragment: node.fragment,
    activity: node.activity,
  };
}

/** The element's on-screen area, padded, as PNG pixels of the snapshot's screenshot; null when it is off screen. */
function cropArea(snapshot: InspectorSnapshot, node: InspectorNode, png: Buffer): PixelRect | null {
  const area = node.visibleBounds;
  if (!area) return null;
  const size = pngSize(png);
  const sx = size.width / snapshot.display.width;
  const sy = size.height / snapshot.display.height;
  return [
    Math.max(0, Math.floor((area[0] - CROP_PADDING_PX) * sx)),
    Math.max(0, Math.floor((area[1] - CROP_PADDING_PX) * sy)),
    Math.min(size.width, Math.ceil((area[2] + CROP_PADDING_PX) * sx)),
    Math.min(size.height, Math.ceil((area[3] + CROP_PADDING_PX) * sy)),
  ];
}

function crop(
  ctx: AgentContext,
  snapshot: InspectorSnapshot,
  node: InspectorNode,
): { image: PngImage | null; why: string | null } {
  const { width, height } = snapshot.display;
  const area = node.visibleBounds;
  const share = area ? ((area[2] - area[0]) * (area[3] - area[1])) / (width * height) : 0;
  if (node.parent === null || share > MAX_CROP_SHARE) return { image: null, why: LARGE_ELEMENT_NOTE };
  const png = ctx.inspector.png(snapshot.id);
  if (!png) return { image: null, why: 'the screenshot is no longer kept' };
  const rect = cropArea(snapshot, node, png);
  if (!rect) return { image: null, why: 'the element is not on the screen' };
  const cropped = cropPng(png, rect, CROP_MAX_EDGE);
  if (!cropped) return { image: null, why: 'the screenshot could not be cropped' };
  return { image: { mimeType: 'image/png', data: cropped.png }, why: null };
}

export const inspectorSelectionTool = defineTool({
  name: 'get_inspector_selection',
  title: 'Inspector selection',
  description: `The element the user selected in the dashboard's Layout Inspector: call this when the user says "this element", "the one I selected", "this button" or similar. Returns its attributes (class, resource id, text, content description, bounds and visible bounds in device pixels, visibility, alpha, flags, padding, margins, layout width/height), the XML layout file and line it was inflated from (the line is where the start tag ENDS, its \`>\`), the owning Fragment and Activity, its ancestor path (Class#id, root first), its children, the snapshot it belongs to (device, app, screen, age, source sdk or uiautomator and why) and a cropped screenshot of the element (at most ${CROP_MAX_EDGE} px; none for window roots or elements covering more than half of the screen). When the selection was made by an agent (select_inspector_node) only its structure comes back: no text, content description or image. SDK-only fields (source, owners, padding, margins, layout params) are null for uiautomator snapshots. Fails when nothing is selected. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({}),
  annotations: READ_ONLY,
  async run(_args, ctx) {
    const selection = ctx.inspector.selection;
    const snapshot = ctx.inspector.current;
    const node =
      selection && snapshot?.id === selection.snapshotId ? snapshot.nodes[selection.nodeId] : undefined;
    if (!selection || !snapshot || !node) throw new ToolError(NOTHING_SELECTED);
    // An agent's own pick only points at an element: it must not read the screen without device control.
    const byUser = selection.origin === 'user';
    const children = snapshot.nodes.filter((candidate) => candidate.parent === node.id);
    const { image, why } = byUser ? crop(ctx, snapshot, node) : { image: null, why: AGENT_SELECTION_NOTE };
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        selectedAt: iso(selection.ts),
        selectedBy: selection.origin,
        ...(byUser ? {} : { note: AGENT_SELECTION_NOTE }),
        snapshot: snapshotView(snapshot, ctx),
        element: elementView(snapshot, node, byUser),
        ancestors: ancestorsOf(snapshot, node),
        children: {
          count: children.length,
          listed: children.slice(0, MAX_CHILDREN_LISTED).map((child) => ({
            nodeId: child.id,
            label: nodeLabel(child),
            ...(byUser && child.text !== null ? { text: child.text } : {}),
            ...(byUser && child.contentDescription !== null
              ? { contentDescription: child.contentDescription }
              : {}),
          })),
        },
        crop: image ? { included: true, maxEdge: CROP_MAX_EDGE } : { included: false, reason: why },
      },
      ...(image ? { image } : {}),
    };
  },
});

function compactNode(node: InspectorNode) {
  const flags = [
    ...(node.clickable ? ['clickable'] : []),
    ...(node.checked !== null ? [node.checked ? 'checked' : 'unchecked'] : []),
    ...(node.focused ? ['focused'] : []),
    ...(node.selected ? ['selected'] : []),
    ...(node.enabled === false ? ['disabled'] : []),
  ];
  return {
    nodeId: node.id,
    parent: node.parent,
    label: nodeLabel(node),
    ...(node.text !== null ? { text: node.text } : {}),
    ...(node.contentDescription !== null ? { contentDescription: node.contentDescription } : {}),
    bounds: node.visibleBounds,
    ...(node.source ? { source: `${node.source.layout}.xml:${node.source.line}` } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

function matchesQuery(node: InspectorNode, needle: string): boolean {
  return [node.className, node.resourceId, node.text, node.contentDescription, node.source?.layout].some(
    (value) => value?.toLowerCase().includes(needle),
  );
}

export const inspectScreenTool = defineTool({
  name: 'inspect_screen',
  title: 'Inspect the screen',
  description: `Captures a Layout Inspector snapshot of the device screen now (the dashboard shows it too) and lists its visible nodes: nodeId, parent, label (Class#id), text, content description, visible bounds in device pixels, the XML layout source (file:line, where the start tag ends) and flags. From the in-app SDK when its app is on top, with or without a profiling session (SDK 0.5.2+; 0.5.0-0.5.1 only during a session), with layout sources and owners; or else uiautomator (fallbackReason says why: sdk_linking = the SDK is still connecting, call it again; sdk_needs_session = the app's SDK is older than 0.5.2, start a session; sdk_link_busy = another Lionscope server holds the device link). query keeps nodes whose class, id, text, description or layout contains it. Pass a nodeId to select_inspector_node to point the user at it. It replaces the snapshot every dashboard shows and may clear the user's selection: when the user means an element they selected, call get_inspector_selection first. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    serial: optionalSerial,
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive substring of class, id, text, description or layout.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LISTED_NODES)
      .default(100)
      .describe(`Most nodes listed (1-${MAX_LISTED_NODES}).`),
  }),
  // It reads the device, but replaces every dashboard's snapshot (and may clear the selection).
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run({ serial: requested, query, limit }, ctx) {
    const serial = targetSerial(ctx, requested);
    const snapshot = await ctx.inspector.inspect(serial);
    const needle = query?.toLowerCase();
    const visible = snapshot.nodes.filter(
      (node) =>
        node.visibility === 'visible' &&
        node.visibleBounds !== null &&
        (needle === undefined || matchesQuery(node, needle)),
    );
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        snapshot: snapshotView(snapshot, ctx),
        matched: visible.length,
        shown: Math.min(limit, visible.length),
        nodes: visible.slice(0, limit).map(compactNode),
      },
    };
  },
});

export const selectInspectorNodeTool = defineTool({
  name: 'select_inspector_node',
  title: 'Select an Inspector node',
  description:
    "Selects a node of the current Inspector snapshot in the dashboard (it is highlighted for the user, marked as the AI's pick), by nodeId from inspect_screen or get_inspector_selection; null clears the selection. Pass snapshotId to make sure the dashboard still shows the snapshot you looked at. Returns the selected node's label. get_inspector_selection then returns only the structure of a node you selected (no text, content description or image).",
  access: 'dashboard',
  input: z.object({
    nodeId: z
      .number()
      .int()
      .min(0)
      .max(MAX_INSPECTOR_NODES - 1)
      .nullable()
      .describe('Node id of the current snapshot; null clears the selection.'),
    snapshotId: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional()
      .describe('The snapshot the node id belongs to.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ nodeId, snapshotId }, ctx) {
    const current = ctx.inspector.current;
    if (!current)
      throw new ToolError('No Inspector snapshot yet: call inspect_screen, or ask the user to press Inspect');
    if (snapshotId !== undefined && snapshotId !== current.id) {
      throw new ToolError(
        'The dashboard shows a newer snapshot: call inspect_screen again and pick the node in it',
      );
    }
    try {
      ctx.inspector.select(current.id, nodeId, 'agent');
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
    const node = nodeId === null ? null : current.nodes[nodeId];
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        snapshotId: current.id,
        selected: node ? { nodeId: node.id, label: nodeLabel(node) } : null,
      },
    };
  },
});

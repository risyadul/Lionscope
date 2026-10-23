/**
 * Live view edits for agents (device control: they change the running app): set a property of a View of the current
 * Inspector snapshot, and revert edits. The same edits the dashboard makes (inspector/viewEdits.ts); each call returns
 * the element as the snapshot taken right after it shows it, with its node id there.
 */
import { z } from 'zod';
import {
  MAX_EDIT_TEXT_CHARS,
  MAX_INSPECTOR_NODES,
  VIEW_PROPERTIES,
  VIEW_PROPERTY_GROUPS,
} from '@lionscope/protocol';
import type { InspectorNode, InspectorSnapshot, ViewProperty, ViewPropertyValue } from '@lionscope/protocol';
import type { ViewEditOutcome } from '../inspector/viewEdits.ts';
import { nodeLabel } from './inspectorTools.ts';
import { defineTool, ToolError, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext, AgentViewEdits } from './tool.ts';

/** How long a tool waits for the snapshot taken after its edit before answering without it. */
export const NEXT_SNAPSHOT_WAIT_MS = 8000;
export const TEMPORARY_NOTE =
  "Temporary: the edit lasts until it is reverted, the app sets the property itself (e.g. a RecyclerView row is rebound) or the view is recreated. Setters can run the app's own listeners (a TextWatcher, a layout listener).";
const NO_EDITS =
  'Live view editing is not available in this server. Start a Lionscope 0.8.0+ server with --allow-device-control.';

const nodeId = z
  .number()
  .int()
  .min(0)
  .max(MAX_INSPECTOR_NODES - 1)
  .describe('Node id of the current Inspector snapshot (inspect_screen, get_inspector_selection).');
const snapshotId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .optional()
  .describe('The snapshot the node id belongs to; the call fails if a newer one replaced it.');
const GROUPS = Object.keys(VIEW_PROPERTY_GROUPS) as (keyof typeof VIEW_PROPERTY_GROUPS)[];

function edits(ctx: AgentContext): AgentViewEdits {
  if (!ctx.viewEdits) throw new ToolError(NO_EDITS);
  return ctx.viewEdits;
}

/** The value `property` has in `node`, as a snapshot reports it. */
function valueOf(node: InspectorNode, property: ViewProperty): unknown {
  for (const group of GROUPS) {
    // `padding` / `margin` are also the node's [left, top, right, bottom] fields.
    const side = (VIEW_PROPERTY_GROUPS[group] as readonly ViewProperty[]).indexOf(property);
    if (side !== -1) return node[group]?.[side] ?? null;
  }
  switch (property) {
    case 'visibility':
    case 'alpha':
    case 'enabled':
    case 'layoutWidth':
    case 'layoutHeight':
    case 'text':
      return node[property];
    case 'translationX':
    case 'translationY':
    case 'elevation':
    case 'backgroundColor':
    case 'textSize':
    case 'textColor':
      return node.view?.[property] ?? null;
    default:
      return null;
  }
}

/**
 * The edited element in the snapshot taken after the change (matched by its view key), or why it is not there.
 * `properties`: the ones whose new values to report.
 */
async function after(
  outcome: Extract<ViewEditOutcome, { ok: true }>,
  key: number | null,
  properties: readonly ViewProperty[],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(
    (resolve) => (timer = setTimeout(() => resolve(null), NEXT_SNAPSHOT_WAIT_MS)),
  );
  const next: InspectorSnapshot | null = await Promise.race([outcome.next, timeout]);
  clearTimeout(timer);
  if (!next) return { snapshot: null, note: 'No new snapshot yet: call inspect_screen to see the change.' };
  const node = key === null ? undefined : next.nodes.find((candidate) => candidate.view?.key === key);
  return {
    snapshot: { id: next.id, liveEdits: next.liveEdits ?? null },
    ...(key === null
      ? {}
      : node
        ? {
            element: {
              nodeId: node.id,
              label: nodeLabel(node),
              values: Object.fromEntries(properties.map((property) => [property, valueOf(node, property)])),
              edited: node.view?.edited ?? [],
            },
          }
        : { note: 'The element is not in the new snapshot (recreated or removed).' }),
  };
}

/** `value` for each side a `padding` / `margin` call names: one number for all four, or [left, top, right, bottom]. */
function sides(
  group: keyof typeof VIEW_PROPERTY_GROUPS,
  value: unknown,
): [ViewProperty, ViewPropertyValue][] {
  const all = typeof value === 'number' ? [value, value, value, value] : value;
  if (!Array.isArray(all) || all.length !== 4 || !all.every((side) => typeof side === 'number')) {
    throw new ToolError(`${group} takes one number of pixels for all sides, or [left, top, right, bottom]`);
  }
  return VIEW_PROPERTY_GROUPS[group].map((property, i) => [property, all[i] as number]);
}

export const setViewPropertyTool = defineTool({
  name: 'set_view_property',
  title: 'Set a view property live',
  description: `Changes a property of a View in the app running on the device, live, through the Lionscope SDK (0.8.0+), by nodeId of the current Inspector snapshot (inspect_screen or get_inspector_selection, whose \`editable\` lists what a node accepts). Properties: visibility (visible|invisible|gone), alpha (0-1), enabled (boolean), paddingLeft/Top/Right/Bottom (0-2000 px), marginLeft/Top/Right/Bottom (-2000..2000 px, MarginLayoutParams only), padding / margin (one number for all sides or [left, top, right, bottom]), layoutWidth / layoutHeight (match_parent, wrap_content or "<n>px", 0-10000; not on window roots), translationX / translationY (-10000..10000 px), elevation (0-1000 px), backgroundColor (#RRGGBB or #AARRGGBB), and on TextViews text (at most ${MAX_EDIT_TEXT_CHARS} characters; never on password fields), textSize (1-200 sp), textColor. Composables and uiautomator snapshots are read-only: change them in code. ${TEMPORARY_NOTE} Returns the live edits in the app and the element in the snapshot taken right after (its new nodeId and values); the dashboard shows it too. Use it to try a fix before changing the layout file. Device control.`,
  access: 'device',
  input: z.object({
    nodeId,
    property: z.enum([...VIEW_PROPERTIES, ...GROUPS]).describe('The property to set (see the description).'),
    value: z
      .union([z.string().max(MAX_EDIT_TEXT_CHARS), z.number(), z.boolean(), z.array(z.number()).length(4)])
      .describe(
        'The new value: a string, number or boolean; padding / margin also [left, top, right, bottom].',
      ),
    snapshotId,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ nodeId, property, value, snapshotId }, ctx) {
    const service = edits(ctx);
    const group = (GROUPS as string[]).includes(property)
      ? (property as keyof typeof VIEW_PROPERTY_GROUPS)
      : null;
    if (group === null && Array.isArray(value)) throw new ToolError(`${property} takes a single value`);
    const steps: [ViewProperty, ViewPropertyValue][] =
      group === null ? [[property as ViewProperty, value as ViewPropertyValue]] : sides(group, value);
    const key = ctx.inspector.current?.nodes[nodeId]?.view?.key ?? null;
    let outcome: ViewEditOutcome | null = null;
    const done: ViewProperty[] = [];
    for (const [step, stepValue] of steps) {
      outcome = await service.set({ snapshotId, nodeId, property: step, value: stepValue });
      if (!outcome.ok) {
        const partly =
          done.length > 0 ? ` (${done.join(', ')} ${done.length === 1 ? 'was' : 'were'} set)` : '';
        throw new ToolError(`${step}: ${outcome.message}${partly}`);
      }
      done.push(step);
    }
    if (!outcome?.ok) throw new ToolError('Nothing to set');
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        set: Object.fromEntries(steps),
        liveEdits: outcome.liveEdits,
        note: TEMPORARY_NOTE,
        ...(await after(
          outcome,
          key,
          steps.map(([step]) => step),
        )),
      },
    };
  },
});

export const revertViewPropertiesTool = defineTool({
  name: 'revert_view_properties',
  title: 'Revert live view edits',
  description:
    'Reverts live edits made with set_view_property (or in the dashboard) in the app on the device: one property (or padding / margin) of a node, every edited property of a node (no property), or every live edit in the app (no nodeId). A property the app has set itself since is left as the app set it. Returns the live edits left and the element in the snapshot taken right after. Device control.',
  access: 'device',
  input: z.object({
    nodeId: nodeId
      .optional()
      .describe('Node id of the current snapshot; omitted: revert every live edit in the app.'),
    property: z
      .enum([...VIEW_PROPERTIES, ...GROUPS])
      .optional()
      .describe('Only this property (or padding / margin); needs nodeId.'),
    snapshotId,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ nodeId, property, snapshotId }, ctx) {
    const service = edits(ctx);
    if (property !== undefined && nodeId === undefined) throw new ToolError('property needs a nodeId');
    const key = nodeId === undefined ? null : (ctx.inspector.current?.nodes[nodeId]?.view?.key ?? null);
    const outcome = await service.revert({ snapshotId, nodeId, property });
    if (!outcome.ok) throw new ToolError(outcome.message);
    const reverted: readonly ViewProperty[] =
      property === undefined
        ? []
        : (GROUPS as string[]).includes(property)
          ? VIEW_PROPERTY_GROUPS[property as keyof typeof VIEW_PROPERTY_GROUPS]
          : [property as ViewProperty];
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        reverted:
          nodeId === undefined
            ? 'every live edit in the app'
            : (property ?? 'every edited property of the node'),
        liveEdits: outcome.liveEdits,
        ...(await after(outcome, key, reverted)),
      },
    };
  },
});

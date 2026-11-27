/**
 * Diff tools for before/after verification (device control):
 * - `diff_ui_tree`: nodes added, removed, and modified since the previous UI tree baseline
 * - `diff_screenshot`: pixel diff metrics and changed bounding boxes since the previous screenshot baseline
 */
import { z } from 'zod';
import { optionalSerial, screencap, SCREENSHOT_SHORT_EDGE, targetSerial } from './deviceTools.ts';
import { screenInsets } from './insets.ts';
import { decodeScreenshot, fitShortEdge, pngSize, screenDiffRegions } from './png.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { dumpUi } from './uiDump.ts';
import { ELEMENT_CALL_MS, elementView } from './uiTools.ts';
import { isActionable } from './uiTree.ts';
import type { Bounds, UiElement, UiTree } from './uiTree.ts';

const MAX_DIFF_ITEMS = 100;
const MAX_SCREENSHOT_REGIONS = 20;

const DIFF_FLAG_KEYS = [
  'clickable',
  'longClickable',
  'scrollable',
  'checkable',
  'checked',
  'editable',
  'enabled',
  'focused',
  'selected',
  'password',
] as const;

export interface UiNodeChange {
  before: ReturnType<typeof elementView>;
  after: ReturnType<typeof elementView>;
  changes: {
    text?: { before: string | null; after: string | null };
    desc?: { before: string | null; after: string | null };
    hint?: { before: string | null; after: string | null };
    bounds?: { before: Bounds; after: Bounds };
    flags?: { added: string[]; removed: string[] };
  };
}

export interface UiTreeDiffResult {
  changed: boolean;
  counts: { added: number; removed: number; modified: number; unchanged: number };
  added: ReturnType<typeof elementView>[];
  removed: ReturnType<typeof elementView>[];
  modified: UiNodeChange[];
  truncated: boolean;
}

function elementFlags(element: UiElement): string[] {
  return [...DIFF_FLAG_KEYS.filter((key) => element[key])];
}

function nodePrimaryKey(element: UiElement): string | null {
  if (element.resourceId !== null) return `id|${element.package}|${element.className}|${element.resourceId}`;
  if (element.hint !== null) return `hint|${element.package}|${element.className}|${element.hint}`;
  return null;
}

function nodeFallbackKey(element: UiElement): string | null {
  // Never pair two nodes whose stable resource IDs disagree (e.g. replaced buttons with identical text).
  if (element.resourceId !== null) return null;
  if (element.desc !== null) return `desc|${element.package}|${element.className}|${element.desc}`;
  if (element.text !== null) return `text|${element.package}|${element.className}|${element.text}`;
  return `bounds|${element.package}|${element.className}|${element.bounds.join(',')}`;
}

function compareElements(before: UiElement, after: UiElement): UiNodeChange['changes'] | null {
  const changes: UiNodeChange['changes'] = {};
  if (before.text !== after.text) changes.text = { before: before.text, after: after.text };
  if (before.desc !== after.desc) changes.desc = { before: before.desc, after: after.desc };
  if (before.hint !== after.hint) changes.hint = { before: before.hint, after: after.hint };
  if (before.bounds.join(',') !== after.bounds.join(',')) {
    changes.bounds = { before: before.bounds, after: after.bounds };
  }
  const beforeFlags = new Set(elementFlags(before));
  const afterFlags = new Set(elementFlags(after));
  const addedFlags = [...afterFlags].filter((flag) => !beforeFlags.has(flag));
  const removedFlags = [...beforeFlags].filter((flag) => !afterFlags.has(flag));
  if (addedFlags.length > 0 || removedFlags.length > 0) {
    changes.flags = { added: addedFlags, removed: removedFlags };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Pure diff between two UI trees: matches nodes first by stable identity (`resourceId` / `hint` + occurrence),
 * then by `desc` / `text` / `bounds`, separating added, removed, and modified elements.
 */
export function diffUiTrees(
  beforeTree: UiTree,
  afterTree: UiTree,
  filter: 'actionable' | 'all' = 'actionable',
  maxItems = MAX_DIFF_ITEMS,
): UiTreeDiffResult {
  const pick = (tree: UiTree) =>
    filter === 'all' ? tree.elements : tree.elements.filter((element) => isActionable(element));

  const beforeList = pick(beforeTree);
  const afterList = pick(afterTree);

  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  const pairs: [UiElement, UiElement][] = [];

  const matchByKey = (keyOf: (el: UiElement) => string | null) => {
    const buckets = new Map<string, UiElement[]>();
    for (const el of beforeList) {
      if (matchedBefore.has(el.index)) continue;
      const key = keyOf(el);
      if (key === null) continue;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(el);
    }
    for (const el of afterList) {
      if (matchedAfter.has(el.index)) continue;
      const key = keyOf(el);
      if (key === null) continue;
      const list = buckets.get(key);
      const match = list?.shift();
      if (!match) continue;
      matchedBefore.add(match.index);
      matchedAfter.add(el.index);
      pairs.push([match, el]);
    }
  };

  matchByKey(nodePrimaryKey);
  matchByKey(nodeFallbackKey);

  const modified: UiNodeChange[] = [];
  let unchanged = 0;
  for (const [before, after] of pairs) {
    const changes = compareElements(before, after);
    if (changes) {
      modified.push({
        before: elementView(beforeTree, before, true),
        after: elementView(afterTree, after, true),
        changes,
      });
    } else {
      unchanged += 1;
    }
  }

  const added = afterList
    .filter((el) => !matchedAfter.has(el.index))
    .map((el) => elementView(afterTree, el, true));
  const removed = beforeList
    .filter((el) => !matchedBefore.has(el.index))
    .map((el) => elementView(beforeTree, el, true));

  const truncated = added.length > maxItems || removed.length > maxItems || modified.length > maxItems;

  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    counts: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      unchanged,
    },
    added: added.slice(0, maxItems),
    removed: removed.slice(0, maxItems),
    modified: modified.slice(0, maxItems),
    truncated,
  };
}

function scaleRect(
  rect: readonly [number, number, number, number],
  device: { width: number; height: number },
  shot: { width: number; height: number },
): [number, number, number, number] {
  const sx = device.width > 0 ? shot.width / device.width : 1;
  const sy = device.height > 0 ? shot.height / device.height : 1;
  return [
    Math.round(rect[0] * sx),
    Math.round(rect[1] * sy),
    Math.round(rect[2] * sx),
    Math.round(rect[3] * sy),
  ];
}

export const diffUiTreeTool = defineTool({
  name: 'diff_ui_tree',
  title: 'Diff UI tree',
  description: `Captures the current UI tree and compares it against the last baseline captured by \`get_ui_tree\` or \`diff_ui_tree\`, returning added, removed, and modified nodes (text, desc, hint, bounds, and flag changes). Pass \`saveOnly: true\` to record a baseline without diffing; \`updateBaseline: false\` keeps the existing baseline for repeated comparisons. Password text is never returned. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    filter: z.enum(['actionable', 'all']).default('actionable'),
    saveOnly: z
      .boolean()
      .default(false)
      .describe('Capture and store a fresh UI tree baseline without computing a diff.'),
    updateBaseline: z
      .boolean()
      .default(true)
      .describe('Replace the stored baseline with this snapshot after diffing (default true).'),
    serial: optionalSerial,
  }),
  annotations: READ_ONLY,
  async run({ filter, saveOnly, updateBaseline, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const token = ctx.diffBaselines.token(serial);
    const baseline = ctx.diffBaselines.getUi(serial, token);
    if (!saveOnly && !baseline) {
      throw new ToolError(
        `No previous UI tree baseline for ${serial}: call get_ui_tree first (or diff_ui_tree with saveOnly: true)`,
      );
    }

    const { tree, activity } = await dumpUi(ctx, serial, {
      withActivity: true,
      deadline: performance.now() + ELEMENT_CALL_MS,
      signal: ctx.signal,
      token,
    });
    if (!ctx.diffBaselines.isCurrent(token)) {
      throw new ToolError(
        `Device connection or profiling session changed for ${serial} while capturing the UI tree: capture a fresh baseline`,
      );
    }
    const now = ctx.now();

    if (saveOnly) {
      ctx.diffBaselines.setUi(serial, { at: now, tree, activity }, token);
      return {
        data: {
          untrusted: UNTRUSTED_NOTE,
          serial,
          savedBaseline: true,
          package: tree.package,
          activity,
          nodes: tree.elements.length,
        },
      };
    }

    const diff = diffUiTrees(baseline!.tree, tree, filter);
    if (updateBaseline) {
      ctx.diffBaselines.setUi(serial, { at: now, tree, activity }, token);
    }

    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        serial,
        changed: diff.changed,
        packageBefore: baseline!.tree.package,
        packageAfter: tree.package,
        activityBefore: baseline!.activity,
        activityAfter: activity,
        counts: diff.counts,
        added: diff.added,
        removed: diff.removed,
        modified: diff.modified,
        truncated: diff.truncated,
      },
    };
  },
});

export const diffScreenshotTool = defineTool({
  name: 'diff_screenshot',
  title: 'Diff screenshot',
  description:
    'Captures a full-resolution screenshot and compares it against the last baseline captured by `screenshot` or `diff_screenshot`, returning pixel diff metrics (changedCells, totalCells, changedRatio, maxChannelDelta, meanChannelDelta) and connected bounding boxes of changed regions in both device pixels (`bounds`) and screenshot pixels (`shotBounds`). Excludes status and navigation bars by default (`ignoreSystemBars: true`) so the clock does not cause false positives. Pass `saveOnly: true` to record a baseline without diffing, or `updateBaseline: false` to keep the previous baseline. Device control.',
  access: 'device',
  input: z.object({
    saveOnly: z
      .boolean()
      .default(false)
      .describe('Capture and store a fresh screenshot baseline without computing a diff.'),
    updateBaseline: z
      .boolean()
      .default(true)
      .describe('Replace the stored baseline with this screenshot after diffing (default true).'),
    ignoreSystemBars: z
      .boolean()
      .default(true)
      .describe('Exclude status and navigation bars from the diff (default true).'),
    threshold: z
      .number()
      .int()
      .min(1)
      .max(255)
      .default(16)
      .describe(
        'Minimum per-channel mean absolute pixel delta (1–255, inclusive) for an 8×8 px cell to count as changed.',
      ),
    serial: optionalSerial,
  }),
  annotations: READ_ONLY,
  async run({ saveOnly, updateBaseline, ignoreSystemBars, threshold, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const token = ctx.diffBaselines.token(serial);
    const baseline = ctx.diffBaselines.getScreenshot(serial, token);
    if (!saveOnly && !baseline) {
      throw new ToolError(
        `No previous screenshot baseline for ${serial}: call screenshot first (or diff_screenshot with saveOnly: true)`,
      );
    }

    const [png, insets] = await Promise.all([
      screencap(ctx, serial),
      ignoreSystemBars && !saveOnly ? screenInsets(ctx, serial) : null,
    ]);
    if (!ctx.diffBaselines.isCurrent(token)) {
      throw new ToolError(
        `Device connection or profiling session changed for ${serial} while capturing the screenshot: capture a fresh baseline`,
      );
    }
    const decoded = decodeScreenshot(png);
    if (!decoded) {
      throw new ToolError(`Could not decode screenshot from ${serial} for pixel comparison`);
    }
    const device = pngSize(png);
    const shotSize = fitShortEdge(device, SCREENSHOT_SHORT_EDGE);
    ctx.screenshots.set(serial, { shot: shotSize, device, token });

    if (saveOnly) {
      const retained = ctx.diffBaselines.setScreenshot(
        serial,
        { at: ctx.now(), image: decoded, shotSize },
        token,
      );
      return {
        data: {
          serial,
          savedBaseline: retained.saved,
          width: shotSize.width,
          height: shotSize.height,
          deviceWidth: device.width,
          deviceHeight: device.height,
          ...(!retained.saved && retained.reason === 'too_large'
            ? {
                note: `Decoded screenshot (${retained.bytes} bytes) exceeds baseline retention budget (${retained.maxBytes} bytes); baseline was not saved and any previous baseline was preserved.`,
              }
            : {}),
        },
      };
    }

    const diff = screenDiffRegions(
      baseline!.image,
      decoded,
      insets?.bars ?? [],
      threshold,
      MAX_SCREENSHOT_REGIONS,
    );
    const retained = updateBaseline
      ? ctx.diffBaselines.setScreenshot(serial, { at: ctx.now(), image: decoded, shotSize }, token)
      : null;

    const changed = diff.sizeChanged || diff.changedCells > 0;
    const notes: string[] = [];
    if (diff.blank) {
      notes.push('Both screenshots are completely black (a FLAG_SECURE window is captured that way).');
    }
    if (retained && !retained.saved && retained.reason === 'too_large') {
      notes.push(
        `Decoded screenshot (${retained.bytes} bytes) exceeds baseline retention budget (${retained.maxBytes} bytes); previous baseline was preserved.`,
      );
    }
    return {
      data: {
        serial,
        changed: diff.blank ? null : changed,
        sizeChanged: diff.sizeChanged,
        width: shotSize.width,
        height: shotSize.height,
        deviceWidth: device.width,
        deviceHeight: device.height,
        changedCells: diff.changedCells,
        totalCells: diff.totalCells,
        changedRatio: diff.changedRatio,
        maxChannelDelta: diff.maxChannelDelta,
        meanChannelDelta: diff.meanChannelDelta,
        blank: diff.blank,
        totalRegions: diff.totalRegions,
        regions: diff.regions.map((region) => ({
          bounds: region.bounds,
          shotBounds: scaleRect(region.bounds, device, shotSize),
          cells: region.cells,
        })),
        ...(retained && !retained.saved ? { baselineUpdated: false } : {}),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      },
    };
  },
});

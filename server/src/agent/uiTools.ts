/**
 * Element-based device control (opt-in like the other device tools): the UI hierarchy from
 * `uiautomator dump`, and taps, waits and scrolls aimed at elements found by text, description or id.
 * Element taps land on the element's exact center, unlike coordinates read off a scaled screenshot.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { MAX_SCREEN_TEXT_CHARS } from '@lionscope/protocol';
import type { Size } from '../emulator/screenInput.ts';
import {
  input,
  INPUT,
  inputTextArgument,
  optionalSerial,
  PRINTABLE_ASCII,
  SCREENSHOT_SHORT_EDGE,
  targetSerial,
} from './deviceTools.ts';
import { fitShortEdge } from './png.ts';
import { defineTool, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { dumpUi, recentTree } from './uiDump.ts';
import {
  clickTarget,
  distinctTargets,
  elementSignature,
  findElements,
  firstScrollable,
  hasSelector,
  isActionable,
  tapPoint,
  visibleBounds,
  visibleFraction,
} from './uiTree.ts';
import type { Bounds, UiElement, UiSelector, UiTree } from './uiTree.ts';

const MAX_LISTED = 300;
const MAX_CANDIDATES = 10;
const LONG_PRESS_MS = 800;
/** After tapping a field, before typing: the keyboard and focus need a moment. */
const FOCUS_SETTLE_MS = 300;
/** After a scroll swipe, before the next dump: lets the fling settle. */
const SCROLL_SETTLE_MS = 500;
/** Longest a get_ui_tree / tap_element / type_text call may take, retries included. */
export const ELEMENT_CALL_MS = 45_000;
/** Longest a scroll_to call may take (up to 15 swipes, each followed by a dump). */
export const SCROLL_CALL_MS = 90_000;

function scaleBounds(bounds: Bounds, screen: Size, shot: Size): Bounds {
  const sx = screen.width > 0 ? shot.width / screen.width : 1;
  const sy = screen.height > 0 ? shot.height / screen.height : 1;
  return [
    Math.round(bounds[0] * sx),
    Math.round(bounds[1] * sy),
    Math.round(bounds[2] * sx),
    Math.round(bounds[3] * sy),
  ];
}

const FLAG_NAMES = [
  'clickable',
  'longClickable',
  'scrollable',
  'checkable',
  'checked',
  'editable',
  'focused',
  'selected',
  'password',
] as const;

const MAX_LABEL_CHARS = 120;

/** Descendant texts of a container with none of its own (`Button` built from a TextView child). */
function labelOf(tree: UiTree, element: UiElement): string | null {
  const texts: string[] = [];
  for (let i = element.index + 1; i < tree.elements.length && texts.length < 3; i++) {
    const other = tree.elements[i];
    if (!other || other.depth <= element.depth) break;
    const text = other.text ?? other.desc;
    if (text !== null) texts.push(text);
  }
  return texts.length > 0 ? texts.join(' · ').slice(0, MAX_LABEL_CHARS) : null;
}

export function elementView(tree: UiTree, element: UiElement, withLabel = false) {
  const shot = fitShortEdge(tree.screen, SCREENSHOT_SHORT_EDGE);
  const takesTaps = element.clickable || element.longClickable || element.checkable;
  const label =
    withLabel && takesTaps && element.text === null && element.desc === null ? labelOf(tree, element) : null;
  return {
    index: element.index,
    class: element.className,
    ...(element.text !== null ? { text: element.text } : {}),
    ...(element.desc !== null ? { desc: element.desc } : {}),
    ...(label !== null ? { label } : {}),
    ...(element.id !== null ? { id: element.id } : {}),
    ...(element.hint !== null ? { hint: element.hint } : {}),
    bounds: element.bounds,
    shotBounds: scaleBounds(element.bounds, tree.screen, shot),
    flags: [...FLAG_NAMES.filter((name) => element[name]), ...(element.enabled ? [] : ['disabled'])],
  };
}

const selectorFields = {
  text: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Visible text (case-insensitive substring unless exact).'),
  id: z.string().min(1).max(200).optional().describe('Resource id: entry name (`login_button`) or full id.'),
  desc: z.string().min(1).max(200).optional().describe('Content description (accessibility label).'),
  exact: z.boolean().default(false).describe('Match text / desc exactly (case-sensitive).'),
};

function describeSelector(selector: UiSelector): string {
  return Object.entries({ text: selector.text, id: selector.id, desc: selector.desc })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} "${value}"`)
    .join(', ');
}

function requireSelector(selector: UiSelector): void {
  if (!hasSelector(selector)) throw new ToolError('Pass text, id or desc to find the element');
}

type TapOutcome =
  | { tapped: true; element: ReturnType<typeof elementView>; at: { x: number; y: number }; long: boolean }
  | {
      tapped: false;
      ambiguous: true;
      matches: number;
      candidates: ReturnType<typeof elementView>[];
      hint: string;
    };

/** Finds one element (by index of the last listing, or a selector) and taps the center of its visible part. */
export async function tapElement(
  ctx: AgentContext,
  serial: string,
  target: UiSelector & { index?: number | undefined; nth?: number | undefined; long?: boolean },
): Promise<TapOutcome> {
  const deadline = performance.now() + ELEMENT_CALL_MS;
  let tree: UiTree;
  let element: UiElement | undefined;
  if (target.index !== undefined) {
    const listed = ctx.uiDumps.get(serial)?.listing?.elements[target.index];
    if (!listed)
      throw new ToolError(
        'No element with that index: call get_ui_tree first (indexes belong to its listing)',
      );
    tree = (await dumpUi(ctx, serial, { deadline })).tree;
    element = tree.elements[target.index];
    if (!element || elementSignature(element) !== elementSignature(listed)) {
      throw new ToolError(
        'The screen changed since get_ui_tree listed that index: list it again, or select by text, id or desc',
      );
    }
  } else {
    requireSelector(target);
    tree = await recentTree(ctx, serial, deadline);
    const matches = distinctTargets(tree, findElements(tree, target));
    if (matches.length === 0) {
      throw new ToolError(
        `Nothing on the screen matches ${describeSelector(target)}; get_ui_tree lists what is there, scroll_to looks further down`,
      );
    }
    if (matches.length > 1 && target.nth === undefined) {
      return {
        tapped: false,
        ambiguous: true,
        matches: matches.length,
        candidates: matches.slice(0, MAX_CANDIDATES).map((match) => elementView(tree, match, true)),
        hint: 'Several elements match: pass nth (1 = first listed) or a more specific selector (exact, id).',
      };
    }
    element = matches[(target.nth ?? 1) - 1];
    if (!element) throw new ToolError(`Only ${matches.length} elements match ${describeSelector(target)}`);
  }
  const at = tapPoint(element.bounds, tree.screen);
  if (!at) throw new ToolError('The element is off the screen: scroll_to it first');
  const long = target.long === true;
  await input(
    ctx,
    serial,
    long ? `swipe ${at.x} ${at.y} ${at.x} ${at.y} ${LONG_PRESS_MS}` : `tap ${at.x} ${at.y}`,
  );
  const taken = clickTarget(tree, element);
  return { tapped: true, element: elementView(tree, taken === element ? element : taken, true), at, long };
}

export const uiTreeTool = defineTool({
  name: 'get_ui_tree',
  title: 'UI tree',
  description: `The elements on the device screen from Android's accessibility tree (uiautomator), for precise element-based control: index (valid for this listing), class, text, content description (desc), resource id (entry name for the app's own ids), hint, bounds [x1,y1,x2,y2] in device pixels of the current rotation and shotBounds in screenshot pixels, and flags (clickable, scrollable, editable, checked, focused, …). filter actionable (default) keeps elements that can be tapped, scrolled, edited or checked or that carry text; all lists every node. query keeps elements whose text, desc, id, hint or class contains it. Password text is never returned. Also gives the foreground package and activity and the screen size. Compose elements have ids only with testTag + testTagsAsResourceId; WebView or canvas content may be missing (use screenshot). Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    filter: z.enum(['actionable', 'all']).default('actionable'),
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive substring of text, desc, id, hint or class.'),
    serial: optionalSerial,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ filter, query, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const { tree, activity } = await dumpUi(ctx, serial, {
      withActivity: true,
      deadline: performance.now() + ELEMENT_CALL_MS,
    });
    const cached = ctx.uiDumps.get(serial);
    if (cached) cached.listing = tree;
    const needle = query?.toLowerCase();
    const listed = tree.elements
      .filter((element) => filter === 'all' || isActionable(element))
      .map((element) => elementView(tree, element, true))
      .filter(
        (view) =>
          needle === undefined ||
          [view.text, view.desc, view.label, view.id, view.hint, view.class].some((value) =>
            value?.toLowerCase().includes(needle),
          ),
      );
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        serial,
        package: tree.package,
        activity,
        screen: { ...tree.screen, rotation: tree.rotation * 90 },
        screenshotSize: fitShortEdge(tree.screen, SCREENSHOT_SHORT_EDGE),
        nodes: tree.elements.length,
        shown: Math.min(listed.length, MAX_LISTED),
        truncated: tree.truncated || listed.length > MAX_LISTED,
        elements: listed.slice(0, MAX_LISTED),
      },
    };
  },
});

export const tapElementTool = defineTool({
  name: 'tap_element',
  title: 'Tap an element',
  description: `Taps an element found by text (visible text or content description), id or desc (all given fields must match; text and desc are case-insensitive substrings unless exact), or by index from the last get_ui_tree. Taps the exact center of its visible part (long: a long press). If several elements match and nth is not given, nothing is tapped and the candidates come back; nth = 1 picks the first in screen order. Returns what was tapped. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    ...selectorFields,
    index: z.number().int().min(0).optional().describe('Index from the last get_ui_tree.'),
    nth: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Which match to tap when several do (1 = first).'),
    long: z.boolean().default(false).describe('Long press instead of a tap.'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run(args, ctx) {
    const serial = targetSerial(ctx, args.serial);
    return { data: { untrusted: UNTRUSTED_NOTE, serial, ...(await tapElement(ctx, serial, args)) } };
  },
});

export const waitForTool = defineTool({
  name: 'wait_for',
  title: 'Wait for an element',
  description: `Polls the screen until an element matching text, id or desc appears (or, with gone, disappears), up to timeoutMs (default 10 s, at most 30 s). Use it after a tap that opens a screen or dialog, or while something loads. Returns met (true / false on timeout), the time it took and the element. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    ...selectorFields,
    gone: z.boolean().default(false).describe('Wait until no element matches.'),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
    intervalMs: z.number().int().min(100).max(5000).default(500).describe('Pause between two looks.'),
    serial: optionalSerial,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    requireSelector(args);
    const serial = targetSerial(ctx, args.serial);
    const start = performance.now();
    const deadline = start + args.timeoutMs;
    let lastError: unknown = null;
    let looked = false;
    for (;;) {
      try {
        const { tree } = await dumpUi(ctx, serial, { deadline });
        looked = true;
        const matches = findElements(tree, args);
        if (args.gone ? matches.length === 0 : matches.length > 0) {
          const [first] = matches;
          return {
            data: {
              untrusted: UNTRUSTED_NOTE,
              met: true,
              elapsedMs: Math.round(performance.now() - start),
              matches: matches.length,
              ...(first ? { element: elementView(tree, first, true) } : {}),
            },
          };
        }
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        lastError = error;
      }
      if (performance.now() + args.intervalMs >= deadline) break;
      await sleep(args.intervalMs);
    }
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        met: false,
        timedOut: true,
        elapsedMs: Math.round(performance.now() - start),
        // Not one look at the screen succeeded: say why.
        ...(!looked && lastError instanceof Error ? { error: lastError.message } : {}),
      },
    };
  },
});

/** Content of the whole tree: unchanged after a swipe means the list is at its end. */
function treeKey(tree: UiTree): string {
  return tree.elements
    .map((element) => `${element.text ?? ''}|${element.desc ?? ''}|${element.bounds.join(',')}`)
    .join(';');
}

export const scrollToTool = defineTool({
  name: 'scroll_to',
  title: 'Scroll to an element',
  description: `Swipes inside the first scrollable container on the screen (or the whole screen) until an element matching text, id or desc is at least half visible, then returns it without tapping (follow with tap_element). direction down reveals what is further down (the finger moves up). Stops after maxSwipes (default 10, at most 15) or at the end of the list. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    ...selectorFields,
    direction: z.enum(['down', 'up']).default('down'),
    maxSwipes: z.number().int().min(1).max(15).default(10),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run(args, ctx) {
    requireSelector(args);
    const serial = targetSerial(ctx, args.serial);
    const deadline = performance.now() + SCROLL_CALL_MS;
    let previous: string | null = null;
    for (let swipes = 0; ; swipes++) {
      const { tree } = await dumpUi(ctx, serial, { deadline });
      const container = firstScrollable(tree);
      const screenArea: Bounds = [0, 0, tree.screen.width, tree.screen.height];
      const area = (container && visibleBounds(container.bounds, tree.screen)) ?? screenArea;
      const found = findElements(tree, args).find(
        (element) =>
          visibleFraction(element.bounds, area) >= 0.5 && visibleFraction(element.bounds, screenArea) >= 0.5,
      );
      if (found)
        return {
          data: { untrusted: UNTRUSTED_NOTE, found: true, swipes, element: elementView(tree, found, true) },
        };
      const key = treeKey(tree);
      const reachedEnd = key === previous;
      if (reachedEnd || swipes >= args.maxSwipes) {
        return { data: { untrusted: UNTRUSTED_NOTE, found: false, swipes, reachedEnd } };
      }
      previous = key;
      const x = Math.floor((area[0] + area[2]) / 2);
      const height = area[3] - area[1];
      const [fromY, toY] =
        args.direction === 'down'
          ? [area[1] + Math.floor(height * 0.75), area[1] + Math.floor(height * 0.25)]
          : [area[1] + Math.floor(height * 0.25), area[1] + Math.floor(height * 0.75)];
      await input(ctx, serial, `swipe ${x} ${fromY} ${x} ${toY} 400`);
      await sleep(SCROLL_SETTLE_MS);
    }
  },
});

export const typeTextTool = defineTool({
  name: 'type_text',
  title: 'Type text',
  description: `Types text into the focused field, as the keyboard would; pass field (text, id or desc, like tap_element) to tap the field first. Printable ASCII only (not the sequence %s, which adb input types as a space), up to ${MAX_SCREEN_TEXT_CHARS} characters; use press_key enter to submit. If field matches several elements, nothing is typed and the candidates come back. Device control.`,
  access: 'device',
  input: z.object({
    text: z
      .string()
      .min(1)
      .max(MAX_SCREEN_TEXT_CHARS)
      .regex(PRINTABLE_ASCII, 'printable ASCII only')
      .refine((text) => !text.includes('%s'), 'can\'t contain "%s" (adb input types it as a space)'),
    field: z
      .object({ ...selectorFields, nth: z.number().int().min(1).max(100).optional() })
      .optional()
      .describe('The field to tap before typing, to focus it.'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ text, field, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    if (field) {
      const focused = await tapElement(ctx, serial, field);
      if (!focused.tapped) return { data: { untrusted: UNTRUSTED_NOTE, serial, typed: 0, field: focused } };
      await sleep(FOCUS_SETTLE_MS);
    }
    try {
      await input(ctx, serial, `text ${inputTextArgument(text)}`);
    } catch {
      // The text may be a password: it must not reach an error or a log line.
      throw new ToolError(`Typing on ${serial} failed`);
    }
    return { data: { serial, typed: text.length } };
  },
});

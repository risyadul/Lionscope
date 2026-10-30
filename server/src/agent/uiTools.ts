/**
 * Element-based device control (opt-in like the other device tools): the UI hierarchy from
 * `uiautomator dump`, and taps, waits and scrolls aimed at elements found by text, description, id or hint.
 * Element taps land on the element's exact center, unlike coordinates read off a scaled screenshot. Taps and
 * typing read the screen back afterwards, so the answer shows what the action did.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { MAX_SCREEN_TEXT_CHARS } from '@lionscope/protocol';
import type { Size } from '../emulator/screenInput.ts';
import {
  AGENT_KEYCODES,
  input,
  INPUT,
  inputTextArgument,
  optionalSerial,
  PRINTABLE_ASCII,
  READBACK_SETTLE_MS,
  SCREENSHOT_SHORT_EDGE,
  SCROLL_SETTLE_MS,
  targetSerial,
} from './deviceTools.ts';
import { aboveKeyboard, inside, joinNotes, KEYBOARD_UNCHECKED, screenInsets } from './insets.ts';
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
  MAX_UI_TEXT_CHARS,
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
/**
 * The part of an element above the keyboard is tapped only when it is at least this share of the screen's short
 * edge high (about 24 dp on a phone), or half the element's visible height.
 */
const MIN_ABOVE_KEYBOARD = 0.06;
/** Android 13 (API 33) is the first whose `input keycombination` holds ctrl down for the next key (ctrl+A). */
const KEY_COMBINATION_MIN_API = 33;
const KEYCODE_FORWARD_DEL = 112;
const KEYCODE_MOVE_END = 123;
/** Key codes per `input keyevent` when a field is cleared key by key: each call has its own timeout. */
const KEYS_PER_INPUT = 100;
const API_LEVEL_TIMEOUT_MS = 5000;
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
  hint: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "A field's hint (placeholder text), as get_ui_tree lists it: it keeps matching once the field has text. Where the dump has no hints (older Android), it matches a field's text instead.",
    ),
  exact: z.boolean().default(false).describe('Match text / desc / hint exactly (case-sensitive).'),
};

function describeSelector(selector: UiSelector): string {
  return Object.entries({ text: selector.text, id: selector.id, desc: selector.desc, hint: selector.hint })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} "${value}"`)
    .join(', ');
}

function requireSelector(selector: UiSelector): void {
  if (!hasSelector(selector)) throw new ToolError('Pass text, id, desc or hint to find the element');
}

/** A dump of the screen after an action, or why there is none (the action itself has happened). */
async function readBack(ctx: AgentContext, serial: string, deadline: number): Promise<UiTree | string> {
  await sleep(READBACK_SETTLE_MS);
  try {
    return (await dumpUi(ctx, serial, { deadline })).tree;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return error.message;
  }
}

/** What names an element: its text or desc, else (a row, a Preference) the first text inside it. */
function titleOf(tree: UiTree, element: UiElement): string | null {
  if (element.text !== null || element.desc !== null) return `${element.text ?? ''}|${element.desc ?? ''}`;
  for (let i = element.index + 1; i < tree.elements.length; i++) {
    const other = tree.elements[i];
    if (!other || other.depth <= element.depth) break;
    const text = other.text ?? other.desc;
    if (text !== null) return text;
  }
  return null;
}

/**
 * The element in a later dump: same package, class, id and bounds, and the same title unless it is a field, or a
 * toggle with an id whose checked state changed (a ToggleButton's ON / OFF, a Follow / Following chip). A different
 * row slid into the same place (an item deleted) is not the element.
 */
function findAgain(before: UiTree, element: UiElement, later: UiTree): UiElement | null {
  const bounds = element.bounds.join();
  const title = titleOf(before, element);
  return (
    later.elements.find(
      (other) =>
        other.package === element.package &&
        other.className === element.className &&
        other.id === element.id &&
        other.bounds.join() === bounds &&
        (element.editable ||
          titleOf(later, other) === title ||
          (element.checkable && element.id !== null && other.checked !== element.checked)),
    ) ?? null
  );
}

/** The element if it is checkable, else the only checkable element inside it (a Preference's Switch). */
function toggleOf(tree: UiTree, element: UiElement): UiElement | null {
  if (element.checkable) return element;
  let toggle: UiElement | null = null;
  for (let i = element.index + 1; i < tree.elements.length; i++) {
    const other = tree.elements[i];
    if (!other || other.depth <= element.depth) break;
    if (!other.checkable) continue;
    // Several: which one the tap changed is unknown.
    if (toggle) return null;
    toggle = other;
  }
  return toggle;
}

/** Everything a dump shows, to tell whether the screen changed. */
function screenKey(tree: UiTree): string {
  return tree.elements
    .map((e) => `${elementSignature(e)}${e.checked}${e.selected}${e.focused}${e.enabled}`)
    .join(';');
}

type View = ReturnType<typeof elementView>;

type TapOutcome =
  | {
      tapped: true;
      element: View;
      at: { x: number; y: number };
      long: boolean;
      after?: View | null;
      checked?: { before: boolean; after: boolean | null };
      screenChanged?: boolean;
      note?: string;
    }
  | {
      tapped: false;
      ambiguous: true;
      matches: number;
      candidates: View[];
      hint: string;
    };

function isAncestor(tree: UiTree, ancestor: UiElement, element: UiElement): boolean {
  for (let current = element.parent; current !== null; current = tree.elements[current]?.parent ?? null) {
    if (current === ancestor.index) return true;
  }
  return false;
}

/**
 * Where to tap an element whose center a docked keyboard covers: the center of its part above the keyboard. Null
 * when that part is a sliver (see MIN_ABOVE_KEYBOARD), or when another element that takes taps holds the point
 * (not the element's ancestors or descendants): apps often lift a button bar or an input row above the keyboard.
 * The dump gives no drawing order, so a clickable view under the element refuses too, and a bar that eats touches
 * without being clickable (a Compose Surface) is not seen.
 */
function pointAboveKeyboard(tree: UiTree, element: UiElement, ime: Bounds): { x: number; y: number } | null {
  const visible = visibleBounds(element.bounds, tree.screen);
  const above = visible && aboveKeyboard(visible, ime);
  if (!visible || !above) return null;
  const shortEdge = Math.min(tree.screen.width, tree.screen.height);
  const needed = Math.min(shortEdge * MIN_ABOVE_KEYBOARD, (visible[3] - visible[1]) / 2);
  if (above[3] - above[1] < needed) return null;
  const at = tapPoint(above, tree.screen);
  if (!at) return null;
  const covers = (other: UiElement) =>
    other !== element &&
    (other.clickable || other.longClickable || other.checkable || other.editable) &&
    !isAncestor(tree, other, element) &&
    !isAncestor(tree, element, other) &&
    inside(other.bounds, at);
  return tree.elements.some(covers) ? null : at;
}

/**
 * Finds one element (by index of the last listing, or a selector) and taps the center of its visible part; with
 * readBack, then reads the screen again and returns that element as it is after the tap. `taken` is the element
 * that took the tap, as it was before (null when nothing was tapped).
 */
export async function tapElement(
  ctx: AgentContext,
  serial: string,
  target: UiSelector & {
    index?: number | undefined;
    nth?: number | undefined;
    long?: boolean;
    readBack?: boolean;
  },
): Promise<{ outcome: TapOutcome; taken: UiElement | null }> {
  const deadline = performance.now() + ELEMENT_CALL_MS;
  // Where the keyboard is: a dump shows no keyboard, and one taken while it slid in has the layout from before.
  const insets = screenInsets(ctx, serial);
  const keyboard = insets.then((read) => read?.ime ?? null);
  let ime: Bounds | null;
  let tree: UiTree;
  let element: UiElement | undefined;
  if (target.index !== undefined) {
    const listed = ctx.uiDumps.get(serial)?.listing?.elements[target.index];
    if (!listed)
      throw new ToolError(
        'No element with that index: call get_ui_tree first (indexes belong to its listing)',
      );
    tree = (await dumpUi(ctx, serial, { deadline })).tree;
    ime = await keyboard;
    element = tree.elements[target.index];
    if (!element || elementSignature(element) !== elementSignature(listed)) {
      throw new ToolError(
        'The screen changed since get_ui_tree listed that index: list it again, or select by text, id, desc or hint',
      );
    }
  } else {
    requireSelector(target);
    ime = await keyboard;
    tree = ime ? (await dumpUi(ctx, serial, { deadline })).tree : await recentTree(ctx, serial, deadline);
    const matches = distinctTargets(tree, findElements(tree, target));
    if (matches.length === 0) {
      throw new ToolError(
        `Nothing on the screen matches ${describeSelector(target)}; get_ui_tree lists what is there, scroll_to looks further down`,
      );
    }
    if (matches.length > 1 && target.nth === undefined) {
      const outcome: TapOutcome = {
        tapped: false,
        ambiguous: true,
        matches: matches.length,
        candidates: matches.slice(0, MAX_CANDIDATES).map((match) => elementView(tree, match, true)),
        hint: 'Several elements match: pass nth (1 = first listed) or a more specific selector (exact, id).',
      };
      return { outcome, taken: null };
    }
    element = matches[(target.nth ?? 1) - 1];
    if (!element) throw new ToolError(`Only ${matches.length} elements match ${describeSelector(target)}`);
  }
  let at = tapPoint(element.bounds, tree.screen);
  if (!at) throw new ToolError('The element is off the screen: scroll_to it first');
  if (ime && inside(ime, at)) {
    at = pointAboveKeyboard(tree, element, ime);
    if (!at) {
      throw new ToolError(
        `The keyboard covers the element (the keyboard starts at y ${ime[1]}, in device pixels): nothing was tapped. Hide the keyboard with press_key back, then tap again`,
      );
    }
  }
  const long = target.long === true;
  await input(
    ctx,
    serial,
    long ? `swipe ${at.x} ${at.y} ${at.x} ${at.y} ${LONG_PRESS_MS}` : `tap ${at.x} ${at.y}`,
  );
  const taken = clickTarget(tree, element);
  const unchecked = (await insets) === null ? KEYBOARD_UNCHECKED : null;
  const tapped = {
    tapped: true as const,
    element: elementView(tree, taken, true),
    at,
    long,
    ...(unchecked ? { note: unchecked } : {}),
  };
  if (target.readBack !== true) return { outcome: tapped, taken };
  const later = await readBack(ctx, serial, deadline);
  if (typeof later === 'string') {
    return {
      outcome: {
        ...tapped,
        after: null,
        note: joinNotes(`Could not read the screen after the tap: ${later}`, unchecked),
      },
      taken,
    };
  }
  const again = findAgain(tree, taken, later);
  const toggle = toggleOf(tree, taken);
  const toggleAfter = again && toggleOf(later, again);
  const outcome: TapOutcome = {
    ...tapped,
    after: again && elementView(later, again, true),
    ...(toggle
      ? { checked: { before: toggle.checked, after: toggleAfter ? toggleAfter.checked : null } }
      : {}),
    screenChanged: screenKey(later) !== screenKey(tree),
    ...(again
      ? {}
      : {
          note: joinNotes(
            'The element moved or is gone (another screen opened, the keyboard shifted the layout, or a list item was removed): get_ui_tree shows the screen now',
            unchecked,
          ),
        }),
  };
  return { outcome, taken };
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
  description: `Taps an element found by text (visible text or content description), id, desc or hint, a field's placeholder (all given fields must match; text, desc and hint are case-insensitive substrings unless exact), or by index from the last get_ui_tree. Taps the exact center of its visible part (long: a long press); the part under the soft keyboard is not visible: above a docked keyboard the part above it is tapped when it is high enough and no other element takes taps there, else nothing is tapped and the error says to hide the keyboard with press_key back first (scroll_to does not know about the keyboard). Other windows on top (dialogs of other apps, overlays) are not checked; when the keyboard can't be located, the tap is sent and a note says so. If several elements match and nth is not given, nothing is tapped and the candidates come back; nth = 1 picks the first in screen order. Returns what took the tap as it was before (element) and, from a fresh dump about ${READBACK_SETTLE_MS} ms later: after, the same element (same place and title) or null with a note when it moved or is gone; checked {before, after} for a switch or checkbox, the tapped one or the only one inside the tapped row; screenChanged, whether anything on the screen differs (content that changes on its own, such as a timer, a carousel or a loading list, sets it too: false is the reliable signal that the tap changed nothing). readBack false skips that second dump. Device control. ${UNTRUSTED_DESCRIPTION}`,
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
    readBack: z
      .boolean()
      .default(true)
      .describe('Read the element again after the tap (adds a dump, a few hundred ms to 2 s).'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run(args, ctx) {
    const serial = targetSerial(ctx, args.serial);
    const { outcome } = await tapElement(ctx, serial, args);
    return { data: { untrusted: UNTRUSTED_NOTE, serial, ...outcome } };
  },
});

export const waitForTool = defineTool({
  name: 'wait_for',
  title: 'Wait for an element',
  description: `Polls the screen until an element matching text, id, desc or hint appears (or, with gone, disappears), up to timeoutMs (default 10 s, at most 30 s). Use it after a tap that opens a screen or dialog, or while something loads. Returns met (true / false on timeout), the time it took and the element. Device control. ${UNTRUSTED_DESCRIPTION}`,
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
  description: `Swipes inside the first scrollable container on the screen (or the whole screen) until an element matching text, id, desc or hint is at least half visible, then returns it without tapping (follow with tap_element). direction down reveals what is further down (the finger moves up). Stops after maxSwipes (default 10, at most 15) or at the end of the list. Device control. ${UNTRUSTED_DESCRIPTION}`,
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

/**
 * Whether an element of a later dump (`later`) is the tapped one, or lies inside it. The keyboard may pan or
 * scroll a field, and the row around it may resize it (a compose box hides its icons once it has text): the only
 * element with the tapped one's package, class and id (else hint) is that field wherever it is. When several
 * share them (a list of fields), it must not have moved.
 */
function isTapped(element: UiElement, tapped: UiElement, later: UiTree): boolean {
  const twin = (other: UiElement) =>
    other.package === tapped.package &&
    other.className === tapped.className &&
    (tapped.id !== null ? other.id === tapped.id : tapped.hint !== null && other.hint === tapped.hint);
  if (twin(element) && later.elements.filter(twin).length === 1) return true;
  if (
    element.package === tapped.package &&
    element.className === tapped.className &&
    element.id === tapped.id
  )
    return element.bounds.join() === tapped.bounds.join();
  const [x1, y1, x2, y2] = tapped.bounds;
  const [ex1, ey1, ex2, ey2] = element.bounds;
  return ex1 >= x1 && ey1 >= y1 && ex2 <= x2 && ey2 <= y2;
}

/**
 * The field typed into, in a dump after typing: the focused editable element, else the tapped field (or a field
 * inside what was tapped).
 */
function typedField(tree: UiTree, tapped: UiElement | null): UiElement | null {
  const focused = tree.elements.find((element) => element.focused && element.editable);
  if (focused) return focused;
  return (
    (tapped && tree.elements.find((element) => element.editable && isTapped(element, tapped, tree))) ?? null
  );
}

/** A field's text as typed: '' when it is empty and shows its hint instead; null for a password field. */
function fieldText(field: UiElement): string | null {
  if (field.password) return null;
  return field.text === field.hint ? '' : (field.text ?? '');
}

type TypeMode = 'cursor' | 'append' | 'replace';

/**
 * Whether the field shows what was typed: after replace it is just that; otherwise it contains it (at the end,
 * after append) and grew by its length since `before` (or, empty before, holds just it). Null when the dump
 * can't tell, with the reason.
 */
function typedMatches(
  field: UiElement,
  typed: string,
  before: string | null,
  mode: TypeMode,
): { matches: boolean | null; note?: string } {
  const text = fieldText(field);
  if (text === null)
    return { matches: null, note: 'A password field does not report its text: check the result another way' };
  if (text.length >= MAX_UI_TEXT_CHARS || (before?.length ?? 0) >= MAX_UI_TEXT_CHARS) {
    return {
      matches: null,
      note: `The UI tree cuts text at ${MAX_UI_TEXT_CHARS} characters: the field's text can't be compared`,
    };
  }
  if (mode === 'replace') return { matches: text === typed };
  if (!(mode === 'append' ? text.endsWith(typed) : text.includes(typed))) return { matches: false };
  // An empty field without a hint attribute in the dump showed its hint as its text before (but unchanged text
  // means nothing arrived).
  if (before !== null) {
    const grown = mode === 'append' ? text === before + typed : text.length === before.length + typed.length;
    return { matches: text !== before && (grown || text === typed) };
  }
  return {
    matches: null,
    note: 'The field may have held this text before typing: pass field, so it is compared with the field as it was',
  };
}

/** The device's API level (the UI helper reads it once per device), null when unknown. */
async function apiLevel(ctx: AgentContext, serial: string, deadline: number): Promise<number | null> {
  const timeoutMs = Math.floor(Math.min(API_LEVEL_TIMEOUT_MS, deadline - performance.now()));
  if (!ctx.uiHelper || timeoutMs <= 0) return null;
  return ctx.uiHelper.apiLevel(serial, timeoutMs);
}

/**
 * The field append or replace works on, from a fresh dump: the focused text field, which must be the tapped one
 * (a field that opens a picker instead of the keyboard takes no focus). Refused before any key when there is none.
 */
async function fieldToEdit(
  ctx: AgentContext,
  serial: string,
  tapped: UiElement | null,
  deadline: number,
): Promise<UiElement> {
  const { tree } = await dumpUi(ctx, serial, { deadline });
  const focused = tree.elements.find((element) => element.focused && element.editable);
  if (tapped && !(focused && isTapped(focused, tapped, tree))) {
    throw new ToolError(
      'The tapped field did not take the focus (it may open a picker or another screen instead of the keyboard): no key was sent',
    );
  }
  if (!focused) throw new ToolError('No focused text field to append to or replace the text of: pass field');
  return focused;
}

/**
 * Before typing in append or replace mode: moves the caret to the end of the field's text, or deletes it
 * (nothing for an empty field). Android 13+ gets ctrl+End, or ctrl+A (select all) and Delete. Older versions (and
 * a device whose version is unknown) have no ctrl: append presses End (the end of the caret's line in a multi-line
 * field), and replace deletes as many characters as the UI tree shows, key by key: End then Delete in a
 * single-line field, Delete and Forward delete around the caret when the text has line breaks.
 */
async function prepareField(
  ctx: AgentContext,
  serial: string,
  mode: 'append' | 'replace',
  field: UiElement,
  deadline: number,
): Promise<void> {
  const text = fieldText(field);
  if (text === '') return;
  const api = await apiLevel(ctx, serial, deadline);
  if (api !== null && api >= KEY_COMBINATION_MIN_API) {
    if (mode === 'append') {
      await input(ctx, serial, 'keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END');
    } else {
      await input(ctx, serial, 'keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
      await input(ctx, serial, `keyevent ${AGENT_KEYCODES.delete}`);
    }
    return;
  }
  if (mode === 'append') {
    await input(ctx, serial, `keyevent ${KEYCODE_MOVE_END}`);
    return;
  }
  if (text === null || text.length >= MAX_UI_TEXT_CHARS) {
    const why =
      api === null
        ? "this device's Android version could not be read, so the text is deleted key by key"
        : 'before Android 13 the text is deleted key by key';
    throw new ToolError(
      `Can't replace the text of a password field, or of one with ${MAX_UI_TEXT_CHARS} characters or more: ${why}, as many characters as the UI tree shows`,
    );
  }
  const keys = text.includes('\n')
    ? [
        ...Array<number>(text.length).fill(AGENT_KEYCODES.delete),
        ...Array<number>(text.length).fill(KEYCODE_FORWARD_DEL),
      ]
    : [KEYCODE_MOVE_END, ...Array<number>(text.length).fill(AGENT_KEYCODES.delete)];
  for (let i = 0; i < keys.length; i += KEYS_PER_INPUT) {
    await input(ctx, serial, `keyevent ${keys.slice(i, i + KEYS_PER_INPUT).join(' ')}`);
  }
}

export const typeTextTool = defineTool({
  name: 'type_text',
  title: 'Type text',
  description: `Types text into the focused field, as the keyboard would; pass field (text, id, desc or hint, like tap_element; hint keeps matching once the field has text, where get_ui_tree lists hints) to tap the field first. mode cursor (default) inserts at the caret, which lands where the tap landed; append moves the caret to the end first; replace deletes the field's text first, and replace with text "" just clears the field. append and replace need a focused text field: the one given must take the focus (one that opens a picker instead gets no key), else the focused one is used. Before Android 13, append reaches the end of the caret's line only (multi-line fields), and replace deletes the characters the UI tree shows, so it can't replace a password field's text, and in a multi-line field whose text wraps without line breaks it may leave part of it (matches then says false). Printable ASCII only (not the sequence %s, which adb input types as a space), up to ${MAX_SCREEN_TEXT_CHARS} characters; use press_key enter to submit. If field matches several elements, nothing is typed and the candidates come back. Then reads the field back from a fresh dump (about ${READBACK_SETTLE_MS} ms later): field is the focused field as it is now (null with a note when there is none); with field given, sameField says whether it is the one tapped (if not, its text is left out). matches says whether the text arrived: the field contains it (at the end, for append) and grew by its length, or for replace holds just it (null when that can't be told: a password field, whose text is never returned, or cursor mode without field, where the text found may have been there before). Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    text: z
      .string()
      .max(MAX_SCREEN_TEXT_CHARS)
      .refine((text) => text === '' || PRINTABLE_ASCII.test(text), 'printable ASCII only')
      .refine((text) => !text.includes('%s'), 'can\'t contain "%s" (adb input types it as a space)')
      .describe('The text to type; "" only with mode replace, to clear the field.'),
    mode: z
      .enum(['cursor', 'append', 'replace'])
      .default('cursor')
      .describe('cursor: insert at the caret; append: at the end of the text; replace: instead of the text.'),
    field: z
      .object({ ...selectorFields, nth: z.number().int().min(1).max(100).optional() })
      .optional()
      .describe('The field to tap before typing, to focus it.'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ text, mode, field, serial: requested }, ctx) {
    if (text === '' && mode !== 'replace')
      throw new ToolError('Pass the text to type (an empty text only clears a field, with mode replace)');
    const serial = targetSerial(ctx, requested);
    const deadline = performance.now() + ELEMENT_CALL_MS;
    let tapped: UiElement | null = null;
    let before: string | null = null;
    if (field) {
      const focused = await tapElement(ctx, serial, field);
      if (!focused.outcome.tapped)
        return { data: { untrusted: UNTRUSTED_NOTE, serial, typed: 0, field: focused.outcome } };
      tapped = focused.taken;
      if (tapped?.editable) before = fieldText(tapped);
      await sleep(FOCUS_SETTLE_MS);
    }
    if (mode !== 'cursor') {
      const editing = await fieldToEdit(ctx, serial, tapped, deadline);
      before = fieldText(editing);
      await prepareField(ctx, serial, mode, editing, deadline);
    }
    try {
      if (text !== '') await input(ctx, serial, `text ${inputTextArgument(text)}`);
    } catch {
      // The text may be a password: it must not reach an error or a log line.
      throw new ToolError(`Typing on ${serial} failed`);
    }
    const typed = { untrusted: UNTRUSTED_NOTE, serial, typed: text.length };
    const later = await readBack(ctx, serial, deadline);
    if (typeof later === 'string') {
      return {
        data: { ...typed, field: null, matches: null, note: `Could not read the field back: ${later}` },
      };
    }
    const found = typedField(later, tapped);
    if (!found) {
      return {
        data: {
          ...typed,
          field: null,
          matches: null,
          note: 'No focused text field on the screen after typing: get_ui_tree shows the screen now',
        },
      };
    }
    if (tapped && !isTapped(found, tapped, later)) {
      // Another field than the one tapped: its text could be what was typed, if it is a secret, so it is left out.
      const { text: _text, ...view } = elementView(later, found);
      const { matches } = typedMatches(found, text, null, mode);
      return {
        data: {
          ...typed,
          field: view,
          sameField: false,
          matches,
          note: 'The focused field is not the one tapped (focus moved on, as in a code field that advances, or the tap missed): its text is left out',
        },
      };
    }
    return {
      data: {
        ...typed,
        field: elementView(later, found),
        ...(tapped ? { sameField: true } : {}),
        ...typedMatches(found, text, before, mode),
      },
    };
  },
});

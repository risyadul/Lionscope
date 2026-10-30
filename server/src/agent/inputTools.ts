/**
 * `run_inputs`: a timed sequence of taps, keys and waits run on the device in one `adb shell`, so the spacing
 * between inputs is what the caller asks for, not a tool round trip each. Every element is found and every
 * coordinate mapped before the first input is sent; the shell script holds only numbers and allowlisted key codes.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_KEYCODES,
  coordinateSpace,
  INPUT,
  optionalSerial,
  targetSerial,
  toDevicePoints,
} from './deviceTools.ts';
import type { AgentKey } from './deviceTools.ts';
import { inside, joinNotes, screenInsets } from './insets.ts';
import { defineTool, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { dumpUi, invalidateUi } from './uiDump.ts';
import {
  elementView,
  listedElement,
  pointAboveKeyboard,
  relistedElement,
  requireSelector,
  selectElement,
  selectorFields,
} from './uiTools.ts';
import { clickTarget, tapPoint } from './uiTree.ts';
import type { Bounds, UiElement, UiTree } from './uiTree.ts';

export const MAX_STEPS = 100;
export const MAX_TOTAL_WAIT_MS = 60_000;
/** Longest a run_inputs call may take, the UI dump included: under the 120 s a `lionscope query` call waits. */
const RUN_CALL_MS = 110_000;
/** The share of the call the UI dump for tap_element steps may take. */
const RESOLVE_MS = 20_000;
/**
 * What one input is reckoned to take when checking that a sequence fits the call: well above the 15-30 ms of
 * Android 16, for older versions where every `input` starts a VM.
 */
export const INPUT_ESTIMATE_MS = 500;
/** Waits plus INPUT_ESTIMATE_MS per input may come to this much: what is left of the call after the dump. */
export const SEQUENCE_BUDGET_MS = 80_000;
/** Added to the result when tap_element steps were resolved without knowing where the keyboard is. */
const KEYBOARD_UNCHECKED =
  'The soft keyboard check was skipped (dumpsys did not say where the keyboard is): if it was open, tap_element steps may have hit keys';
/** Why a key step in the sequence can't clear the way for a tap_element step after it. */
const HIDE_KEYBOARD_FIRST =
  'Hide the keyboard with press_key back in a call before this one (a back step in the sequence is too late: elements are found before any step runs)';

/** Script output kept (a few dozen bytes per step are expected). */
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_ERROR_CHARS = 200;

const stepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tap'),
    x: z.number().min(0),
    y: z.number().min(0),
  }),
  z.object({
    type: z.literal('tap_element'),
    ...selectorFields,
    index: z.number().int().min(0).optional().describe('Index from the last get_ui_tree.'),
    nth: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Which match to tap when several do (1 = first).'),
  }),
  z.object({
    type: z.literal('key'),
    key: z.enum(Object.keys(AGENT_KEYCODES) as [AgentKey, ...AgentKey[]]),
  }),
  z.object({
    type: z.literal('wait'),
    ms: z.number().int().min(1).max(MAX_TOTAL_WAIT_MS).describe('Pause in ms.'),
  }),
]);

type Step = z.infer<typeof stepSchema>;

const totalWait = (steps: readonly Step[]) =>
  steps.reduce((sum, step) => sum + (step.type === 'wait' ? step.ms : 0), 0);

/** How long the sequence may take on the device: its waits, plus INPUT_ESTIMATE_MS per input. */
const estimateMs = (steps: readonly Step[]) =>
  totalWait(steps) + steps.filter((step) => step.type !== 'wait').length * INPUT_ESTIMATE_MS;

/** A step as the shell runs it: an input in device pixels or key code, or a pause. */
export type PlannedStep =
  | { type: 'tap' | 'tap_element'; x: number; y: number }
  | { type: 'key'; key: AgentKey }
  | { type: 'wait'; ms: number };

/**
 * mksh's microsecond clock, read without starting a process (Android 7.0+ ships it, as it ships toybox `sleep` with
 * fractions); `date` only for a shell without it.
 */
const NOW = '${EPOCHREALTIME:-$(date +%s.%N)}';

function shellCommand(step: PlannedStep): string {
  switch (step.type) {
    case 'tap':
    case 'tap_element':
      return `input tap ${Math.round(step.x)} ${Math.round(step.y)}`;
    case 'key':
      return `input keyevent ${AGENT_KEYCODES[step.key]}`;
    case 'wait':
      return `sleep ${(step.ms / 1000).toFixed(3)}`;
  }
}

/**
 * One shell script for the whole sequence: a timestamp line at the start and after every step, and on a step
 * that fails (an input, or a `sleep` that refuses a fraction), a line with its exit status and no further step.
 * `marker` is random, so other output cannot forge these lines.
 */
export function buildInputScript(steps: readonly PlannedStep[], marker: string): string {
  const lines = [`m=${marker}`, `t() { echo "$m $1 ${NOW}"; }`, 'f() { echo "$m F $1 $2"; exit 0; }', 't S'];
  steps.forEach((step, index) => {
    lines.push(`${shellCommand(step)} || f ${index} $?`, `t ${index}`);
  });
  return lines.join('; ');
}

/**
 * Runs the script and resolves with its output so far, and why it did not finish (adb dropped, the timeout) or
 * null. adbShell drops the output on a failure; this keeps it, so the steps that ran can still be reported.
 */
function runScript(
  ctx: AgentContext,
  serial: string,
  script: string,
  timeoutMs: number,
): Promise<{ output: string; error: string | null }> {
  return new Promise((resolve) => {
    const child = ctx.adb.spawn(['-s', serial, 'shell', script]);
    // The script reads no input: an open pipe would only be forwarded to the device shell.
    child.stdin?.end();
    let output = '';
    let stderr = '';
    let ended = !child.stdout;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) child.kill();
      resolve({ output, error });
    };
    const maybeDone = () => {
      if (!ended || exit === undefined) return;
      const status =
        exit.code === null
          ? `adb was stopped (${exit.signal ?? 'by a signal'})`
          : `adb exited with ${exit.code}`;
      finish(exit.code === 0 ? null : stderr.trim().slice(0, MAX_ERROR_CHARS) || status);
    };
    const timer = setTimeout(() => finish(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      if (output.length < MAX_OUTPUT_CHARS) output += text;
    });
    child.stdout?.on('end', () => {
      ended = true;
      maybeDone();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      stderr = (stderr + text).slice(-4096);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      maybeDone();
    });
    child.on('error', (error) => finish(error.message.slice(0, MAX_ERROR_CHARS)));
  });
}

export interface ScriptResult {
  /** ms from the start mark to the end of each step that ran; null where the device gave no readable clock. */
  ends: (number | null)[];
  failed: { index: number; exitCode: number } | null;
}

/** A clock reading `seconds.fraction` as [seconds, nanoseconds]. */
function readClock(value: string): [number, number] | null {
  const match = /^(\d+)\.(\d{1,9})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  return [Number(match[1]), Number(match[2].padEnd(9, '0'))];
}

/** Reads the script's lines (marker S, then one per finished step, or F for a failed input). */
export function parseScriptOutput(output: string, marker: string, steps: number): ScriptResult {
  let start: [number, number] | null = null;
  const ends: (number | null)[] = [];
  let failed: ScriptResult['failed'] = null;
  for (const line of output.split(/\r?\n/)) {
    const [head, what, value = '', extra] = line.trim().split(' ');
    if (head !== marker || what === undefined) continue;
    if (what === 'S') {
      start = readClock(value);
    } else if (what === 'F') {
      failed = { index: Number(value), exitCode: Number(extra) };
    } else if (/^\d+$/.test(what) && Number(what) === ends.length && ends.length < steps) {
      const at = readClock(value);
      ends.push(
        start && at ? Math.round(((at[0] - start[0]) * 1e3 + (at[1] - start[1]) / 1e6) * 10) / 10 : null,
      );
    }
  }
  return { ends, failed };
}

/**
 * Where a tap_element step taps (the center of the element's visible part, or of its part above a docked keyboard
 * `ime` as tap_element does), and the element that takes it.
 */
function resolveElement(
  ctx: AgentContext,
  serial: string,
  tree: UiTree,
  ime: Bounds | null,
  step: Extract<Step, { type: 'tap_element' }>,
  index: number,
): { x: number; y: number; element: UiElement } {
  let element: UiElement;
  try {
    if (step.index !== undefined) {
      element = relistedElement(tree, listedElement(ctx, serial, step.index));
    } else {
      const selected = selectElement(tree, step);
      if (Array.isArray(selected)) {
        throw new ToolError(
          `${selected.length} elements match: pass nth (1 = first in screen order) or a more specific selector (exact, id); get_ui_tree lists them`,
        );
      }
      element = selected;
    }
  } catch (error) {
    if (error instanceof ToolError) throw new ToolError(`steps[${index}]: ${error.message}`);
    throw error;
  }
  let at = tapPoint(element.bounds, tree.screen);
  if (!at) throw new ToolError(`steps[${index}]: the element is off the screen (scroll_to it first)`);
  if (ime && inside(ime, at)) {
    at = pointAboveKeyboard(tree, element, ime);
    if (!at) {
      throw new ToolError(
        `steps[${index}]: the keyboard covers the element (the keyboard starts at y ${ime[1]}, in device pixels): nothing was sent. ${HIDE_KEYBOARD_FIRST}`,
      );
    }
  }
  return { ...at, element: clickTarget(tree, element) };
}

/**
 * The steps in device terms: taps mapped from screenshot pixels, tap_element steps resolved from one fresh dump
 * (`elements`, by step index) and checked against the keyboard as it is now. Everything that can fail is checked
 * before the dump, and the dump before any input. `keyboardUnchecked` when tap_element steps were resolved without
 * knowing where the keyboard is.
 */
async function planSteps(
  ctx: AgentContext,
  serial: string,
  steps: readonly Step[],
  space: { width?: number | undefined; height?: number | undefined },
  started: number,
): Promise<{
  planned: PlannedStep[];
  tree: UiTree | null;
  elements: Map<number, UiElement>;
  keyboardUnchecked: boolean;
}> {
  steps.forEach((step, index) => {
    if (step.type !== 'tap_element') return;
    try {
      if (step.index !== undefined) listedElement(ctx, serial, step.index);
      else requireSelector(step);
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(`steps[${index}]: ${error.message}`);
      throw error;
    }
  });
  const resolves = steps.some((step) => step.type === 'tap_element');
  // A dump shows no keyboard; read where it is beside the dump (it fails open, as for tap_element).
  const insets = resolves ? screenInsets(ctx, serial) : Promise.resolve(null);
  const taps = steps.flatMap((step) => (step.type === 'tap' ? [{ x: step.x, y: step.y }] : []));
  const points = taps.length > 0 ? await toDevicePoints(ctx, serial, space, taps) : [];
  const tree = resolves ? (await dumpUi(ctx, serial, { deadline: started + RESOLVE_MS })).tree : null;
  const read = await insets;
  const ime = read?.ime ?? null;
  const elements = new Map<number, UiElement>();
  const planned = steps.map((step, index): PlannedStep => {
    if (step.type === 'tap') {
      const point = points.shift();
      if (!point) throw new ToolError('no point');
      return { type: 'tap', ...point };
    }
    if (step.type === 'tap_element') {
      if (!tree) throw new ToolError('no UI dump');
      const { x, y, element } = resolveElement(ctx, serial, tree, ime, step, index);
      elements.set(index, element);
      return { type: 'tap_element', x, y };
    }
    return step;
  });
  return { planned, tree, elements, keyboardUnchecked: resolves && read === null };
}

export const runInputsTool = defineTool({
  name: 'run_inputs',
  title: 'Run a timed input sequence',
  description: `Runs a sequence of steps on the device in one adb shell call, so their spacing is set by wait steps instead of one tool round trip per input (for races that need inputs tens of ms apart). Steps (at most ${MAX_STEPS}; waits at most ${MAX_TOTAL_WAIT_MS / 1000} s in total, and the waits plus ${INPUT_ESTIMATE_MS} ms per input at most ${SEQUENCE_BUDGET_MS / 1000} s): {type: 'tap', x, y} in screenshot pixels like tap (width / height apply to every tap step); {type: 'tap_element', text | id | desc | hint | index, exact, nth} like tap_element; {type: 'key', key} with the keys of press_key; {type: 'wait', ms}. Every tap_element is resolved before anything is sent, from one fresh UI dump, to the center of its element: a selector that matches nothing, or several without nth, fails the call with no input sent. The soft keyboard is checked as tap_element checks it, as it is when the call starts: an element it covers is tapped on its part above a docked keyboard when that part is high enough and no other element takes taps there, else the call fails with no input sent (hide the keyboard with press_key back in a call before: a back step in the sequence runs after the elements are found); when the keyboard can't be located, the steps run unchecked and a note says so. So a tap_element must name an element already on the screen when the call starts: for one that an earlier step opens (a dialog's OK), use a tap with coordinates from a screenshot of that screen, or a separate call; otherwise a match on the current screen is tapped at its old place. Each input costs time itself (about 15-30 ms per tap on an Android 16 emulator, a key more, and more on older Android where \`input\` starts a VM) and a wait takes 5-10 ms more than asked (\`sleep\` is a process), so the actual spacing is the wait plus that: the result gives each step's end (atMs, from the start) and duration (tookMs) measured on the device, and totalMs (the end of the last step that finished). A step that fails stops the sequence (failed says which). If the sequence stops otherwise (adb drops, the time runs out), incomplete says so: the steps listed ran and later ones may have too, so check the screen before running it again; if every step ran and adb failed only afterwards, warning says so. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    steps: z
      .array(stepSchema)
      .min(1)
      .max(MAX_STEPS)
      .refine((steps) => totalWait(steps) <= MAX_TOTAL_WAIT_MS, {
        message: `waits add up to more than ${MAX_TOTAL_WAIT_MS} ms`,
      })
      .refine((steps) => estimateMs(steps) <= SEQUENCE_BUDGET_MS, {
        message: `the waits plus ${INPUT_ESTIMATE_MS} ms per input (what an input can take on older Android) come to more than ${SEQUENCE_BUDGET_MS / 1000} s: use fewer inputs or shorter waits`,
      })
      .describe(
        "The steps in order, e.g. [{type: 'tap_element', text: 'Save'}, {type: 'wait', ms: 50}, {type: 'key', key: 'back'}].",
      ),
    ...coordinateSpace,
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ steps, width, height, serial: requested }, ctx) {
    const started = performance.now();
    const serial = targetSerial(ctx, requested);
    const { planned, tree, elements, keyboardUnchecked } = await planSteps(
      ctx,
      serial,
      steps,
      { width, height },
      started,
    );
    const left = Math.floor(RUN_CALL_MS - (performance.now() - started));
    if (left < estimateMs(steps)) {
      throw new ToolError(
        'Reading the screen took too long to leave time for the sequence; nothing was sent',
      );
    }
    const marker = `__LS_${randomBytes(6).toString('hex')}__`;
    const { output, error } = await runScript(ctx, serial, buildInputScript(planned, marker), left).finally(
      () => invalidateUi(ctx, serial),
    );
    const { ends, failed } = parseScriptOutput(output, marker, planned.length);
    const incomplete = failed === null && ends.length < planned.length;
    // Every step ran, and adb complained after the last one.
    const warning = failed === null && !incomplete && error !== null ? error : null;
    const clocked = ends.length > 0 && ends.every((end) => end !== null);
    const note = joinNotes(
      clocked || ends.length === 0
        ? null
        : 'The device shell has no clock with sub-second resolution: no timings',
      keyboardUnchecked ? KEYBOARD_UNCHECKED : null,
    );
    const results = ends.map((end, index) => {
      const step = planned[index];
      const element = elements.get(index);
      const previous = index === 0 ? 0 : ends[index - 1];
      return {
        index,
        ...step,
        ...(element && tree ? { element: elementView(tree, element, true) } : {}),
        atMs: end,
        tookMs:
          end === null || previous === null || previous === undefined
            ? null
            : Math.round((end - previous) * 10) / 10,
      };
    });
    return {
      data: {
        ...(tree ? { untrusted: UNTRUSTED_NOTE } : {}),
        serial,
        steps: results,
        totalMs: clocked ? (ends.at(-1) ?? null) : null,
        ...(failed
          ? {
              failed: {
                ...failed,
                type: planned[failed.index]?.type,
                note: 'That step failed; the steps after it did not run',
              },
            }
          : {}),
        ...(incomplete
          ? {
              incomplete: {
                ran: ends.length,
                of: planned.length,
                reason: error ?? 'the device stopped answering',
                note: 'The sequence did not finish as reported: the steps listed ran, and the next ones may have run too. Check the screen (get_ui_tree, screenshot) before running it again.',
              },
            }
          : {}),
        ...(warning !== null ? { warning: `Every step ran, but adb then reported: ${warning}` } : {}),
        ...(note ? { note } : {}),
      },
    };
  },
});

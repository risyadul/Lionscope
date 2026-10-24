/**
 * The UI dump for the element tools and the Inspector: from the UI helper (uiHelper.ts) when the context has one,
 * else, or when the helper fails, `uiautomator dump` to a unique file that is always removed. The display size
 * (and the foreground activity) is read in one shell round trip beside it; attempts are retried while the screen
 * has no root or is not idle, bounded by the caller's deadline.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { adbShell } from '../adb/adb.ts';
import { errorMessage } from '../log.ts';
import { parseWmSize, rotate, sameSize, SCREENSHOT_SHORT_EDGE } from './display.ts';
import { fitShortEdge } from './png.ts';
import { ToolError } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { buildUiTree } from './uiTree.ts';
import type { UiTree } from './uiTree.ts';
import { UiHelperError } from './uiHelper.ts';
import { parseUiXml, UiXmlError } from './uiXml.ts';

const DUMP_TIMEOUT_MS = 20_000;
/** The helper's share of an attempt (starting it included); uiautomator gets the rest when it fails. */
const HELPER_DUMP_TIMEOUT_MS = 10_000;
/** Less time than this left, and a helper that is not running yet is not started (that could fail and back off). */
const HELPER_START_MIN_MS = 3000;
/** Less of the deadline left than this, and no dump attempt is started. */
const MIN_ATTEMPT_MS = 300;
/** Waits before the 2nd and 3rd attempt: an animating screen often settles within a second. */
const DUMP_RETRY_MS = [400, 1000];
/** A dump file a killed `uiautomator` may still write is removed again after this long. */
const LATE_CLEANUP_MS = 5000;
const CLEANUP_TIMEOUT_MS = 5000;
/** A dump this recent is reused by tap_element (selectors are resolved against the screen as it is). */
export const FRESH_DUMP_MS = 1000;

export const UI_DUMP_FAILED =
  'uiautomator could not read the screen (it waits for the UI to be idle, and animations or a secure window prevent that). Try again in a moment, or use screenshot and tap by coordinates.';
export const UI_DUMP_TIMEOUT =
  'uiautomator did not answer in time. Try again, or use screenshot and tap by coordinates.';
/** Appended when the UI helper failed before uiautomator did. */
export const UI_HELPER_FAILED_TOO = 'The Lionscope UI helper could not read the screen either';

const resumed = (field: string): RegExp =>
  new RegExp(`${field}[=:]\\s*ActivityRecord\\{\\S+ \\S+ ([\\w.]+)\\/([\\w.$]+)`);
/** The focused resumed activity first (several are resumed in split screen), else the older field. */
const ACTIVITIES = [resumed('topResumedActivity'), resumed('mResumedActivity')];

function resumedActivity(output: string): RegExpExecArray | null {
  for (const pattern of ACTIVITIES) {
    const match = pattern.exec(output);
    if (match) return match;
  }
  return null;
}

/** Prints the resumed (foreground) activity: parseTopActivity / parseTopPackage read it. */
export const TOP_ACTIVITY_COMMAND =
  "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'";

/** The package of the resumed activity, null when there is none (or the output is something else). */
export function parseTopPackage(output: string): string | null {
  return resumedActivity(output)?.[1] ?? null;
}

/** `com.example.shop/.MainActivity` → `com.example.shop.MainActivity`. */
export function parseTopActivity(output: string): string | null {
  const match = resumedActivity(output);
  if (!match?.[1] || !match[2]) return null;
  return match[2].startsWith('.') ? `${match[1]}${match[2]}` : match[2];
}

export interface Dump {
  tree: UiTree;
  activity: string | null;
}

/** The latest dump goes stale: anything that may change the screen calls this (the listing stays). */
export function invalidateUi(ctx: AgentContext, serial?: string): void {
  for (const [key, cached] of ctx.uiDumps) if (serial === undefined || key === serial) cached.at = -Infinity;
}

/** Splits shell output at per-call markers, each section taken after the LAST occurrence of its marker. */
function sections(output: string, markers: readonly string[]): string[] {
  const parts: string[] = [];
  let rest = output;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i] ?? '';
    const at = rest.lastIndexOf(marker);
    if (at < 0) return [];
    parts.unshift(rest.slice(at + marker.length));
    rest = rest.slice(0, at);
  }
  return [rest, ...parts];
}

function removeFile(ctx: AgentContext, serial: string, file: string): void {
  const remove = () =>
    adbShell(ctx.adb, serial, `rm -f ${file}`, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  void remove();
  setTimeout(() => void remove(), LATE_CLEANUP_MS).unref();
}

function shellError(error: unknown): ToolError {
  return new ToolError(/timed out/.test(errorMessage(error)) ? UI_DUMP_TIMEOUT : errorMessage(error));
}

/** `echo <marker>; wm size[; echo <marker>; dumpsys … top activity]`: what a dump is read with. */
function displayCommand(token: string, withActivity: boolean): { command: string; markers: string[] } {
  const markers = [`__LS_${token}_WM__`, ...(withActivity ? [`__LS_${token}_TOP__`] : [])];
  const activity = withActivity ? `; echo ${markers[1]}; ${TOP_ACTIVITY_COMMAND}` : '';
  return { command: `echo ${markers[0]}; wm size${activity}`, markers };
}

/** `uiautomator dump`: the tree, or a status line explaining why there is none (screen not idle, null root). */
async function uiautomatorAttempt(
  ctx: AgentContext,
  serial: string,
  withActivity: boolean,
  timeoutMs: number,
): Promise<Dump | string> {
  const token = randomBytes(6).toString('hex');
  const file = `/data/local/tmp/lionscope-ui-${token}.xml`;
  const display = displayCommand(token, withActivity);
  const markers = [`__LS_${token}_XML__`, ...display.markers];
  const command = `uiautomator dump ${file} 2>&1; echo ${markers[0]}; cat ${file} 2>/dev/null; rm -f ${file}; ${display.command}`;
  let output: string;
  try {
    output = await adbShell(ctx.adb, serial, command, { timeoutMs });
  } catch (error) {
    // Killed on the timeout: the dump may still land on the device.
    removeFile(ctx, serial, file);
    throw shellError(error);
  }
  const [status = '', xml = '', wm = '', top = ''] = sections(output, markers);
  if (!xml.includes('<hierarchy')) return status.trim() || 'no UI dump';
  return readDump(xml, wm, top);
}

/**
 * The UI helper's dump, with the display read beside it: the tree, 'null root node', or null when the helper
 * failed (`failures` says why; uiautomator is tried instead).
 */
async function helperAttempt(
  ctx: AgentContext,
  serial: string,
  withActivity: boolean,
  timeoutMs: number,
  failures: string[],
): Promise<Dump | string | null> {
  const helper = ctx.uiHelper;
  if (!helper) return null;
  const unavailable = helper.unavailable(serial);
  if (unavailable !== null) {
    failures.push(unavailable);
    return null;
  }
  if (timeoutMs < HELPER_START_MIN_MS && !helper.isRunning(serial)) return null;
  const token = randomBytes(6).toString('hex');
  const display = displayCommand(token, withActivity);
  const shell = adbShell(ctx.adb, serial, display.command, { timeoutMs });
  // Settled even when the helper fails first and nobody waits for it.
  shell.catch(() => undefined);
  let dump;
  try {
    dump = await helper.dump(serial, Math.min(HELPER_DUMP_TIMEOUT_MS, timeoutMs));
  } catch (error) {
    if (!(error instanceof UiHelperError)) throw error;
    failures.push(error.message);
    return null;
  }
  if (dump === null) return 'null root node';
  let output: string;
  try {
    output = await shell;
  } catch (error) {
    throw shellError(error);
  }
  const [, wm = '', top = ''] = sections(output, display.markers);
  return readDump(dump.xml, wm, top);
}

/** One attempt: the helper's dump, else uiautomator's, bounded by `deadline`. */
async function attempt(
  ctx: AgentContext,
  serial: string,
  withActivity: boolean,
  deadline: number,
  failures: string[],
): Promise<Dump | string> {
  const timeout = () => Math.floor(Math.min(DUMP_TIMEOUT_MS, deadline - performance.now()));
  const fromHelper = await helperAttempt(ctx, serial, withActivity, timeout(), failures);
  if (fromHelper !== null) return fromHelper;
  if (timeout() < MIN_ATTEMPT_MS) throw new ToolError(UI_DUMP_TIMEOUT);
  return uiautomatorAttempt(ctx, serial, withActivity, timeout());
}

function readDump(xml: string, wm: string, top: string): Dump | string {
  let hierarchy;
  try {
    hierarchy = parseUiXml(xml.trim());
  } catch (error) {
    if (error instanceof UiXmlError) throw new ToolError(`Unreadable UI dump: ${error.message}`);
    throw error;
  }
  const natural = parseWmSize(wm);
  if (!natural) throw new ToolError('Could not read the display size (`wm size`)');
  const tree = buildUiTree(hierarchy, rotate(natural, hierarchy.rotation));
  if (tree.elements.length === 0) return 'null root node';
  return { tree, activity: parseTopActivity(top) };
}

/** Remembers the dump; screenshot coordinates of that size map onto it unless a screenshot of this size exists. */
function remember(ctx: AgentContext, serial: string, tree: UiTree): void {
  const listing = ctx.uiDumps.get(serial)?.listing ?? null;
  ctx.uiDumps.set(serial, { at: performance.now(), tree, listing });
  const shot = ctx.screenshots.get(serial);
  if (!shot || !sameSize(shot.device, tree.screen)) {
    ctx.screenshots.set(serial, {
      shot: fitShortEdge(tree.screen, SCREENSHOT_SHORT_EDGE),
      device: tree.screen,
    });
  }
}

/**
 * Dumps the UI, retrying while the screen is not idle; `deadline` (performance.now()) bounds every attempt
 * and the retries.
 */
export async function dumpUi(
  ctx: AgentContext,
  serial: string,
  options: { withActivity?: boolean; deadline?: number } = {},
): Promise<Dump> {
  const deadline = options.deadline ?? performance.now() + 60_000;
  /** Why the helper gave no dump in this call: named when uiautomator fails too. */
  const failures: string[] = [];
  const helperNote = () => {
    const reason = failures.at(-1);
    return reason === undefined ? '' : ` ${UI_HELPER_FAILED_TOO} (${reason}).`;
  };
  let lastStatus = '';
  for (let i = 0; i <= DUMP_RETRY_MS.length; i++) {
    if (i > 0) await sleep(DUMP_RETRY_MS[i - 1]);
    const remaining = deadline - performance.now();
    if (remaining < MIN_ATTEMPT_MS) {
      if (i === 0) throw new ToolError(UI_DUMP_TIMEOUT);
      break;
    }
    let result;
    try {
      result = await attempt(ctx, serial, options.withActivity === true, deadline, failures);
    } catch (error) {
      if (error instanceof ToolError && failures.length > 0)
        throw new ToolError(`${error.message}${helperNote()}`);
      throw error;
    }
    if (typeof result !== 'string') {
      remember(ctx, serial, result.tree);
      return result;
    }
    lastStatus = result;
  }
  throw new ToolError(
    `${UI_DUMP_FAILED}${lastStatus ? ` (uiautomator: ${lastStatus.slice(0, 200)})` : ''}${helperNote()}`,
  );
}

/** The latest dump if it is under a second old, else a new one. */
export async function recentTree(ctx: AgentContext, serial: string, deadline?: number): Promise<UiTree> {
  const cached = ctx.uiDumps.get(serial);
  if (cached && performance.now() - cached.at <= FRESH_DUMP_MS) return cached.tree;
  return (await dumpUi(ctx, serial, { deadline })).tree;
}

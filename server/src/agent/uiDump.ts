/**
 * `uiautomator dump` for the element tools: one dump to a unique file that is always removed, read together
 * with the display size in one shell round trip, retried while the screen is not idle and bounded by the
 * caller's deadline.
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
import { parseUiXml, UiXmlError } from './uiXml.ts';

const DUMP_TIMEOUT_MS = 20_000;
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

const ACTIVITY = /(?:topResumedActivity|mResumedActivity)[=:]\s*ActivityRecord\{\S+ \S+ ([\w.]+)\/([\w.$]+)/;

/** `com.example.shop/.MainActivity` → `com.example.shop.MainActivity`. */
export function parseTopActivity(output: string): string | null {
  const match = ACTIVITY.exec(output);
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

/** One attempt: the tree, or a status line explaining why there is none (screen not idle, null root). */
async function attempt(
  ctx: AgentContext,
  serial: string,
  withActivity: boolean,
  timeoutMs: number,
): Promise<Dump | string> {
  const token = randomBytes(6).toString('hex');
  const file = `/data/local/tmp/lionscope-ui-${token}.xml`;
  const markers = [
    `__LS_${token}_XML__`,
    `__LS_${token}_WM__`,
    ...(withActivity ? [`__LS_${token}_TOP__`] : []),
  ];
  const activity = withActivity
    ? `; echo ${markers[2]}; dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'`
    : '';
  const command = `uiautomator dump ${file} 2>&1; echo ${markers[0]}; cat ${file} 2>/dev/null; rm -f ${file}; echo ${markers[1]}; wm size${activity}`;
  let output: string;
  try {
    output = await adbShell(ctx.adb, serial, command, { timeoutMs });
  } catch (error) {
    // Killed on the timeout: the dump may still land on the device.
    removeFile(ctx, serial, file);
    throw new ToolError(/timed out/.test(errorMessage(error)) ? UI_DUMP_TIMEOUT : errorMessage(error));
  }
  const [status = '', xml = '', wm = '', top = ''] = sections(output, markers);
  if (!xml.includes('<hierarchy')) return status.trim() || 'no UI dump';
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
  let lastStatus = '';
  for (let i = 0; i <= DUMP_RETRY_MS.length; i++) {
    if (i > 0) await sleep(DUMP_RETRY_MS[i - 1]);
    const remaining = deadline - performance.now();
    if (remaining < MIN_ATTEMPT_MS) {
      if (i === 0) throw new ToolError(UI_DUMP_TIMEOUT);
      break;
    }
    const result = await attempt(
      ctx,
      serial,
      options.withActivity === true,
      Math.floor(Math.min(DUMP_TIMEOUT_MS, remaining)),
    );
    if (typeof result !== 'string') {
      remember(ctx, serial, result.tree);
      return result;
    }
    lastStatus = result;
  }
  throw new ToolError(`${UI_DUMP_FAILED}${lastStatus ? ` (uiautomator: ${lastStatus.slice(0, 200)})` : ''}`);
}

/** The latest dump if it is under a second old, else a new one. */
export async function recentTree(ctx: AgentContext, serial: string, deadline?: number): Promise<UiTree> {
  const cached = ctx.uiDumps.get(serial);
  if (cached && performance.now() - cached.at <= FRESH_DUMP_MS) return cached.tree;
  return (await dumpUi(ctx, serial, { deadline })).tree;
}

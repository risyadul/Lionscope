/**
 * Where the soft keyboard (IME) is, from the window manager's insets state. A UI dump shows the app's window only,
 * and an app drawn edge to edge keeps its elements under the keyboard: there they look tappable, but a tap on
 * them lands on a key.
 */
import { adbShell } from '../adb/adb.ts';
import type { AgentContext } from './tool.ts';
import type { Bounds } from './uiTree.ts';

const IME_TIMEOUT_MS = 5000;

/** The IME's insets source of the default display (listed first): about 50-150 ms on an emulator. */
export const IME_COMMAND =
  "dumpsys window displays | grep -m 1 -E 'InsetsSource (id=[^ ]+ )?type=(ime|ITYPE_IME) '";

const RECT = String.raw`\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]`;
/**
 * `InsetsSource id=3 type=ime frame=[0,1541][1080,2424] visibleFrame=[0,1541][1080,2424] visible=true …` (Android
 * 14+; Android 11-13 print `type=ITYPE_IME` without an id).
 */
const IME_SOURCE = new RegExp(
  String.raw`InsetsSource (?:id=\S+ )?type=(?:ime|ITYPE_IME) frame=${RECT}(?: visibleFrame=${RECT})? visible=(true|false)`,
);

/** The part of the screen the keyboard covers while it is shown, else null (also for output it can't read). */
export function parseImeFrame(output: string): Bounds | null {
  const match = IME_SOURCE.exec(output);
  if (match?.[9] !== 'true') return null;
  const at = match[5] === undefined ? 1 : 5;
  const bounds: Bounds = [
    Number(match[at]),
    Number(match[at + 1]),
    Number(match[at + 2]),
    Number(match[at + 3]),
  ];
  return bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : null;
}

/** The keyboard's frame while it is shown; null when it is hidden or can't be read (then nothing is checked). */
export async function imeFrame(ctx: AgentContext, serial: string): Promise<Bounds | null> {
  try {
    return parseImeFrame(await adbShell(ctx.adb, serial, IME_COMMAND, { timeoutMs: IME_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

export function onKeyboard(ime: Bounds | null, point: { x: number; y: number }): boolean {
  return ime !== null && point.x >= ime[0] && point.x < ime[2] && point.y >= ime[1] && point.y < ime[3];
}

/**
 * The part of on-screen `bounds` above a keyboard that spans their whole width (a docked keyboard), null when
 * nothing of them is above it or the keyboard covers them otherwise (a floating one).
 */
export function aboveKeyboard(bounds: Bounds, ime: Bounds): Bounds | null {
  if (ime[0] > bounds[0] || ime[2] < bounds[2] || ime[1] <= bounds[1]) return null;
  return [bounds[0], bounds[1], bounds[2], Math.min(bounds[3], ime[1])];
}

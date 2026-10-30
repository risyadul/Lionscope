/**
 * The window manager's insets of the default display: where the soft keyboard (IME) and the system bars are. A UI
 * dump shows the app's window only, and an app drawn edge to edge keeps its elements under the keyboard: there
 * they look tappable, but a tap on them lands on a key. The system bars change on their own (the clock), so screen
 * comparisons leave them out.
 */
import { adbShell } from '../adb/adb.ts';
import type { AgentContext } from './tool.ts';
import type { Bounds } from './uiTree.ts';

/** The check fails open (nothing is checked), so a slow dumpsys must not hold the tap up for long. */
const INSETS_TIMEOUT_MS = 1500;

/** Each display's header and its insets sources: about 50-150 ms on an emulator. */
export const INSETS_COMMAND = "dumpsys window displays | grep -E 'Display: mDisplayId=|^ *InsetsSource '";

const DISPLAY = /Display: mDisplayId=(\d+)/;
const RECT = String.raw`\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]`;
/**
 * `InsetsSource id=3 type=ime frame=[0,1541][1080,2424] visibleFrame=[0,1541][1080,2424] visible=true …` (Android
 * 14+; Android 11-13 print `type=ITYPE_IME` without an id). visibleFrame is there while it differs from frame.
 */
const SOURCE = new RegExp(
  String.raw`^\s*InsetsSource (?:id=\S+ )?type=(\w+) frame=${RECT}(?: visibleFrame=${RECT})? visible=(true|false)`,
);
const IME_TYPES = new Set(['ime', 'ITYPE_IME']);
const BAR_TYPES = new Set(['statusBars', 'navigationBars', 'ITYPE_STATUS_BAR', 'ITYPE_NAVIGATION_BAR']);

export interface Insets {
  /** The part of the screen the keyboard covers while it is shown, else null. */
  ime: Bounds | null;
  /** The status and navigation bars that are shown. */
  bars: Bounds[];
}

/** The insets of display 0 (or of the only display listed, when no header is); null when there are none. */
export function parseInsets(output: string): Insets | null {
  let display: number | null = null;
  let found = false;
  const insets: Insets = { ime: null, bars: [] };
  for (const line of output.split('\n')) {
    const header = DISPLAY.exec(line);
    if (header) {
      display = Number(header[1]);
      continue;
    }
    if (display !== null && display !== 0) continue;
    const match = SOURCE.exec(line);
    if (!match?.[1]) continue;
    found = true;
    if (match[10] !== 'true') continue;
    const at = match[6] === undefined ? 2 : 6;
    const bounds: Bounds = [
      Number(match[at]),
      Number(match[at + 1]),
      Number(match[at + 2]),
      Number(match[at + 3]),
    ];
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue;
    if (IME_TYPES.has(match[1])) insets.ime ??= bounds;
    else if (BAR_TYPES.has(match[1])) insets.bars.push(bounds);
  }
  return found ? insets : null;
}

/** The default display's insets; null when they can't be read (then nothing is checked or left out). */
export async function screenInsets(ctx: AgentContext, serial: string): Promise<Insets | null> {
  try {
    return parseInsets(await adbShell(ctx.adb, serial, INSETS_COMMAND, { timeoutMs: INSETS_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

export function inside(bounds: Bounds | null, point: { x: number; y: number }): boolean {
  return (
    bounds !== null &&
    point.x >= bounds[0] &&
    point.x < bounds[2] &&
    point.y >= bounds[1] &&
    point.y < bounds[3]
  );
}

/**
 * The part of on-screen `bounds` above a keyboard that spans their whole width (a docked keyboard), null when
 * nothing of them is above it or the keyboard covers them otherwise. A floating keyboard usually reports no
 * visible frame at all, so it is not seen.
 */
export function aboveKeyboard(bounds: Bounds, ime: Bounds): Bounds | null {
  if (ime[0] > bounds[0] || ime[2] < bounds[2] || ime[1] <= bounds[1]) return null;
  return [bounds[0], bounds[1], bounds[2], Math.min(bounds[3], ime[1])];
}

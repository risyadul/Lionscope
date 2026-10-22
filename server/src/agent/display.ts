/**
 * The device display as `input` sees it: the natural size from `wm size` (an override wins), turned by the
 * current rotation. Never guessed from a UI node (a dialog's window is not the screen).
 */
import { adbShell } from '../adb/adb.ts';
import type { Size } from '../emulator/screenInput.ts';
import type { AgentContext } from './tool.ts';

/** Screenshots, and the screenshot-scale bounds of UI elements, are scaled to this short edge. */
export const SCREENSHOT_SHORT_EDGE = 720;

const SIZE_LINE = /(Physical|Override) size:\s*(\d+)x(\d+)/g;
/** The default display's input viewport (`Viewport INTERNAL: displayId=0, …, orientation=1, …`). */
const ORIENTATION = /displayId=0,[^\n]*?orientation=([0-3])\b/;
const DISPLAY_TIMEOUT_MS = 5000;

/** `wm size` output → the size in effect (override over physical), in natural orientation. */
export function parseWmSize(output: string): Size | null {
  let physical: Size | null = null;
  let override: Size | null = null;
  for (const match of output.matchAll(SIZE_LINE)) {
    const size = { width: Number(match[2]), height: Number(match[3]) };
    if (match[1] === 'Override') override = size;
    else physical = size;
  }
  const size = override ?? physical;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/**
 * The default display's rotation in quarter turns from `dumpsys input`; viewports of input devices without a
 * display (`displayId=-1`) report 0 whatever the screen does, so they don't count.
 */
export function parseInputOrientation(output: string): number | null {
  const match = ORIENTATION.exec(output);
  return match ? Number(match[1]) : null;
}

/** The natural size as shown at `rotation` quarter turns. */
export function rotate(natural: Size, rotation: number): Size {
  return rotation % 2 === 1 ? { width: natural.height, height: natural.width } : natural;
}

/** The display size in the current rotation, or null when adb output could not be read. */
export async function displaySize(ctx: AgentContext, serial: string): Promise<Size | null> {
  const marker = '__LIONSCOPE_ROTATION__';
  const output = await adbShell(
    ctx.adb,
    serial,
    `wm size; echo ${marker}; dumpsys input 2>/dev/null | grep -m 1 -E 'displayId=0,.*orientation=[0-3]'`,
    { timeoutMs: DISPLAY_TIMEOUT_MS },
  );
  const at = output.lastIndexOf(marker);
  const natural = parseWmSize(at < 0 ? output : output.slice(0, at));
  const rotation = at < 0 ? null : parseInputOrientation(output.slice(at));
  return natural && rotation !== null ? rotate(natural, rotation) : null;
}

/** Sizes are the same (a rotation or a resolution change makes them differ). */
export function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

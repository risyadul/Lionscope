import type { ScreenFpsCap } from '@lionscope/protocol/wire';
import {
  DEFAULT_SCREEN_FPS_CAP,
  isValidScreenFpsCap,
  MAX_SCREEN_FPS_CAP,
  MIN_SCREEN_FPS_CAP,
  SCREEN_FPS_CAPS,
} from '@lionscope/protocol/wire';

/** The range as the dashboard words it. */
export const FPS_CAP_RANGE = `${MIN_SCREEN_FPS_CAP}–${MAX_SCREEN_FPS_CAP}`;

/**
 * The cap remembered in localStorage: a preset or a custom whole number in range. Anything else (nothing stored,
 * an edited or broken value, a number out of range) falls back to the default rather than being guessed at.
 */
export function parseStoredFpsCap(raw: string | null): ScreenFpsCap {
  if (raw === null || !/^[1-9][0-9]?$/.test(raw)) return DEFAULT_SCREEN_FPS_CAP;
  const fps = Number(raw);
  return isValidScreenFpsCap(fps) ? fps : DEFAULT_SCREEN_FPS_CAP;
}

export function isPresetFpsCap(fps: ScreenFpsCap): boolean {
  return SCREEN_FPS_CAPS.includes(fps);
}

/** What typing `text` into the custom cap field gives: the cap to apply, and why it differs from what was typed. */
export type FpsCapInput = { fps: ScreenFpsCap; note: string | null } | { fps: null; note: string };

/**
 * A number typed for a custom cap: rounded to a whole number and clamped into range, with a note when either
 * changed it. Text that is not a number is refused (the field keeps the cap it had).
 */
export function resolveFpsCapInput(text: string): FpsCapInput {
  const trimmed = text.trim();
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    return { fps: null, note: `Enter a whole number from ${FPS_CAP_RANGE} fps` };
  }
  const typed = Number(trimmed);
  const rounded = Math.round(typed);
  const fps = Math.min(MAX_SCREEN_FPS_CAP, Math.max(MIN_SCREEN_FPS_CAP, rounded));
  if (fps !== rounded) return { fps, note: `Set to ${fps} fps: the cap is ${FPS_CAP_RANGE} fps` };
  if (rounded !== typed) return { fps, note: `Rounded to ${fps} fps` };
  return { fps, note: null };
}

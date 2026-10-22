import type { ScreenNavButton } from '@lionscope/protocol';

/** android.view.KeyEvent.KEYCODE_* values used here. */
export const AKEYCODE = {
  HOME: 3,
  BACK: 4,
  DIGIT_0: 7,
  A: 29,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  POWER: 26,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  APP_SWITCH: 187,
  PASTE: 279,
} as const;

/** KeyEvent.META_SHIFT_ON | META_SHIFT_LEFT_ON, for capital letters. */
export const META_SHIFT = 0x41;

/**
 * W3C `KeyboardEvent.key` values → Android keycodes. Home / End move the caret (as on a desktop keyboard); the
 * emulator's navigation names are accepted too.
 */
const NAMED_KEYS: Readonly<Record<string, number>> = {
  Enter: AKEYCODE.ENTER,
  Backspace: AKEYCODE.DEL,
  Delete: AKEYCODE.FORWARD_DEL,
  Tab: AKEYCODE.TAB,
  Escape: AKEYCODE.ESCAPE,
  ArrowUp: AKEYCODE.DPAD_UP,
  ArrowDown: AKEYCODE.DPAD_DOWN,
  ArrowLeft: AKEYCODE.DPAD_LEFT,
  ArrowRight: AKEYCODE.DPAD_RIGHT,
  Home: AKEYCODE.MOVE_HOME,
  End: AKEYCODE.MOVE_END,
  PageUp: AKEYCODE.PAGE_UP,
  PageDown: AKEYCODE.PAGE_DOWN,
  Insert: AKEYCODE.INSERT,
  ' ': AKEYCODE.SPACE,
  Paste: AKEYCODE.PASTE,
  GoBack: AKEYCODE.BACK,
  GoHome: AKEYCODE.HOME,
  AppSwitch: AKEYCODE.APP_SWITCH,
  Power: AKEYCODE.POWER,
};

export interface AndroidKey {
  keycode: number;
  metaState: number;
}

/** The Android key for a W3C `key` value: the named keys above, ASCII letters and digits; null otherwise. */
export function androidKey(key: string): AndroidKey | null {
  if (Object.hasOwn(NAMED_KEYS, key)) return { keycode: NAMED_KEYS[key] ?? 0, metaState: 0 };
  if (/^[a-z]$/.test(key)) return { keycode: AKEYCODE.A + key.charCodeAt(0) - 0x61, metaState: 0 };
  if (/^[A-Z]$/.test(key)) return { keycode: AKEYCODE.A + key.charCodeAt(0) - 0x41, metaState: META_SHIFT };
  if (/^[0-9]$/.test(key)) return { keycode: AKEYCODE.DIGIT_0 + key.charCodeAt(0) - 0x30, metaState: 0 };
  return null;
}

/** Navigation buttons; `back` goes through BACK_OR_SCREEN_ON instead (it also wakes the screen). */
export const NAV_KEYCODES: Readonly<Record<Exclude<ScreenNavButton, 'back'>, number>> = {
  home: AKEYCODE.HOME,
  recents: AKEYCODE.APP_SWITCH,
  power: AKEYCODE.POWER,
};

/**
 * Per-viewer layout preferences (collapsed panels, drawer height) in localStorage. Storage can be missing,
 * full or blocked (private windows, disabled site data): every access is guarded and falls back to defaults.
 */

export const LAYOUT_KEYS = {
  deviceCollapsed: 'lionscope.layout.deviceCollapsed',
  logcatCollapsed: 'lionscope.layout.logcatCollapsed',
  logcatHeight: 'lionscope.layout.logcatHeight',
  screenSize: 'lionscope.layout.screenSize',
  clipboardShare: 'lionscope.layout.clipboardShare',
} as const;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Full or blocked storage: the preference just isn't remembered.
  }
}

export function parseBoolean(raw: string | null, fallback: boolean): boolean {
  return raw === 'true' ? true : raw === 'false' ? false : fallback;
}

export function parsePositiveInt<F>(raw: string | null, fallback: F): number | F {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return fallback;
  const value = Number(raw);
  return value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Logcat drawer height
// ---------------------------------------------------------------------------

/** Until the user sizes it, the drawer takes this share of the instrument column, within the bounds below. */
export const LOGCAT_DEFAULT_SHARE = 0.25;
export const LOGCAT_DEFAULT_MIN = 160;
export const LOGCAT_DEFAULT_MAX = 240;
/** Default before the column has been measured. */
export const LOGCAT_DEFAULT_HEIGHT = 210;
export const LOGCAT_MIN_HEIGHT = 120;
/** The timeline keeps at least this much of the instrument column. */
export const TIMELINE_MIN_HEIGHT = 220;
/** Upper bound before the column has been measured. */
const UNMEASURED_MAX_HEIGHT = 640;
/** Arrow keys on the splitter; Page Up / Down step four times as far. */
export const LOGCAT_KEY_STEP = 24;

/**
 * Keeps the drawer body between its minimum and what leaves the timeline its minimum. `barHeight` is the
 * drawer's bar above the body (it wraps to two rows when narrow), which also comes out of the column.
 */
export function clampDrawerHeight(height: number, columnHeight: number, barHeight = 0): number {
  const max = columnHeight > 0 ? columnHeight - TIMELINE_MIN_HEIGHT - barHeight : UNMEASURED_MAX_HEIGHT;
  return Math.round(Math.max(LOGCAT_MIN_HEIGHT, Math.min(height, Math.max(LOGCAT_MIN_HEIGHT, max))));
}

/** A quarter of the column (160–240 px): at 1440 × 900 the timeline keeps room for every lane. */
export function defaultDrawerHeight(columnHeight: number): number {
  if (columnHeight <= 0) return LOGCAT_DEFAULT_HEIGHT;
  const share = Math.round(columnHeight * LOGCAT_DEFAULT_SHARE);
  return clampDrawerHeight(Math.min(LOGCAT_DEFAULT_MAX, Math.max(LOGCAT_DEFAULT_MIN, share)), columnHeight);
}

export function drawerMaxHeight(columnHeight: number, barHeight = 0): number {
  return clampDrawerHeight(Number.POSITIVE_INFINITY, columnHeight, barHeight);
}

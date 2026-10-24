import type { InspectorNode } from '@lionscope/protocol/wire';
import { normalizeColor } from '@lionscope/protocol/wire';
import { readStored, writeStored } from './layoutPrefs.ts';
import { createSignal } from './signal.ts';

/** Hue 0..360, saturation, value and alpha 0..1: what the picker's square and sliders move. */
export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

/** How many colors the "On this screen" and "Recent" rows show. */
export const SWATCH_LIMIT = 10;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const byte = (n: number) =>
  Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** `#AARRGGBB` (or `#RRGGBB`, any case) as HSVA; null when it is not a hex color. */
export function argbToHsva(text: string): Hsva | null {
  const argb = normalizeColor(text.trim());
  if (argb === null) return null;
  const [a, r, g, b] = [1, 3, 5, 7].map((i) => parseInt(argb.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max, a };
}

/** HSVA as the wire's `#AARRGGBB`. */
export function hsvaToArgb({ h, s, v, a }: Hsva): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * clamp01(s) * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${byte(a)}${byte(f(5))}${byte(f(3))}${byte(f(1))}`;
}

/** The pure hue at full saturation and value, as CSS (the square's backdrop). */
export function hueCss(h: number): string {
  return `hsl(${Math.round(h)} 100% 50%)`;
}

/** `#AARRGGBB` as CSS `#RRGGBBAA`. */
export function argbCss(argb: string): string {
  return `#${argb.slice(3)}${argb.slice(1, 3)}`;
}

/** A screenshot pixel (always opaque) as `#AARRGGBB`. */
export function pixelArgb(r: number, g: number, b: number): string {
  return `#FF${[r, g, b].map((n) => byte(n / 255)).join('')}`;
}

/**
 * The background and text colors the snapshot's views use, most used first (ties keep tree order), at most
 * SWATCH_LIMIT: the app's own palette, one click away.
 */
export function screenColors(nodes: Iterable<InspectorNode>): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const color of [node.view?.backgroundColor, node.view?.textColor]) {
      if (typeof color !== 'string') continue;
      const argb = normalizeColor(color);
      if (argb !== null) counts.set(argb, (counts.get(argb) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, SWATCH_LIMIT)
    .map(([argb]) => argb);
}

/** `recent` with `argb` moved to the front, at most SWATCH_LIMIT. */
export function withRecent(recent: readonly string[], argb: string): string[] {
  return [argb, ...recent.filter((c) => c !== argb)].slice(0, SWATCH_LIMIT);
}

export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const colors = list
      .map((c) => (typeof c === 'string' ? normalizeColor(c) : null))
      .filter((c): c is string => c !== null);
    return [...new Set(colors)].slice(0, SWATCH_LIMIT);
  } catch {
    return [];
  }
}

const RECENT_KEY = 'lionscope.inspector.recentColors';

/** The colors sent from a picker, newest first; one list for every picker, remembered per viewer. */
export const recentColors = createSignal<readonly string[]>(parseRecent(readStored(RECENT_KEY)));

export function rememberColor(argb: string): void {
  const next = withRecent(recentColors.get(), argb);
  recentColors.set(next);
  writeStored(RECENT_KEY, JSON.stringify(next));
}

/** A color picker waiting for a pixel of the frozen screen. */
export interface EyedropperRequest {
  /** Names the field it fills ("background color"), for the overlay's hint. */
  label: string;
  onPick: (argb: string) => void;
  onCancel: () => void;
}

/** The pending eyedropper pick; the Inspector's frozen screen serves it. */
export const eyedropper = createSignal<EyedropperRequest | null>(null);

/** The frozen screen's screenshot is loaded, so the eyedropper has something to sample. */
export const canSampleScreen = createSignal(false);

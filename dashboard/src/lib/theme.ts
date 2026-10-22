/**
 * Chart colors live in CSS custom properties (src/styles/tokens.css). Canvas can't read
 * `var(--x)`, so charts resolve them once per color scheme through `readChartTheme`.
 */

export const CHART_COLOR_TOKENS = {
  surface: '--surface',
  ink: '--ink',
  ink2: '--ink-2',
  muted: '--ink-muted',
  grid: '--rule',
  axis: '--rule-strong',
  event: '--event',
  jank: '--jank',
  cpu: '--viz-cpu',
  fps: '--viz-fps',
  frameTime: '--viz-frametime',
  frameMax: '--viz-framemax',
  memNative: '--viz-mem-native',
  memJava: '--viz-mem-java',
  memGraphics: '--viz-mem-graphics',
  memCode: '--viz-mem-code',
  memOther: '--viz-mem-other',
  memTotal: '--viz-mem-total',
  threshold: '--viz-threshold',
  stageInput: '--viz-stage-input',
  stageAnimation: '--viz-stage-animation',
  stageLayout: '--viz-stage-layout',
  stageDraw: '--viz-stage-draw',
  stageSync: '--viz-stage-sync',
  stageCommand: '--viz-stage-command',
  stageSwap: '--viz-stage-swap',
  stageDelay: '--viz-stage-delay',
  stageGpu: '--viz-stage-gpu',
  screen1: '--viz-screen-1',
  screen2: '--viz-screen-2',
  screen3: '--viz-screen-3',
  stall1: '--viz-stall-1',
  stall2: '--viz-stall-2',
  stall3: '--viz-stall-3',
  stallDebug: '--viz-stall-debug',
  strictMode: '--viz-strictmode',
  inflate: '--viz-inflate',
} as const;

export type ChartColor = keyof typeof CHART_COLOR_TOKENS;
export type ChartColors = Record<ChartColor, string>;

export interface ChartTheme {
  colors: ChartColors;
  fontMono: string;
  /** Opacity of the active-screen tint painted behind every lane. */
  screenWash: number;
}

/** Light-scheme fallbacks, used when a token is missing (e.g. jsdom). */
export const FALLBACK_COLORS: ChartColors = {
  surface: '#fbfbfc',
  ink: '#111418',
  ink2: '#474e5a',
  muted: '#5f6673',
  grid: '#e2e4e8',
  axis: '#c4c8cf',
  event: '#6250d6',
  jank: '#c26a00',
  cpu: '#2a78d6',
  fps: '#2a78d6',
  frameTime: '#2a78d6',
  frameMax: '#8b919c',
  memNative: '#1baf7a',
  memJava: '#2a78d6',
  memGraphics: '#e87ba4',
  memCode: '#008300',
  memOther: '#8b919c',
  memTotal: '#111418',
  threshold: '#5f6673',
  stageInput: '#1c5cab',
  stageAnimation: '#2a78d6',
  stageLayout: '#5598e7',
  stageDraw: '#86b6ef',
  stageSync: '#4fb94a',
  stageCommand: '#2b9927',
  stageSwap: '#007a00',
  stageDelay: '#babfc7',
  stageGpu: '#e87ba4',
  screen1: '#2a78d6',
  screen2: '#e87ba4',
  screen3: '#008300',
  stall1: '#df7e82',
  stall2: '#ba2840',
  stall3: '#89142a',
  stallDebug: '#8b919c',
  strictMode: '#00a396',
  inflate: '#b88a00',
};

const FALLBACK_SCREEN_WASH = 0.06;

const FALLBACK_MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

export function readChartTheme(read: (token: string) => string): ChartTheme {
  const colors = { ...FALLBACK_COLORS };
  for (const key of Object.keys(CHART_COLOR_TOKENS) as ChartColor[]) {
    const value = read(CHART_COLOR_TOKENS[key]).trim();
    if (value !== '') colors[key] = value;
  }
  const fontMono = read('--font-mono').trim() || FALLBACK_MONO;
  const wash = Number.parseFloat(read('--viz-screen-wash'));
  const screenWash = Number.isFinite(wash) && wash >= 0 && wash <= 1 ? wash : FALLBACK_SCREEN_WASH;
  return { colors, fontMono, screenWash };
}

/**
 * Resolves the tokens currently applied to the document. `scheme` is only a cache key:
 * the CSS media query has already swapped the values by the time it changes.
 */
export function readDocumentTheme(_scheme: 'light' | 'dark'): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return readChartTheme((token) => style.getPropertyValue(token));
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const n = Number.parseInt(digits, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** sRGB mix: `t` = 0 → `a`, 1 → `b`. Non-hex input returns `a` unchanged. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.min(1, Math.max(0, t));
  const channel = (i: 0 | 1 | 2) => Math.round(ca[i] + (cb[i] - ca[i]) * k);
  return `#${[channel(0), channel(1), channel(2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** `#rrggbb` + alpha → `rgba(...)`. Non-hex input is returned unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

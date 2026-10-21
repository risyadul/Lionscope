/** Display formatting. Every formatter renders missing data as an em dash. */

export const EMPTY = '—';

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `HH:MM:SS.mmm` in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

/** `HH:MM:SS` in local time. */
export function formatClockShort(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

/** Fixed-precision number, or the em dash for missing / non-finite values. */
export function formatFixed(value: number | null | undefined, digits = 1): string {
  return isFiniteNumber(value) ? value.toFixed(digits) : EMPTY;
}

/** Integers with thousands separators (`1,284`). */
export function formatInteger(value: number | null | undefined): string {
  return isFiniteNumber(value) ? Math.round(value).toLocaleString('en-US') : EMPTY;
}

export function kbToMb(kb: number): number {
  return kb / 1024;
}

/** Megabytes with precision that shrinks as the value grows (`9.84`, `98.4`, `984`). */
export function formatMb(mb: number | null | undefined): string {
  if (!isFiniteNumber(mb)) return EMPTY;
  const abs = Math.abs(mb);
  if (abs >= 1000) return Math.round(mb).toLocaleString('en-US');
  if (abs >= 100) return mb.toFixed(0);
  if (abs >= 10) return mb.toFixed(1);
  return mb.toFixed(2);
}

/** Compact axis tick for a numeric scale: `0`, `250`, `1.5K`. */
export function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  if (Number.isInteger(value)) return String(value);
  return abs >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/** `42 s`, `3 m 07 s`, `1 h 02 m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${pad(minutes, 2)} m`;
  if (minutes > 0) return `${minutes} m ${pad(seconds, 2)} s`;
  return `${seconds} s`;
}

/** Span length: `0.8 s`, `12.4 s`, `42 s`, then `formatElapsed` from a minute up. */
export function formatDuration(ms: number): string {
  if (!isFiniteNumber(ms) || ms < 0) return EMPTY;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  return formatElapsed(ms);
}

/** Main-thread block length: `342 ms`, `1.24 s`, `12.6 s`. */
export function formatBlockMs(ms: number | null | undefined): string {
  if (!isFiniteNumber(ms) || ms < 0) return EMPTY;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 9995) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

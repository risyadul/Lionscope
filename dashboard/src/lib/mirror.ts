/**
 * Pure helpers for mirroring spans: while a physical device's screen is mirrored its hardware video encoder
 * is busy, so the timeline marks those stretches "Mirroring on". Emulators record no spans.
 */
import type { MirrorSpan } from '@lionscope/protocol/wire';

/** Buffer cap; the oldest spans go first. A span per mirror open/close, so this is generous. */
export const MAX_MIRROR_SPANS = 500;

/** End of a span; an open one (still mirroring) ends at `openEnd`. */
export function mirrorSpanEnd(span: MirrorSpan, openEnd: number): number {
  return span.end ?? Math.max(span.start, openEnd);
}

function isSameSpan(a: MirrorSpan, b: MirrorSpan): boolean {
  return a.start === b.start && a.serial === b.serial;
}

function capMirror(spans: MirrorSpan[]): MirrorSpan[] {
  return spans.length > MAX_MIRROR_SPANS ? spans.slice(spans.length - MAX_MIRROR_SPANS) : spans;
}

/**
 * An update replaces the span with the same start (and serial); a new span slots in by start and closes the
 * serial's open span (one device mirrors once at a time). That also ends a span re-based by a clock reset,
 * whose closing update still carries the original start.
 */
export function upsertMirrorSpan(spans: readonly MirrorSpan[], span: MirrorSpan): MirrorSpan[] {
  const incoming: MirrorSpan = { ...span };
  const same = spans.findIndex((s) => isSameSpan(s, span));
  if (same >= 0) return [...spans.slice(0, same), incoming, ...spans.slice(same + 1)];
  const closeAt = span.end ?? span.start;
  const closed = spans.map((s) =>
    s.serial === span.serial && s.end === null ? { ...s, end: Math.max(s.start, closeAt) } : s,
  );
  let at = closed.length;
  while (at > 0 && (closed[at - 1]?.start ?? -Infinity) > span.start) at--;
  return capMirror([...closed.slice(0, at), incoming, ...closed.slice(at)]);
}

/** Sorted by start, one span per start and serial (the last report wins), no inverted spans, capped. */
export function normalizeMirrorSpans(spans: readonly MirrorSpan[]): MirrorSpan[] {
  const byKey = new Map<string, MirrorSpan>();
  for (const span of spans) {
    if (span.end !== null && span.end < span.start) continue;
    const key = `${span.serial}\u0000${span.start}`;
    byKey.delete(key);
    byKey.set(key, { ...span });
  }
  return capMirror([...byKey.values()].sort((a, b) => a.start - b.start));
}

/** Drops spans that ended before `cutoff`. Returns the same array when nothing is dropped. */
export function pruneMirrorSpans(spans: MirrorSpan[], cutoff: number, openEnd: number): MirrorSpan[] {
  const kept = spans.filter((span) => mirrorSpanEnd(span, openEnd) >= cutoff);
  return kept.length === spans.length ? spans : kept;
}

export interface MirrorRun {
  /** Clipped to the window, epoch ms. */
  from: number;
  to: number;
  /** Still mirroring at the window's right edge (which is "now" only while the window follows the clock). */
  isOpen: boolean;
  /** Stable across re-renders: the first span's serial and start. */
  key: string;
}

/** Spans overlapping [fromTs, toTs], clipped to it, with overlapping ones merged into one run. */
export function visibleMirrorRuns(
  spans: readonly MirrorSpan[],
  fromTs: number,
  toTs: number,
  openEnd: number,
): MirrorRun[] {
  const runs: MirrorRun[] = [];
  for (const span of spans) {
    const end = mirrorSpanEnd(span, openEnd);
    if (end <= fromTs || span.start >= toTs) continue;
    const from = Math.max(fromTs, span.start);
    const to = Math.min(toTs, end);
    const isOpen = span.end === null && end >= toTs;
    const last = runs[runs.length - 1];
    if (last !== undefined && from <= last.to) {
      runs[runs.length - 1] = { ...last, to: Math.max(last.to, to), isOpen: last.isOpen || isOpen };
      continue;
    }
    runs.push({ from, to, isOpen, key: `${span.serial}-${span.start}` });
  }
  return runs;
}

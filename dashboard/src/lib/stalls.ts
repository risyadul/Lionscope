/**
 * Stalls and StrictMode in the dashboard: severity colors, the interleaved feed and the lane's scale / hit
 * testing. Culprit frames, stack collapsing, stall origins and the offenders / origins rankings live in
 * @lionscope/protocol/insights (shared with the agent tools) and are re-exported here.
 */
import type { StackFrame, StallSample, StrictModeSample } from '@lionscope/protocol/wire';
import { culpritFrame, culpritKey, stallInWindow, stallOrigin } from '@lionscope/protocol/insights';
import { niceCeil, type Aligned } from './series.ts';
import type { ChartColor } from './theme.ts';

export {
  aggregateOffenders,
  aggregateOrigins,
  collapseStack,
  countDebuggerStalls,
  countEventsInWindow,
  culpritFrame,
  culpritKey,
  culpritLabel,
  culpritText,
  formatStackLine,
  frameLocation,
  frameMethod,
  isGeneratedFrame,
  isPlatformFrame,
  MIN_COLLAPSE_RUN,
  NATIVE_LINE,
  NO_STACK_KEY,
  NO_STACK_LABEL,
  ORIGIN_KIND_LABELS,
  originText,
  packageName,
  runnableLabel,
  rxOperator,
  simpleClassName,
  stackText,
  stallInWindow,
  stallOrigin,
  stallsByScreen,
  summarizeWindow,
} from '@lionscope/protocol/insights';
export type {
  Offender,
  OriginGroup,
  ScreenStalls,
  StackItem,
  StallOrigin,
  StallOriginKind,
  WindowSummary,
} from '@lionscope/protocol/insights';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** Severity steps: under 500 ms, 500 ms – 1 s, 1 s and over (the watchdog threshold is the floor). */
export const SEVERE_STALL_MS = 500;
export const FROZEN_STALL_MS = 1000;

export type StallSeverity = 1 | 2 | 3;

export function stallSeverity(durationMs: number): StallSeverity {
  if (durationMs >= FROZEN_STALL_MS) return 3;
  if (durationMs >= SEVERE_STALL_MS) return 2;
  return 1;
}

export const SEVERITY_COLORS: Record<StallSeverity, ChartColor> = { 1: 'stall1', 2: 'stall2', 3: 'stall3' };
export const SEVERITY_LABELS: Record<StallSeverity, string> = {
  1: 'under 500 ms',
  2: '500 ms – 1 s',
  3: '1 s and over',
};

/** A debugger-attached stall is most likely a breakpoint: it recedes to gray whatever its length. */
export function stallColor(stall: Pick<StallSample, 'durationMs' | 'debugger'>): ChartColor {
  return stall.debugger ? 'stallDebug' : SEVERITY_COLORS[stallSeverity(stall.durationMs)];
}

// ---------------------------------------------------------------------------
// Feed: stalls and violations interleaved, newest first
// ---------------------------------------------------------------------------

function inWindow(ts: number, fromTs: number, toTs: number): boolean {
  return ts >= fromTs && ts <= toTs;
}

export type FeedFilter = 'all' | 'stalls' | 'strictmode';

export type FeedItem =
  | { kind: 'stall'; key: string; ts: number; sample: StallSample; culprit: StackFrame | null }
  | { kind: 'strictmode'; key: string; ts: number; sample: StrictModeSample; culprit: StackFrame | null };

/** A stall's start is unique on one main thread, so it identifies the stall across resyncs. */
export function stallKey(stall: Pick<StallSample, 'ts'>): string {
  return `s:${stall.ts}`;
}

/** Violations can share a timestamp; the n-th repeat of a (ts, violation) pair gets its own key. */
export function strictModeKeys(samples: readonly StrictModeSample[]): string[] {
  const seen = new Map<string, number>();
  return samples.map((sample) => {
    const base = `m:${sample.ts}:${sample.violation}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}:${n}`;
  });
}

export interface FeedQuery {
  fromTs: number;
  toTs: number;
  filter: FeedFilter;
  /** Only items whose culprit has this `culpritKey`. */
  culprit: string | null;
  /** Only stalls whose origin has this key (StrictMode items have no origin, so they never match). */
  origin: string | null;
}

export function buildFeed(
  stalls: readonly StallSample[],
  strictMode: readonly StrictModeSample[],
  query: FeedQuery,
): FeedItem[] {
  const { fromTs, toTs, filter, culprit, origin } = query;
  const matches = (frame: StackFrame | null) => culprit === null || culpritKey(frame) === culprit;
  const items: FeedItem[] = [];
  if (filter !== 'strictmode') {
    for (const sample of stalls) {
      if (!stallInWindow(sample, fromTs, toTs)) continue;
      // Offender and origin rows leave debugger stalls out; their filter must list what the row counts.
      if ((culprit !== null || origin !== null) && sample.debugger) continue;
      if (origin !== null && stallOrigin(sample).key !== origin) continue;
      const frame = culpritFrame(sample.frames);
      if (matches(frame))
        items.push({ kind: 'stall', key: stallKey(sample), ts: sample.ts, sample, culprit: frame });
    }
  }
  if (filter !== 'stalls' && origin === null) {
    const keys = strictModeKeys(strictMode);
    strictMode.forEach((sample, i) => {
      if (!inWindow(sample.ts, fromTs, toTs)) return;
      const frame = culpritFrame(sample.frames);
      if (matches(frame)) {
        items.push({ kind: 'strictmode', key: keys[i] ?? '', ts: sample.ts, sample, culprit: frame });
      }
    });
  }
  // Newest first; at the same instant the stall (the bigger event) leads.
  return items.sort((a, b) => b.ts - a.ts || (a.kind === b.kind ? 0 : a.kind === 'stall' ? -1 : 1));
}

/** Looks an item up in the whole buffer (a selection outlives the visible window). */
export function findFeedItem(
  stalls: readonly StallSample[],
  strictMode: readonly StrictModeSample[],
  key: string,
): FeedItem | null {
  if (key.startsWith('s:')) {
    const sample = stalls.find((stall) => stallKey(stall) === key);
    return sample
      ? { kind: 'stall', key, ts: sample.ts, sample, culprit: culpritFrame(sample.frames) }
      : null;
  }
  const index = strictModeKeys(strictMode).indexOf(key);
  const sample = strictMode[index];
  return sample
    ? { kind: 'strictmode', key, ts: sample.ts, sample, culprit: culpritFrame(sample.frames) }
    : null;
}

// ---------------------------------------------------------------------------
// Lane scale and hit testing
// ---------------------------------------------------------------------------

/** The lane's y scale is linear and capped: one 20 s freeze must not flatten every other bar. */
export const STALL_SCALE_MIN_MS = 500;
export const STALL_SCALE_MAX_MS = 2000;

/** Top of the lane's y scale (ms): fits the longest stall, from 500 ms (or 2× threshold) up to 2 s. */
export function stallScaleMax(maxDurationMs: number | null, thresholdMs: number): number {
  const floor = Math.max(STALL_SCALE_MIN_MS, niceCeil(thresholdMs * 2));
  const fit = maxDurationMs === null || maxDurationMs <= 0 ? floor : niceCeil(maxDurationMs * 1.05);
  return Math.min(STALL_SCALE_MAX_MS, Math.max(floor, fit));
}

/** uPlot data for the lane's y auto-range: one point per stall start; debugger stalls don't stretch it. */
export function buildStallScaleData(stalls: readonly StallSample[]): Aligned {
  return [
    stalls.map((stall) => stall.ts / 1000),
    stalls.map((stall) => (stall.debugger ? null : stall.durationMs)),
  ];
}

/** Pointer tolerance around a mark, px. */
export const HIT_SLOP_PX = 5;
/** Stall bars are drawn at least this wide, px. */
export const MIN_BAR_PX = 3;

export interface HitQuery {
  /** Epoch ms under the pointer. */
  ts: number;
  pxPerMs: number;
  /** The pointer is over the StrictMode rail: violations win over bars there. */
  isOverRail: boolean;
}

function stallDistancePx(item: Extract<FeedItem, { kind: 'stall' }>, query: HitQuery): number {
  const start = item.ts;
  const end = Math.max(start + item.sample.durationMs, start + MIN_BAR_PX / query.pxPerMs);
  if (query.ts >= start && query.ts <= end) return 0;
  return Math.min(Math.abs(query.ts - start), Math.abs(query.ts - end)) * query.pxPerMs;
}

/** The mark under the pointer, or null. Nearest wins; on a tie the later (drawn on top) one. */
export function hitTestMarks(items: readonly FeedItem[], query: HitQuery): FeedItem | null {
  if (!(query.pxPerMs > 0)) return null;
  const nearest = (kind: FeedItem['kind']): FeedItem | null => {
    let best: FeedItem | null = null;
    let bestDistance = Infinity;
    for (const item of items) {
      if (item.kind !== kind) continue;
      const distance =
        item.kind === 'stall' ? stallDistancePx(item, query) : Math.abs(query.ts - item.ts) * query.pxPerMs;
      if (distance > HIT_SLOP_PX) continue;
      if (distance < bestDistance || (distance === bestDistance && best !== null && item.ts > best.ts)) {
        best = item;
        bestDistance = distance;
      }
    }
    return best;
  };
  if (query.isOverRail) return nearest('strictmode') ?? nearest('stall');
  return nearest('stall') ?? nearest('strictmode');
}

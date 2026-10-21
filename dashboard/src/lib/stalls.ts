/**
 * Pure helpers for main-thread stalls and StrictMode violations: culprit frames, the offenders
 * ranking, stack collapsing, the interleaved feed and the lane's scale / hit testing.
 */
import type { StackFrame, StallSample, StrictModeSample } from '@lionscope/protocol/wire';
import { niceCeil, type Aligned } from './series.ts';
import type { ChartColor } from './theme.ts';

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
// Frames
// ---------------------------------------------------------------------------

/** `StackTraceElement` uses -2 for native methods. */
export const NATIVE_LINE = -2;

/** Packages of the runtime and of Google's support libraries: never the culprit while another frame can be. */
const PLATFORM_PACKAGE =
  /^(?:java|javax|jdk|sun|libcore|dalvik|kotlin|kotlinx|android|androidx|com\.android|com\.google\.android\.material)\./;

/** ViewBinding / DataBinding output (`com.example.databinding.FragmentHomeBinding`): nobody edits that line. */
const GENERATED_BINDING = /\.databinding\.[A-Za-z0-9_$]+(?:Binding|BindingImpl)$|\.DataBinderMapperImpl$/;

export function isPlatformFrame(frame: StackFrame): boolean {
  return PLATFORM_PACKAGE.test(frame.className);
}

export function isGeneratedFrame(frame: StackFrame): boolean {
  return GENERATED_BINDING.test(frame.className);
}

/**
 * The line responsible: the innermost hand-written app frame (its binding's caller rather than the
 * generated binding), else the innermost library frame (a third-party SDK blocking the main thread
 * is the finding, not the `Unsafe.park` it ends in), else the innermost frame.
 */
export function culpritFrame(frames: readonly StackFrame[]): StackFrame | null {
  return (
    frames.find((frame) => frame.inApp && !isGeneratedFrame(frame)) ??
    frames.find((frame) => frame.inApp) ??
    frames.find((frame) => !isPlatformFrame(frame)) ??
    frames[0] ??
    null
  );
}

/** `com.example.home.HomeViewModel$load$1` → `HomeViewModel$load$1`. */
export function simpleClassName(className: string): string {
  const dot = className.lastIndexOf('.');
  return dot < 0 ? className : className.slice(dot + 1);
}

/** Package part of a class name (`com.example.home`), empty for the default package. */
export function packageName(className: string): string {
  const dot = className.lastIndexOf('.');
  return dot < 0 ? '' : className.slice(0, dot);
}

/** `HomeViewModel.mapItems`. */
export function frameMethod(frame: StackFrame): string {
  return `${simpleClassName(frame.className)}.${frame.method}`;
}

/** `HomeViewModel.kt:87`, as `StackTraceElement` prints it (`Native Method`, `Unknown Source`). */
export function frameLocation(frame: StackFrame): string {
  if (frame.line === NATIVE_LINE) return 'Native Method';
  if (frame.file === null) return 'Unknown Source';
  return frame.line !== null && frame.line >= 0 ? `${frame.file}:${frame.line}` : frame.file;
}

/** One `at …` line in the JVM's own format, so IDEs can link it. */
export function formatStackLine(frame: StackFrame): string {
  return `at ${frame.className}.${frame.method}(${frameLocation(frame)})`;
}

export function stackText(frames: readonly StackFrame[]): string {
  return frames.map(formatStackLine).join('\n');
}

/** `com.example.home.HomeViewModel.mapItems (HomeViewModel.kt:87)`. */
export function culpritText(frame: StackFrame): string {
  return `${frame.className}.${frame.method} (${frameLocation(frame)})`;
}

/** Stands in for the culprit when the SDK could not sample the main thread (`frames: []`). */
export const NO_STACK_LABEL = '(no stack captured)';
/** Offender key shared by every stall without a stack, so they rank as one row. */
export const NO_STACK_KEY = 'no-stack';

/** The culprit line as shown (`HomeViewModel.kt:87`), or the no-stack label. */
export function culpritLabel(frame: StackFrame | null): string {
  return frame === null ? NO_STACK_LABEL : frameLocation(frame);
}

/** Groups stalls by the exact culprit line; stalls without a stack share `NO_STACK_KEY`. */
export function culpritKey(frame: StackFrame | null): string {
  if (frame === null) return NO_STACK_KEY;
  return `${frame.className}#${frame.method}#${frame.file ?? ''}#${frame.line ?? ''}`;
}

// ---------------------------------------------------------------------------
// Stack collapsing
// ---------------------------------------------------------------------------

export type StackItem =
  | { kind: 'frame'; frame: StackFrame; index: number }
  /** A run of framework / library frames shown as "+N framework frames". */
  | { kind: 'collapsed'; frames: StackFrame[]; start: number };

/** Shorter runs of non-app frames stay visible: a single collapsed row hides nothing. */
export const MIN_COLLAPSE_RUN = 2;

/**
 * Collapses runs of consecutive non-app frames. The innermost frame always stays visible: it says
 * what the thread was blocked in (`Thread.sleep`, a file read, a lock). So does the culprit, which
 * can be a library frame.
 */
export function collapseStack(frames: readonly StackFrame[]): StackItem[] {
  const culprit = culpritFrame(frames);
  const items: StackItem[] = [];
  let run: { frame: StackFrame; index: number }[] = [];
  const flush = () => {
    const first = run[0];
    if (first !== undefined && run.length >= MIN_COLLAPSE_RUN) {
      items.push({ kind: 'collapsed', frames: run.map((r) => r.frame), start: first.index });
    } else {
      for (const r of run) items.push({ kind: 'frame', frame: r.frame, index: r.index });
    }
    run = [];
  };
  frames.forEach((frame, index) => {
    if (frame.inApp || index === 0 || frame === culprit) {
      flush();
      items.push({ kind: 'frame', frame, index });
    } else {
      run.push({ frame, index });
    }
  });
  flush();
  return items;
}

// ---------------------------------------------------------------------------
// Offenders and per-screen totals
// ---------------------------------------------------------------------------

export interface Offender {
  key: string;
  /** null when the stalls carried no stack at all. */
  frame: StackFrame | null;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Screens the culprit blocked, most stalls first. */
  screens: string[];
  lastTs: number;
}

function inWindow(ts: number, fromTs: number, toTs: number): boolean {
  return ts >= fromTs && ts <= toTs;
}

/** A stall is in the window while any of it is: one that started before the left edge still shows. */
export function stallInWindow(
  stall: Pick<StallSample, 'ts' | 'durationMs'>,
  fromTs: number,
  toTs: number,
): boolean {
  return stall.ts <= toTs && stall.ts + stall.durationMs >= fromTs;
}

/**
 * Stalls with `fromTs ≤ ts ≤ toTs` grouped by culprit line, worst total blocked time first.
 * Debugger-attached stalls are left out: a breakpoint would top every ranking.
 */
export function aggregateOffenders(stalls: readonly StallSample[], fromTs: number, toTs: number): Offender[] {
  const groups = new Map<string, Offender & { screenCounts: Map<string, number> }>();
  for (const stall of stalls) {
    if (stall.debugger || !stallInWindow(stall, fromTs, toTs)) continue;
    const frame = culpritFrame(stall.frames);
    const key = culpritKey(frame);
    const group = groups.get(key) ?? {
      key,
      frame,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      screens: [],
      lastTs: stall.ts,
      screenCounts: new Map<string, number>(),
    };
    group.count += 1;
    group.totalMs += stall.durationMs;
    group.maxMs = Math.max(group.maxMs, stall.durationMs);
    group.lastTs = Math.max(group.lastTs, stall.ts);
    if (stall.screen !== null) {
      group.screenCounts.set(stall.screen, (group.screenCounts.get(stall.screen) ?? 0) + 1);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ screenCounts, ...offender }) => ({
      ...offender,
      screens: [...screenCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name),
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count || a.key.localeCompare(b.key));
}

/** Stalls overlapping the window plus violations in it: the Stalls tab's event count. */
export function countEventsInWindow(
  stalls: readonly StallSample[],
  strictMode: readonly StrictModeSample[],
  fromTs: number,
  toTs: number,
): number {
  const stallCount = stalls.reduce((sum, s) => (stallInWindow(s, fromTs, toTs) ? sum + 1 : sum), 0);
  return strictMode.reduce((sum, v) => (inWindow(v.ts, fromTs, toTs) ? sum + 1 : sum), stallCount);
}

export function countDebuggerStalls(stalls: readonly StallSample[], fromTs: number, toTs: number): number {
  return stalls.filter((stall) => stall.debugger && stallInWindow(stall, fromTs, toTs)).length;
}

export interface ScreenStalls {
  count: number;
  totalMs: number;
}

/** Stall count and blocked time per screen name in the window (debugger stalls excluded). */
export function stallsByScreen(
  stalls: readonly StallSample[],
  fromTs: number,
  toTs: number,
): ReadonlyMap<string, ScreenStalls> {
  const totals = new Map<string, ScreenStalls>();
  for (const stall of stalls) {
    if (stall.debugger || stall.screen === null || !stallInWindow(stall, fromTs, toTs)) continue;
    const current = totals.get(stall.screen) ?? { count: 0, totalMs: 0 };
    totals.set(stall.screen, { count: current.count + 1, totalMs: current.totalMs + stall.durationMs });
  }
  return totals;
}

export interface WindowSummary {
  count: number;
  totalMs: number;
  worstMs: number;
  /** Violation samples (the list's rows); each coalesces `count` occurrences. */
  strictModeCount: number;
  strictModeOccurrences: number;
  debuggerCount: number;
}

export function summarizeWindow(
  stalls: readonly StallSample[],
  strictMode: readonly StrictModeSample[],
  fromTs: number,
  toTs: number,
): WindowSummary {
  let count = 0;
  let totalMs = 0;
  let worstMs = 0;
  let debuggerCount = 0;
  for (const stall of stalls) {
    if (!stallInWindow(stall, fromTs, toTs)) continue;
    if (stall.debugger) {
      debuggerCount++;
      continue;
    }
    count++;
    totalMs += stall.durationMs;
    worstMs = Math.max(worstMs, stall.durationMs);
  }
  let strictModeCount = 0;
  let strictModeOccurrences = 0;
  for (const sample of strictMode) {
    if (!inWindow(sample.ts, fromTs, toTs)) continue;
    strictModeCount++;
    strictModeOccurrences += Math.max(1, sample.count);
  }
  return { count, totalMs, worstMs, strictModeCount, strictModeOccurrences, debuggerCount };
}

// ---------------------------------------------------------------------------
// Feed: stalls and violations interleaved, newest first
// ---------------------------------------------------------------------------

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
}

export function buildFeed(
  stalls: readonly StallSample[],
  strictMode: readonly StrictModeSample[],
  query: FeedQuery,
): FeedItem[] {
  const { fromTs, toTs, filter, culprit } = query;
  const matches = (frame: StackFrame | null) => culprit === null || culpritKey(frame) === culprit;
  const items: FeedItem[] = [];
  if (filter !== 'strictmode') {
    for (const sample of stalls) {
      if (!stallInWindow(sample, fromTs, toTs)) continue;
      // Offender rows leave debugger stalls out; a line filter must list what its row counts.
      if (culprit !== null && sample.debugger) continue;
      const frame = culpritFrame(sample.frames);
      if (matches(frame))
        items.push({ kind: 'stall', key: stallKey(sample), ts: sample.ts, sample, culprit: frame });
    }
  }
  if (filter !== 'stalls') {
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

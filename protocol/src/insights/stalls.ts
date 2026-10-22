/**
 * Pure helpers for main-thread stalls and StrictMode violations: culprit frames, stack collapsing, the
 * offenders ranking and per-window totals. Shared by the dashboard's Stalls tab and the agent tools.
 */
import type { StackFrame, StallSample, StrictModePolicy, StrictModeSample } from '../wire.ts';

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
// StrictMode violations grouped by violation and culprit line
// ---------------------------------------------------------------------------

export interface StrictModeGroup {
  /** Unique per (violation, culprit line). */
  key: string;
  violation: string;
  policy: StrictModePolicy;
  /** The culprit of the group's stack (same rule as stalls); null when no stack was captured. */
  frame: StackFrame | null;
  /** Violation samples in the window; each coalesces one or more occurrences. */
  samples: number;
  occurrences: number;
  /** Screens it happened on, most occurrences first. */
  screens: string[];
  lastTs: number;
  /** The newest sample of the group (its message and stack). */
  latest: StrictModeSample;
}

/** Violations with `fromTs ≤ ts ≤ toTs` grouped by violation and culprit line, most occurrences first. */
export function groupStrictMode(
  samples: readonly StrictModeSample[],
  fromTs: number,
  toTs: number,
): StrictModeGroup[] {
  const groups = new Map<string, StrictModeGroup & { screenCounts: Map<string, number> }>();
  for (const sample of samples) {
    if (!inWindow(sample.ts, fromTs, toTs)) continue;
    const frame = culpritFrame(sample.frames);
    const key = JSON.stringify([sample.violation, culpritKey(frame)]);
    const occurrences = Math.max(1, sample.count);
    const group = groups.get(key) ?? {
      key,
      violation: sample.violation,
      policy: sample.policy,
      frame,
      samples: 0,
      occurrences: 0,
      screens: [],
      lastTs: sample.ts,
      latest: sample,
      screenCounts: new Map<string, number>(),
    };
    group.samples += 1;
    group.occurrences += occurrences;
    if (sample.ts >= group.lastTs) {
      group.lastTs = sample.ts;
      group.latest = sample;
    }
    if (sample.screen !== null) {
      group.screenCounts.set(sample.screen, (group.screenCounts.get(sample.screen) ?? 0) + occurrences);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ screenCounts, ...group }) => ({
      ...group,
      screens: [...screenCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.lastTs - a.lastTs || a.key.localeCompare(b.key));
}

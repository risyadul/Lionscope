/** Shaping store data for the agent tools: time windows, rounding, stack text. */
import { z } from 'zod';
import type { Snapshot, StackFrame } from '@lionscope/protocol';
import {
  collapseStack,
  culpritFrame,
  culpritLabel,
  culpritText,
  formatStackLine,
  frameLocation,
  originText,
  type StallOrigin,
} from '@lionscope/protocol/insights';
import type { AgentContext } from './tool.ts';

/** The dashboard's time window presets (WindowControls). */
export const WINDOWS = { '1m': 60_000, '5m': 5 * 60_000, '10m': 10 * 60_000 } as const;
export type WindowLabel = keyof typeof WINDOWS;

export const windowInput = z
  .enum(['1m', '5m', '10m'])
  .default('1m')
  .describe(
    'Time window ending now (or at the last sample once the session stopped), like the dashboard window control.',
  );

export interface TimeWindow {
  label: WindowLabel;
  fromTs: number;
  toTs: number;
  /** The window follows the clock (a session is running or waiting for its process). */
  live: boolean;
}

/** Newest timestamp in the snapshot, as the dashboard store tracks it (logs excluded). */
export function latestTimestamp(snapshot: Snapshot): number {
  let latest = 0;
  const streams = [
    snapshot.cpu,
    snapshot.memory,
    snapshot.frames,
    snapshot.events,
    snapshot.breakdown ?? [],
    snapshot.stalls ?? [],
    snapshot.strictMode ?? [],
    snapshot.inflates ?? [],
    snapshot.viewTrees ?? [],
  ];
  for (const stream of streams) latest = Math.max(latest, stream.at(-1)?.ts ?? 0);
  for (const span of snapshot.screens ?? []) latest = Math.max(latest, span.end ?? span.start);
  return latest;
}

/** The dashboard's window: it ends now while a session is live, else at the last recorded sample. */
export function timeWindow(ctx: AgentContext, snapshot: Snapshot, label: WindowLabel): TimeWindow {
  const { status } = ctx.sessions.getSessionState();
  const live = status === 'running' || status === 'waiting_for_process';
  const latest = latestTimestamp(snapshot);
  const toTs = live || latest === 0 ? ctx.now() : latest;
  return { label, fromTs: toTs - WINDOWS[label], toTs, live };
}

export function windowView(window: TimeWindow): {
  label: WindowLabel;
  from: string;
  to: string;
  live: boolean;
} {
  return { label: window.label, from: iso(window.fromTs), to: iso(window.toTs), live: window.live };
}

export function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** Rounded for compact output; null stays null. */
export function round(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const MAX_MESSAGE_CHARS = 500;

/** App strings can be long (a JSON payload in a log line): cut with a marker. */
export function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

/** Most frames shown per stack; the innermost ones (where the thread was blocked) come first. */
export const MAX_STACK_LINES = 30;

/**
 * A stack as `at …` lines with runs of framework frames collapsed like the dashboard's stack view
 * (`… 12 framework frames`); the culprit and the innermost frame always stay.
 */
export function stackLines(frames: readonly StackFrame[], maxLines = MAX_STACK_LINES): string[] {
  const lines = collapseStack(frames).map((item) =>
    item.kind === 'frame' ? formatStackLine(item.frame) : `… ${item.frames.length} framework frames`,
  );
  return lines.length <= maxLines
    ? lines
    : [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more`];
}

/** A stall's origin for an agent: kind, what ran, where it came from, and the facts that apply. */
export function originView(origin: StallOrigin): Record<string, unknown> {
  return {
    kind: origin.kind,
    label: origin.label,
    text: originText(origin),
    ...(origin.frame === null ? {} : { location: frameLocation(origin.frame) }),
    ...(origin.dispatched === null ? {} : { dispatched: origin.dispatched }),
    ...(origin.operator === null ? {} : { operator: origin.operator }),
    ...(origin.consumer === null ? {} : { consumer: origin.consumer }),
    ...(origin.dispatcher === null ? {} : { dispatcher: origin.dispatcher }),
    ...(origin.coroutine === null ? {} : { coroutine: origin.coroutine }),
  };
}

/** The culprit line: `com.example.Foo.bar (Foo.kt:12)` and its short label `Foo.kt:12`. */
export function culpritView(frames: readonly StackFrame[]): { culprit: string; location: string } {
  const frame = culpritFrame(frames);
  return { culprit: frame === null ? culpritLabel(null) : culpritText(frame), location: culpritLabel(frame) };
}

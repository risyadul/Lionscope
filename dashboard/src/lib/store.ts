/**
 * Dashboard state: a pure, immutable reducer over `ServerMessage`s plus a tiny external
 * store that batches high-frequency messages into one notification per animation frame.
 */
import type {
  AppInfo,
  CpuSample,
  DeviceInfo,
  FrameBreakdownSample,
  FrameSample,
  LogEntry,
  MemorySample,
  ScreenSpan,
  ServerMessage,
  SessionState,
  Snapshot,
  StallSample,
  StrictModeSample,
  TimelineEvent,
} from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';

export const DEFAULT_BUFFER_WINDOW_MS = 10 * 60_000;
export const MAX_LOGS = 5000;

export interface LogRecord extends LogEntry {
  /** Monotonic id assigned on arrival; stable React key. */
  seq: number;
}

/** `closed`: the page closed the socket on purpose (e.g. entering the back-forward cache). */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Why the server last closed us, when it said so: 1008 = rate limit. (Over-capacity is refused
 * with HTTP 503 before the upgrade, which the browser only reports as a generic 1006 close.)
 */
export type CloseReason = 'rate-limited';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed attempts since the connection was last stable. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt while `reconnecting`. */
  retryAt: number | null;
  closeReason: CloseReason | null;
}

export interface ServerInfo {
  protocolVersion: number;
  serverVersion: string;
}

export interface ServerError {
  id: number;
  message: string;
  code?: string;
}

export interface DashboardState {
  connection: ConnectionState;
  server: ServerInfo | null;
  bufferWindowMs: number;
  /** null until the first `devices` message. */
  devices: DeviceInfo[] | null;
  apps: { serial: string; apps: AppInfo[] } | null;
  session: SessionState;
  cpu: CpuSample[];
  memory: MemorySample[];
  frames: FrameSample[];
  logs: LogRecord[];
  events: TimelineEvent[];
  /** Top-screen spans from the in-app SDK, ascending by `start`; only the last can be open. */
  screens: ScreenSpan[];
  /** SDK FrameMetrics aggregated per 500 ms bucket. */
  breakdown: FrameBreakdownSample[];
  /** Main-thread stalls from the SDK watchdog, ascending by start; starts are unique. */
  stalls: StallSample[];
  /** Coalesced StrictMode violations, ascending by `ts`. */
  strictMode: StrictModeSample[];
  /**
   * Newest laptop-clock timestamp (cpu / memory / frames / events / screens / breakdown / stalls /
   * StrictMode); the pruning reference.
   * Logs never advance it: they carry the device clock, which can jump.
   */
  latestTs: number;
  nextLogSeq: number;
  lastError: ServerError | null;
  /** Count of errors received; ids never repeat even after dismissal. */
  errorSeq: number;
  /** Count of `session` messages; lets the UI know a start/stop request was answered. */
  sessionSeq: number;
  /** Sticky until a device shows up: the server can't run adb at all. */
  adbUnavailable: string | null;
  /**
   * Sticky until a new session starts or the SDK connects: the server could not map the SDK
   * port (`adb reverse`), so the app's SDK can't reach it.
   */
  sdkLinkError: string | null;
}

export const ADB_UNAVAILABLE_CODE = 'adb_unavailable';
export const SDK_LINK_UNAVAILABLE_CODE = 'sdk_link_unavailable';
/** Mirrors the server's span buffer cap; the oldest spans go first. */
export const MAX_SCREEN_SPANS = 2000;
/** Caps on the stall / StrictMode buffers (the oldest go first); the server's byte limits are tighter. */
export const MAX_STALLS = 2000;
export const MAX_STRICT_MODE = 2000;
/** A span start this far past the laptop clock can't move the pruning reference further. */
export const FUTURE_SLACK_MS = 5000;
/** A laptop clock step back larger than this resets the timeline instead of dropping samples. */
export const CLOCK_STEP_BACK_MS = 5000;

export const IDLE_SESSION: SessionState = {
  status: 'idle',
  serial: null,
  packageName: null,
  pid: null,
  startedAt: null,
};

export function createInitialState(): DashboardState {
  return {
    connection: { status: 'connecting', attempt: 0, retryAt: null, closeReason: null },
    server: null,
    bufferWindowMs: DEFAULT_BUFFER_WINDOW_MS,
    devices: null,
    apps: null,
    session: IDLE_SESSION,
    cpu: [],
    memory: [],
    frames: [],
    logs: [],
    events: [],
    screens: [],
    breakdown: [],
    stalls: [],
    strictMode: [],
    latestTs: 0,
    nextLogSeq: 0,
    lastError: null,
    errorSeq: 0,
    sessionSeq: 0,
    adbUnavailable: null,
    sdkLinkError: null,
  };
}

export function isProtocolMismatch(state: DashboardState): boolean {
  return state.server !== null && state.server.protocolVersion !== PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Drops leading items older than `cutoff`. Returns the same array when nothing is dropped. */
export function pruneBefore<T extends { ts: number }>(items: T[], cutoff: number): T[] {
  let first = 0;
  while (first < items.length && (items[first]?.ts ?? Infinity) < cutoff) first++;
  return first === 0 ? items : items.slice(first);
}

/**
 * Drops leading spans that ended before `cutoff`. An open span ends "now" (`openEnd`), so the
 * current screen is never pruned. Returns the same array when nothing is dropped.
 */
export function pruneSpans(spans: ScreenSpan[], cutoff: number, openEnd: number): ScreenSpan[] {
  let first = 0;
  while (first < spans.length) {
    const span = spans[first];
    if (span === undefined || (span.end ?? openEnd) >= cutoff) break;
    first++;
  }
  return first === 0 ? spans : spans.slice(first);
}

/**
 * Sorts spans by start, keeps the last report for each start, drops empty closed spans and closes
 * every span at the next one's start, so starts are unique, only the last can stay open and spans
 * never overlap (a snapshot is trusted for content, not for shape).
 */
export function normalizeSpans(spans: readonly ScreenSpan[]): ScreenSpan[] {
  const byStart = new Map<number, ScreenSpan>();
  for (const span of spans) {
    if (span.end !== null && span.end <= span.start) continue;
    byStart.delete(span.start);
    byStart.set(span.start, span);
  }
  const sorted = [...byStart.values()].sort((a, b) => a.start - b.start);
  return capSpans(sorted).map((span, i, kept) => {
    const next = kept[i + 1];
    if (next === undefined) return { ...span };
    const end = span.end === null || span.end > next.start ? next.start : span.end;
    return { ...span, end };
  });
}

function capSpans(spans: ScreenSpan[]): ScreenSpan[] {
  return spans.length > MAX_SCREEN_SPANS ? spans.slice(spans.length - MAX_SCREEN_SPANS) : spans;
}

export type SpanAppendResult = { kind: 'append' | 'reset'; spans: ScreenSpan[] } | { kind: 'drop' };

/**
 * A new top screen closes the open span at its start. Like `appendSample`, a small step back is
 * dropped and a large one (laptop clock moved) restarts the buffer from this span.
 */
export function appendSpan(spans: ScreenSpan[], span: ScreenSpan): SpanAppendResult {
  const last = spans[spans.length - 1];
  const incoming: ScreenSpan = { ...span };
  if (last === undefined) return { kind: 'append', spans: [incoming] };
  // Same start: the newer report of that moment wins.
  if (span.start === last.start) return { kind: 'append', spans: [...spans.slice(0, -1), incoming] };
  if (span.start > last.start) {
    const closed: ScreenSpan =
      last.end === null || last.end > span.start ? { ...last, end: span.start } : last;
    return { kind: 'append', spans: capSpans([...spans.slice(0, -1), closed, incoming]) };
  }
  if (last.start - span.start > CLOCK_STEP_BACK_MS) return { kind: 'reset', spans: [incoming] };
  return { kind: 'drop' };
}

export type AppendResult<T> = { kind: 'append' | 'reset'; items: T[] } | { kind: 'drop' };

/**
 * Appends a sample in time order (uPlot needs ascending x). Small reorderings are dropped;
 * a step back of more than `CLOCK_STEP_BACK_MS` means the laptop clock moved, so the
 * buffer restarts from this sample instead of rejecting every sample from now on.
 */
export function appendSample<T extends { ts: number }>(items: T[], sample: T): AppendResult<T> {
  const last = items[items.length - 1];
  if (last === undefined || sample.ts > last.ts) return { kind: 'append', items: [...items, sample] };
  if (last.ts - sample.ts > CLOCK_STEP_BACK_MS) return { kind: 'reset', items: [sample] };
  return { kind: 'drop' };
}

function byTs<T extends { ts: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.ts - b.ts);
}

function capTail<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/**
 * Inserts a sample at its time position. Stalls are reported when the block ends, up to 30 s after
 * their start, so they arrive behind newer metric samples; that is never a clock step. With
 * `replaceSameTs`, a sample with the same `ts` replaces the stored one (a stall start is unique).
 */
export function insertByTs<T extends { ts: number }>(
  items: T[],
  sample: T,
  max: number,
  replaceSameTs: boolean,
): T[] {
  let at = items.length;
  while (at > 0 && (items[at - 1]?.ts ?? -Infinity) > sample.ts) at--;
  if (replaceSameTs && at > 0 && items[at - 1]?.ts === sample.ts) {
    return [...items.slice(0, at - 1), sample, ...items.slice(at)];
  }
  return capTail([...items.slice(0, at), sample, ...items.slice(at)], max);
}

/**
 * Drops leading stalls that ended before `cutoff`: one that started before the window's left edge is
 * still on screen. Stalls on one main thread never overlap, so ends ascend with starts.
 */
export function pruneStallsBefore(stalls: StallSample[], cutoff: number): StallSample[] {
  let first = 0;
  while (first < stalls.length) {
    const stall = stalls[first];
    if (stall === undefined || stall.ts + stall.durationMs >= cutoff) break;
    first++;
  }
  return first === 0 ? stalls : stalls.slice(first);
}

/** Sorted, one stall per start (the last report wins), capped. */
export function normalizeStalls(stalls: readonly StallSample[]): StallSample[] {
  const byStart = new Map<number, StallSample>();
  for (const stall of stalls) {
    byStart.delete(stall.ts);
    byStart.set(stall.ts, stall);
  }
  return capTail(byTs([...byStart.values()]), MAX_STALLS);
}

function capLogs(logs: LogRecord[]): LogRecord[] {
  return logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs;
}

function withSeq(entries: readonly LogEntry[], startSeq: number): LogRecord[] {
  return entries.map((entry, i) => ({ ...entry, seq: startSeq + i }));
}

function maxTs(...groups: ReadonlyArray<readonly { ts: number }[]>): number {
  let max = 0;
  for (const group of groups) for (const item of group) if (item.ts > max) max = item.ts;
  return max;
}

function maxSpanTs(spans: readonly ScreenSpan[]): number {
  let max = 0;
  for (const span of spans) max = Math.max(max, span.start, span.end ?? 0);
  return max;
}

/** Re-applies the time window to every buffer relative to `latestTs`. */
function pruneAll(state: DashboardState): DashboardState {
  if (state.latestTs === 0) {
    const logs = capLogs(state.logs);
    return logs === state.logs ? state : { ...state, logs };
  }
  const cutoff = state.latestTs - state.bufferWindowMs;
  const cpu = pruneBefore(state.cpu, cutoff);
  const memory = pruneBefore(state.memory, cutoff);
  const frames = pruneBefore(state.frames, cutoff);
  const logs = capLogs(pruneBefore(state.logs, cutoff));
  const events = pruneBefore(state.events, cutoff);
  const screens = pruneSpans(state.screens, cutoff, state.latestTs);
  const breakdown = pruneBefore(state.breakdown, cutoff);
  const stalls = pruneStallsBefore(state.stalls, cutoff);
  const strictMode = pruneBefore(state.strictMode, cutoff);
  if (
    cpu === state.cpu &&
    memory === state.memory &&
    frames === state.frames &&
    logs === state.logs &&
    events === state.events &&
    screens === state.screens &&
    breakdown === state.breakdown &&
    stalls === state.stalls &&
    strictMode === state.strictMode
  ) {
    return state;
  }
  return { ...state, cpu, memory, frames, logs, events, screens, breakdown, stalls, strictMode };
}

function applySnapshot(state: DashboardState, snapshot: Snapshot, now: number): DashboardState {
  const logs = withSeq(byTs(snapshot.logs), state.nextLogSeq);
  const screens = normalizeSpans(snapshot.screens ?? []);
  const breakdown = byTs(snapshot.breakdown ?? []);
  const horizon = now + FUTURE_SLACK_MS;
  const stalls = normalizeStalls((snapshot.stalls ?? []).filter((s) => s.ts <= horizon));
  const strictMode = capTail(
    byTs((snapshot.strictMode ?? []).filter((v) => v.ts <= horizon)),
    MAX_STRICT_MODE,
  );
  const next: DashboardState = {
    ...state,
    cpu: byTs(snapshot.cpu),
    memory: byTs(snapshot.memory),
    frames: byTs(snapshot.frames),
    logs,
    events: byTs(snapshot.events),
    screens,
    breakdown,
    stalls,
    strictMode,
    nextLogSeq: state.nextLogSeq + logs.length,
    latestTs: Math.max(
      maxTs(snapshot.cpu, snapshot.memory, snapshot.frames, snapshot.events, breakdown, stalls, strictMode),
      maxSpanTs(screens),
    ),
  };
  return pruneAll(next);
}

function advance(state: DashboardState, ts: number): number {
  return ts > state.latestTs ? ts : state.latestTs;
}

type MetricKey = 'cpu' | 'memory' | 'frames' | 'breakdown';

/**
 * The laptop clock moved back: every laptop-clock buffer restarts at `ts`. The screen on top
 * is still on top, so an open span carries over, re-based to the reset.
 */
function resetTimeline(state: DashboardState, ts: number): DashboardState {
  const open = state.screens[state.screens.length - 1];
  const screens = open !== undefined && open.end === null ? [{ ...open, start: ts }] : [];
  return {
    ...state,
    cpu: [],
    memory: [],
    frames: [],
    events: [],
    screens,
    breakdown: [],
    stalls: [],
    strictMode: [],
    latestTs: ts,
  };
}

function applyMetric<K extends MetricKey>(
  state: DashboardState,
  key: K,
  sample: DashboardState[K][number],
): DashboardState {
  const result = appendSample<DashboardState[K][number]>(state[key], sample);
  switch (result.kind) {
    case 'drop':
      return state;
    case 'append':
      return pruneAll({ ...state, [key]: result.items, latestTs: advance(state, sample.ts) });
    case 'reset':
      // The whole timeline shares one clock: restart every laptop-clock buffer together.
      return pruneAll({ ...resetTimeline(state, sample.ts), [key]: result.items });
  }
}

function applyScreen(state: DashboardState, span: ScreenSpan, now: number): DashboardState {
  const result = appendSpan(state.screens, span);
  switch (result.kind) {
    case 'drop':
      return state;
    case 'append': {
      // A bogus far-future start must not drag the window (and pruning) past the present.
      const reference = Math.min(span.start, now + FUTURE_SLACK_MS);
      return pruneAll({ ...state, screens: result.spans, latestTs: advance(state, reference) });
    }
    case 'reset':
      return pruneAll({ ...resetTimeline(state, span.start), screens: result.spans });
  }
}

/**
 * Stalls and violations slot in by time. One that claims to start more than `FUTURE_SLACK_MS` past the
 * laptop clock is bogus (both are reported after the fact): it is dropped, so it can't sit in the buffer
 * ahead of every real one or drag the window (and pruning) past the present.
 */
function applyStall(state: DashboardState, sample: StallSample, now: number): DashboardState {
  if (sample.ts > now + FUTURE_SLACK_MS) return state;
  const stalls = insertByTs(state.stalls, sample, MAX_STALLS, true);
  return pruneAll({ ...state, stalls, latestTs: advance(state, sample.ts) });
}

function applyStrictMode(state: DashboardState, sample: StrictModeSample, now: number): DashboardState {
  if (sample.ts > now + FUTURE_SLACK_MS) return state;
  const strictMode = insertByTs(state.strictMode, sample, MAX_STRICT_MODE, false);
  return pruneAll({ ...state, strictMode, latestTs: advance(state, sample.ts) });
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyServerMessage(state: DashboardState, msg: ServerMessage): DashboardState {
  return applyServerMessageAt(state, msg, Date.now());
}

/** `now` (laptop clock) only bounds how far SDK spans / stalls / violations can move the pruning reference. */
export function applyServerMessageAt(state: DashboardState, msg: ServerMessage, now: number): DashboardState {
  switch (msg.type) {
    case 'hello': {
      const bufferWindowMs = msg.bufferWindowMs > 0 ? msg.bufferWindowMs : DEFAULT_BUFFER_WINDOW_MS;
      return pruneAll({
        ...state,
        server: { protocolVersion: msg.protocolVersion, serverVersion: msg.serverVersion },
        bufferWindowMs,
      });
    }
    case 'devices':
      return {
        ...state,
        devices: [...msg.devices],
        adbUnavailable: msg.devices.length > 0 ? null : state.adbUnavailable,
      };
    case 'apps':
      return { ...state, apps: { serial: msg.serial, apps: [...msg.apps] } };
    case 'session': {
      const isNewSession = msg.session.startedAt !== state.session.startedAt;
      const sdkLinkError = msg.session.sdk?.connected === true || isNewSession ? null : state.sdkLinkError;
      return { ...state, session: { ...msg.session }, sessionSeq: state.sessionSeq + 1, sdkLinkError };
    }
    case 'snapshot':
      return applySnapshot(state, msg.snapshot, now);
    case 'cpu':
      return applyMetric(state, 'cpu', msg.sample);
    case 'memory':
      return applyMetric(state, 'memory', msg.sample);
    case 'frames':
      return applyMetric(state, 'frames', msg.sample);
    case 'logs': {
      if (msg.entries.length === 0) return state;
      const incoming = withSeq(msg.entries, state.nextLogSeq);
      return pruneAll({
        ...state,
        logs: capLogs([...state.logs, ...incoming]),
        nextLogSeq: state.nextLogSeq + incoming.length,
      });
    }
    case 'event':
      return pruneAll({
        ...state,
        events: byTs([...state.events, msg.event]),
        latestTs: advance(state, msg.event.ts),
      });
    case 'screen':
      return applyScreen(state, msg.span, now);
    case 'breakdown':
      return applyMetric(state, 'breakdown', msg.sample);
    case 'stall':
      return applyStall(state, msg.sample, now);
    case 'strictmode':
      return applyStrictMode(state, msg.sample, now);
    case 'error': {
      const id = state.errorSeq + 1;
      const lastError: ServerError =
        msg.code === undefined ? { id, message: msg.message } : { id, message: msg.message, code: msg.code };
      const adbUnavailable = msg.code === ADB_UNAVAILABLE_CODE ? msg.message : state.adbUnavailable;
      const sdkLinkError = msg.code === SDK_LINK_UNAVAILABLE_CODE ? msg.message : state.sdkLinkError;
      return { ...state, lastError, errorSeq: id, adbUnavailable, sdkLinkError };
    }
  }
}

export function setConnection(state: DashboardState, connection: ConnectionState): DashboardState {
  const prev = state.connection;
  if (
    prev.status === connection.status &&
    prev.attempt === connection.attempt &&
    prev.retryAt === connection.retryAt &&
    prev.closeReason === connection.closeReason
  ) {
    return state;
  }
  return { ...state, connection: { ...connection } };
}

export function dismissError(state: DashboardState, id: number): DashboardState {
  return state.lastError?.id === id ? { ...state, lastError: null } : state;
}

// ---------------------------------------------------------------------------
// External store with frame batching
// ---------------------------------------------------------------------------

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'connection'; connection: ConnectionState }
  | { kind: 'dismissError'; id: number };

export function reduce(state: DashboardState, action: Action): DashboardState {
  switch (action.kind) {
    case 'server':
      return applyServerMessage(state, action.msg);
    case 'connection':
      return setConnection(state, action.connection);
    case 'dismissError':
      return dismissError(state, action.id);
  }
}

/** Schedules `flush`; returns a cancel function. */
export type FlushScheduler = (flush: () => void) => () => void;

/** Max wait for a flush when animation frames are throttled (background tab). */
const FALLBACK_FLUSH_MS = 250;

export const frameScheduler: FlushScheduler = (flush) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    flush();
  };
  const raf = requestAnimationFrame(run);
  const timer = setTimeout(run, FALLBACK_FLUSH_MS);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
};

export interface DashboardStore {
  getState(): DashboardState;
  subscribe(listener: () => void): () => void;
  /** Queues an action; listeners are notified once per scheduled flush. */
  dispatch(action: Action): void;
  /** Applies queued actions immediately. */
  flush(): void;
}

/** Applies one action; a throwing reducer skips that action instead of losing the batch. */
function reduceSafely(state: DashboardState, action: Action): DashboardState {
  try {
    return reduce(state, action);
  } catch (error) {
    console.error('Lionscope: dropped a message the dashboard could not apply', action, error);
    return state;
  }
}

export function createStore(
  scheduler: FlushScheduler = frameScheduler,
  initial: DashboardState = createInitialState(),
): DashboardStore {
  let state = initial;
  let queue: Action[] = [];
  let cancelScheduled: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const flush = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    const next = pending.reduce(reduceSafely, state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action) {
      queue.push(action);
      cancelScheduled ??= scheduler(flush);
    },
    flush,
  };
}

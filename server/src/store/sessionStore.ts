import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  LogEntry,
  MemorySample,
  ScreenRef,
  ScreenSpan,
  ServerMessage,
  Snapshot,
  TimelineEvent,
} from '@lionscope/protocol';
import { TimeWindowBuffer } from './timeWindowBuffer.ts';
import type { ByteLimit } from './timeWindowBuffer.ts';

/** Item type of every timestamped stream. */
export interface StreamItems {
  cpu: CpuSample;
  memory: MemorySample;
  frames: FrameSample;
  logs: LogEntry;
  events: TimelineEvent;
  breakdown: FrameBreakdownSample;
}
export type SampleStream = keyof StreamItems;

interface StreamSpec<S extends SampleStream> {
  maxItems: number;
  byteLimit?: ByteLimit<StreamItems[S]>;
  /** Items must have strictly increasing `ts` (two producers hand over the stream); others are dropped. */
  increasing?: true;
  /** The dashboard messages announcing freshly appended items. */
  toMessages: (items: StreamItems[S][]) => ServerMessage[];
}

const MAX_SAMPLES = 5000;
const MAX_SCREEN_SPANS = 2000;

const STREAMS: { [S in SampleStream]: StreamSpec<S> } = {
  cpu: { maxItems: MAX_SAMPLES, toMessages: (items) => items.map((sample) => ({ type: 'cpu', sample })) },
  memory: {
    maxItems: MAX_SAMPLES,
    toMessages: (items) => items.map((sample) => ({ type: 'memory', sample })),
  },
  frames: {
    maxItems: MAX_SAMPLES,
    increasing: true,
    toMessages: (items) => items.map((sample) => ({ type: 'frames', sample })),
  },
  logs: {
    maxItems: 5000,
    byteLimit: {
      maxBytes: 8 * 1024 * 1024,
      // UTF-16 text plus a rough per-entry overhead.
      sizeOf: (entry) => 2 * (entry.message.length + entry.tag.length) + 64,
    },
    toMessages: (entries) => [{ type: 'logs', entries }],
  },
  events: { maxItems: 1000, toMessages: (items) => items.map((event) => ({ type: 'event', event })) },
  breakdown: {
    maxItems: MAX_SAMPLES,
    increasing: true,
    toMessages: (items) => items.map((sample) => ({ type: 'breakdown', sample })),
  },
};

export const SAMPLE_STREAMS = Object.keys(STREAMS) as SampleStream[];

function sameScreen(a: ScreenRef | null, b: ScreenRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.className === b.className && a.kind === b.kind;
}

/** Screen spans are pruned by their end, so an old but still open span stays visible. */
interface ScreenEntry {
  ts: number;
  span: ScreenSpan;
}

type Buffers = { [S in SampleStream]: TimeWindowBuffer<StreamItems[S]> };
type Arrays = { [S in SampleStream]: StreamItems[S][] };

export function emptySnapshot(): Required<Snapshot> {
  const streams = Object.fromEntries(SAMPLE_STREAMS.map((stream) => [stream, []])) as unknown as Arrays;
  return { ...streams, screens: [] };
}

export interface SessionStoreOptions {
  windowMs: number;
  emit: (message: ServerMessage) => void;
  now: () => number;
}

/**
 * Every data stream of one profiling session: a TimeWindowBuffer per stream, and the single place where
 * new data is buffered and announced. Buffers are written before broadcasting, so a snapshot taken for a
 * resync always contains the item that triggered it.
 */
export class SessionStore {
  private readonly buffers: Buffers;
  private readonly screens: TimeWindowBuffer<ScreenEntry>;

  constructor(private readonly options: SessionStoreOptions) {
    const buffer = <S extends SampleStream>(stream: S): TimeWindowBuffer<StreamItems[S]> =>
      new TimeWindowBuffer(options.windowMs, STREAMS[stream].maxItems, STREAMS[stream].byteLimit);
    this.buffers = {
      cpu: buffer('cpu'),
      memory: buffer('memory'),
      frames: buffer('frames'),
      logs: buffer('logs'),
      events: buffer('events'),
      breakdown: buffer('breakdown'),
    };
    this.screens = new TimeWindowBuffer(options.windowMs, MAX_SCREEN_SPANS);
  }

  append<S extends SampleStream>(stream: S, ...items: StreamItems[S][]): void {
    const buffer = this.buffers[stream];
    let latest = buffer.last()?.ts ?? -Infinity;
    const fresh = STREAMS[stream].increasing
      ? items.filter((item) => {
          if (item.ts <= latest) return false;
          latest = item.ts;
          return true;
        })
      : items;
    if (fresh.length === 0) return;
    buffer.push(...fresh);
    for (const message of STREAMS[stream].toMessages(fresh)) this.options.emit(message);
  }

  /** The newest item of a stream. */
  last<S extends SampleStream>(stream: S): StreamItems[S] | undefined {
    return this.buffers[stream].last();
  }

  /**
   * A new top screen from `start` on; closes the open span (starts never go backwards). Repeating the
   * screen that is already on top is a no-op.
   */
  appendScreen(start: number, screen: ScreenRef | null): void {
    const previous = this.screens.last()?.span;
    if (previous?.end === null && sameScreen(previous.screen, screen)) return;
    const span: ScreenSpan = { start: Math.max(start, previous?.start ?? start), end: null, screen };
    this.closeOpenSpan(span.start);
    this.screens.push({ ts: span.start, span });
    this.options.emit({ type: 'screen', span });
  }

  /**
   * End the open span at `end` (SDK link closed, session stopped). Announced as a `screen` message carrying
   * the closed span: it has the same `start` as the open one, which it replaces.
   */
  closeScreen(end: number): void {
    const closed = this.closeOpenSpan(end);
    if (closed) this.options.emit({ type: 'screen', span: closed });
  }

  /** `ScreenRef.name` on top at `ts`, or null (no span, background, or after the last span closed). */
  topScreenAt(ts: number): string | null {
    const span = this.screens.findLast((entry) => entry.span.start <= ts)?.span;
    if (!span || (span.end !== null && span.end <= ts)) return null;
    return span.screen?.name ?? null;
  }

  snapshot(): Required<Snapshot> {
    const now = this.options.now();
    const streams = Object.fromEntries(
      SAMPLE_STREAMS.map((stream) => [stream, this.buffers[stream].toArray(now)]),
    ) as unknown as Arrays;
    const cutoff = now - this.options.windowMs;
    const screens = this.screens
      .toArray()
      .map((entry) => entry.span)
      .filter((span) => (span.end ?? Infinity) >= cutoff);
    return { ...streams, screens };
  }

  /** Returns the span it closed, or null when none was open. */
  private closeOpenSpan(end: number): ScreenSpan | null {
    const last = this.screens.last()?.span;
    if (!last || last.end !== null) return null;
    const closed: ScreenSpan = { ...last, end: Math.max(end, last.start) };
    this.screens.replaceLast({ ts: closed.end ?? closed.start, span: closed });
    return closed;
  }
}

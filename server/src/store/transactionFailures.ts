import { MAX_FAILURE_REPORT_BYTES, TRANSACTION_FAILURE_JOIN_MS } from '@lionscope/protocol';
import type { LogEntry, SavedStateSample, ServerMessage, TransactionFailure } from '@lionscope/protocol';
import type { AppCrash } from './crashLog.ts';

/** `!!! FAILED BINDER TRANSACTION !!!  (parcel size = 583524)` (tag JavaBinder); older releases log no size. */
const BINDER_LINE = /^!!! FAILED BINDER TRANSACTION !!!(?:\s+\(parcel size = (\d+)\))?/;
const TTLE = 'android.os.TransactionTooLargeException';
/** `data parcel size 583524 bytes`, the exception's message (Android 7+). */
const DATA_PARCEL_SIZE = /data parcel size (\d+) bytes/;
/** `at android.app.IActivityManager$Stub$Proxy.activityStopped(IActivityManager.java:4027)`: the failed call. */
const PROXY_FRAME = /^at (?:[\w$]+\.)*([\w$]+)\$Stub\$Proxy\.([\w$]+)\(/;
export const MAX_TRANSACTION_FAILURES = 50;
/** Saved-state reports kept per process to join a later failure with. */
const RECENT_SAVED_STATES = 20;

interface RecentState {
  pid: number;
  sample: SavedStateSample;
}

export interface TransactionFailuresOptions {
  emit: (message: ServerMessage) => void;
  /** The SDK's top screen at a time (null without the SDK). */
  topScreenAt: (ts: number) => string | null;
  /** A failure was recorded for the first time (the session puts it on the timeline). */
  onNew?: (failure: TransactionFailure) => void;
}

/**
 * The session's TransactionTooLargeException failures, read from logcat (no SDK needed): JavaBinder's line in the
 * app's own log, and app crashes caused by the exception (crash buffer). A crash within TRANSACTION_FAILURE_JOIN_MS
 * of a binder line of the same process is the same failure. CrashLog reads a crash line by line, so a crash is looked
 * at again on every flush until its facts are complete: its failure is filled in, never recorded twice. The SDK's
 * saved-state report that explains a failure is the one of that process within TRANSACTION_FAILURE_JOIN_MS, newest at
 * or before the failure (else the nearest after); SDK and logcat are separate streams, so a report that arrives late
 * replaces an older one, and never a better one. Kept for the whole session, the last MAX_TRANSACTION_FAILURES, each
 * with that whole report (`report`, its summary's) for as long: within MAX_FAILURE_REPORT_BYTES all together, past
 * which the oldest failures' reports go (their summaries stay).
 */
export class TransactionFailures {
  private readonly failures: TransactionFailure[] = [];
  /** Crash identity (`kind:pid:tid:ts`, stable while CrashLog adds lines) → the failure it is part of. */
  private readonly crashFailures = new Map<string, number>();
  private readonly recent: RecentState[] = [];
  private nextId = 1;

  constructor(private readonly options: TransactionFailuresOptions) {}

  /** Oldest first; copies. */
  list(): TransactionFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  /** Log lines of the app's process. */
  addLogs(entries: readonly LogEntry[]): void {
    for (const entry of entries) {
      if (entry.tag !== 'JavaBinder') continue;
      const line = BINDER_LINE.exec(entry.message);
      if (!line) continue;
      const parcelBytes = line[1] === undefined ? null : Number(line[1]);
      const joined = this.near(entry.pid, entry.ts, (failure) => !failure.binderLine);
      if (joined) this.update(joined, { binderLine: true, parcelBytes: joined.parcelBytes ?? parcelBytes });
      else
        this.record({
          ts: entry.ts,
          pid: entry.pid,
          parcelBytes,
          binderLine: true,
          crashed: false,
          transaction: null,
        });
    }
  }

  /**
   * The session's crashes so far (CrashLog keeps them, each growing line by line): one that shows the exception joins
   * or records a failure once, and fills in what later lines tell (the failed call) on later calls.
   */
  addCrashes(crashes: readonly AppCrash[]): void {
    for (const crash of crashes) {
      if (crash.kind !== 'java') continue;
      const facts = crashFacts(crash);
      if (!facts) continue;
      const key = `${crash.kind}:${crash.pid}:${crash.tid}:${crash.ts}`;
      const id = this.crashFailures.get(key);
      if (id !== undefined) {
        const failure = this.failures.find((known) => known.id === id);
        if (failure) this.fillIn(failure, facts);
        continue;
      }
      const joined = this.near(crash.pid, crash.ts, (failure) => !failure.crashed);
      if (joined) {
        this.crashFailures.set(key, joined.id);
        this.update(joined, {
          crashed: true,
          parcelBytes: joined.parcelBytes ?? facts.parcelBytes,
          transaction: joined.transaction ?? facts.transaction,
        });
      } else {
        const failure = this.record({
          ts: crash.ts,
          pid: crash.pid,
          binderLine: false,
          crashed: true,
          ...facts,
        });
        this.crashFailures.set(key, failure.id);
      }
    }
  }

  /**
   * An SDK saved-state report of process `pid`: explains that process's failures near it, now or later. It replaces a
   * failure's report only if it explains the failure better than the one it has: that one may already be gone from
   * the bounded recent history, so a late, worse report never downgrades it.
   */
  addSavedState(pid: number, sample: SavedStateSample): void {
    this.recent.push({ pid, sample });
    if (this.recent.length > RECENT_SAVED_STATES) this.recent.shift();
    for (const failure of this.failures) {
      if (failure.pid !== pid || Math.abs(failure.ts - sample.ts) > TRANSACTION_FAILURE_JOIN_MS) continue;
      const known = failure.savedState;
      if (sameSummary(known, sample) || (known !== null && !better(sample, known, failure.ts))) continue;
      this.update(failure, { savedState: summary(sample), report: sample });
    }
    this.capReports();
  }

  private record(
    facts: Omit<TransactionFailure, 'id' | 'screen' | 'savedState' | 'report'>,
  ): TransactionFailure {
    const state = this.savedStateFor(facts.pid, facts.ts);
    const failure: TransactionFailure = {
      id: this.nextId++,
      ...facts,
      screen: this.options.topScreenAt(facts.ts),
      savedState: state ? summary(state) : null,
      report: state ?? null,
    };
    this.failures.push(failure);
    // Its report goes with it.
    if (this.failures.length > MAX_TRANSACTION_FAILURES) this.failures.shift();
    this.options.emit({ type: 'transactionFailure', failure: { ...failure } });
    this.options.onNew?.({ ...failure });
    this.capReports();
    return failure;
  }

  /** What a crash's later lines tell that its failure does not know yet; emitted only when something changed. */
  private fillIn(failure: TransactionFailure, facts: NonNullable<ReturnType<typeof crashFacts>>): void {
    const changes: Partial<TransactionFailure> = {};
    if (failure.parcelBytes === null && facts.parcelBytes !== null) changes.parcelBytes = facts.parcelBytes;
    if (failure.transaction === null && facts.transaction !== null) changes.transaction = facts.transaction;
    if (Object.keys(changes).length > 0) this.update(failure, changes);
  }

  private update(failure: TransactionFailure, changes: Partial<TransactionFailure>): void {
    Object.assign(failure, changes);
    this.options.emit({ type: 'transactionFailure', failure: { ...failure } });
  }

  /** Within MAX_FAILURE_REPORT_BYTES: the oldest failures lose their report (not their summary) first. */
  private capReports(): void {
    const sizes = this.failures.map((failure) =>
      failure.report === null ? 0 : Buffer.byteLength(JSON.stringify(failure.report)),
    );
    let total = sizes.reduce((sum, size) => sum + size, 0);
    for (const [index, failure] of this.failures.entries()) {
      if (total <= MAX_FAILURE_REPORT_BYTES) return;
      if (failure.report === null) continue;
      total -= sizes[index] ?? 0;
      this.update(failure, { report: null });
    }
  }

  /**
   * The report of `pid` that explains a failure at `ts`: within the join window, the newest at or before it (the save
   * that was being sent), else the nearest after it. Ties go to the later arrival.
   */
  private savedStateFor(pid: number, ts: number): SavedStateSample | undefined {
    let best: SavedStateSample | undefined;
    for (const { pid: statePid, sample } of this.recent) {
      if (statePid !== pid || Math.abs(sample.ts - ts) > TRANSACTION_FAILURE_JOIN_MS) continue;
      if (best === undefined || better(sample, best, ts)) best = sample;
    }
    return best;
  }

  /** The newest failure of `pid` within the join window of `ts` that `open` accepts. */
  private near(
    pid: number,
    ts: number,
    open: (failure: TransactionFailure) => boolean,
  ): TransactionFailure | undefined {
    return this.failures.findLast(
      (failure) =>
        failure.pid === pid && Math.abs(failure.ts - ts) <= TRANSACTION_FAILURE_JOIN_MS && open(failure),
    );
  }
}

/**
 * Whether `candidate` explains a failure at `ts` at least as well as `current` (both in its window); equal times go to
 * the candidate, the later arrival.
 */
function better(
  candidate: Pick<SavedStateSample, 'ts'>,
  current: Pick<SavedStateSample, 'ts'>,
  ts: number,
): boolean {
  const candidateBefore = candidate.ts <= ts;
  const currentBefore = current.ts <= ts;
  if (candidateBefore !== currentBefore) return candidateBefore;
  return candidateBefore ? candidate.ts >= current.ts : candidate.ts <= current.ts;
}

/**
 * The same report again (the process is already the failure's): same save of the same instance. Two instances of one
 * class can save at the same time with the same size; the later arrival is then a different report, not a duplicate.
 */
function sameSummary(known: TransactionFailure['savedState'], sample: SavedStateSample): boolean {
  return (
    known !== null &&
    known.ts === sample.ts &&
    known.activity === sample.activity &&
    known.totalBytes === sample.totalBytes &&
    known.instanceId === sample.instanceId
  );
}

function summary(sample: SavedStateSample): TransactionFailure['savedState'] {
  return {
    ts: sample.ts,
    activity: sample.activity,
    totalBytes: sample.totalBytes,
    instanceId: sample.instanceId,
  };
}

/** The size and failed call of a crash caused by TransactionTooLargeException; null for any other crash. */
export function crashFacts(
  crash: Pick<AppCrash, 'exception' | 'message' | 'stack'>,
): { parcelBytes: number | null; transaction: string | null } | null {
  const texts = [crash.exception ?? '', crash.message ?? '', ...crash.stack];
  if (!texts.some((text) => text.includes(TTLE))) return null;
  let parcelBytes: number | null = null;
  let transaction: string | null = null;
  for (const text of texts) {
    const size = DATA_PARCEL_SIZE.exec(text);
    if (size && parcelBytes === null) parcelBytes = Number(size[1]);
    const proxy = PROXY_FRAME.exec(text.trim());
    if (proxy && transaction === null) transaction = `${proxy[1]}.${proxy[2]}`;
  }
  return { parcelBytes, transaction };
}

import type { ServerMessage } from '@lionscope/protocol';
import { ErrorThrottle } from '../errors.ts';
import { errorMessage, log } from '../log.ts';

export type Collector = 'setup' | 'cpu' | 'frames' | 'memory' | 'logcat';
export type ParsedCollector = Extract<Collector, 'cpu' | 'frames' | 'memory'>;

/** Fixed client-facing messages for collector failures; details only go to the server log. */
export const PUBLIC_COLLECTOR_ERRORS: Readonly<Record<Collector, string>> = {
  setup: 'Could not read device properties; using defaults',
  cpu: 'CPU sampling failed; retrying',
  frames: 'Frame sampling failed; retrying',
  memory: 'Memory sampling failed; retrying',
  logcat: 'Logcat stream failed; restarting',
};

/** Sent when a command keeps succeeding but its output can't be parsed (e.g. an OEM format change). */
export const PUBLIC_UNPARSABLE_ERRORS: Readonly<Record<ParsedCollector, string>> = {
  cpu: 'CPU data unavailable on this device',
  frames: 'Frame data unavailable on this device (no window frame stats from gfxinfo)',
  memory: 'Memory data unavailable on this device',
};

/** Consecutive unparsable outputs before the problem is surfaced. */
export const PARSE_MISS_LIMIT = 3;

/** Counts consecutive parse misses; any success resets the streak. */
export class ParseMissCounter {
  private misses = 0;

  /** Returns true exactly when a miss streak reaches PARSE_MISS_LIMIT. */
  record(parsed: boolean): boolean {
    if (parsed) {
      this.misses = 0;
      return false;
    }
    this.misses += 1;
    return this.misses === PARSE_MISS_LIMIT;
  }

  reset(): void {
    this.misses = 0;
  }
}

export interface CollectorErrorReporterOptions {
  /** Prefix for server log lines, e.g. `[serial package]`. */
  logPrefix: string;
  emit: (message: ServerMessage) => void;
  now: () => number;
  /** Reporting stops once this returns true (the session was stopped). */
  isStopped: () => boolean;
}

/**
 * Error surfacing for one profiling session: details (command lines, adb output) go to the server log,
 * clients get a fixed per-collector message. Both are throttled per distinct message (re-reported after
 * ERROR_REPORT_TTL_MS); the session keeps running.
 */
export class CollectorErrorReporter {
  private readonly clientErrors: ErrorThrottle;
  private readonly loggedErrors: ErrorThrottle;
  private readonly parseMisses: Record<ParsedCollector, ParseMissCounter> = {
    cpu: new ParseMissCounter(),
    frames: new ParseMissCounter(),
    memory: new ParseMissCounter(),
  };

  constructor(private readonly options: CollectorErrorReporterOptions) {
    this.clientErrors = new ErrorThrottle(options.now);
    this.loggedErrors = new ErrorThrottle(options.now);
  }

  report(collector: Collector, error: unknown): void {
    if (this.options.isStopped()) return;
    const detail = `${collector}: ${errorMessage(error)}`;
    if (this.loggedErrors.shouldReport(detail)) log.warn(`${this.options.logPrefix} ${detail}`);
    if (this.clientErrors.shouldReport(collector)) {
      this.options.emit({
        type: 'error',
        code: 'collector_error',
        message: PUBLIC_COLLECTOR_ERRORS[collector],
      });
    }
  }

  /** A client-facing problem outside the collectors (e.g. the SDK link); throttled per `key`. */
  notify(key: string, message: string): void {
    if (this.options.isStopped()) return;
    if (this.loggedErrors.shouldReport(key)) log.warn(`${this.options.logPrefix} ${message}`);
    if (this.clientErrors.shouldReport(key)) {
      this.options.emit({ type: 'error', code: 'collector_error', message });
    }
  }

  /** Track a parse result; a streak of PARSE_MISS_LIMIT unparsable outputs is surfaced once (throttled). */
  parsed(collector: ParsedCollector, ok: boolean, output: string): void {
    if (!this.parseMisses[collector].record(ok) || this.options.isStopped()) return;
    const head = output.trim().slice(0, 200).replaceAll('\n', ' | ');
    log.warn(`${this.options.logPrefix} ${collector}: unparsable output, e.g. "${head}"`);
    if (this.clientErrors.shouldReport(`${collector}:unparsable`)) {
      this.options.emit({
        type: 'error',
        code: 'collector_error',
        message: PUBLIC_UNPARSABLE_ERRORS[collector],
      });
    }
  }

  /** A new process: earlier parse misses no longer count. */
  resetParseMisses(): void {
    for (const counter of Object.values(this.parseMisses)) counter.reset();
  }
}

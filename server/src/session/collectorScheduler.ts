import type { Collector } from './collectorErrors.ts';

/** Minimum pause between two ticks of one collector, even when a tick overruns its interval. */
const MIN_TICK_GAP_MS = 50;

export interface CollectorSchedulerOptions {
  now: () => number;
  /** A tick (or scheduled callback) failed; the collector keeps running. */
  report: (collector: Collector, error: unknown) => void;
}

/**
 * Timers of one profiling session's collectors: each polled collector runs on its own loop, never
 * overlapping itself, and can be paused. After stop() nothing runs any more.
 */
export class CollectorScheduler {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly paused = new Set<Collector>();
  private stopped = false;

  constructor(private readonly options: CollectorSchedulerOptions) {}

  isPaused(collector: Collector): boolean {
    return this.paused.has(collector);
  }

  /** Returns false when the collector already was in that state. */
  setPaused(collector: Collector, paused: boolean): boolean {
    if (paused === this.paused.has(collector)) return false;
    if (paused) this.paused.add(collector);
    else this.paused.delete(collector);
    return true;
  }

  /** Run `tick` every `intervalMs` (measured start to start), first after `delayMs`; skipped while paused. */
  loop(collector: Collector, intervalMs: number, tick: () => Promise<void>, delayMs: number): void {
    const run = async (): Promise<void> => {
      const started = this.options.now();
      if (!this.paused.has(collector)) await this.run(collector, tick);
      if (this.stopped) return;
      const elapsed = this.options.now() - started;
      this.schedule(collector, run, Math.max(MIN_TICK_GAP_MS, intervalMs - elapsed));
    };
    this.schedule(collector, run, delayMs);
  }

  schedule(collector: Collector, fn: () => Promise<void> | void, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        Promise.resolve(fn()).catch((error: unknown) => this.options.report(collector, error));
      } catch (error) {
        this.options.report(collector, error);
      }
    }, delayMs);
    this.timers.add(timer);
  }

  /** Run one tick now, reporting (not throwing) its failure. */
  async run(collector: Collector, tick: () => Promise<unknown>): Promise<void> {
    if (this.stopped) return;
    try {
      await tick();
    } catch (error) {
      this.options.report(collector, error);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

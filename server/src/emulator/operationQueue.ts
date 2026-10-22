import { PublicError } from '../errors.ts';

/** Boots and shutdowns waiting or running at once; more are refused as busy. */
export const MAX_QUEUED_OPERATIONS = 4;

/**
 * One boot or shutdown at a time, in order. Refused while one for the same AVD is pending or the queue is
 * full; operations still queued once `isClosed` (the server closes) do not start.
 */
export class OperationQueue {
  private readonly pendingAvds = new Set<string>();
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly isClosed: () => boolean) {}

  /** Settles (never rejects) once every operation queued so far has settled. */
  get settled(): Promise<unknown> {
    return this.tail;
  }

  run<T>(avdName: string, operation: () => Promise<T>): Promise<T> {
    if (this.pendingAvds.has(avdName)) {
      return Promise.reject(new PublicError(`${avdName} is busy: a boot or shutdown is still in progress`));
    }
    if (this.queued >= MAX_QUEUED_OPERATIONS) {
      return Promise.reject(new PublicError('Emulator operations are busy: try again in a moment'));
    }
    this.pendingAvds.add(avdName);
    this.queued += 1;
    const run = (): Promise<T> => {
      if (this.isClosed()) return Promise.reject(new PublicError('server is shutting down'));
      return operation();
    };
    const result = this.tail.then(run, run).finally(() => {
      this.pendingAvds.delete(avdName);
      this.queued -= 1;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

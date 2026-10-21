/** An error whose message is safe to show to dashboard clients (no paths, no command lines). */
export class PublicError extends Error {
  override name = 'PublicError';
}

export const ERROR_REPORT_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_ERRORS = 100;

/**
 * Time-based de-duplication: a key is reported at most once per `ttlMs`. When `maxKeys` distinct
 * keys are being tracked, expired ones are evicted; if none are, new keys are dropped silently.
 */
export class ErrorThrottle {
  private readonly lastReported = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = ERROR_REPORT_TTL_MS,
    private readonly maxKeys = MAX_TRACKED_ERRORS,
  ) {}

  shouldReport(key: string): boolean {
    const now = this.now();
    const last = this.lastReported.get(key);
    if (last !== undefined && now - last < this.ttlMs) return false;
    if (last === undefined && this.lastReported.size >= this.maxKeys) {
      for (const [tracked, at] of this.lastReported) {
        if (now - at >= this.ttlMs) this.lastReported.delete(tracked);
      }
      if (this.lastReported.size >= this.maxKeys) return false;
    }
    this.lastReported.set(key, now);
    return true;
  }
}

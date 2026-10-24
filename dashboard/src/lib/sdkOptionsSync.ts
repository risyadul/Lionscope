/**
 * Optimistic SDK options with request coalescing. The server rate-limits the socket (it closes a client
 * that floods it), answers every `setSdkOptions` with one `session` broadcast, and debounces the config it
 * pushes to the SDK. So the dashboard keeps at most one request in flight, merges later changes into one
 * queued patch that goes out when the answer (or an error) arrives, and shows the requested values until
 * `session.sdk.options` matches them, or a timeout says the server settled on something else.
 */
import type { SdkOptions } from '@lionscope/protocol/wire';

/** After this long without a matching `session`, the server's options win again. */
export const OPTIONS_SYNC_TIMEOUT_MS = 2000;

export interface OptionsSync {
  /** Every change requested since the sync started, merged; shown over the server's options. */
  desired: Partial<SdkOptions> | null;
  /** The request on the wire, marked by the counters it was sent at; null when none. */
  inFlight: { sessionSeq: number; errorSeq: number } | null;
  /** Changes made while a request was in flight, sent together once it is answered. */
  queued: Partial<SdkOptions> | null;
  /** When the latest change was requested (epoch ms). */
  since: number;
}

export const IDLE_SYNC: OptionsSync = { desired: null, inFlight: null, queued: null, since: 0 };

export interface SyncContext {
  sessionSeq: number;
  errorSeq: number;
  now: number;
}

/** The next sync state, plus a patch to send now (null: send nothing). */
export interface SyncStep {
  sync: OptionsSync;
  send: Partial<SdkOptions> | null;
}

/** The fields of `patch` that differ from `current`; null when nothing changes. */
export function changedFields(patch: Partial<SdkOptions>, current: SdkOptions): Partial<SdkOptions> | null {
  const changed: Partial<SdkOptions> = {};
  if (patch.stallThresholdMs !== undefined && patch.stallThresholdMs !== current.stallThresholdMs) {
    changed.stallThresholdMs = patch.stallThresholdMs;
  }
  if (patch.strictMode !== undefined && patch.strictMode !== current.strictMode) {
    changed.strictMode = patch.strictMode;
  }
  // Absent on older servers: read as on.
  if (patch.inflateTracking !== undefined && patch.inflateTracking !== (current.inflateTracking ?? true)) {
    changed.inflateTracking = patch.inflateTracking;
  }
  if (patch.rxTracking !== undefined && patch.rxTracking !== (current.rxTracking ?? true)) {
    changed.rxTracking = patch.rxTracking;
  }
  return Object.keys(changed).length === 0 ? null : changed;
}

export function matchesOptions(options: SdkOptions, desired: Partial<SdkOptions>): boolean {
  return changedFields(desired, options) === null;
}

/** Options to show: the server's, overlaid with what is still being applied. */
export function shownOptions(sync: OptionsSync, options: SdkOptions): SdkOptions {
  return sync.desired === null ? options : { ...options, ...sync.desired };
}

export function isSyncPending(sync: OptionsSync): boolean {
  return sync.desired !== null;
}

/** A user change: skipped when it equals what is shown, queued behind a request in flight. */
export function requestOptions(
  sync: OptionsSync,
  patch: Partial<SdkOptions>,
  options: SdkOptions,
  ctx: SyncContext,
): SyncStep {
  const changed = changedFields(patch, shownOptions(sync, options));
  if (changed === null) return { sync, send: null };
  const desired = { ...sync.desired, ...changed };
  if (sync.inFlight !== null) {
    return { sync: { ...sync, desired, queued: { ...sync.queued, ...changed }, since: ctx.now }, send: null };
  }
  return {
    sync: {
      desired,
      inFlight: { sessionSeq: ctx.sessionSeq, errorSeq: ctx.errorSeq },
      queued: null,
      since: ctx.now,
    },
    send: changed,
  };
}

/**
 * Reacts to the server: an error drops everything (the server's options are the truth); a matching
 * `session.sdk.options` or the timeout ends the sync; an answered request releases the queued patch.
 */
export function settleOptions(sync: OptionsSync, options: SdkOptions, ctx: SyncContext): SyncStep {
  if (sync.desired === null && sync.inFlight === null) return { sync, send: null };
  const { inFlight } = sync;
  if (inFlight !== null && ctx.errorSeq !== inFlight.errorSeq) return { sync: IDLE_SYNC, send: null };
  if (ctx.now - sync.since >= OPTIONS_SYNC_TIMEOUT_MS) return { sync: IDLE_SYNC, send: null };
  const isAnswered = inFlight !== null && ctx.sessionSeq !== inFlight.sessionSeq;
  if (
    sync.desired !== null &&
    matchesOptions(options, sync.desired) &&
    (sync.queued === null || isAnswered)
  ) {
    return { sync: IDLE_SYNC, send: null };
  }
  if (!isAnswered) return { sync, send: null };
  if (sync.queued === null) return { sync: { ...sync, inFlight: null }, send: null };
  // Only what still differs from the server goes out.
  const next = changedFields(sync.queued, options);
  if (next === null) return { sync: { ...sync, inFlight: null, queued: null }, send: null };
  return {
    sync: { ...sync, inFlight: { sessionSeq: ctx.sessionSeq, errorSeq: ctx.errorSeq }, queued: null },
    send: next,
  };
}

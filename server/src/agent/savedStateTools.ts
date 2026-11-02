/** `get_saved_state`: TransactionTooLarge failures (logcat, no SDK needed) and the SDK's saved-state attribution. */
import { z } from 'zod';
import {
  DEVICE_PROTOCOL_V10,
  LARGE_SAVED_STATE_BYTES,
  MAX_SAVED_STATE_DEPTH,
  MAX_SAVED_STATE_ENTRIES,
  TRANSACTION_FAILURE_JOIN_MS,
} from '@lionscope/protocol';
import { savedStateChainRows, sortChainRows } from '@lionscope/protocol/insights';
import type { SavedStateSample, TransactionFailure } from '@lionscope/protocol';
import { MAX_TRANSACTION_FAILURES } from '../store/transactionFailures.ts';
import { rangeInput, rangeView, timeRange } from './logTools.ts';
import { defineTool, READ_ONLY, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { iso, round } from './views.ts';

const MAX_REPORTS = 20;

const NO_SDK_NOTE =
  'No in-app SDK (0.12.0+) is connected: savedStates are not measured, but transactionFailures (from logcat) still are.';
const TRACKING_OFF_NOTE =
  'Saved-state tracking is off (set_sdk_options savedStateTracking: true turns it on): no new savedStates are measured, but transactionFailures (from logcat) still are.';

/**
 * The Fragment states of a report by class, biggest first: how many listed instances, their bytes together and the
 * largest one (a parent's bytes include its child fragments'), and the shallowest depth (keys from the Activity's
 * bundle down).
 */
function fragmentsOf(sample: SavedStateSample) {
  const byClass = new Map<
    string,
    { fragment: string; instances: number; bytes: number; largestBytes: number; depth: number }
  >();
  for (const entry of sample.entries) {
    if (entry.kind !== 'fragment' || entry.fragment === null) continue;
    const row = byClass.get(entry.fragment) ?? {
      fragment: entry.fragment,
      instances: 0,
      bytes: 0,
      largestBytes: 0,
      depth: entry.path.length,
    };
    row.instances += 1;
    row.bytes += entry.bytes;
    row.largestBytes = Math.max(row.largestBytes, entry.bytes);
    row.depth = Math.min(row.depth, entry.path.length);
    byClass.set(entry.fragment, row);
  }
  return [...byClass.values()].sort((a, b) => b.bytes - a.bytes);
}

function reportView(sample: SavedStateSample, entries: number) {
  return {
    time: iso(sample.ts),
    activity: sample.activity,
    pid: sample.pid,
    sdkInstanceId: sample.instanceId,
    screen: sample.screen,
    hook: sample.hook,
    totalBytes: sample.totalBytes,
    measureMs: round(sample.measureMs, 2),
    breakdownMs: sample.breakdownMs === null ? null : round(sample.breakdownMs, 2),
    fragments: fragmentsOf(sample),
    top: sample.entries.slice(0, entries).map((entry) => ({
      path: entry.path.join(' › '),
      bytes: entry.bytes,
      kind: entry.kind,
      fragment: entry.fragment,
      valueClass: entry.valueClass,
    })),
    truncated: sample.truncated || sample.entries.length > entries,
  };
}

function failureView(failure: TransactionFailure, entries: number) {
  return {
    time: iso(failure.ts),
    pid: failure.pid,
    parcelBytes: failure.parcelBytes,
    transaction: failure.transaction,
    crashed: failure.crashed,
    binderLine: failure.binderLine,
    screen: failure.screen,
    savedState:
      failure.savedState === null
        ? null
        : {
            time: iso(failure.savedState.ts),
            activity: failure.savedState.activity,
            totalBytes: failure.savedState.totalBytes,
            sdkInstanceId: failure.savedState.instanceId,
          },
    report: failure.report === null ? null : reportView(failure.report, entries),
  };
}

export const savedStateTool = defineTool({
  name: 'get_saved_state',
  title: 'Saved state and TransactionTooLarge',
  description: `What makes an app's saved state too large. transactionFailures (logcat, works without the SDK, kept all session, the last ${MAX_TRANSACTION_FAILURES}): binder calls of the app that failed with TransactionTooLargeException, from JavaBinder's "FAILED BINDER TRANSACTION (parcel size = N)" line and/or a crash caused by the exception (Android 7+ crashes when an Activity's saved state does not fit the activityStopped call made when it goes to the background: IActivityManager before Android 12, IActivityClientController from 12), each {time, pid, parcelBytes, transaction (the failed call), crashed, binderLine, screen, savedState: the SDK's report of that process within ${TRANSACTION_FAILURE_JOIN_MS} ms}. savedStates (in-app SDK 0.12.0+, session window): each Activity's complete saved state as measured once the save finished (also keys added after super.onSaveInstanceState(), and all Fragment state), {time, activity, screen, hook (post_save on API 29+, posted on 23-28), totalBytes as the system parcels it, measureMs / breakdownMs main-thread cost, fragments: the listed Fragment states by class {instances, bytes together, largestBytes, depth}, largest first (a parent's bytes include its child fragments'), top: the largest keys (from ${LARGE_SAVED_STATE_BYTES / 1024} KiB states on; path from the Activity's bundle down through nested and child fragments, at most ${MAX_SAVED_STATE_DEPTH} keys; bytes include nested content), truncated}. instances (SDK 0.12.0+): each Activity object, live ones first then by its last save, largest first: {activity, screen, pid, sdkInstanceIds (the SDK's per-process counter of Activity objects, newest first: a rotation continues the same Activity under a new id; not get_activity_instance's instanceId, a dumpsys hash), state (live, closed, process_ended), saves in the range, firstBytes, lastBytes, maxBytes, lastTime}, so a live Activity whose saves keep growing shows; savedStates and transactionFailures.savedState carry pid and sdkInstanceId (null from pre-release SDKs), and each failure keeps its whole report (top keys) all session. Sizes, keys and class names only, never values. minBytes keeps reports at least that big. since / sinceMarker / untilMarker as in search_logcat. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    ...rangeInput,
    minBytes: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Only saved-state reports at least this many bytes.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_REPORTS)
      .default(5)
      .describe(`Most reports returned, largest first (1-${MAX_REPORTS}).`),
    entries: z
      .number()
      .int()
      .min(1)
      .max(MAX_SAVED_STATE_ENTRIES)
      .default(10)
      .describe(`Keys listed per report (1-${MAX_SAVED_STATE_ENTRIES}).`),
  }),
  annotations: READ_ONLY,
  async run({ since, sinceMarker, untilMarker, minBytes, limit, entries }, ctx) {
    const range = timeRange(ctx, { since, sinceMarker, untilMarker });
    const { from, until } = range;
    const inRange = (ts: number) => ts >= from && ts < until;
    const reports = (ctx.sessions.getSnapshot().savedStates ?? []).filter(
      (sample) => inRange(sample.ts) && sample.totalBytes >= minBytes,
    );
    const failures = ctx.sessions.getTransactionFailures().filter((failure) => inRange(failure.ts));
    const snapshot = ctx.sessions.getSnapshot();
    const instances = sortChainRows(
      savedStateChainRows(snapshot.savedStateInstances ?? [], snapshot.savedStates ?? [], from, until - 1),
      'largest',
    )
      .sort((a, b) => Number(b.chain.head.state === 'live') - Number(a.chain.head.state === 'live'))
      .slice(0, limit * 2);
    const sdk = ctx.sessions.getSessionState().sdk;
    const savedStateTracking = sdk?.options?.savedStateTracking ?? true;
    // A v10 SDK is linked (it can measure saved states) and its saved-state tracking is on (it does).
    const capable = sdk?.connected === true && (sdk.protocolVersion ?? 0) >= DEVICE_PROTOCOL_V10;
    const measuring = capable && savedStateTracking;
    const largest = [...reports].sort((a, b) => b.totalBytes - a.totalBytes || b.ts - a.ts).slice(0, limit);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        range: rangeView(range),
        sdk: {
          connected: sdk?.connected ?? false,
          measuring,
          savedStateTracking,
        },
        ...(capable && !savedStateTracking
          ? { note: TRACKING_OFF_NOTE }
          : measuring || reports.length > 0
            ? {}
            : { note: NO_SDK_NOTE }),
        transactionFailures: failures.map((failure) => failureView(failure, entries)),
        savedStateReports: reports.length,
        largestBytes: largest[0]?.totalBytes ?? null,
        savedStates: largest.map((sample) => reportView(sample, entries)),
        instances: instances.map((row) => ({
          activity: row.chain.head.activity,
          screen: row.screen,
          pid: row.chain.pid,
          sdkInstanceIds: row.chain.instances.map((instance) => instance.id),
          state: row.chain.head.state,
          saves: row.saves,
          firstBytes: row.firstBytes,
          lastBytes: row.lastBytes,
          maxBytes: row.maxBytes,
          lastTime: row.lastTs === null ? null : iso(row.lastTs),
        })),
      },
    };
  },
});

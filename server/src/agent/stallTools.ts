/** `get_stalls` and `get_strictmode`: main-thread blocks and StrictMode violations, by culprit line. */
import { z } from 'zod';
import type { StallSample } from '@lionscope/protocol';
import {
  aggregateOffenders,
  aggregateOrigins,
  culpritFrame,
  culpritKey,
  groupStrictMode,
  originText,
  stallInWindow,
  stallOrigin,
  summarizeWindow,
} from '@lionscope/protocol/insights';
import { defineTool, READ_ONLY, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import {
  culpritView,
  iso,
  originView,
  round,
  stackLines,
  timeWindow,
  truncate,
  windowInput,
  windowView,
} from './views.ts';

const MAX_ROWS = 20;
const limitInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_ROWS)
  .default(10)
  .describe(`Most rows returned (1-${MAX_ROWS}).`);

const NO_SDK_NOTE =
  'No in-app SDK is connected, and stalls and StrictMode violations come from it: zero here means not measured, not that nothing happened.';
const STRICTMODE_OFF_NOTE =
  'StrictMode reporting is off, so zero means not measured: turn it on with set_sdk_options { strictMode: true }.';

/** The SDK link now and, for an empty result of a session whose SDK never linked, why it proves nothing. */
function sdkView(ctx: AgentContext, empty: boolean) {
  const connected = ctx.sessions.getSessionState().sdk?.connected === true;
  const never = !connected && !ctx.sessions.getSdkEverLinked();
  return { sdk: { connected }, ...(empty && never ? { note: NO_SDK_NOTE } : {}) };
}

/** The newest stall of each culprit line in the window, for its stack. */
function newestByCulprit(
  stalls: readonly StallSample[],
  fromTs: number,
  toTs: number,
): Map<string, StallSample> {
  const newest = new Map<string, StallSample>();
  for (const stall of stalls) {
    if (stall.debugger || !stallInWindow(stall, fromTs, toTs)) continue;
    const key = culpritKey(culpritFrame(stall.frames));
    const previous = newest.get(key);
    if (!previous || stall.ts >= previous.ts) newest.set(key, stall);
  }
  return newest;
}

export const stallsTool = defineTool({
  name: 'get_stalls',
  title: 'Main-thread stalls',
  description: `Main-thread blocks the in-app SDK watchdog caught (each at least the stall threshold, default 150 ms) in the window, as the dashboard's Stalls tab ranks them: offenders grouped by culprit line (the innermost app frame, else the innermost library frame), worst total blocked time first, with count, total/max ms and the screens they blocked; origins, the same stalls grouped by where the main-thread work came from (kind rx / coroutine / handler / frame / input / lifecycle / idle / unknown: the RxJava operator and the line that subscribed the chain, the coroutine's dispatcher, continuation and name, the posted Runnable, the Choreographer frame...), worst first; plus the newest stall events with their origin. Stalls with a debugger attached are counted apart (likely breakpoints). Pass includeStacks for each offender's newest stack and each Rx origin's subscribe stack, framework frames collapsed. sdk.connected is the SDK link now; an empty result with a note means the SDK never linked, so nothing was measured. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    window: windowInput,
    limit: limitInput,
    includeStacks: z.boolean().default(false).describe('Add the newest stack of each offender.'),
  }),
  annotations: READ_ONLY,
  async run({ window: label, limit, includeStacks }, ctx) {
    const snapshot = ctx.sessions.getSnapshot();
    const window = timeWindow(ctx, snapshot, label);
    const { fromTs, toTs } = window;
    const stalls = snapshot.stalls ?? [];
    const summary = summarizeWindow(stalls, [], fromTs, toTs);
    const newest = includeStacks ? newestByCulprit(stalls, fromTs, toTs) : null;
    const offenders = aggregateOffenders(stalls, fromTs, toTs).slice(0, limit);
    const origins = aggregateOrigins(stalls, fromTs, toTs).slice(0, limit);
    const events = stalls
      .filter((stall) => stallInWindow(stall, fromTs, toTs))
      .slice(-limit)
      .reverse();
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        window: windowView(window),
        ...sdkView(ctx, summary.count === 0 && summary.debuggerCount === 0),
        stallThresholdMs: ctx.sessions.getSessionState().sdk?.options?.stallThresholdMs ?? null,
        count: summary.count,
        blockedMs: round(summary.totalMs, 0),
        worstMs: round(summary.worstMs, 0),
        debuggerStalls: summary.debuggerCount,
        offenders: offenders.map((offender) => {
          const stack = newest?.get(offender.key)?.frames;
          return {
            ...culpritView(offender.frame === null ? [] : [offender.frame]),
            count: offender.count,
            totalMs: round(offender.totalMs, 0),
            maxMs: round(offender.maxMs, 0),
            screens: offender.screens,
            lastAt: iso(offender.lastTs),
            ...(stack ? { stack: stackLines(stack) } : {}),
          };
        }),
        origins: origins.map((group) => ({
          ...originView(group.origin),
          count: group.count,
          totalMs: round(group.totalMs, 0),
          maxMs: round(group.maxMs, 0),
          screens: group.screens,
          lastAt: iso(group.lastTs),
          ...(includeStacks && group.origin.subscribedAt.length > 0
            ? { subscribedAt: stackLines(group.origin.subscribedAt) }
            : {}),
        })),
        recentStalls: events.map((stall) => ({
          at: iso(stall.ts),
          durationMs: round(stall.durationMs, 0),
          screen: stall.screen,
          debugger: stall.debugger,
          ...culpritView(stall.frames),
          origin: originText(stallOrigin(stall)),
        })),
      },
    };
  },
});

export const strictModeTool = defineTool({
  name: 'get_strictmode',
  title: 'StrictMode violations',
  description: `StrictMode violations (disk/network on the main thread, leaked closeables, …) the in-app SDK reported in the window, grouped by violation class and culprit line, most occurrences first: violation, policy (thread/vm), culprit, occurrences, screens, the newest message and stack (framework frames collapsed). StrictMode reporting is off by default; turn it on with set_sdk_options { strictMode: true }. sdk.connected is the SDK link now; a note on an empty result says nothing was measured (no SDK linked, or StrictMode off). ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({ window: windowInput, limit: limitInput }),
  annotations: READ_ONLY,
  async run({ window: label, limit }, ctx) {
    const snapshot = ctx.sessions.getSnapshot();
    const window = timeWindow(ctx, snapshot, label);
    const groups = groupStrictMode(snapshot.strictMode ?? [], window.fromTs, window.toTs);
    const strictModeOn = ctx.sessions.getSessionState().sdk?.options?.strictMode ?? null;
    const empty = groups.length === 0;
    const sdk = sdkView(ctx, empty);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        window: windowView(window),
        ...sdk,
        ...(empty && !sdk.note && ctx.sessions.getSdkEverLinked() && strictModeOn === false
          ? { note: STRICTMODE_OFF_NOTE }
          : {}),
        strictModeOn,
        total: groups.length,
        violations: groups.slice(0, limit).map((group) => ({
          violation: group.violation,
          policy: group.policy,
          ...culpritView(group.latest.frames),
          occurrences: group.occurrences,
          screens: group.screens,
          lastAt: iso(group.lastTs),
          message: group.latest.message === null ? null : truncate(group.latest.message),
          stack: stackLines(group.latest.frames),
        })),
      },
    };
  },
});

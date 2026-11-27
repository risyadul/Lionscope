/**
 * Synchronization tools for low-flakiness E2E verification:
 * - `wait_for_network`: wait for a captured OkHttp exchange matching method/host/path/status, bound to the
 *   originating session and defaulting to invocation time (or explicit `sinceMarker`)
 * - `wait_for_screen`: wait until a target Activity/Fragment/screen alias is active (SDK screen data when linked,
 *   else `dumpsys activity activities` restricted to session device+package for read-only clients)
 * - `wait_for_idle`: wait until the UI tree settles without changes for `quietMs`
 * All waits check remaining budget before every probe and respect caller cancellation (`ctx.signal`).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { MAX_HTTP_URL_CHARS } from '@lionscope/protocol';
import type { HttpExchange, SessionState } from '@lionscope/protocol';
import { statusClassOf, urlParts } from '@lionscope/protocol/insights';
import type { HttpStatusClass } from '@lionscope/protocol/insights';
import { adbShellArgs } from '../adb/adb.ts';
import { optionalSerial, targetSerial } from './deviceTools.ts';
import { markerLabel, markerTs } from './logTools.ts';
import { NO_CAPTURE } from './networkTools.ts';
import { networkCapture } from './statusTools.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { dumpUi, parseTopActivity, parseTopPackage } from './uiDump.ts';
import { screenKey } from './uiTools.ts';
import { iso, round, truncate } from './views.ts';

const DUMPSYS_TIMEOUT_MS = 5000;
const MAX_LISTED_URL_CHARS = 1000;
const STOPPED_SESSION: ReadonlySet<SessionState['status']> = new Set(['idle', 'error']);

const statusMatcherInput = z
  .union([
    z.number().int().min(100).max(599),
    z.enum(['1xx', '2xx', '3xx', '4xx', '5xx', 'failed', 'pending']),
  ])
  .describe('Exact HTTP status code (e.g. 200, 404) or status class (1xx–5xx, failed, pending).');

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ToolError('Wait cancelled');
}

async function sleepBounded(ms: number, signal: AbortSignal | undefined): Promise<void> {
  checkAborted(signal);
  if (ms <= 0) return;
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new ToolError('Wait cancelled');
    }
    throw error;
  }
}

function matchesStatus(exchange: HttpExchange, wanted: number | HttpStatusClass | undefined): boolean {
  if (wanted === undefined) return true;
  if (typeof wanted === 'number') return exchange.status === wanted;
  return statusClassOf(exchange) === wanted;
}

function summarizeExchange(exchange: HttpExchange) {
  const { host, path } = urlParts(exchange.url);
  return {
    id: exchange.id,
    startedAt: iso(exchange.ts),
    method: exchange.method,
    url: truncate(exchange.url, MAX_LISTED_URL_CHARS),
    host,
    path: truncate(path, MAX_LISTED_URL_CHARS),
    state: exchange.state,
    status: exchange.status,
    headersMs: round(exchange.headersMs),
    durationMs: round(exchange.durationMs),
    requestSize: exchange.requestSize,
    responseSize: exchange.responseSize,
    responseType: exchange.responseType,
    mockId: exchange.mockId,
    error: exchange.error,
    screen: exchange.screen,
  };
}

function describeNetworkFilter(filter: {
  method?: string | undefined;
  host?: string | undefined;
  path?: string | undefined;
  status?: number | HttpStatusClass | undefined;
  sinceMarker?: string | undefined;
}): string {
  const parts: string[] = [];
  if (filter.method) parts.push(`method=${filter.method.toUpperCase()}`);
  if (filter.host) parts.push(`host*=${filter.host}`);
  if (filter.path) parts.push(`path*=${filter.path}`);
  if (filter.status !== undefined) parts.push(`status=${filter.status}`);
  if (filter.sinceMarker) parts.push(`sinceMarker=${filter.sinceMarker}`);
  return parts.length > 0 ? parts.join(', ') : 'any request';
}

function isActiveSession(session: SessionState): boolean {
  return !STOPPED_SESSION.has(session.status) && session.serial !== null && session.packageName !== null;
}

function sessionReplaced(
  initialId: number | null,
  initial: SessionState,
  currentId: number | null,
  current: SessionState,
): boolean {
  return (
    currentId !== initialId ||
    current.serial !== initial.serial ||
    current.packageName !== initial.packageName ||
    current.startedAt !== initial.startedAt ||
    STOPPED_SESSION.has(current.status)
  );
}

export const waitForNetworkTool = defineTool({
  name: 'wait_for_network',
  title: 'Wait for an HTTP request',
  description: `Waits until a captured OkHttp request matches method, host, path, and/or status (exact status code or class 1xx–5xx/failed/pending). Bound to the originating profiling session and defaults to matching requests started at or after invocation time (pass \`sinceMarker\` to include requests started since a \`mark\` label). Fails immediately if the session stops or is replaced, or when SDK 0.9.0+ HTTP capture is not active. By default waits for a completed or failed exchange (pass \`includePending: true\` or \`status: "pending"\` to match in-flight requests). ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    method: z.string().min(1).max(16).optional().describe('HTTP method, e.g. GET or POST (any case).'),
    host: z.string().min(1).max(256).optional().describe('Substring of the request host (any case).'),
    path: z
      .string()
      .min(1)
      .max(MAX_HTTP_URL_CHARS)
      .optional()
      .describe('Substring of the URL path (any case), e.g. "/v1/cart".'),
    status: statusMatcherInput.optional(),
    includePending: z
      .boolean()
      .default(false)
      .describe('Also match requests still in flight (default false: wait for response or failure).'),
    sinceMarker: markerLabel
      .optional()
      .describe('Only match requests started at or after this mark label (default: tool invocation time).'),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    intervalMs: z.number().int().min(50).max(5000).default(150),
  }),
  annotations: READ_ONLY,
  async run(
    { method, host, path: pathFilter, status, includePending, sinceMarker, timeoutMs, intervalMs },
    ctx,
  ) {
    checkAborted(ctx.signal);
    const initialSession = ctx.sessions.getSessionState();
    const initialSessionId = ctx.sessions.getSessionId();
    if (!networkCapture(initialSession) || !isActiveSession(initialSession)) {
      throw new ToolError(NO_CAPTURE);
    }
    const fromTs = sinceMarker === undefined ? ctx.now() : markerTs(ctx, sinceMarker);
    const wantMethod = method?.trim().toUpperCase();
    const wantHost = host?.toLowerCase();
    const wantPath = pathFilter?.toLowerCase();
    const allowPending = includePending || status === 'pending';

    const matches = (exchange: HttpExchange): boolean => {
      if (exchange.ts < fromTs) return false;
      if (!allowPending && exchange.state === 'pending') return false;
      if (wantMethod !== undefined && exchange.method.toUpperCase() !== wantMethod) return false;
      const parts = urlParts(exchange.url);
      if (wantHost !== undefined && !parts.host.toLowerCase().includes(wantHost)) return false;
      if (wantPath !== undefined && !parts.path.toLowerCase().includes(wantPath)) return false;
      return matchesStatus(exchange, status);
    };

    const start = performance.now();
    const deadline = start + timeoutMs;
    let seenSince = 0;

    for (let attempt = 0; ; attempt++) {
      checkAborted(ctx.signal);
      if (attempt > 0 && deadline - performance.now() <= 0) break;

      const currentSession = ctx.sessions.getSessionState();
      const currentSessionId = ctx.sessions.getSessionId();
      if (sessionReplaced(initialSessionId, initialSession, currentSessionId, currentSession)) {
        throw new ToolError(
          `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for network request`,
        );
      }

      const exchanges = ctx.sessions.getHttpExchanges();
      seenSince = exchanges.filter((ex) => ex.ts >= fromTs).length;
      const matched = exchanges.findLast(matches);
      if (matched) {
        return {
          data: {
            untrusted: UNTRUSTED_NOTE,
            matched: true,
            elapsedMs: Math.round(performance.now() - start),
            exchange: summarizeExchange(matched),
          },
        };
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleepBounded(Math.min(intervalMs, remaining), ctx.signal);
    }

    const elapsedMs = Math.round(performance.now() - start);
    const filterDesc = describeNetworkFilter({ method, host, path: pathFilter, status, sinceMarker });
    const hint =
      ctx.sessions.getHttpExchangesSeen() === 0
        ? ' (no HTTP exchanges have been captured in this session: verify Lionscope.okHttpInterceptor() is attached)'
        : ` (${seenSince} exchange${seenSince === 1 ? '' : 's'} seen in range)`;
    throw new ToolError(`Timed out after ${elapsedMs} ms waiting for network request (${filterDesc})${hint}`);
  },
});

function matchesScreenName(candidate: string | null | undefined, wanted: string, exact: boolean): boolean {
  if (!candidate) return false;
  return exact ? candidate === wanted : candidate.toLowerCase().includes(wanted.toLowerCase());
}

function simpleName(fullName: string): string {
  const dot = fullName.lastIndexOf('.');
  return dot === -1 ? fullName : fullName.slice(dot + 1);
}

export const waitForScreenTool = defineTool({
  name: 'wait_for_screen',
  title: 'Wait for a screen',
  description: `Waits until the target screen (Activity, Fragment, DialogFragment, or SDK ScreenName alias) becomes active, up to timeoutMs (default 10 s, max 30 s). Bound to the originating profiling session and device when a session is active (fails if the session stops or is replaced). Uses live SDK screen spans when the app's SDK is linked, and when the SDK's top screen is a Fragment/Dialog/destination also checks the target package's hosting resumed Activity via \`dumpsys activity activities\` (reporting \`matchedOn\`: \`screen\`, \`hostActivity\`, or \`activity\`). Falls back to the resumed Activity from \`dumpsys activity activities\` when the SDK is not linked. Without device control, \`dumpsys\` checks are restricted to the active session's device and target package and never reveal another app's foreground activity. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    screen: z
      .string()
      .min(1)
      .max(200)
      .describe('Target screen name, Fragment/Activity class name, or SDK ScreenName alias.'),
    exact: z
      .boolean()
      .default(false)
      .describe('Require exact case-sensitive match (default false: case-insensitive substring).'),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    intervalMs: z.number().int().min(50).max(5000).default(250),
    serial: optionalSerial,
  }),
  annotations: READ_ONLY,
  async run({ screen: wanted, exact, timeoutMs, intervalMs, serial: requested }, ctx) {
    checkAborted(ctx.signal);
    const initialSession = ctx.sessions.getSessionState();
    const initialSessionId = ctx.sessions.getSessionId();
    const hasActiveSession = isActiveSession(initialSession);

    let boundSession = false;
    let restrictToPackage: string | null = null;
    let serial: string;

    if (!ctx.deviceControl) {
      if (!hasActiveSession || !initialSession.serial || !initialSession.packageName) {
        throw new ToolError(
          'wait_for_screen without device control requires an active profiling session: call start_session first',
        );
      }
      if (requested !== undefined && requested !== initialSession.serial) {
        throw new ToolError(
          `Only the session target device (${initialSession.serial}) is allowed without device control, not ${requested}`,
        );
      }
      boundSession = true;
      restrictToPackage = initialSession.packageName;
      serial =
        initialSession.sdk?.connected === true
          ? initialSession.serial
          : targetSerial(ctx, initialSession.serial);
    } else if (
      hasActiveSession &&
      initialSession.serial &&
      (requested === undefined || requested === initialSession.serial)
    ) {
      boundSession = true;
      serial =
        initialSession.sdk?.connected === true
          ? initialSession.serial
          : targetSerial(ctx, initialSession.serial);
    } else {
      serial = targetSerial(ctx, requested);
    }

    const start = performance.now();
    const deadline = start + timeoutMs;
    let lastSource: 'sdk' | 'dumpsys' =
      boundSession && initialSession.sdk?.connected === true ? 'sdk' : 'dumpsys';
    let lastSeen: string | null = null;

    for (let attempt = 0; ; attempt++) {
      checkAborted(ctx.signal);
      const remainingBeforeProbe = deadline - performance.now();
      if (attempt > 0 && remainingBeforeProbe <= 0) break;

      const currentSession = ctx.sessions.getSessionState();
      const currentSessionId = ctx.sessions.getSessionId();
      if (
        boundSession &&
        sessionReplaced(initialSessionId, initialSession, currentSessionId, currentSession)
      ) {
        throw new ToolError(
          `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for screen "${wanted}"`,
        );
      }

      const useSdk = boundSession && currentSession.sdk?.connected === true;
      if (useSdk) {
        lastSource = 'sdk';
        const current = ctx.sessions.getCurrentScreen();
        lastSeen = current ? current.name : null;
        if (
          current &&
          (matchesScreenName(current.name, wanted, exact) ||
            matchesScreenName(current.className, wanted, exact) ||
            matchesScreenName(simpleName(current.className), wanted, exact))
        ) {
          return {
            data: {
              untrusted: UNTRUSTED_NOTE,
              matched: true,
              matchedOn: 'screen',
              source: 'sdk',
              screen: current.name,
              className: current.className,
              kind: current.kind,
              elapsedMs: Math.round(performance.now() - start),
            },
          };
        }
        // When the SDK reports a Fragment/Dialog/destination as the top screen, ScreenRef has no owning Activity
        // field; check the session package's resumed Activity so waiting for a hosting Activity still succeeds.
        if (current !== null && current.kind !== 'activity' && initialSession.packageName !== null) {
          const cmdBudget = Math.floor(Math.min(DUMPSYS_TIMEOUT_MS, deadline - performance.now()));
          if (cmdBudget > 0) {
            let output: string | null = null;
            try {
              output = await adbShellArgs(ctx.adb, serial, ['dumpsys', 'activity', 'activities'], {
                timeoutMs: cmdBudget,
                signal: ctx.signal,
              });
            } catch {
              checkAborted(ctx.signal);
              const afterFailSession = ctx.sessions.getSessionState();
              const afterFailSessionId = ctx.sessions.getSessionId();
              if (sessionReplaced(initialSessionId, initialSession, afterFailSessionId, afterFailSession)) {
                throw new ToolError(
                  `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for screen "${wanted}"`,
                );
              }
            }
            if (output !== null) {
              checkAborted(ctx.signal);
              const afterSession = ctx.sessions.getSessionState();
              const afterSessionId = ctx.sessions.getSessionId();
              if (sessionReplaced(initialSessionId, initialSession, afterSessionId, afterSession)) {
                throw new ToolError(
                  `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for screen "${wanted}"`,
                );
              }
              const topPkg = parseTopPackage(output);
              const hostActivity = parseTopActivity(output);
              if (hostActivity !== null && topPkg === initialSession.packageName) {
                lastSeen = `${current.name} (activity: ${hostActivity})`;
                if (deadline - performance.now() <= 0) break;
                if (
                  matchesScreenName(hostActivity, wanted, exact) ||
                  matchesScreenName(simpleName(hostActivity), wanted, exact)
                ) {
                  return {
                    data: {
                      untrusted: UNTRUSTED_NOTE,
                      matched: true,
                      matchedOn: 'hostActivity',
                      source: 'dumpsys',
                      serial,
                      screen: current.name,
                      className: current.className,
                      kind: current.kind,
                      activity: hostActivity,
                      elapsedMs: Math.round(performance.now() - start),
                    },
                  };
                }
              }
            }
          }
        }
      } else {
        lastSource = 'dumpsys';
        const cmdBudget = Math.floor(Math.min(DUMPSYS_TIMEOUT_MS, remainingBeforeProbe));
        if (cmdBudget <= 0) break;
        let output: string;
        try {
          // Run dumpsys directly and parse on the server so a transiently absent resumed activity does not fail via grep exit 1.
          output = await adbShellArgs(ctx.adb, serial, ['dumpsys', 'activity', 'activities'], {
            timeoutMs: cmdBudget,
            signal: ctx.signal,
          });
        } catch (error) {
          checkAborted(ctx.signal);
          if (boundSession) {
            const afterFailSession = ctx.sessions.getSessionState();
            const afterFailSessionId = ctx.sessions.getSessionId();
            if (sessionReplaced(initialSessionId, initialSession, afterFailSessionId, afterFailSession)) {
              throw new ToolError(
                `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for screen "${wanted}"`,
              );
            }
          }
          if (deadline - performance.now() <= 0) break;
          throw error;
        }
        // Recheck cancellation, session identity, and deadline immediately after the async probe settles.
        checkAborted(ctx.signal);
        if (boundSession) {
          const afterSession = ctx.sessions.getSessionState();
          const afterSessionId = ctx.sessions.getSessionId();
          if (sessionReplaced(initialSessionId, initialSession, afterSessionId, afterSession)) {
            throw new ToolError(
              `Profiling session for ${initialSession.packageName} on ${initialSession.serial} stopped or was replaced while waiting for screen "${wanted}"`,
            );
          }
        }
        const topPkg = parseTopPackage(output);
        const activity = parseTopActivity(output);
        if (restrictToPackage !== null && topPkg !== null && topPkg !== restrictToPackage) {
          // Never reveal another app's foreground activity to read-only clients.
          lastSeen = 'another app';
        } else {
          lastSeen = activity;
          if (deadline - performance.now() <= 0) break;
          if (
            activity !== null &&
            (restrictToPackage === null || topPkg === restrictToPackage) &&
            (matchesScreenName(activity, wanted, exact) ||
              matchesScreenName(simpleName(activity), wanted, exact))
          ) {
            return {
              data: {
                untrusted: UNTRUSTED_NOTE,
                matched: true,
                matchedOn: 'activity',
                source: 'dumpsys',
                serial,
                screen: simpleName(activity),
                activity,
                elapsedMs: Math.round(performance.now() - start),
              },
            };
          }
        }
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleepBounded(Math.min(intervalMs, remaining), ctx.signal);
    }

    const elapsedMs = Math.round(performance.now() - start);
    throw new ToolError(
      `Timed out after ${elapsedMs} ms waiting for screen "${wanted}" (source: ${lastSource}, last seen: ${lastSeen ?? 'none'})`,
    );
  },
});

export const waitForIdleTool = defineTool({
  name: 'wait_for_idle',
  title: 'Wait for UI to settle',
  description: `Waits until the screen's UI hierarchy stops changing for \`quietMs\` (default 500 ms), polling through Lionscope's UI dump (using the on-device UI helper and its built-in accessibility idle wait when available, falling back to \`uiautomator dump\`). Fails with a clear timeout error if the UI keeps changing past \`timeoutMs\`. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    quietMs: z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(500)
      .describe('How long the UI tree must remain unchanged to count as idle (100–10000 ms).'),
    timeoutMs: z
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(10_000)
      .describe('Maximum total wait in ms (500–30000).'),
    intervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .default(250)
      .describe('Pause between consecutive UI tree checks in ms.'),
    serial: optionalSerial,
  }),
  annotations: READ_ONLY,
  async run({ quietMs, timeoutMs, intervalMs, serial: requested }, ctx) {
    checkAborted(ctx.signal);
    const serial = targetSerial(ctx, requested);
    const start = performance.now();
    const deadline = start + timeoutMs;
    let lastKey: string | null = null;
    let stableSince: number | null = null;
    let polls = 0;
    let lastError: string | null = null;

    for (let attempt = 0; ; attempt++) {
      checkAborted(ctx.signal);
      if (attempt > 0 && deadline - performance.now() <= 0) break;

      try {
        const { tree, activity } = await dumpUi(ctx, serial, {
          withActivity: true,
          deadline,
          signal: ctx.signal,
        });
        checkAborted(ctx.signal);
        const now = performance.now();
        if (now > deadline) break;
        polls += 1;
        const key = `${activity ?? ''}|${screenKey(tree)}`;
        if (key === lastKey && stableSince !== null) {
          if (now - stableSince >= quietMs) {
            return {
              data: {
                untrusted: UNTRUSTED_NOTE,
                serial,
                idle: true,
                elapsedMs: Math.round(now - start),
                quietMs,
                polls,
                package: tree.package,
                activity,
              },
            };
          }
        } else {
          lastKey = key;
          stableSince = now;
        }
      } catch (error) {
        checkAborted(ctx.signal);
        if (!(error instanceof ToolError)) throw error;
        lastError = error.message;
        lastKey = null;
        stableSince = null;
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleepBounded(Math.min(intervalMs, remaining), ctx.signal);
    }

    const elapsedMs = Math.round(performance.now() - start);
    const detail =
      polls === 0 && lastError !== null
        ? `no UI dump succeeded: ${lastError}`
        : `${polls} poll${polls === 1 ? '' : 's'}; UI did not stay unchanged for ${quietMs} ms`;
    throw new ToolError(
      `Timed out after ${elapsedMs} ms waiting for UI on ${serial} to become idle (${detail})`,
    );
  },
});

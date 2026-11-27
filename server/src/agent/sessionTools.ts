/** `start_session`, `stop_session`, `set_sdk_options`: the dashboard's session controls. */
import { z } from 'zod';
import { isValidPackageName, STALL_THRESHOLDS_MS } from '@lionscope/protocol';
import { NO_SESSION_MESSAGE } from '../http/wsGateway.ts';
import type { ComposeRecompositionDelivery } from '../device/inspectLinks.ts';
import { targetSerial } from './deviceTools.ts';
import { serialInput, sessionView } from './statusTools.ts';
import { defineTool, ToolError } from './tool.ts';

const RECOMP_PENDING_NOTE =
  'No live SDK link on this device yet: tracking is queued and will be applied once a v15+ SDK link connects. Call inspect_screen first to establish the link and confirm snapshot.recompositionTracking === "active" before reproducing the interaction.';
const RECOMP_UNSUPPORTED_SDK_NOTE =
  'Connected SDK is older than device protocol v15 and does not support Compose recomposition tracking.';

function deliveryNote(state: ComposeRecompositionDelivery['state']): string | undefined {
  if (state === 'pending') return RECOMP_PENDING_NOTE;
  if (state === 'unsupported_sdk') return RECOMP_UNSUPPORTED_SDK_NOTE;
  return undefined;
}

export const packageInput = z
  .string()
  .refine(isValidPackageName, 'not an Android package name')
  .describe('Application id, e.g. com.example.shop (see list_apps).');

export const startSessionTool = defineTool({
  name: 'start_session',
  title: 'Start profiling',
  description:
    "Starts profiling an app on a device (one session at a time): CPU, memory, frames and logcat over adb, plus screens, stalls, StrictMode and layouts once the app's in-app Lionscope SDK connects. Replaces the current session and clears its recording, as Start in the dashboard does. The app does not have to run yet: the session waits for its process (status waiting_for_process). Returns the new session; check status for the SDK link.",
  access: 'session',
  input: z.object({ serial: serialInput, packageName: packageInput }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run({ serial, packageName }, ctx) {
    return { data: { session: sessionView(await ctx.sessions.startSession(serial, packageName)) } };
  },
});

export const stopSessionTool = defineTool({
  name: 'stop_session',
  title: 'Stop profiling',
  description:
    'Stops the profiling session. Its recording stays readable (the read tools then use the window ending at the last sample) until a new session starts.',
  access: 'session',
  input: z.object({}),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(_args, ctx) {
    return { data: { session: sessionView(await ctx.sessions.stopSession()) } };
  },
});

export const sdkOptionsTool = defineTool({
  name: 'set_sdk_options',
  title: 'Set SDK options',
  description: `Changes the in-app SDK options: stallThresholdMs is the main-thread watchdog threshold (one of ${STALL_THRESHOLDS_MS.join(', ')} ms; default 150), strictMode turns StrictMode violation reporting on (it changes the app's StrictMode policy; default off), inflateTracking turns layout inflation timing on or off (default on), rxTracking turns the SDK's RxJava 2 hooks on or off (they name the Rx chain and its subscribe site for each stall; default on; SDK 0.9.0+), savedStateTracking turns the SDK's saved-state measurement on or off (each Activity's complete saved state, see get_saved_state; default on; SDK 0.12.0+), composeRecompositionTracking turns Compose recomposition and skip counting on or off for Layout Inspector snapshots (default off; requires Compose runtime 1.9+ and a compatible SDK; works during a session and on inspect-only links without a session when given alone, optionally with serial). Omitted fields stay as they are. When composeRecompositionTracking is set, returns delivery ("applied", "pending" when no live SDK link exists yet, or "unsupported_sdk") and sdkConnected. Establish the link (inspect_screen or start_session) and confirm snapshot.recompositionTracking === "active" before reproducing an interaction.`,
  access: 'session',
  input: z.object({
    serial: serialInput
      .optional()
      .describe('Device serial (from status); defaults to the session device, or the only connected device.'),
    stallThresholdMs: z.literal(STALL_THRESHOLDS_MS).optional().describe('Watchdog threshold in ms.'),
    strictMode: z.boolean().optional().describe('Report StrictMode violations.'),
    inflateTracking: z.boolean().optional().describe('Time layout inflations.'),
    rxTracking: z.boolean().optional().describe('Attribute stalls to RxJava chains.'),
    savedStateTracking: z.boolean().optional().describe('Measure Activity saved states.'),
    composeRecompositionTracking: z
      .boolean()
      .optional()
      .describe('Track Compose recomposition and skip counts for Layout Inspector (Compose 1.9+).'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(
    {
      serial: requestedSerial,
      stallThresholdMs,
      strictMode,
      inflateTracking,
      rxTracking,
      savedStateTracking,
      composeRecompositionTracking,
    },
    ctx,
  ) {
    const options = {
      stallThresholdMs,
      strictMode,
      inflateTracking,
      rxTracking,
      savedStateTracking,
      composeRecompositionTracking,
    };
    const hasSessionOnlyOptions =
      stallThresholdMs !== undefined ||
      strictMode !== undefined ||
      inflateTracking !== undefined ||
      rxTracking !== undefined ||
      savedStateTracking !== undefined;
    const session = ctx.sessions.getSessionState();
    const sessionSerial = session.status !== 'idle' && session.status !== 'error' ? session.serial : null;

    // Resolve explicit target serial BEFORE mutating anything: never silently change device A when serial B was asked.
    if (requestedSerial !== undefined && sessionSerial !== null && requestedSerial !== sessionSerial) {
      if (hasSessionOnlyOptions || composeRecompositionTracking === undefined) {
        throw new ToolError(
          `Active profiling session is on ${sessionSerial}, not ${requestedSerial}: session SDK options apply only to the session device`,
        );
      }
      const serial = targetSerial(ctx, requestedSerial);
      const delivery = ctx.sessions.setComposeRecompositionTracking(serial, composeRecompositionTracking);
      const note = deliveryNote(delivery.state);
      return {
        data: {
          serial,
          composeRecompositionTracking,
          options: null,
          sdkConnected: delivery.sdkConnected,
          delivery: delivery.state,
          ...(note === undefined ? {} : { note }),
        },
      };
    }

    if (sessionSerial !== null) {
      if (composeRecompositionTracking === undefined) {
        if (ctx.sessions.setSdkOptions(options)) {
          const sdk = ctx.sessions.getSessionState().sdk;
          return { data: { options: sdk?.options ?? null, sdkConnected: sdk?.connected ?? false } };
        }
      } else {
        if (hasSessionOnlyOptions) {
          const appliedSession = ctx.sessions.setSdkOptions({
            stallThresholdMs,
            strictMode,
            inflateTracking,
            rxTracking,
            savedStateTracking,
          });
          if (!appliedSession) throw new ToolError(NO_SESSION_MESSAGE);
        }
        // Route Compose tracking through setComposeRecompositionTracking so delivery and sdkConnected combine
        // both the profiling session link and any live inspect-only link on the same device.
        const delivery = ctx.sessions.setComposeRecompositionTracking(
          sessionSerial,
          composeRecompositionTracking,
        );
        const sdk = ctx.sessions.getSessionState().sdk;
        const note = deliveryNote(delivery.state);
        return {
          data: {
            serial: sessionSerial,
            options: sdk?.options ?? null,
            sdkConnected: delivery.sdkConnected,
            delivery: delivery.state,
            ...(note === undefined ? {} : { note }),
          },
        };
      }
    }
    if (hasSessionOnlyOptions || composeRecompositionTracking === undefined) {
      throw new ToolError(NO_SESSION_MESSAGE);
    }
    const serial = targetSerial(ctx, requestedSerial);
    const delivery = ctx.sessions.setComposeRecompositionTracking(serial, composeRecompositionTracking);
    const note = deliveryNote(delivery.state);
    return {
      data: {
        serial,
        composeRecompositionTracking,
        options: null,
        sdkConnected: delivery.sdkConnected,
        delivery: delivery.state,
        ...(note === undefined ? {} : { note }),
      },
    };
  },
});

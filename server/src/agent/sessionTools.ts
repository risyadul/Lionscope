/** `start_session`, `stop_session`, `set_sdk_options`: the dashboard's session controls. */
import { z } from 'zod';
import { isValidPackageName, STALL_THRESHOLDS_MS } from '@lionscope/protocol';
import { NO_SESSION_MESSAGE } from '../http/wsGateway.ts';
import { targetSerial } from './deviceTools.ts';
import { serialInput, sessionView } from './statusTools.ts';
import { defineTool, ToolError } from './tool.ts';

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
  description: `Changes the in-app SDK options: stallThresholdMs is the main-thread watchdog threshold (one of ${STALL_THRESHOLDS_MS.join(', ')} ms; default 150), strictMode turns StrictMode violation reporting on (it changes the app's StrictMode policy; default off), inflateTracking turns layout inflation timing on or off (default on), rxTracking turns the SDK's RxJava 2 hooks on or off (they name the Rx chain and its subscribe site for each stall; default on; SDK 0.9.0+), savedStateTracking turns the SDK's saved-state measurement on or off (each Activity's complete saved state, see get_saved_state; default on; SDK 0.12.0+), composeRecompositionTracking turns Compose recomposition and skip counting on or off for Layout Inspector snapshots (default off; requires Compose runtime 1.9+ and a compatible SDK; works during a session and on inspect-only links without a session when given alone, optionally with serial). Omitted fields stay as they are. Returns the options now in effect.`,
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
    if (ctx.sessions.setSdkOptions(options)) {
      const sdk = ctx.sessions.getSessionState().sdk;
      return { data: { options: sdk?.options ?? null, sdkConnected: sdk?.connected ?? false } };
    }
    if (hasSessionOnlyOptions || composeRecompositionTracking === undefined) {
      throw new ToolError(NO_SESSION_MESSAGE);
    }
    const serial = targetSerial(ctx, requestedSerial);
    ctx.sessions.setComposeRecompositionTracking(serial, composeRecompositionTracking);
    return {
      data: {
        serial,
        composeRecompositionTracking,
        options: null,
        sdkConnected: false,
      },
    };
  },
});

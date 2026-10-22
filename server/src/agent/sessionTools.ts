/** `start_session`, `stop_session`, `set_sdk_options`: the dashboard's session controls. */
import { z } from 'zod';
import { isValidPackageName, STALL_THRESHOLDS_MS } from '@lionscope/protocol';
import { NO_SESSION_MESSAGE } from '../http/wsGateway.ts';
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
  description: `Changes the in-app SDK options of the running session (the Stalls tab controls): stallThresholdMs is the main-thread watchdog threshold (one of ${STALL_THRESHOLDS_MS.join(', ')} ms; default 150), strictMode turns StrictMode violation reporting on (it changes the app's StrictMode policy; default off), inflateTracking turns layout inflation timing on or off (default on). Omitted fields stay as they are. Returns the options now in effect.`,
  access: 'session',
  input: z.object({
    stallThresholdMs: z.literal(STALL_THRESHOLDS_MS).optional().describe('Watchdog threshold in ms.'),
    strictMode: z.boolean().optional().describe('Report StrictMode violations.'),
    inflateTracking: z.boolean().optional().describe('Time layout inflations.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ stallThresholdMs, strictMode, inflateTracking }, ctx) {
    if (!ctx.sessions.setSdkOptions({ stallThresholdMs, strictMode, inflateTracking })) {
      throw new ToolError(NO_SESSION_MESSAGE);
    }
    const sdk = ctx.sessions.getSessionState().sdk;
    return { data: { options: sdk?.options ?? null, sdkConnected: sdk?.connected ?? false } };
  },
});

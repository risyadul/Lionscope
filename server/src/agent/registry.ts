/** Every agent tool, and the one place calls are validated, gated and turned into results or errors. */
import { z } from 'zod';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import {
  bootEmulatorTool,
  launchAppTool,
  pressKeyTool,
  screenshotTool,
  shutdownEmulatorTool,
  swipeTool,
  tapTool,
} from './deviceTools.ts';
import { layoutsTool, viewTreeTool } from './layoutTools.ts';
import { logcatTool } from './logTools.ts';
import { screensTool, summaryTool } from './metricTools.ts';
import { sdkOptionsTool, startSessionTool, stopSessionTool } from './sessionTools.ts';
import { strictModeTool, stallsTool } from './stallTools.ts';
import { listAppsTool, statusTool } from './statusTools.ts';
import { scrollToTool, tapElementTool, typeTextTool, uiTreeTool, waitForTool } from './uiTools.ts';
import { ToolError } from './tool.ts';
import type { AgentContext, AgentTool } from './tool.ts';

export const AGENT_TOOLS: readonly AgentTool[] = [
  statusTool,
  listAppsTool,
  summaryTool,
  screensTool,
  stallsTool,
  strictModeTool,
  layoutsTool,
  viewTreeTool,
  logcatTool,
  startSessionTool,
  stopSessionTool,
  sdkOptionsTool,
  screenshotTool,
  uiTreeTool,
  tapElementTool,
  waitForTool,
  scrollToTool,
  tapTool,
  swipeTool,
  typeTextTool,
  pressKeyTool,
  launchAppTool,
  bootEmulatorTool,
  shutdownEmulatorTool,
];

export const DEVICE_CONTROL_DISABLED =
  'Device control is off. Start Lionscope (or `lionscope mcp`) with --allow-device-control, or pass it to `lionscope query`.';

/** Device tools running at once on one device; more get a busy answer instead of piling up adb commands. */
export const MAX_DEVICE_CALLS = 2;

/** The device a device tool will act on, as far as its arguments say (an unnamed device shares one key). */
function deviceKey(ctx: Omit<AgentContext, 'deviceControl'>, args: Record<string, unknown>): string {
  const named =
    typeof args.serial === 'string' ? args.serial : typeof args.avdName === 'string' ? args.avdName : null;
  return named ?? ctx.sessions.getSessionState().serial ?? 'default';
}

/** The tools a caller may list and call. */
export function availableTools(deviceControl: boolean): AgentTool[] {
  return AGENT_TOOLS.filter((tool) => deviceControl || tool.access !== 'device');
}

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/** Why a call failed: what the HTTP API maps to a status code. */
export type ToolFailure =
  | 'unknown_tool'
  | 'forbidden'
  | 'invalid_arguments'
  | 'failed'
  | 'busy'
  /** Client side only: no server answers on the port (agentClient.ts). */
  | 'unreachable';

export type ToolOutcome =
  | { ok: true; result: unknown; image?: { mimeType: 'image/png'; data: string } }
  | { ok: false; error: string; code: ToolFailure };

function invalidArguments(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** Validates and runs one call. Never throws: failures come back as `{ ok: false }` with a message for the caller. */
export async function callTool(
  ctx: Omit<AgentContext, 'deviceControl'>,
  name: string,
  args: unknown,
  deviceControl: boolean,
): Promise<ToolOutcome> {
  const tool = findTool(name);
  if (!tool) return { ok: false, code: 'unknown_tool', error: `No tool named ${name}` };
  if (tool.access === 'device' && !deviceControl) {
    return { ok: false, code: 'forbidden', error: DEVICE_CONTROL_DISABLED };
  }
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_arguments',
      error: `Invalid arguments for ${name}: ${invalidArguments(parsed.error)}`,
    };
  }
  const key = tool.access === 'device' ? deviceKey(ctx, parsed.data as Record<string, unknown>) : null;
  if (key !== null) {
    const running = ctx.deviceCalls.get(key) ?? 0;
    if (running >= MAX_DEVICE_CALLS) {
      return {
        ok: false,
        code: 'busy',
        error: `${running} device actions are already running on ${key}: wait for them to finish`,
      };
    }
    ctx.deviceCalls.set(key, running + 1);
  }
  try {
    const { data, image } = await tool.run(parsed.data, { ...ctx, deviceControl });
    return image
      ? { ok: true, result: data, image: { mimeType: image.mimeType, data: image.data.toString('base64') } }
      : { ok: true, result: data };
  } catch (error) {
    if (!(error instanceof ToolError) && !(error instanceof PublicError)) {
      log.warn(`Agent tool ${name} failed: ${errorMessage(error)}`);
    }
    return { ok: false, code: 'failed', error: errorMessage(error) };
  } finally {
    if (key !== null) {
      const left = (ctx.deviceCalls.get(key) ?? 1) - 1;
      if (left > 0) ctx.deviceCalls.set(key, left);
      else ctx.deviceCalls.delete(key);
    }
  }
}

/** JSON Schema of a tool's arguments (for `lionscope query --list`). */
export function inputJsonSchema(tool: AgentTool): unknown {
  return z.toJSONSchema(tool.input, { io: 'input' });
}

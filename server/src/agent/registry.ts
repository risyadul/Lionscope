/** Every agent tool, and the one place calls are validated, gated and turned into results or errors. */
import { z } from 'zod';
import type { StorageConsent } from '@lionscope/protocol';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import {
  bootEmulatorTool,
  launchAppTool,
  pressKeyTool,
  screenshotTool,
  shutdownEmulatorTool,
  stopAppTool,
  swipeTool,
  tapTool,
} from './deviceTools.ts';
import { runInputsTool } from './inputTools.ts';
import { inspectorSelectionTool, inspectScreenTool, selectInspectorNodeTool } from './inspectorTools.ts';
import { clearLocationTool, getLocationTool, setLocationTool } from './locationTools.ts';
import { revertViewPropertiesTool, setViewPropertyTool } from './viewEditTools.ts';
import { layoutsTool, viewTreeTool } from './layoutTools.ts';
import { crashesTool, logcatTool, markTool } from './logTools.ts';
import { screensTool, summaryTool } from './metricTools.ts';
import {
  clearNetworkMocksTool,
  networkRequestTool,
  networkTool,
  setNetworkMockTool,
} from './networkTools.ts';
import {
  bringToFrontTool,
  getActivityInstanceTool,
  setDontKeepActivitiesTool,
  simulateProcessDeathTool,
} from './restoreTools.ts';
import { savedStateTool } from './savedStateTools.ts';
import { listStorageTool, readStorageTool, storageAuditTool, writeStorageTool } from './storageTools.ts';
import { sdkOptionsTool, startSessionTool, stopSessionTool } from './sessionTools.ts';
import { strictModeTool, stallsTool } from './stallTools.ts';
import { listAppsTool, statusTool } from './statusTools.ts';
import { scrollToTool, tapElementTool, typeTextTool, uiTreeTool, waitForTool } from './uiTools.ts';
import { ToolError } from './tool.ts';
import type { AgentBaseContext, AgentTool } from './tool.ts';

export const AGENT_TOOLS: readonly AgentTool[] = [
  statusTool,
  listAppsTool,
  summaryTool,
  screensTool,
  stallsTool,
  strictModeTool,
  layoutsTool,
  viewTreeTool,
  inspectorSelectionTool,
  selectInspectorNodeTool,
  logcatTool,
  crashesTool,
  savedStateTool,
  networkTool,
  networkRequestTool,
  getLocationTool,
  startSessionTool,
  stopSessionTool,
  sdkOptionsTool,
  markTool,
  screenshotTool,
  uiTreeTool,
  inspectScreenTool,
  setViewPropertyTool,
  revertViewPropertiesTool,
  tapElementTool,
  waitForTool,
  scrollToTool,
  tapTool,
  swipeTool,
  typeTextTool,
  pressKeyTool,
  runInputsTool,
  launchAppTool,
  stopAppTool,
  getActivityInstanceTool,
  setDontKeepActivitiesTool,
  simulateProcessDeathTool,
  bringToFrontTool,
  setNetworkMockTool,
  clearNetworkMocksTool,
  setLocationTool,
  clearLocationTool,
  bootEmulatorTool,
  shutdownEmulatorTool,
  listStorageTool,
  readStorageTool,
  writeStorageTool,
  storageAuditTool,
];

export const DEVICE_CONTROL_DISABLED =
  'Device control is off. Start Lionscope (or `lionscope mcp`) with --allow-device-control, or pass it to `lionscope query`.';

/** Device tools running at once on one device; more get a busy answer instead of piling up adb commands. */
export const MAX_DEVICE_CALLS = 2;

/** The device a device tool will act on, as far as its arguments say (an unnamed device shares one key). */
function deviceKey(ctx: AgentBaseContext, args: Record<string, unknown>): string {
  const named =
    typeof args.serial === 'string' ? args.serial : typeof args.avdName === 'string' ? args.avdName : null;
  return named ?? ctx.sessions.getSessionState().serial ?? 'default';
}

export const STORAGE_READ_DISABLED =
  'The storage inspector is off. Start Lionscope with --allow-storage-read (and --allow-storage-write to edit values).';
export const STORAGE_WRITE_DISABLED =
  'Editing app storage is off. Start Lionscope with --allow-storage-write (as well as --allow-storage-read).';

/** Whether a tool of `access` may run under the server's storage consent (other tools: always). */
export function storageAllows(access: AgentTool['access'], consent: StorageConsent): boolean {
  if (access === 'storage_read') return consent !== 'off';
  if (access === 'storage_write') return consent === 'read_write';
  return true;
}

/** The tools a caller may list and call: device tools with device control, storage tools as far as consent goes. */
export function availableTools(deviceControl: boolean, storageConsent: StorageConsent = 'off'): AgentTool[] {
  return AGENT_TOOLS.filter(
    (tool) => (deviceControl || tool.access !== 'device') && storageAllows(tool.access, storageConsent),
  );
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

/** Per-call permissions beyond device control. */
export interface CallOptions {
  /** --allow-network-bodies: get_network_request returns body texts. */
  networkBodies?: boolean;
}

/** Validates and runs one call. Never throws: failures come back as `{ ok: false }` with a message for the caller. */
export async function callTool(
  ctx: AgentBaseContext,
  name: string,
  args: unknown,
  deviceControl: boolean,
  options: CallOptions = {},
): Promise<ToolOutcome> {
  const tool = findTool(name);
  if (!tool) return { ok: false, code: 'unknown_tool', error: `No tool named ${name}` };
  if (tool.access === 'device' && !deviceControl) {
    return { ok: false, code: 'forbidden', error: DEVICE_CONTROL_DISABLED };
  }
  // The server's own flags decide, whatever the caller listed (an attached `lionscope mcp` lists by its own).
  if (!storageAllows(tool.access, ctx.storage?.consent ?? 'off')) {
    return {
      ok: false,
      code: 'forbidden',
      error:
        tool.access === 'storage_write' && ctx.storage?.consent === 'read'
          ? STORAGE_WRITE_DISABLED
          : STORAGE_READ_DISABLED,
    };
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
    const { data, image } = await tool.run(parsed.data, {
      ...ctx,
      deviceControl,
      networkBodies: options.networkBodies ?? false,
    });
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

/** `status` and `list_apps`: what is connected, what is being profiled, and what can be. */
import { z } from 'zod';
import { isValidSerial } from '@lionscope/protocol';
import type { DeviceInfo, EmulatorInfo, SessionState } from '@lionscope/protocol';
import { isEmulatorSerial } from '../emulator/screenGateway.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { iso } from './views.ts';

function deviceView(device: DeviceInfo, emulators: readonly EmulatorInfo[], dontKeepActivities: boolean) {
  const isEmulator = isEmulatorSerial(device.serial);
  const emulator = emulators.find((candidate) => candidate.serial === device.serial);
  return {
    serial: device.serial,
    model: device.model ?? null,
    state: device.state,
    kind: isEmulator ? 'emulator' : 'physical',
    // Emulators are mirrored over gRPC (when it has an endpoint), other ready devices through scrcpy.
    canMirror: isEmulator ? emulator?.canMirror === true : device.state === 'device',
    // Turned on by set_dont_keep_activities and not put back yet (when the session stops, or Lionscope stops).
    dontKeepActivities,
  };
}

export function sessionView(session: SessionState) {
  return {
    status: session.status,
    serial: session.serial,
    packageName: session.packageName,
    pid: session.pid,
    startedAt: session.startedAt === null ? null : iso(session.startedAt),
    ...(session.error ? { error: session.error } : {}),
  };
}

/** The SDK reports its own version string: anything but a plain version reads as unknown. */
const SDK_VERSION = /^[\w.+-]{1,64}$/;

export function sdkVersionView(version: string | null): string | null {
  if (version === null) return null;
  return SDK_VERSION.test(version) ? version : 'unknown';
}

function sdkView(session: SessionState) {
  const sdk = session.sdk;
  if (!sdk) return null;
  return {
    connected: sdk.connected,
    version: sdkVersionView(sdk.sdkVersion),
    apiLevel: sdk.apiLevel,
    protocolVersion: sdk.protocolVersion ?? null,
    processName: sdk.processName,
    framesActive: sdk.framesActive,
    options: sdk.options ?? null,
    network: sdk.network ?? null,
  };
}

/** HTTP capture (and mocking) runs while the session's SDK link is live at device protocol v7 with a link proof. */
export function networkCapture(session: SessionState): boolean {
  return session.sdk?.connected === true && session.sdk.network === 'active';
}

function networkView(ctx: AgentContext, session: SessionState) {
  const mocks = ctx.sessions.getNetworkMocks();
  return {
    capture: networkCapture(session),
    exchanges: ctx.sessions.getHttpExchangeCount(),
    mocks: {
      total: mocks.rules.length,
      enabled: mocks.rules.filter((rule) => rule.enabled).length,
      applied: mocks.appliedRev !== null && mocks.appliedRev === mocks.rev,
    },
  };
}

export function statusData(ctx: AgentContext) {
  const emulators = ctx.emulators.getEmulators();
  const session = ctx.sessions.getSessionState();
  return {
    // Device models and the SDK's process name come from the device and the app.
    untrusted: UNTRUSTED_NOTE,
    server: {
      version: ctx.serverVersion,
      dashboardUrl: ctx.dashboardUrl(),
      sdkGatewayPort: ctx.sdkGatewayPort(),
      bufferWindowMinutes: ctx.bufferWindowMs / 60_000,
      deviceControl: ctx.deviceControl,
      networkBodies: ctx.networkBodies,
    },
    devices: ctx.sessions
      .getDevices()
      .map((device) => deviceView(device, emulators, ctx.dontKeepActivities.isOn(device.serial))),
    emulators: emulators.map((emulator) => ({
      avdName: emulator.avdName,
      displayName: emulator.displayName,
      state: emulator.state,
      serial: emulator.serial,
      managed: emulator.managed,
      canMirror: emulator.canMirror,
      renderer: emulator.renderer,
    })),
    session: sessionView(session),
    sdk: sdkView(session),
    network: networkView(ctx, session),
  };
}

export const statusTool = defineTool({
  name: 'status',
  title: 'Lionscope status',
  description:
    'Start here. Returns the Lionscope server version and dashboard URL; connected adb devices (serial, model, state, kind emulator/physical, canMirror, dontKeepActivities = turned on by set_dont_keep_activities and not yet off); Android Virtual Devices (AVD name, state off/booting/running/shutting_down, serial, managed = booted by this server); the profiling session (status idle/waiting_for_process/running/error, serial, packageName, pid, startedAt); the in-app SDK link (connected, version, apiLevel, protocol, options, network: active / unverified = the link key could not be handed to the app over adb / needs_sdk = SDK older than 0.9.0); HTTP capture (network: capture on while the SDK link is at protocol 7 and active, exchanges kept, mock rules total/enabled/applied); and whether device-control tools and network bodies are enabled. Use the serials it lists for list_apps and start_session. ' +
    UNTRUSTED_DESCRIPTION,
  access: 'read',
  input: z.object({}),
  annotations: READ_ONLY,
  async run(_args, ctx) {
    return { data: statusData(ctx) };
  },
});

export const serialInput = z
  .string()
  .refine(isValidSerial, 'not an adb serial')
  .describe('adb serial from `status`, e.g. emulator-5554');

export const listAppsTool = defineTool({
  name: 'list_apps',
  title: 'List apps on a device',
  description:
    'Lists the apps installed on a connected device, as the dashboard app picker shows them: running apps first (with their PID), then by name. By default only third-party (user-installed) apps; pass includeSystem to list system packages too. Use a packageName from here for start_session.',
  access: 'read',
  input: z.object({
    serial: serialInput,
    includeSystem: z.boolean().default(false).describe('Also list system packages.'),
  }),
  annotations: READ_ONLY,
  async run({ serial, includeSystem }, ctx) {
    if (!ctx.sessions.getDevices().some((device) => device.serial === serial)) {
      throw new ToolError(`Device ${serial} is not connected; see status for the connected devices`);
    }
    const apps = await ctx.sessions.listApps(serial);
    const shown = includeSystem ? apps : apps.filter((app) => app.thirdParty);
    return {
      data: {
        serial,
        total: apps.length,
        shown: shown.length,
        apps: shown.map((app) => ({
          packageName: app.packageName,
          pid: app.pid,
          thirdParty: app.thirdParty,
        })),
      },
    };
  },
});

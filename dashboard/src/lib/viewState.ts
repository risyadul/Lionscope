/** Decides which empty / edge state the timeline shows. Pure so it can be tested directly. */
import type { DeviceInfo, SdkStatus } from '@lionscope/protocol/wire';
import { DEVICE_PROTOCOL_V2 } from '@lionscope/protocol/wire';
import { isReady } from './devices.ts';
import type { DashboardState } from './store.ts';

export type TimelineState =
  | { kind: 'disconnected' }
  | { kind: 'loading' }
  | { kind: 'adb-unavailable'; message: string }
  | { kind: 'no-devices' }
  | { kind: 'no-ready-device'; devices: DeviceInfo[] }
  | { kind: 'idle' }
  | { kind: 'waiting'; packageName: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export function isSessionActive(state: Pick<DashboardState, 'session'>): boolean {
  return state.session.status === 'running' || state.session.status === 'waiting_for_process';
}

export function hasSeries(state: Pick<DashboardState, 'cpu' | 'memory' | 'frames'>): boolean {
  return state.cpu.length > 0 || state.memory.length > 0 || state.frames.length > 0;
}

/**
 * One-line notice shown above the charts when there is recorded data to keep visible
 * (instead of covering it with the full empty-state overlay).
 */
export function timelineNotice(view: TimelineState): string | null {
  switch (view.kind) {
    case 'adb-unavailable':
      return 'adb is unavailable — showing the last recording.';
    case 'no-devices':
      return 'No device connected — showing the last recording.';
    case 'no-ready-device':
      return 'No device is ready — showing the last recording.';
    case 'idle':
      return 'Session stopped — showing the last recording.';
    case 'waiting':
      return `Waiting for ${view.packageName ?? 'the app'} to start — recording resumes when its process appears.`;
    case 'error':
      return `Session error: ${view.message}`;
    case 'disconnected':
    case 'loading':
    case 'ready':
      return null;
  }
}

export function timelineState(state: DashboardState): TimelineState {
  const { session } = state;
  if (state.connection.status !== 'open' && state.server === null) return { kind: 'disconnected' };
  if (session.status === 'error')
    return { kind: 'error', message: session.error ?? 'The session stopped unexpectedly.' };
  if (session.status === 'waiting_for_process') return { kind: 'waiting', packageName: session.packageName };
  if (session.status === 'running') return { kind: 'ready' };
  const hasDevices = state.devices !== null && state.devices.length > 0;
  if (state.adbUnavailable !== null && !hasDevices) {
    return { kind: 'adb-unavailable', message: state.adbUnavailable };
  }
  if (state.devices === null) return { kind: 'loading' };
  if (state.devices.length === 0) return { kind: 'no-devices' };
  if (!state.devices.some(isReady)) return { kind: 'no-ready-device', devices: state.devices };
  return { kind: 'idle' };
}

/** Why the screens table has no rows. */
export type ScreensEmpty =
  | { kind: 'no-sdk' }
  | { kind: 'waiting' }
  | { kind: 'window' }
  /** The SDK was linked this session and dropped before any frame arrived. */
  | { kind: 'disconnected'; sdkVersion: string }
  /** The server could not map the SDK port (`adb reverse`). */
  | { kind: 'link-failed'; message: string };

export interface ScreensEmptyInput {
  hasRows: boolean;
  /** Any breakdown bucket in the buffer (not just the window). */
  hasAnyBreakdown: boolean;
  isSdkConnected: boolean;
  sdk: SdkStatus | undefined;
  sdkLinkError: string | null;
}

/** Picks the screens-table empty state, most specific first; null when there are rows. */
export function screensEmptyState(input: ScreensEmptyInput): ScreensEmpty | null {
  if (input.hasRows) return null;
  if (input.hasAnyBreakdown) return { kind: 'window' };
  if (input.isSdkConnected) return { kind: 'waiting' };
  if (input.sdkLinkError !== null) return { kind: 'link-failed', message: input.sdkLinkError };
  const version = input.sdk?.sdkVersion ?? null;
  if (version !== null) return { kind: 'disconnected', sdkVersion: version };
  return { kind: 'no-sdk' };
}

/** The live SDK link speaks protocol v2 (stalls, StrictMode, options). */
export function isStallCapable(sdk: SdkStatus | undefined): boolean {
  return sdk?.connected === true && (sdk.protocolVersion ?? 0) >= DEVICE_PROTOCOL_V2;
}

export const SDK_UPDATE_HINT = 'Update the app’s Lionscope SDK to 0.2.0 for stall detection';

/** Why the watchdog / StrictMode controls can't be used right now; null when they can. */
export function sdkOptionsBlocker(isSessionActive: boolean, sdk: SdkStatus | undefined): string | null {
  if (!isSessionActive) return 'Start a session to change the watchdog and StrictMode.';
  if (sdk === undefined || (sdk.connected && sdk.options === undefined)) {
    return 'This Lionscope server can’t configure the SDK — update it to 0.2.0.';
  }
  if (!sdk.connected) return 'Connect the app’s Lionscope SDK to change these.';
  if (!isStallCapable(sdk)) return SDK_UPDATE_HINT;
  return null;
}

/** Why the Stalls panel has nothing to list. */
export type StallsEmpty =
  /** Stalls are buffered, just not in the visible window. */
  | { kind: 'window' }
  | { kind: 'no-session' }
  | { kind: 'no-sdk' }
  | { kind: 'disconnected'; sdkVersion: string }
  /** The server could not map the SDK port (`adb reverse`). */
  | { kind: 'link-failed'; message: string }
  /** The live link negotiated protocol v1: the app's SDK predates stall detection. */
  | { kind: 'old-sdk'; sdkVersion: string | null }
  /** The server doesn't report link versions: it predates stall detection. */
  | { kind: 'old-server' }
  | { kind: 'waiting'; thresholdMs: number };

export interface StallsEmptyInput {
  hasItems: boolean;
  /** Any stall or violation in the buffer (not just the window). */
  hasAnyData: boolean;
  isSessionActive: boolean;
  sdk: SdkStatus | undefined;
  sdkLinkError: string | null;
  thresholdMs: number;
}

/** Picks the Stalls panel empty state, most specific first; null when there are items. */
export function stallsEmptyState(input: StallsEmptyInput): StallsEmpty | null {
  if (input.hasItems) return null;
  if (input.hasAnyData) return { kind: 'window' };
  if (!input.isSessionActive) return { kind: 'no-session' };
  const { sdk } = input;
  if (sdk === undefined) return { kind: 'old-server' };
  if (!sdk.connected) {
    if (input.sdkLinkError !== null) return { kind: 'link-failed', message: input.sdkLinkError };
    return sdk.sdkVersion === null
      ? { kind: 'no-sdk' }
      : { kind: 'disconnected', sdkVersion: sdk.sdkVersion };
  }
  if (sdk.protocolVersion === undefined) return { kind: 'old-server' };
  if (!isStallCapable(sdk)) return { kind: 'old-sdk', sdkVersion: sdk.sdkVersion };
  return { kind: 'waiting', thresholdMs: input.thresholdMs };
}

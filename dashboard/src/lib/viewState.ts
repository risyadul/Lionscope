/** Decides which empty / edge state the timeline shows. Pure so it can be tested directly. */
import type {
  CpuSample,
  DeviceInfo,
  EmulatorInfo,
  FrameBreakdownSample,
  FrameSample,
  InflateSample,
  MemorySample,
  ScreenSpan,
  SdkStatus,
  StallSample,
  StrictModeSample,
  TimelineEvent,
  ViewTreeSample,
} from '@lionscope/protocol/wire';
import { DEVICE_PROTOCOL_V2, DEVICE_PROTOCOL_V3, isValidPackageName } from '@lionscope/protocol/wire';
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

/** The live SDK link speaks protocol v3 (inflation timing, view trees, the inflateTracking option). */
export function isLayoutCapable(sdk: SdkStatus | undefined): boolean {
  return sdk?.connected === true && (sdk.protocolVersion ?? 0) >= DEVICE_PROTOCOL_V3;
}

/** XML layout inflation is measured through a LayoutInflater API that exists from Android 10. */
export const MIN_INFLATE_API_LEVEL = 29;

/** Why the Layouts tab has nothing to list. */
export type LayoutsEmpty =
  /** Inflations are buffered, just not in the visible window. */
  | { kind: 'window' }
  | { kind: 'no-session' }
  | { kind: 'no-sdk' }
  | { kind: 'disconnected'; sdkVersion: string }
  | { kind: 'link-failed'; message: string }
  /** The link negotiated below protocol v3: the app's SDK predates layout timing. */
  | { kind: 'old-sdk'; sdkVersion: string | null }
  | { kind: 'old-server' }
  /** Android below 10: nothing is measured (view trees still are). */
  | { kind: 'api-level'; apiLevel: number }
  /** Inflation tracking is turned off in the SDK options. */
  | { kind: 'off' }
  | { kind: 'waiting' };

export interface LayoutsEmptyInput {
  hasItems: boolean;
  /** Any inflation in the buffer (not just the window). */
  hasAnyData: boolean;
  isSessionActive: boolean;
  sdk: SdkStatus | undefined;
  sdkLinkError: string | null;
  isTrackingOn: boolean;
}

/** Picks the Layouts tab empty state, most specific first; null when there are items. */
export function layoutsEmptyState(input: LayoutsEmptyInput): LayoutsEmpty | null {
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
  if (!isLayoutCapable(sdk)) return { kind: 'old-sdk', sdkVersion: sdk.sdkVersion };
  if (sdk.apiLevel !== null && sdk.apiLevel < MIN_INFLATE_API_LEVEL) {
    return { kind: 'api-level', apiLevel: sdk.apiLevel };
  }
  return input.isTrackingOn ? { kind: 'waiting' } : { kind: 'off' };
}

export interface StartHintInput {
  isOpen: boolean;
  serial: string | null;
  /** The AVD behind the selection; an AVD that is off has no serial yet. */
  emulator: EmulatorInfo | null;
  deviceReason: string | null;
  packageName: string | null;
}

/** Why Start is disabled, phrased as the next step; null when a session can start. */
export function startHint({
  isOpen,
  serial,
  emulator,
  deviceReason,
  packageName,
}: StartHintInput): string | null {
  if (!isOpen) return 'Offline — waiting for the server';
  if (serial === null && emulator !== null) {
    if (emulator.state === 'off') return 'Boot the emulator first';
    return emulator.state === 'shutting_down'
      ? 'The emulator is shutting down'
      : 'Wait for the emulator to boot';
  }
  if (serial === null) return 'Connect a device first';
  if (deviceReason !== null) return deviceReason;
  if (packageName === null || !isValidPackageName(packageName)) return 'Pick an app to profile';
  return null;
}

/** The series the timeline draws, captured whole when paused so nothing moves underneath. */
export interface PausedView {
  at: number;
  cpu: readonly CpuSample[];
  memory: readonly MemorySample[];
  frames: readonly FrameSample[];
  events: readonly TimelineEvent[];
  screens: readonly ScreenSpan[];
  breakdown: readonly FrameBreakdownSample[];
  stalls: readonly StallSample[];
  strictMode: readonly StrictModeSample[];
  inflates: readonly InflateSample[];
  viewTrees: readonly ViewTreeSample[];
}

export function captureView(state: DashboardState, at: number): PausedView {
  const { cpu, memory, frames, events, screens, breakdown, stalls, strictMode, inflates, viewTrees } = state;
  return { at, cpu, memory, frames, events, screens, breakdown, stalls, strictMode, inflates, viewTrees };
}

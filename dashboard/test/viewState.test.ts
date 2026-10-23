import { describe, expect, it } from 'vitest';
import { createInitialState, type DashboardState } from '../src/lib/store.ts';
import {
  hasSeries,
  isSessionActive,
  isNetworkCapable,
  isStallCapable,
  networkEmptyState,
  networkLinkState,
  screensEmptyState,
  SDK_UPDATE_HINT,
  sdkOptionsBlocker,
  stallsEmptyState,
  timelineNotice,
  timelineState,
} from '../src/lib/viewState.ts';
import { cpu, SDK_V2, SDK_V3, SDK_V7, session, T0 } from './fixtures.ts';

function connected(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    ...createInitialState(),
    connection: { status: 'open', attempt: 0, retryAt: null, closeReason: null },
    server: { protocolVersion: 1, serverVersion: '0.1.0' },
    ...overrides,
  };
}

describe('timelineState', () => {
  it('is disconnected before the server ever answered', () => {
    expect(timelineState(createInitialState()).kind).toBe('disconnected');
  });

  it('walks the device states', () => {
    expect(timelineState(connected()).kind).toBe('loading');
    expect(timelineState(connected({ devices: [] })).kind).toBe('no-devices');
    const unauthorized = connected({ devices: [{ serial: 'x', state: 'unauthorized' }] });
    expect(timelineState(unauthorized)).toEqual({ kind: 'no-ready-device', devices: unauthorized.devices });
    expect(timelineState(connected({ devices: [{ serial: 'x', state: 'device' }] })).kind).toBe('idle');
  });

  it('shows adb being unavailable instead of USB-debugging advice', () => {
    const state = connected({ devices: [], adbUnavailable: 'adb is not available' });
    expect(timelineState(state)).toEqual({ kind: 'adb-unavailable', message: 'adb is not available' });
    expect(timelineState({ ...state, devices: [{ serial: 'x', state: 'device' }] }).kind).toBe('idle');
    expect(timelineNotice({ kind: 'adb-unavailable', message: 'x' })).toMatch(/adb is unavailable/);
  });

  it('reflects the session', () => {
    expect(timelineState(connected({ session: session() })).kind).toBe('ready');
    expect(timelineState(connected({ session: session({ status: 'waiting_for_process' }) }))).toEqual({
      kind: 'waiting',
      packageName: 'com.example.shop',
    });
    expect(timelineState(connected({ session: session({ status: 'error', error: 'adb died' }) }))).toEqual({
      kind: 'error',
      message: 'adb died',
    });
    expect(timelineState(connected({ session: session({ status: 'error' }) }))).toMatchObject({
      kind: 'error',
    });
  });

  it('keeps showing the session once the server has answered, even while reconnecting', () => {
    const state = connected({
      connection: { status: 'reconnecting', attempt: 1, retryAt: 0, closeReason: null },
      session: session(),
    });
    expect(timelineState(state).kind).toBe('ready');
  });
});

describe('notices and helpers', () => {
  it('produces a notice for states that keep recorded data visible', () => {
    expect(timelineNotice({ kind: 'idle' })).toMatch(/last recording/);
    expect(timelineNotice({ kind: 'no-devices' })).toMatch(/No device/);
    expect(timelineNotice({ kind: 'no-ready-device', devices: [] })).toMatch(/ready/);
    expect(timelineNotice({ kind: 'waiting', packageName: null })).toMatch(/the app/);
    expect(timelineNotice({ kind: 'error', message: 'x' })).toBe('Session error: x');
    expect(timelineNotice({ kind: 'ready' })).toBeNull();
    expect(timelineNotice({ kind: 'disconnected' })).toBeNull();
    expect(timelineNotice({ kind: 'loading' })).toBeNull();
  });

  it('detects active sessions and recorded series', () => {
    expect(isSessionActive({ session: session() })).toBe(true);
    expect(isSessionActive({ session: session({ status: 'waiting_for_process' }) })).toBe(true);
    expect(isSessionActive({ session: session({ status: 'idle' }) })).toBe(false);
    expect(hasSeries(createInitialState())).toBe(false);
    expect(hasSeries({ ...createInitialState(), cpu: [cpu(T0)] })).toBe(true);
  });
});

describe('screensEmptyState', () => {
  const base = {
    hasRows: false,
    hasAnyBreakdown: false,
    isSdkConnected: false,
    sdk: undefined,
    sdkLinkError: null,
  };
  const known = {
    connected: false,
    sdkVersion: '0.1.0',
    processName: 'p',
    apiLevel: 34,
    framesActive: false,
  };

  it('picks the most specific reason, rows first', () => {
    expect(screensEmptyState({ ...base, hasRows: true })).toBeNull();
    expect(screensEmptyState({ ...base, hasAnyBreakdown: true })).toEqual({ kind: 'window' });
    expect(screensEmptyState({ ...base, isSdkConnected: true, sdkLinkError: 'x' })).toEqual({
      kind: 'waiting',
    });
    expect(screensEmptyState({ ...base, sdk: known, sdkLinkError: 'reverse failed' })).toEqual({
      kind: 'link-failed',
      message: 'reverse failed',
    });
    expect(screensEmptyState({ ...base, sdk: known })).toEqual({ kind: 'disconnected', sdkVersion: '0.1.0' });
    expect(screensEmptyState({ ...base, sdk: { ...known, sdkVersion: null } })).toEqual({ kind: 'no-sdk' });
    expect(screensEmptyState(base)).toEqual({ kind: 'no-sdk' });
  });
});

describe('stall view state', () => {
  const v1 = { ...SDK_V2, sdkVersion: '0.1.1', protocolVersion: 1 };
  const gone = { ...SDK_V2, connected: false, protocolVersion: null };
  const missing = { ...gone, sdkVersion: null };

  it('only a live v2 link can detect stalls', () => {
    expect(isStallCapable(SDK_V2)).toBe(true);
    expect(isStallCapable(v1)).toBe(false);
    expect(isStallCapable(gone)).toBe(false);
    expect(isStallCapable(undefined)).toBe(false);
  });

  it('explains why the SDK options are disabled', () => {
    expect(sdkOptionsBlocker(true, SDK_V2)).toBeNull();
    expect(sdkOptionsBlocker(false, SDK_V2)).toMatch(/Start a session/);
    expect(sdkOptionsBlocker(true, gone)).toMatch(/Connect the app/);
    expect(sdkOptionsBlocker(true, v1)).toBe(SDK_UPDATE_HINT);
    expect(SDK_UPDATE_HINT).toBe('Update the app’s Lionscope SDK to 0.2.0 for stall detection');
    // Older servers: no SDK state at all, or a link without options.
    expect(sdkOptionsBlocker(true, undefined)).toMatch(/server/);
    expect(sdkOptionsBlocker(true, { ...SDK_V2, options: undefined })).toMatch(/server/);
  });

  it('picks the Stalls empty state, most specific first', () => {
    const input = {
      hasItems: false,
      hasAnyData: false,
      isSessionActive: true,
      sdk: SDK_V2,
      sdkLinkError: null,
      thresholdMs: 250,
    };
    expect(stallsEmptyState({ ...input, hasItems: true })).toBeNull();
    expect(stallsEmptyState({ ...input, hasAnyData: true })).toEqual({ kind: 'window' });
    expect(stallsEmptyState(input)).toEqual({ kind: 'waiting', thresholdMs: 250 });
    expect(stallsEmptyState({ ...input, isSessionActive: false })).toEqual({ kind: 'no-session' });
    expect(stallsEmptyState({ ...input, sdk: v1 })).toEqual({ kind: 'old-sdk', sdkVersion: '0.1.1' });
    expect(stallsEmptyState({ ...input, sdk: { ...SDK_V2, protocolVersion: undefined } })).toEqual({
      kind: 'old-server',
    });
    expect(stallsEmptyState({ ...input, sdk: undefined })).toEqual({ kind: 'old-server' });
    expect(stallsEmptyState({ ...input, sdk: missing })).toEqual({ kind: 'no-sdk' });
    expect(stallsEmptyState({ ...input, sdk: gone })).toEqual({ kind: 'disconnected', sdkVersion: '0.2.0' });
    expect(stallsEmptyState({ ...input, sdk: missing, sdkLinkError: 'closed' })).toEqual({
      kind: 'link-failed',
      message: 'closed',
    });
  });
});

describe('network view state', () => {
  const empty = (sdk: Parameters<typeof networkLinkState>[0]) =>
    networkEmptyState({ hasItems: false, hasAnyData: false, isSessionActive: true, sdk, sdkLinkError: null });

  it('reads SdkStatus.network, falling back to the protocol version on older servers', () => {
    expect(networkLinkState(undefined)).toBeNull();
    expect(networkLinkState({ ...SDK_V7, connected: false, network: null })).toBeNull();
    expect(networkLinkState(SDK_V7)).toBe('active');
    expect(networkLinkState(SDK_V3)).toBe('needs_sdk');
    expect(networkLinkState({ ...SDK_V7, network: 'unverified' })).toBe('unverified');
    expect(networkLinkState({ ...SDK_V7, network: 'needs_sdk' })).toBe('needs_sdk');
    expect(isNetworkCapable({ ...SDK_V7, network: 'active' })).toBe(true);
    expect(isNetworkCapable({ ...SDK_V7, network: 'unverified' })).toBe(false);
  });

  it('picks the Network tab state from it', () => {
    expect(empty(SDK_V7)).toEqual({ kind: 'waiting' });
    expect(empty({ ...SDK_V7, network: 'active' })).toEqual({ kind: 'waiting' });
    expect(empty({ ...SDK_V7, network: 'unverified' })).toEqual({ kind: 'unverified' });
    expect(empty({ ...SDK_V7, network: 'needs_sdk' })).toEqual({ kind: 'needs-sdk', sdkVersion: '0.7.0' });
    expect(empty(SDK_V3)).toEqual({ kind: 'needs-sdk', sdkVersion: '0.4.0' });
  });
});

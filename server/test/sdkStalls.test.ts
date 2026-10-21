import { DEFAULT_SDK_OPTIONS, DEVICE_PROTOCOL_V2 } from '@lionscope/protocol';
import type { StackFrame } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_DEBOUNCE_MS,
  INVALID_DIAGNOSTIC_MESSAGE,
  MAX_EVENT_AGE_MS,
  SDK_EVENT_CLOCK_MESSAGE,
} from '../src/device/sdkBridge.ts';
import type { SdkLinkMessage } from '../src/device/sdkLink.ts';
import { ERROR_REPORT_TTL_MS } from '../src/errors.ts';
import { log } from '../src/log.ts';
import { deviceNow, FakeLink, HELLO, HOME, setupSdkSession as setup, START } from './helpers/sdkSession.ts';

const HELLO_V2 = { ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2, sdkVersion: '0.2.0' };
const APP_FRAME: StackFrame = {
  className: 'com.example.HomeViewModel',
  method: 'mapItems',
  file: 'HomeViewModel.kt',
  line: 87,
  inApp: true,
};

type Stall = Extract<SdkLinkMessage, { type: 'stall' }>;
type StrictMode = Extract<SdkLinkMessage, { type: 'strictmode' }>;

/** A stall that started `agoMs` before now (device clock). */
function stall(agoMs: number, changes: Partial<Stall> = {}): Stall {
  return {
    type: 'stall',
    ts: deviceNow() - agoMs,
    durationMs: 342,
    frames: [APP_FRAME],
    samples: 6,
    truncated: false,
    screen: 'homepage',
    debugger: false,
    ...changes,
  };
}

function strictMode(agoMs: number, changes: Partial<StrictMode> = {}): StrictMode {
  return {
    type: 'strictmode',
    ts: deviceNow() - agoMs,
    policy: 'thread',
    violation: 'DiskReadViolation',
    message: null,
    frames: [APP_FRAME],
    count: 3,
    screen: null,
    ...changes,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProfilingSession SDK options', () => {
  it('reports the live link’s protocol version and the session options (defaults until changed)', async () => {
    const { session, connect } = await setup();
    expect(session.state.sdk).toMatchObject({ protocolVersion: null, options: DEFAULT_SDK_OPTIONS });
    const { link, handler } = await connect(HELLO_V2);
    expect(session.state.sdk).toMatchObject({ connected: true, protocolVersion: 2 });
    // Sent on attach, before the PID check: the gateway writes it right after the welcome.
    expect(link.configs).toEqual([DEFAULT_SDK_OPTIONS]);
    handler.onClose();
    expect(session.state.sdk).toMatchObject({ connected: false, protocolVersion: null });

    await connect(); // a v1 SDK: its link ignores config
    expect(session.state.sdk?.protocolVersion).toBe(1);
    session.stop();
    expect(session.state.sdk).toMatchObject({ protocolVersion: null, options: DEFAULT_SDK_OPTIONS });
  });

  it('announces changes at once and pushes the latest to every link once they settle', async () => {
    const { session, device, ofType, connect } = await setup();
    const live = await connect(HELLO_V2);
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command.startsWith('pidof') ? { output: '1105\n', delayMs: 1000 } : original(command);
    const pending = new FakeLink(DEVICE_PROTOCOL_V2);
    session.attachSdk(HELLO_V2, pending); // its PID check takes a second

    session.setSdkOptions({ strictMode: true });
    const strict = { stallThresholdMs: 150, strictMode: true };
    expect(session.state.sdk?.options).toEqual(strict);
    expect(ofType('session').at(-1)?.session.sdk?.options).toEqual(strict);
    session.setSdkOptions({ stallThresholdMs: 500, strictMode: undefined });
    const latest = { stallThresholdMs: 500, strictMode: true };
    expect(session.state.sdk?.options).toEqual(latest);
    await vi.advanceTimersByTimeAsync(CONFIG_DEBOUNCE_MS - 1);
    expect(live.link.configs).toEqual([DEFAULT_SDK_OPTIONS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.link.configs).toEqual([DEFAULT_SDK_OPTIONS, latest]);
    expect(pending.configs).toEqual([DEFAULT_SDK_OPTIONS, latest]);

    // No change: still answered with a session broadcast, but nothing is pushed.
    const sessions = ofType('session').length;
    session.setSdkOptions({ strictMode: true });
    expect(ofType('session')).toHaveLength(sessions + 1);
    await vi.advanceTimersByTimeAsync(CONFIG_DEBOUNCE_MS);
    expect(live.link.configs).toHaveLength(2);

    // Options belong to the session: a reconnecting SDK gets the current ones.
    device.handle = original;
    await vi.advanceTimersByTimeAsync(1000);
    const next = await connect(HELLO_V2);
    expect(next.link.configs).toEqual([latest]);

    // Stopping cancels a pending push; a stopped session ignores changes.
    session.setSdkOptions({ strictMode: false });
    session.stop();
    await vi.advanceTimersByTimeAsync(CONFIG_DEBOUNCE_MS);
    expect(next.link.configs).toEqual([latest]);
    const count = ofType('session').length;
    session.setSdkOptions({ stallThresholdMs: 1000 });
    expect(session.state.sdk?.options).toEqual({ stallThresholdMs: 500, strictMode: false });
    expect(ofType('session')).toHaveLength(count);
  });

  it('tells the dashboard (throttled) when the live link sent an invalid diagnostic', async () => {
    const { session, ofType, connect } = await setup();
    const pending = session.attachSdk({ ...HELLO_V2, pid: 6666 }, new FakeLink(DEVICE_PROTOCOL_V2));
    pending.onInvalidDiagnostic(); // not verified: no notice
    const { handler } = await connect(HELLO_V2);
    handler.onInvalidDiagnostic();
    handler.onInvalidDiagnostic();
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: INVALID_DIAGNOSTIC_MESSAGE },
    ]);
    expect(INVALID_DIAGNOSTIC_MESSAGE).toBe('SDK sent an invalid diagnostic; ignored');
    session.stop();
    handler.onInvalidDiagnostic();
    expect(ofType('error')).toHaveLength(1);
  });
});

describe('ProfilingSession stalls and StrictMode', () => {
  it('records stalls on the laptop clock, with the SDK screen or else the top screen at their start', async () => {
    const { session, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(5000);
    const { handler } = await connect(HELLO_V2);
    handler.onMessage({ type: 'screen', ts: deviceNow() - 3000, screen: HOME });
    handler.onMessage(stall(2000));
    handler.onMessage(stall(1500, { screen: null, debugger: true, truncated: true }));
    handler.onMessage({ type: 'screen', ts: deviceNow() - 1000, screen: null });
    handler.onMessage(stall(800, { screen: null }));
    handler.onMessage(stall(4000, { screen: null })); // before the first span

    const now = Date.now();
    const { type: _type, ...base } = stall(0);
    expect(ofType('stall').map((message) => message.sample)).toEqual([
      { ...base, ts: now - 2000, screen: 'homepage' },
      { ...base, ts: now - 1500, screen: 'home', debugger: true, truncated: true },
      { ...base, ts: now - 800, screen: null },
      { ...base, ts: now - 4000, screen: null },
    ]);
    expect(session.snapshot().stalls).toEqual(ofType('stall').map((message) => message.sample));
    session.stop();
  });

  it('records coalesced StrictMode violations the same way', async () => {
    const { session, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(5000);
    const { handler } = await connect(HELLO_V2);
    handler.onMessage({ type: 'screen', ts: deviceNow() - 3000, screen: HOME });
    handler.onMessage(strictMode(1000));
    handler.onMessage(
      strictMode(500, {
        policy: 'vm',
        violation: 'LeakedClosableViolation',
        message: 'leak',
        screen: 'cart',
      }),
    );
    const now = Date.now();
    expect(ofType('strictmode').map((message) => message.sample)).toEqual([
      {
        ts: now - 1000,
        policy: 'thread',
        violation: 'DiskReadViolation',
        message: null,
        frames: [APP_FRAME],
        count: 3,
        screen: 'home',
      },
      {
        ts: now - 500,
        policy: 'vm',
        violation: 'LeakedClosableViolation',
        message: 'leak',
        frames: [APP_FRAME],
        count: 3,
        screen: 'cart',
      },
    ]);
    expect(session.snapshot().strictMode).toHaveLength(2);
    session.stop();
  });

  it('holds stalls of a pending link until its PID is verified', async () => {
    const { session, ofType } = await setup();
    await vi.advanceTimersByTimeAsync(5000);
    const handler = session.attachSdk(HELLO_V2, new FakeLink(DEVICE_PROTOCOL_V2));
    handler.onMessage(stall(500));
    expect(ofType('stall')).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('stall')).toHaveLength(1);

    const spoof = session.attachSdk({ ...HELLO_V2, pid: 6666 }, new FakeLink(DEVICE_PROTOCOL_V2));
    spoof.onMessage(stall(400));
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('stall')).toHaveLength(1);
    session.stop();
  });

  it(`accepts events completed within ${MAX_EVENT_AGE_MS / 1000} s and up to 2 s ahead (clamped to now)`, async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(120_000);
    const { handler } = await connect(HELLO_V2);
    // A 30 s block (cut by the SDK) that started 70 s ago ended 40 s ago: kept.
    handler.onMessage(stall(70_000, { durationMs: 30_000 }));
    handler.onMessage(stall(-1500)); // 1.5 s ahead: as of now
    handler.onMessage(strictMode(-1500));
    expect(ofType('error')).toEqual([]);
    const now = Date.now();
    expect(ofType('stall').map((message) => message.sample.ts)).toEqual([now - 70_000, now]);
    expect(ofType('strictmode').map((message) => message.sample.ts)).toEqual([now]);

    // Completed just over a minute ago, or starting over 2 s ahead: dropped, with one (throttled) notice.
    handler.onMessage(stall(MAX_EVENT_AGE_MS + 1342, { durationMs: 342 }));
    handler.onMessage(strictMode(MAX_EVENT_AGE_MS + 1));
    handler.onMessage(stall(-2001));
    expect(ofType('stall')).toHaveLength(2);
    expect(ofType('strictmode')).toHaveLength(1);
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: SDK_EVENT_CLOCK_MESSAGE },
    ]);
    const lines = () =>
      warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('stall/StrictMode'));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('dropped an SDK stall/StrictMode event 1000 ms behind the accepted window');
    expect(lines()[0]).toContain('clock offset 5000 ms');

    await vi.advanceTimersByTimeAsync(ERROR_REPORT_TTL_MS);
    handler.onMessage(strictMode(-2500));
    expect(lines().at(-1)).toContain('500 ms ahead of the accepted window');
    session.stop();
  });

  it('drops events that ended before the session started and starts straddling ones with it', async () => {
    const { session, ofType, connect } = await setup();
    const { handler } = await connect(HELLO_V2);
    expect(Date.now()).toBe(START);
    handler.onMessage(stall(10_000)); // ended 9.7 s before the session
    handler.onMessage(stall(1000, { durationMs: 2000 })); // started 1 s before it
    handler.onMessage(strictMode(500));
    handler.onMessage(strictMode(0));
    expect(ofType('stall').map((message) => message.sample)).toMatchObject([{ ts: START, durationMs: 2000 }]);
    expect(ofType('strictmode').map((message) => message.sample.ts)).toEqual([START]);
    expect(ofType('error')).toEqual([]); // not a clock problem
    session.stop();
  });
});

import type {
  DeviceInfo,
  EmulatorInfo,
  FrameBreakdownSample,
  FrameSample,
  HttpExchangeDetail,
  InflateSample,
  LogEntry,
  SessionState,
  Snapshot,
  StackFrame,
  StallSample,
  StrictModeSample,
  ViewTreeSample,
} from '@lionscope/protocol';
import { FRAME_STAGES } from '@lionscope/protocol';
import type { AgentBaseContext, AgentInspector } from '../../src/agent/tool.ts';
import { PublicError } from '../../src/errors.ts';
import { MockRules, NO_SESSION_MOCKS_MESSAGE } from '../../src/session/mockRules.ts';
import { emptySnapshot } from '../../src/store/sessionStore.ts';
import { FakeAdb } from './fakes.ts';

export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
export const PKG = 'com.example.shop';

export function frame(ts: number, overrides: Partial<FrameSample> = {}): FrameSample {
  return {
    ts,
    frameCount: 60,
    jankCount: 3,
    slowCount: 5,
    fps: 60,
    p50Ms: 8,
    p90Ms: 14,
    p99Ms: 22,
    maxMs: 40,
    frameIntervalMs: 16.67,
    frameIntervalSource: 'reported',
    durationsMs: [8, 9, 10, 14, 30],
    source: 'sdk',
    ...overrides,
  };
}

export function breakdown(
  ts: number,
  screen: string | null,
  overrides: Partial<FrameBreakdownSample> = {},
): FrameBreakdownSample {
  const meanStageMs = Object.fromEntries(FRAME_STAGES.map((stage) => [stage, 0])) as Record<
    (typeof FRAME_STAGES)[number],
    number
  >;
  return {
    ts,
    screen,
    frameCount: 30,
    jankCount: 3,
    slowCount: 6,
    meanStageMs: { ...meanStageMs, draw: 4 },
    p90TotalMs: 12,
    maxTotalMs: 20,
    frameIntervalMs: 16.67,
    ...overrides,
  };
}

export function stackFrame(className: string, method: string, line: number, inApp: boolean): StackFrame {
  return { className, method, file: `${className.split('.').at(-1)}.kt`, line, inApp };
}

export const HOME_STACK: StackFrame[] = [
  stackFrame('java.lang.Thread', 'sleep', -2, false),
  stackFrame('java.lang.Thread', 'sleep', 450, false),
  stackFrame('com.example.shop.home.HomeViewModel', 'load', 87, true),
  stackFrame('android.os.Handler', 'dispatchMessage', 102, false),
  stackFrame('android.os.Looper', 'loop', 288, false),
  stackFrame('android.app.ActivityThread', 'main', 8177, false),
];

export function stall(ts: number, durationMs: number, overrides: Partial<StallSample> = {}): StallSample {
  return {
    ts,
    durationMs,
    frames: HOME_STACK,
    samples: 4,
    truncated: false,
    screen: 'Home',
    debugger: false,
    ...overrides,
  };
}

export function violation(ts: number, overrides: Partial<StrictModeSample> = {}): StrictModeSample {
  return {
    ts,
    policy: 'thread',
    violation: 'DiskReadViolation',
    message: null,
    frames: HOME_STACK,
    count: 1,
    screen: 'Home',
    ...overrides,
  };
}

export function inflate(ts: number, layout: string, overrides: Partial<InflateSample> = {}): InflateSample {
  return {
    ts,
    layout,
    label: null,
    library: false,
    nested: false,
    screen: 'Home',
    count: 1,
    totalMs: 10,
    maxMs: 10,
    views: 20,
    ...overrides,
  };
}

export function viewTree(
  ts: number,
  screen: string,
  overrides: Partial<ViewTreeSample> = {},
): ViewTreeSample {
  return {
    ts,
    screen,
    window: 'MainActivity',
    views: 120,
    viewGroups: 30,
    maxDepth: 9,
    deepestPath: [
      { className: 'DecorView', id: null },
      { className: 'RecyclerView', id: 'list' },
    ],
    topClasses: [{ className: 'TextView', count: 40 }],
    ...overrides,
  };
}

export function logEntry(ts: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return { ts, pid: 1234, tid: 1234, level: 'I', tag: 'Shop', message: 'hello', ...overrides };
}

export const RUNNING: SessionState = {
  status: 'running',
  serial: 'emulator-5554',
  packageName: PKG,
  pid: 1234,
  startedAt: T0,
};

export const DEVICES: DeviceInfo[] = [
  { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' },
  { serial: 'R58M123ABC', state: 'unauthorized' },
];

export const EMULATORS: EmulatorInfo[] = [
  {
    avdName: 'Pixel_9',
    displayName: 'Pixel 9',
    state: 'running',
    serial: 'emulator-5554',
    managed: true,
    canMirror: true,
    renderer: 'host',
  },
];

export interface FakeAgent {
  ctx: AgentBaseContext;
  adb: FakeAdb;
  snapshot: Required<Snapshot>;
  session: SessionState;
  sdkOptionCalls: unknown[];
  /** getSdkEverLinked answers true when set, or while the session's SDK is connected. */
  sdkEverLinked: boolean;
  /** The session's mock rules (a real MockRules; `networkMocks` messages are dropped). */
  mocks: MockRules;
  /** What getHttpExchange answers, by id. */
  httpDetails: Map<number, HttpExchangeDetail>;
}

/** A context over a fixed snapshot; the clock stands at `now`. */
export function fakeAgent(
  snapshot: Partial<Snapshot> = {},
  options: { session?: SessionState; now?: number; adb?: FakeAdb; inspector?: AgentInspector } = {},
): FakeAgent {
  const agent: FakeAgent = {
    adb: options.adb ?? new FakeAdb(() => ''),
    snapshot: { ...emptySnapshot(), ...snapshot },
    session: options.session ?? RUNNING,
    sdkOptionCalls: [],
    sdkEverLinked: false,
    mocks: new MockRules({ now: () => options.now ?? T0 + 60_000, emit: () => undefined }),
    httpDetails: new Map(),
    ctx: undefined as unknown as FakeAgent['ctx'],
  };
  const running = () => agent.session.status !== 'idle' && agent.session.status !== 'error';
  agent.ctx = {
    sessions: {
      getDevices: () => DEVICES,
      getSessionState: () => agent.session,
      getSnapshot: () => agent.snapshot,
      refreshDevices: async () => DEVICES,
      listApps: async () => [
        { packageName: PKG, pid: 1234, thirdParty: true },
        { packageName: 'com.android.settings', pid: null, thirdParty: false },
      ],
      startSession: async (serial, packageName) => {
        agent.session = { ...RUNNING, serial, packageName, status: 'waiting_for_process', pid: null };
        return agent.session;
      },
      stopSession: async () => {
        agent.session = { ...agent.session, status: 'idle' };
        return agent.session;
      },
      setSdkOptions: (changes) => {
        agent.sdkOptionCalls.push(changes);
        return agent.session.status !== 'idle';
      },
      getHttpExchange: (id) => agent.httpDetails.get(id) ?? null,
      getHttpExchangeCount: () => agent.snapshot.http.length,
      getHttpExchangesSeen: () => agent.snapshot.http.length,
      getSdkEverLinked: () => agent.sdkEverLinked || agent.session.sdk?.connected === true,
      getNetworkMocks: () => agent.mocks.state,
      setNetworkMock: (input, origin) => {
        if (!running()) throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
        return agent.mocks.set(input, origin);
      },
      clearNetworkMocks: (id) => {
        if (!running()) return false;
        if (id !== undefined) return agent.mocks.remove(id);
        agent.mocks.clear();
        return true;
      },
    },
    emulators: {
      getEmulators: () => EMULATORS,
      refresh: async () => EMULATORS,
      boot: async () => undefined,
      shutdown: async () => undefined,
    },
    inspector: options.inspector ?? {
      inspect: () => Promise.reject(new Error('no Inspector in this test')),
      select: () => null,
      current: null,
      selection: null,
      png: () => null,
    },
    adb: agent.adb,
    serverVersion: '0.4.1',
    bufferWindowMs: 10 * 60_000,
    dashboardUrl: () => 'http://localhost:8701',
    sdkGatewayPort: () => 8700,
    now: () => options.now ?? T0 + 60_000,
    screenshots: new Map(),
    uiDumps: new Map(),
    deviceCalls: new Map(),
  };
  return agent;
}

/** A tool's JSON result, read loosely in assertions (its shape is what the assertions check). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

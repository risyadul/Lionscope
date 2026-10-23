import type {
  CpuSample,
  HttpBody,
  HttpExchange,
  HttpExchangeDetail,
  NetworkMockRule,
  FrameBreakdownSample,
  FrameSample,
  FrameStage,
  LogEntry,
  MemorySample,
  ScreenKind,
  ScreenSpan,
  SdkStatus,
  SessionState,
  StackFrame,
  StallSample,
  StrictModeSample,
  InflateSample,
  ViewTreeSample,
} from '@lionscope/protocol/wire';

export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

export function cpu(ts: number, percent = 10, overrides: Partial<CpuSample> = {}): CpuSample {
  return { ts, percent, percentSingleCore: percent * 8, threads: 42, ...overrides };
}

export function memory(ts: number, overrides: Partial<MemorySample> = {}): MemorySample {
  return {
    ts,
    totalPssKb: 102_400,
    javaHeapKb: 30_720,
    nativeHeapKb: 20_480,
    codeKb: 10_240,
    stackKb: 1_024,
    graphicsKb: 15_360,
    privateOtherKb: 2_048,
    systemKb: 22_528,
    ...overrides,
  };
}

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
    ...overrides,
  };
}

export function log(ts: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return { ts, pid: 1234, tid: 1234, level: 'I', tag: 'ActivityManager', message: 'Displayed', ...overrides };
}

export function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: 'running',
    serial: 'emulator-5554',
    packageName: 'com.example.shop',
    pid: 1234,
    startedAt: T0,
    ...overrides,
  };
}

export function span(
  start: number,
  end: number | null,
  name: string | null,
  kind: ScreenKind = 'fragment',
): ScreenSpan {
  return {
    start,
    end,
    screen: name === null ? null : { name, className: `com.example.shop.ui.${name}`, kind },
  };
}

export const STAGES_ZERO: Record<FrameStage, number> = {
  input: 0,
  animation: 0,
  layout: 0,
  draw: 0,
  sync: 0,
  command: 0,
  swap: 0,
  delay: 0,
  gpu: 0,
};

export function breakdown(
  ts: number,
  screen: string | null,
  overrides: Partial<Omit<FrameBreakdownSample, 'meanStageMs'>> & {
    stages?: Partial<Record<FrameStage, number>>;
  } = {},
): FrameBreakdownSample {
  const { stages, ...rest } = overrides;
  return {
    ts,
    screen,
    frameCount: 30,
    jankCount: 1,
    slowCount: 2,
    meanStageMs: { ...STAGES_ZERO, layout: 2, draw: 3, command: 1, ...stages },
    p90TotalMs: 9,
    maxTotalMs: 20,
    frameIntervalMs: 16.67,
    ...rest,
  };
}

export function stackFrame(
  className: string,
  method: string,
  file: string | null,
  line: number | null,
  inApp = false,
): StackFrame {
  return { className, method, file, line, inApp };
}

/** Innermost first: a framework sort under an app method, then the Looper. */
export const HOME_STACK: StackFrame[] = [
  stackFrame('java.util.TimSort', 'sort', 'TimSort.java', 245),
  stackFrame('java.util.Arrays', 'sort', 'Arrays.java', 1498),
  stackFrame('kotlin.collections.CollectionsKt___CollectionsKt', 'sortedWith', '_Collections.kt', 1105),
  stackFrame('com.example.shop.home.HomeViewModel', 'mapItems', 'HomeViewModel.kt', 87, true),
  stackFrame('com.example.shop.home.HomeViewModel$load$1', 'invokeSuspend', 'HomeViewModel.kt', 52, true),
  stackFrame('kotlinx.coroutines.DispatchedTask', 'run', 'DispatchedTask.kt', 108),
  stackFrame('android.os.Handler', 'dispatchMessage', 'Handler.java', 99),
  stackFrame('android.os.Looper', 'loop', 'Looper.java', 294),
  stackFrame('java.lang.reflect.Method', 'invoke', null, -2),
];

export const CART_STACK: StackFrame[] = [
  stackFrame('java.io.FileInputStream', 'read', 'FileInputStream.java', 321),
  stackFrame('com.example.shop.data.CartRepository', 'loadFromDisk', 'CartRepository.kt', 41, true),
  stackFrame('android.os.Looper', 'loop', 'Looper.java', 294),
];

export function stall(ts: number, durationMs: number, overrides: Partial<StallSample> = {}): StallSample {
  return {
    ts,
    durationMs,
    frames: HOME_STACK,
    samples: Math.max(1, Math.round(durationMs / 50)),
    truncated: false,
    screen: 'homepage',
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
    frames: CART_STACK,
    count: 1,
    screen: 'CartFragment',
    ...overrides,
  };
}

/** A live protocol-v2 SDK link with the default options. */
export const SDK_V2: SdkStatus = {
  connected: true,
  sdkVersion: '0.2.0',
  processName: 'com.example.shop',
  apiLevel: 34,
  framesActive: true,
  protocolVersion: 2,
  options: { stallThresholdMs: 150, strictMode: false, inflateTracking: true },
};

/** A live protocol-v3 SDK link on Android 14 with the default options. */
export const SDK_V3: SdkStatus = {
  ...SDK_V2,
  sdkVersion: '0.4.0',
  protocolVersion: 3,
  options: { stallThresholdMs: 150, strictMode: false, inflateTracking: true },
};

export function inflate(ts: number, overrides: Partial<InflateSample> = {}): InflateSample {
  return {
    ts,
    layout: 'fragment_home',
    label: null,
    library: false,
    nested: false,
    screen: 'homepage',
    count: 1,
    totalMs: 6,
    maxMs: 6,
    views: 24,
    ...overrides,
  };
}

export function viewTree(ts: number, overrides: Partial<ViewTreeSample> = {}): ViewTreeSample {
  return {
    ts,
    screen: 'homepage',
    window: 'MainActivity',
    views: 142,
    viewGroups: 31,
    maxDepth: 14,
    deepestPath: [
      { className: 'DecorView', id: null },
      { className: 'ConstraintLayout', id: 'content' },
      { className: 'TextView', id: 'title' },
    ],
    topClasses: [{ className: 'TextView', count: 40 }],
    ...overrides,
  };
}

/** A live protocol-v7 SDK link (network capture and mocks). */
export const SDK_V7: SdkStatus = {
  ...SDK_V3,
  sdkVersion: '0.7.0',
  protocolVersion: 7,
};

/** A completed GET of api.example.com that took 120 ms. */
export function exchange(id: number, ts: number, overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    id,
    ts,
    endTs: ts + 120,
    method: 'GET',
    url: `https://api.example.com/v1/items/${id}`,
    state: 'complete',
    status: 200,
    headersMs: 80,
    durationMs: 120,
    requestSize: 0,
    responseSize: 2048,
    responseType: 'application/json',
    mockId: null,
    error: null,
    screen: 'homepage',
    ...overrides,
  };
}

export function body(overrides: Partial<HttpBody> = {}): HttpBody {
  return {
    size: 17,
    contentType: 'application/json',
    text: '{"items":[1,2,3]}',
    truncated: false,
    omitted: null,
    ...overrides,
  };
}

export function exchangeDetail(
  summary: HttpExchange,
  overrides: Partial<HttpExchangeDetail> = {},
): HttpExchangeDetail {
  return {
    ...summary,
    protocol: 'h2',
    requestHeaders: [
      ['Accept', 'application/json'],
      ['Authorization', '‹redacted›'],
    ],
    responseHeaders: [['Content-Type', 'application/json; charset=utf-8']],
    requestBody: null,
    responseBody: body(),
    ...overrides,
  };
}

export function mockRule(id: string, overrides: Partial<NetworkMockRule> = {}): NetworkMockRule {
  return {
    id,
    method: 'GET',
    match: 'prefix',
    url: 'https://api.example.com/v1/items',
    action: 'respond',
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: '[]',
    delayMs: 0,
    enabled: true,
    origin: 'user',
    updatedAt: T0,
    ...overrides,
  };
}

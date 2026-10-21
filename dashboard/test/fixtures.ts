import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  FrameStage,
  LogEntry,
  MemorySample,
  ScreenKind,
  ScreenSpan,
  SessionState,
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

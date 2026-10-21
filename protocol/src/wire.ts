/**
 * Lionscope wire contract: constants, identifier rules and message types.
 *
 * Dependency-free on purpose so the dashboard can import it without bundling zod (zod probes
 * `new Function` at load time, which a strict CSP reports as a violation). Runtime validation of
 * dashboard → server messages lives in `./index.ts`.
 */

export const PROTOCOL_VERSION = 1;

/** WebSocket path on the dashboard HTTP server. */
export const WS_PATH = '/ws';
export const DEFAULT_DASHBOARD_PORT = 8701;
/** Reserved for the in-app SDK gateway (Phase 2). */
export const DEFAULT_DEVICE_GATEWAY_PORT = 8700;

// ---------------------------------------------------------------------------
// Identifiers (validated because they end up in adb arguments / device shell commands)
// ---------------------------------------------------------------------------

/** adb serials: `emulator-5554`, `R58M123ABC`, `192.168.1.5:5555`, `adb-R58M._adb-tls-connect._tcp`. */
export const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** Android application id (at least two segments, Java identifier rules). */
export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function isValidSerial(value: string): boolean {
  return SERIAL_PATTERN.test(value);
}

export function isValidPackageName(value: string): boolean {
  return value.length <= 255 && PACKAGE_NAME_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown';

export interface DeviceInfo {
  serial: string;
  state: DeviceState;
  model?: string;
  product?: string;
  transportId?: string;
}

export interface AppInfo {
  packageName: string;
  /** PID when the app process is running, otherwise null. */
  pid: number | null;
  thirdParty: boolean;
}

/** All timestamps are epoch milliseconds (laptop clock unless stated otherwise). */
export interface CpuSample {
  ts: number;
  /** App CPU usage normalized to all cores (0–100). */
  percent: number;
  /** App CPU usage relative to one core (can exceed 100 on multi-core). */
  percentSingleCore: number;
  threads: number;
}

export interface MemorySample {
  ts: number;
  totalPssKb: number;
  javaHeapKb: number;
  nativeHeapKb: number;
  codeKb: number;
  stackKb: number;
  graphicsKb: number;
  privateOtherKb: number;
  systemKb: number;
}

export interface FrameSample {
  ts: number;
  /** Valid frames (Flags = 0) rendered since the previous sample. */
  frameCount: number;
  /**
   * Frames that missed their deadline (FrameCompleted > FrameDeadline, API 31+), matching Android's own
   * jank accounting. Below API 31 there is no deadline column, so this equals `slowCount`.
   */
  jankCount: number;
  /** Frames slower than one vsync interval (duration > frameIntervalMs). Always ≥ jankCount on API 31+. */
  slowCount: number;
  /** frameCount / elapsed seconds since previous sample. */
  fps: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Vsync period: FrameInterval (API 31+), else inferred from IntendedVsync gaps, else 16.67 ms. */
  frameIntervalMs: number;
  /** Where frameIntervalMs came from; 'default' means no evidence yet (treat high-refresh numbers with care). */
  frameIntervalSource: 'reported' | 'inferred' | 'default';
  /** Individual frame durations (ms), capped to the most recent MAX_FRAME_DURATIONS. */
  durationsMs: number[];
  /** Where the frames came from; absent on samples from older servers (= 'gfxinfo'). */
  source?: FrameSource;
}

/** `gfxinfo` = adb `dumpsys gfxinfo` polling; `sdk` = FrameMetrics streamed by the in-app SDK. */
export type FrameSource = 'gfxinfo' | 'sdk';

export const MAX_FRAME_DURATIONS = 240;

export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';

export interface LogEntry {
  /**
   * Epoch ms on the laptop clock: the device timestamp from `logcat -v epoch`, shifted by the
   * device↔laptop clock offset measured at session start, so logs line up with the charts.
   */
  ts: number;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

export type TimelineEventKind = 'process_start' | 'process_restart' | 'process_died';

export interface TimelineEvent {
  ts: number;
  kind: TimelineEventKind;
  pid: number | null;
  /** Producer of the event; absent = 'adb'. */
  source?: 'adb' | 'sdk';
  /** Optional human-readable detail shown with the marker. */
  detail?: string;
}

export type SessionStatus = 'idle' | 'waiting_for_process' | 'running' | 'error';

export interface SdkStatus {
  /** An SDK connection for the session's app is live. */
  connected: boolean;
  sdkVersion: string | null;
  processName: string | null;
  apiLevel: number | null;
  /** SDK frames are flowing, so the gfxinfo poller is paused. */
  framesActive: boolean;
}

export interface SessionState {
  status: SessionStatus;
  serial: string | null;
  packageName: string | null;
  pid: number | null;
  startedAt: number | null;
  error?: string;
  /** Present once a session exists; absent on older servers. */
  sdk?: SdkStatus;
}

export type ScreenKind = 'activity' | 'fragment' | 'dialog';

export interface ScreenRef {
  /** Display name: the app's own screen alias (e.g. `ScreenName.getScreen().value`) or the simple class name. */
  name: string;
  /** Fully-qualified class name of the Activity / Fragment. */
  className: string;
  kind: ScreenKind;
}

/** A period during which `screen` was the top screen (laptop clock). `end` is null while still on top. */
export interface ScreenSpan {
  start: number;
  end: number | null;
  /** null = app in background / no screen. */
  screen: ScreenRef | null;
}

export const FRAME_STAGES = [
  'input',
  'animation',
  'layout',
  'draw',
  'sync',
  'command',
  'swap',
  'delay',
  'gpu',
] as const;
export type FrameStage = (typeof FRAME_STAGES)[number];

/** SDK FrameMetrics aggregated per 500 ms bucket (laptop clock). */
export interface FrameBreakdownSample {
  ts: number;
  /** `ScreenRef.name` that was on top at the end of the bucket. */
  screen: string | null;
  frameCount: number;
  jankCount: number;
  slowCount: number;
  /** Mean milliseconds per stage across the bucket's frames (`gpu` = 0 below API 31). */
  meanStageMs: Record<FrameStage, number>;
  p90TotalMs: number;
  maxTotalMs: number;
  frameIntervalMs: number;
}

export interface Snapshot {
  cpu: CpuSample[];
  memory: MemorySample[];
  frames: FrameSample[];
  logs: LogEntry[];
  events: TimelineEvent[];
  /** Phase 2 streams are optional: older servers omit them (dashboard reads `?? []`). */
  screens?: ScreenSpan[];
  breakdown?: FrameBreakdownSample[];
}

// ---------------------------------------------------------------------------
// Server → dashboard
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; serverVersion: string; bufferWindowMs: number }
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'apps'; serial: string; apps: AppInfo[] }
  | { type: 'session'; session: SessionState }
  /** Sent on connect and when a new session starts: full ring-buffer contents. */
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'cpu'; sample: CpuSample }
  | { type: 'memory'; sample: MemorySample }
  | { type: 'frames'; sample: FrameSample }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'event'; event: TimelineEvent }
  /**
   * Screen span update. If a span with the same `start` exists, replace it (the server re-sends a span with
   * `end` set when it closes on SDK disconnect / session stop). Otherwise it is a new top screen: close the
   * previous open span at `span.start` and append. Snapshots hold the authoritative list.
   */
  | { type: 'screen'; span: ScreenSpan }
  | { type: 'breakdown'; sample: FrameBreakdownSample }
  | { type: 'error'; message: string; code?: string };

export type ServerMessageType = ServerMessage['type'];

/**
 * Control messages are always delivered. Every other server message type is a "live" stream that may be
 * dropped for a slow client, which is then resynced with a `snapshot`. New streams (e.g. Phase 2 SDK data)
 * are therefore droppable by default; only add a type here if losing it would desync the dashboard.
 */
export const CONTROL_SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set([
  'hello',
  'devices',
  'apps',
  'session',
  'snapshot',
  'error',
]);

// ---------------------------------------------------------------------------
// Dashboard → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'refreshDevices' }
  | { type: 'listApps'; serial: string }
  | { type: 'startSession'; serial: string; packageName: string }
  | { type: 'stopSession' };

/** Max accepted size of a dashboard → server frame, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

// ---------------------------------------------------------------------------
// In-app SDK ↔ server (device gateway)
//
// Plain TCP, one JSON object per line (UTF-8, `\n`-terminated), over `adb reverse tcp:8700`. The SDK sends
// `hello` first. All `ts` / `deviceWallMs` values are device wall-clock epoch ms; the server converts them to
// the laptop clock. Golden examples: `protocol/fixtures/device-messages.ndjson` (shared by SDK and server tests).
// ---------------------------------------------------------------------------

export const DEVICE_PROTOCOL_VERSION = 1;
/** Port the SDK connects to on the device (`adb reverse tcp:8700 tcp:<gateway port>`). */
export const DEVICE_LINK_PORT = DEFAULT_DEVICE_GATEWAY_PORT;
/** Max bytes per line from the SDK (a frames batch at 120 Hz × 0.5 s is ~10 KB). */
export const MAX_DEVICE_LINE_BYTES = 64 * 1024;
/** Max frames per `frames` message. */
export const MAX_SDK_FRAMES_PER_BATCH = 256;

/** One frame from `Window.OnFrameMetricsAvailableListener`, durations in ms. */
export interface SdkFrame {
  /** Device wall-clock ms of INTENDED_VSYNC (API 26+; callback time below). */
  ts: number;
  totalMs: number;
  inputMs: number;
  animationMs: number;
  layoutMs: number;
  drawMs: number;
  syncMs: number;
  commandMs: number;
  swapMs: number;
  delayMs: number;
  /** GPU_DURATION (API 31+), else null. */
  gpuMs: number | null;
  /** DEADLINE (API 31+), else null. */
  deadlineMs: number | null;
  /** FIRST_DRAW_FRAME: first frame of a window (layout-heavy by nature). */
  firstDraw: boolean;
}

export type DeviceMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      sdkVersion: string;
      packageName: string;
      processName: string;
      pid: number;
      apiLevel: number;
      deviceWallMs: number;
      refreshRateHz: number;
    }
  /** The top screen changed; `screen: null` when the app went to background. */
  | { type: 'screen'; ts: number; screen: ScreenRef | null }
  | {
      type: 'frames';
      window: string;
      intervalMs: number;
      frames: SdkFrame[];
      /** Frames FrameMetrics dropped before the SDK saw them (`dropCountSinceLastInvocation`); absent = 0. */
      droppedFrames?: number;
    }
  | { type: 'heartbeat'; ts: number; droppedMessages: number };

export type DeviceMessageType = DeviceMessage['type'];

/** Server → SDK. */
export type GatewayMessage =
  | { type: 'welcome'; protocolVersion: number }
  /** The server will close the connection; the SDK retries with backoff. */
  | { type: 'bye'; reason: 'no_session' | 'package_mismatch' | 'protocol_error' | 'too_many_connections' };

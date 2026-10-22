/**
 * Lionscope wire contract: constants, identifier rules and message types.
 *
 * Dependency-free on purpose so the dashboard can import it without bundling zod (zod probes
 * `new Function` at load time, which a strict CSP reports as a violation). Runtime validation of
 * dashboard → server messages lives in `./index.ts`.
 */

/** Dashboard ↔ server. They ship together; a cached dashboard of another version shows a mismatch banner. */
export const PROTOCOL_VERSION = 2;

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
  /** Negotiated device protocol version of the live link (null when not connected); absent on older servers. */
  protocolVersion?: number | null;
  /** SDK options for this session (applied to protocol ≥ 2 links); absent on older servers. */
  options?: SdkOptions;
}

/** Per-session SDK options, set from the dashboard (`setSdkOptions`) and pushed to the SDK as `config`. */
export interface SdkOptions {
  /** Main-thread watchdog threshold: a block at least this long is reported as a stall. One of STALL_THRESHOLDS_MS. */
  stallThresholdMs: number;
  /** StrictMode thread/VM violation reporting (off by default; it changes the app's StrictMode policies). */
  strictMode: boolean;
}

export const STALL_THRESHOLDS_MS = [100, 150, 250, 500, 1000] as const;
export const DEFAULT_SDK_OPTIONS: SdkOptions = { stallThresholdMs: 150, strictMode: false };

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

/** One stack frame as captured on the device (`StackTraceElement`). */
export interface StackFrame {
  className: string;
  method: string;
  /** Source file name (e.g. `HomeViewModel.kt`), null when unknown. */
  file: string | null;
  /** Line number; null when unknown; -2 for native methods (as in `StackTraceElement`). */
  line: number | null;
  /** The frame belongs to the app (same ownership rule as screens: Activity / applicationId package root). */
  inApp: boolean;
}

/** Max frames per captured stack (innermost first); longer stacks are cut and flagged `truncated`. */
export const MAX_STACK_FRAMES = 64;

/** A main-thread block detected by the SDK watchdog (laptop clock). */
export interface StallSample {
  /** Start of the block (when the watchdog's tick was posted). */
  ts: number;
  durationMs: number;
  /** Representative main-thread stack (the most frequent of the samples taken while blocked), innermost first. */
  frames: StackFrame[];
  /** How many stack samples were taken while blocked. */
  samples: number;
  truncated: boolean;
  /** Top screen name when the block started (SDK's view), null if unknown/background. */
  screen: string | null;
  /** A debugger was attached (blocks are likely breakpoints, not app work). */
  debugger: boolean;
}

export type StrictModePolicy = 'thread' | 'vm';

/** StrictMode violation(s) reported by the SDK, coalesced per stack (laptop clock). */
export interface StrictModeSample {
  ts: number;
  policy: StrictModePolicy;
  /** Violation class simple name, e.g. `DiskReadViolation`, `NetworkViolation`, `LeakedClosableViolation`. */
  violation: string;
  message: string | null;
  frames: StackFrame[];
  /** Occurrences of this violation+stack coalesced into this sample. */
  count: number;
  screen: string | null;
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
  /** Phase 3 streams, optional like the Phase 2 ones. */
  stalls?: StallSample[];
  strictMode?: StrictModeSample[];
}

// ---------------------------------------------------------------------------
// Emulators (0.3.0): boot AVDs headless, mirror and operate them in the dashboard
//
// The server talks to each emulator over its own gRPC endpoint (EmulatorController), found through the
// emulator's discovery file (`pid_<pid>.ini`: `port.serial`, `grpc.port`, `grpc.token`). The token never
// leaves the server. Physical devices (0.3.1) are mirrored through scrcpy-server instead (`server/src/scrcpy`).
// ---------------------------------------------------------------------------

/**
 * AVD ids as `emulator -list-avds` prints them (`Pixel_9a`). Validated: they end up in emulator arguments, so a
 * leading `-` (which would read as a flag) is refused. The server also requires the name to be listed.
 */
export const AVD_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/;

export function isValidAvdName(value: string): boolean {
  return AVD_NAME_PATTERN.test(value);
}

/** `quick` loads the Quick Boot snapshot and saves it on shutdown; `cold` boots from scratch (`-no-snapshot-load`). */
export type BootMode = 'quick' | 'cold';

export type EmulatorState = 'off' | 'booting' | 'running' | 'shutting_down';

/**
 * How the emulator renders. `software` (SwiftShader / lavapipe, e.g. `-no-window` without `-gpu host`) burns host
 * CPU and makes frame times meaningless, so the dashboard warns. `unknown` until the server has checked.
 */
export type EmulatorRenderer = 'host' | 'software' | 'unknown';

export interface EmulatorInfo {
  avdName: string;
  /** `avd.ini.displayname` (`Pixel 9a`) when the AVD config has one. */
  displayName: string | null;
  state: EmulatorState;
  /** adb serial (`emulator-5554`) while it runs; null when off or before adb sees it. */
  serial: string | null;
  /**
   * Booted by this server: shut down when the server stops. Any running emulator can be shut down from the
   * dashboard; one this server did not boot (Android Studio, a terminal) needs `confirmUnmanaged`.
   */
  managed: boolean;
  /** gRPC endpoint and token found: the screen can be mirrored and operated. */
  canMirror: boolean;
  renderer: EmulatorRenderer;
}

/** Screen mirror WebSocket on the dashboard HTTP server: `/ws/screen?serial=<serial>&size=<SCREEN_SIZES>`. */
export const SCREEN_WS_PATH = '/ws/screen';

/** Frame size presets: pixels along the screen's SHORT edge (aspect ratio kept, also in landscape). */
export const SCREEN_SIZES = [360, 540, 720] as const;
export type ScreenSize = (typeof SCREEN_SIZES)[number];
export const DEFAULT_SCREEN_SIZE: ScreenSize = 540;

/** The emulator accepts up to 10 concurrent touch points. */
export const MAX_TOUCH_POINTS = 10;
export const MAX_SCREEN_TEXT_CHARS = 256;
/** W3C `KeyboardEvent.key` values are short (`a`, `Enter`, `ArrowLeft`, `GoBack`). */
export const MAX_SCREEN_KEY_CHARS = 32;
/** Max accepted size of one dashboard → server screen message, in bytes (`clipboard` / `paste` excepted). */
export const MAX_SCREEN_CLIENT_MESSAGE_BYTES = 2048;
/** Clipboard text in either direction, UTF-8 bytes; the socket's frame cap leaves room for the JSON around it. */
export const MAX_SCREEN_CLIPBOARD_BYTES = 32 * 1024;
export const MAX_SCREEN_SOCKET_FRAME_BYTES = MAX_SCREEN_CLIPBOARD_BYTES + 1024;
/** Input messages per second per screen socket before the server drops them (touch moves come at ~60–120/s). */
export const MAX_SCREEN_INPUT_PER_SECOND = 400;

/**
 * Binary server → dashboard messages on the screen socket: one kind byte, then the payload.
 * - `frame` (emulators): a live, scaled PNG frame.
 * - `screenshot`: the full-resolution PNG answering a `screenshot` request (emulators and physical devices).
 * - `video` (physical devices, 0.3.1): one H.264 access unit, see SCREEN_VIDEO_HEADER_BYTES.
 */
export const SCREEN_BINARY_KIND = { frame: 1, screenshot: 2, video: 3 } as const;

/**
 * `video` messages: kind byte, then a flags byte (SCREEN_VIDEO_FLAG), then the PTS in microseconds as a
 * big-endian float64 (0 for config packets), then the H.264 Annex B payload (start codes included). Config
 * packets carry SPS/PPS: the dashboard (re)configures its decoder from them; a key frame always follows one.
 */
export const SCREEN_VIDEO_HEADER_BYTES = 1 + 1 + 8;
export const SCREEN_VIDEO_FLAG = { config: 1, key: 2 } as const;

/** How a screen socket delivers pixels: PNG frames (emulator gRPC) or an H.264 stream (scrcpy on a device). */
export type ScreenCodec = 'png' | 'h264';

/** Degrees clockwise from the display's natural (portrait) orientation, as the frame is shown. */
export type ScreenRotation = 0 | 90 | 180 | 270;

export type ScreenErrorCode =
  /**
   * The serial can't be mirrored: not an adb device in the `device` state (offline, unauthorized, gone), or an
   * emulator without gRPC (see `unavailable`). The name predates physical-device mirroring (0.3.1).
   */
  | 'not_emulator'
  /** A physical device: the mirroring server (scrcpy) could not be started; `message` says why. */
  | 'mirror_failed'
  /**
   * A physical device refused input injection (screen mirroring still works). On Xiaomi / HyperOS this needs
   * "USB debugging (Security settings)" turned on in Developer options.
   */
  | 'input_denied'
  /** The emulator has no usable gRPC endpoint or token (too old, or started with `-grpc` without a token). */
  | 'unavailable'
  /** The emulator rejected the token. */
  | 'auth'
  /** The stream ended: emulator shut down, crashed or stopped responding. */
  | 'ended'
  /** Too many open screen sockets. */
  | 'busy';

/** Text server → dashboard messages on the screen socket. */
export type ScreenServerMessage =
  /**
   * Sent before the first frame and again before the first frame after any change. `displayWidth/Height` are
   * the display's natural (unrotated) size in device pixels; `frameWidth/Height` the PNG or video size as
   * delivered (already rotated: a landscape frame is wider than tall). Physical devices rotate by themselves,
   * so their `rotation` follows the device and a new `screenInfo` arrives with each rotation.
   */
  | {
      type: 'screenInfo';
      serial: string;
      codec: ScreenCodec;
      displayWidth: number;
      displayHeight: number;
      rotation: ScreenRotation;
      frameWidth: number;
      frameHeight: number;
    }
  | { type: 'screenError'; code: ScreenErrorCode; message: string }
  /**
   * Text copied inside Android, only while the dashboard has `clipboardSync` on. The emulator's initial
   * clipboard state and echoes of the dashboard's own `clipboard`/`paste` are not forwarded.
   */
  | { type: 'clipboard'; text: string };

/**
 * One touch point in FRAME coordinates normalized to 0..1 (0,0 = top-left of the frame as shown, after
 * rotation). The server maps them to the emulator's native display coordinates (touches are always injected
 * unrotated: verified on emulator 36.6 in REVERSE_LANDSCAPE, frame (x, y) = (H − nativeY, nativeX)).
 * `pressure` 0 lifts the point. `id` 0..MAX_TOUCH_POINTS-1 tracks a finger for the whole gesture.
 */
export interface ScreenTouchPoint {
  id: number;
  x: number;
  y: number;
  pressure: number;
}

export type ScreenNavButton = 'back' | 'home' | 'recents' | 'power';

/** Text dashboard → server messages on the screen socket (JSON, ≤ MAX_SCREEN_CLIENT_MESSAGE_BYTES, or ≤ MAX_SCREEN_SOCKET_FRAME_BYTES for `clipboard` / `paste`). */
export type ScreenClientMessage =
  /** Every point currently changing (move/down/up); 1..MAX_TOUCH_POINTS points. */
  | { type: 'touch'; touches: ScreenTouchPoint[] }
  /**
   * Mouse wheel at a frame position; 120 = one notch, positive dy = wheel away from the user (scroll up),
   * |dx|, |dy| ≤ MAX_SCREEN_WHEEL_DELTA (protocol index.ts). AVDs have no mouse device, so the server turns
   * the wheel into a short touch drag at that position (never shorter than the touch slop, so it never taps).
   */
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** A physical key by its W3C `key` value. */
  | { type: 'key'; key: string; eventType: 'keydown' | 'keyup' | 'keypress' }
  /** Typed or pasted text (printable ASCII is reliable; the emulator may drop other characters). */
  | { type: 'text'; text: string }
  | { type: 'nav'; button: ScreenNavButton }
  /** Rotate the virtual device a quarter turn. */
  | { type: 'rotate'; direction: 'left' | 'right' }
  | { type: 'setSize'; size: ScreenSize }
  /** Answered with one SCREEN_BINARY_KIND.screenshot message (full resolution, as shown). */
  | { type: 'screenshot' }
  /**
   * Share clipboard on/off for this socket (default off until the dashboard sends it). While off the server
   * neither forwards Android's clipboard nor accepts `clipboard` messages.
   */
  | { type: 'clipboardSync'; enabled: boolean }
  /** Put desktop text on Android's clipboard (Unicode-safe, ≤ MAX_SCREEN_CLIPBOARD_BYTES); no key is pressed. */
  | { type: 'clipboard'; text: string }
  /** Cmd/Ctrl+V on the screen: put the text on Android's clipboard, then press Paste in the focused field. */
  | { type: 'paste'; text: string }
  /**
   * Physical devices: the dashboard dropped video until the next key frame (decoder reset, backpressure, first
   * key frame lost while configuring). The server asks the encoder for one now (scrcpy RESET_VIDEO), at most
   * a few times per second. Ignored for emulators (PNG frames need none).
   */
  | { type: 'keyFrame' };

// ---------------------------------------------------------------------------
// Server → dashboard
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; serverVersion: string; bufferWindowMs: number }
  | { type: 'devices'; devices: DeviceInfo[] }
  /** Every AVD (off or running) and its state; sent on connect, on refresh and on every state change. */
  | { type: 'emulators'; emulators: EmulatorInfo[] }
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
  | { type: 'stall'; sample: StallSample }
  | { type: 'strictmode'; sample: StrictModeSample }
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
  'emulators',
  'apps',
  'session',
  'snapshot',
  'error',
]);

// ---------------------------------------------------------------------------
// Dashboard → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** Also refreshes the AVD list (`emulators`). */
  | { type: 'refreshDevices' }
  /**
   * Refused with an `error` when the AVD is unknown or already running; if the emulator process later exits
   * unexpectedly (while booting or running) the server sends `error` with code `emulator_exited`.
   */
  | { type: 'bootEmulator'; avdName: string; mode: BootMode }
  /**
   * Shut down a running emulator, after ending a profiling session on it. One this server did not boot is shut
   * down only with `confirmUnmanaged: true` (the dashboard asks the user first), otherwise refused with an
   * `error`. Graceful (gRPC SHUTDOWN, which saves the Quick Boot snapshot unless it was started with
   * -no-snapshot-save), then `adb emu kill` on its serial as a fallback.
   */
  | { type: 'shutdownEmulator'; avdName: string; confirmUnmanaged?: boolean }
  | { type: 'listApps'; serial: string }
  | { type: 'startSession'; serial: string; packageName: string }
  | { type: 'stopSession' }
  /** Change SDK options for the current session (partial). The server answers with an updated `session`. */
  | { type: 'setSdkOptions'; stallThresholdMs?: number; strictMode?: boolean };

/** Max accepted size of a dashboard → server frame, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;

// ---------------------------------------------------------------------------
// In-app SDK ↔ server (device gateway)
//
// Plain TCP, one JSON object per line (UTF-8, `\n`-terminated), over `adb reverse tcp:8700`. The SDK sends
// `hello` first. All `ts` / `deviceWallMs` values are device wall-clock epoch ms; the server converts them to
// the laptop clock. Golden examples: `protocol/fixtures/device-messages.ndjson` (shared by SDK and server tests).
// ---------------------------------------------------------------------------

/**
 * Highest device protocol version this build speaks. The SDK sends its own in `hello`; the server accepts any
 * version from MIN_DEVICE_PROTOCOL_VERSION to MAX_DEVICE_PROTOCOL_VERSION and answers
 * `welcome.protocolVersion = min(sdk, server)`. Both sides only use message types available in the negotiated
 * version, and the server ignores (counts) unknown `type`s instead of closing the link, so from 0.1.1 on, newer
 * SDKs keep working against older servers and vice versa. (A 0.1.0 server rejects any `protocolVersion` other
 * than 1 and closes the link on unknown types.)
 */
export const DEVICE_PROTOCOL_VERSION = 2;
export const MIN_DEVICE_PROTOCOL_VERSION = 1;
/**
 * Message types per negotiated version. v1: hello, screen, frames, heartbeat / welcome, bye.
 * v2 adds SDK → server `stall` and `strictmode`, and server → SDK `config`. Neither side sends a v2 type on a
 * link negotiated at 1.
 */
export const DEVICE_PROTOCOL_V2 = 2;
/**
 * Highest `hello.protocolVersion` the server accepts (and negotiates down). It bounds the field to a plausible
 * range: anything above is garbage, not a future SDK.
 */
export const MAX_DEVICE_PROTOCOL_VERSION = 1000;
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
  | { type: 'heartbeat'; ts: number; droppedMessages: number }
  /** v2. A main-thread block ≥ the configured threshold; sent when the block ends (or is cut at 30 s). */
  | {
      type: 'stall';
      ts: number;
      durationMs: number;
      frames: StackFrame[];
      samples: number;
      truncated: boolean;
      screen: string | null;
      debugger: boolean;
    }
  /** v2. Coalesced StrictMode violation(s) with the same violation + stack, at most one per stack per second. */
  | {
      type: 'strictmode';
      ts: number;
      policy: StrictModePolicy;
      violation: string;
      message: string | null;
      frames: StackFrame[];
      count: number;
      screen: string | null;
    };

export type DeviceMessageType = DeviceMessage['type'];

/**
 * Server → SDK. Contract: each line is a flat JSON object serialised with `type` as its FIRST key and with no
 * nested objects that contain `type` or `protocolVersion` keys, because the SDK reads these lines with a
 * dependency-free top-level scan rather than a full JSON parser. New fields must be appended after `type`.
 */
export type GatewayMessage =
  | { type: 'welcome'; protocolVersion: number }
  /** The server will close the connection; the SDK retries with backoff. */
  | { type: 'bye'; reason: 'no_session' | 'package_mismatch' | 'protocol_error' | 'too_many_connections' }
  /** v2. Current SDK options; sent right after `welcome` and whenever they change. */
  | { type: 'config'; stallThresholdMs: number; strictMode: boolean };

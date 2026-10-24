/**
 * Lionscope wire contract: constants, identifier rules and message types.
 *
 * Dependency-free on purpose so the dashboard can import it without bundling zod (zod probes
 * `new Function` at load time, which a strict CSP reports as a violation). Runtime validation of
 * dashboard → server messages lives in `./index.ts`.
 */

/** Dashboard ↔ server. They ship together; a cached dashboard of another version shows a mismatch banner. */
export const PROTOCOL_VERSION = 8;

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
  /**
   * 0.7.0. Network capture on the live link: `active` (a v7 session link whose welcome carries the link proof, see
   * LINK_KEY_RECEIVER), `needs_sdk` (the SDK is older than device protocol v7), `unverified` (the link key could not
   * be handed to the app, so the SDK keeps capture and mocks off). Null or absent while not connected.
   */
  network?: SdkNetworkState | null;
}

export type SdkNetworkState = 'active' | 'needs_sdk' | 'unverified';

/** Per-session SDK options, set from the dashboard (`setSdkOptions`) and pushed to the SDK as `config`. */
export interface SdkOptions {
  /** Main-thread watchdog threshold: a block at least this long is reported as a stall. One of STALL_THRESHOLDS_MS. */
  stallThresholdMs: number;
  /** StrictMode thread/VM violation reporting (off by default; it changes the app's StrictMode policies). */
  strictMode: boolean;
  /**
   * Layout inflation timing (0.4.0, on by default; Android 10+ only). Turning it off stops recording; the SDK's
   * LayoutInflater factory stays installed on Activities created while it was on (it can't be removed).
   * Absent on older servers / SDK links below device protocol 3 (read as true).
   */
  inflateTracking: boolean;
  /**
   * 0.9.0. RxJava 2 hooks (on by default; device protocol 9): a chained `RxJavaPlugins` schedule handler and
   * subscribe hooks name the Rx chain and the line that subscribed it for each stall (StallRx). Absent on older
   * servers (read as true); the SDK runs them only on a v9 session link with RxJava 2 in the app.
   */
  rxTracking: boolean;
}

export const STALL_THRESHOLDS_MS = [100, 150, 250, 500, 1000] as const;
export const DEFAULT_SDK_OPTIONS: SdkOptions = {
  stallThresholdMs: 150,
  strictMode: false,
  inflateTracking: true,
  rxTracking: true,
};

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

/** `destination`: a navigation-compose destination tracked with `Lionscope.trackNavigation` (device protocol v6). */
export type ScreenKind = 'activity' | 'fragment' | 'dialog' | 'destination';

export interface ScreenRef {
  /**
   * Display name: the app's own screen alias (e.g. `ScreenName.getScreen().value`) or the simple class name; for a
   * navigation destination its route pattern (`product/{id}`) or, for a type-safe route, its class's simple name.
   */
  name: string;
  /** Fully-qualified class name of the Activity / Fragment; a destination's whole route pattern. */
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

/** `stall.outerFrames` keeps at most this many of the stack's outermost frames (device protocol 9). */
export const MAX_OUTER_FRAMES = 16;
/** `StallRx.subscribedAt` keeps at most this many frames of the subscribe call's stack. */
export const MAX_RX_SITE_FRAMES = 8;
/** Longest `StallRx.task` / `consumer` class name and `stall.coroutine` text. */
export const MAX_ORIGIN_TEXT_LENGTH = 200;

/**
 * What the SDK's RxJava 2 hooks (SdkOptions.rxTracking) saw on the main thread during a stall (device protocol 9):
 * the Rx task the main-thread scheduler was running, the chain's final consumer and where the chain was subscribed.
 */
export interface StallRx {
  /** Class of the scheduled task, e.g. `io.reactivex.internal.operators.observable.ObservableObserveOn$ObserveOnObserver`. */
  task: string;
  /** Class of the chain's final consumer (the `subscribe` lambda, or the app's own Observer); null when not found. */
  consumer: string | null;
  /**
   * The stack of the `subscribe` call of the chain's `observeOn` (Rx and SDK frames dropped, innermost first, at most
   * MAX_RX_SITE_FRAMES); empty when it was not captured (subscribed before the session, or over the capture rate).
   */
  subscribedAt: StackFrame[];
}

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
  /**
   * 0.9.0. The outermost frames of the sampled stack (innermost first, at most MAX_OUTER_FRAMES), when `frames` was cut
   * before them: they hold the Looper dispatch the work came from. Absent otherwise and from older SDKs.
   */
  outerFrames?: StackFrame[];
  /** 0.9.0. What the SDK's RxJava hooks saw (absent without RxJava, with `rxTracking` off, or outside Rx work). */
  rx?: StallRx;
  /** 0.9.0. The coroutine on the main thread (`name#id`), when the app runs kotlinx.coroutines debug mode. */
  coroutine?: string;
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

// ---------------------------------------------------------------------------
// Layouts (0.4.0): XML inflation timing and view trees, measured by the SDK
// ---------------------------------------------------------------------------

/**
 * Layout inflations coalesced per (layout, screen, nested) over one SDK flush window (usually ≤ 1 s; windows held
 * at cold start or deferred by the SDK's line budget can span up to 10 s), laptop clock. One inflation = one
 * `LayoutInflater.inflate` of `layout` on the main thread, measured from the first view's creation to the end of
 * the last one (a lower bound: parser setup is not included). A layout inflated inside another one's inflation
 * (an `<include>`, or a compound view's own layout) is reported with `nested: true`; its time and views are also
 * part of the enclosing layout's, so per-screen totals add up `nested: false` samples only.
 */
export interface InflateSample {
  /** Start of the slowest inflation in the window (timeline markers use `ts` + `maxMs`). */
  ts: number;
  /** Layout resource entry name, e.g. `fragment_home`; null when the SDK could not resolve it. */
  layout: string | null;
  /** Fallback label when `layout` is null: `<FirstViewSimpleClassName>:<xml line>` (ASCII), else null. */
  label: string | null;
  /** The layout comes from a library or the framework (`android:` package or a known library prefix like `abc_`). */
  library: boolean;
  /** Inflated inside another layout's inflation (its time and views are already counted in that one). */
  nested: boolean;
  /** Screen whose view was being created when the layout was inflated, else the top screen; null = unknown. */
  screen: string | null;
  /** Inflations of this layout in the window. */
  count: number;
  totalMs: number;
  maxMs: number;
  /** Views created by the slowest inflation (including views of nested includes). */
  views: number;
}

/** Inflations at least this long are drawn as markers on the Main thread lane. */
export const SLOW_INFLATE_MS = 16;

/** One step of `ViewTreeSample.deepestPath`, root first. */
export interface ViewPathNode {
  /** Simple class name, e.g. `ConstraintLayout`. */
  className: string;
  /** View id entry name (`R.id` name without package), null when the view has no id. */
  id: string | null;
}

export const MAX_VIEW_PATH_NODES = 64;
export const MAX_VIEW_TREE_CLASSES = 10;

/** Snapshot of a screen's view hierarchy, taken once per screen visit after its first frame (laptop clock). */
export interface ViewTreeSample {
  ts: number;
  /** Screen on top when the snapshot was taken. */
  screen: string | null;
  /** Window it was taken from: the Activity's simple class name, or `Dialog · <name>` for dialog windows. */
  window: string;
  /** All views in the window's hierarchy, ViewGroups included. */
  views: number;
  viewGroups: number;
  /** Depth of the deepest view (the decor view = 1). */
  maxDepth: number;
  /** The path to the deepest view, root first, at most MAX_VIEW_PATH_NODES (cut at the root end). */
  deepestPath: ViewPathNode[];
  /** Most frequent view classes, at most MAX_VIEW_TREE_CLASSES, most frequent first. */
  topClasses: { className: string; count: number }[];
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
  /** 0.4.0 streams, optional like the Phase 2 ones. */
  inflates?: InflateSample[];
  viewTrees?: ViewTreeSample[];
  /** 0.7.0: the session's HTTP exchanges (summaries, oldest first); details come with `getHttpExchange`. */
  http?: HttpExchange[];
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
// Layout Inspector (0.5.0): a frozen snapshot of the device's view hierarchy, aligned with a screenshot
//
// Source `sdk`: the in-app SDK walks every window of the app (Android 10+), with the XML layout and line each view
// was inflated from and its owning Fragment / Activity, and (0.6.0, device protocol v6) the composables of Compose
// windows with the Kotlin file and line they are called from. Source `uiautomator`: the accessibility tree from
// `uiautomator dump` (apps without the SDK, Compose it cannot read, system UI); no source, owner or layout params.
// ---------------------------------------------------------------------------

export type InspectorSource = 'sdk' | 'uiautomator';
/** [left, top, right, bottom] in device screen pixels (the current rotation). */
export type PixelRect = [number, number, number, number];

export const MAX_INSPECTOR_NODES = 5000;

export interface InspectorWindow {
  /** Index in `InspectorSnapshot.windows`, bottom-most first. */
  id: number;
  /** WindowManager.LayoutParams.type (1 = application, 2 = dialog, …), null when unknown. */
  type: number | null;
  bounds: PixelRect;
}

/**
 * One view (SDK) or accessibility node (uiautomator). Siblings are listed in drawing order: the ViewGroup's custom
 * drawing order when enabled (getChildDrawingOrder), then stably by Z (elevation + translationZ). A later sibling
 * draws over an earlier one, so for overlapping nodes the later one in pre-order is on top.
 */
export interface InspectorNode {
  /** Unique within its snapshot (pre-order index). */
  id: number;
  /** Parent node id, null for a window's root. */
  parent: number | null;
  window: number;
  /** Fully-qualified class (SDK) or the accessibility class name (uiautomator); a composable's name (`Button`). */
  className: string;
  /**
   * Resource id entry name for the app's own ids (`btn_checkout`), `package:id/name` for others, a composable's
   * `testTag`, null if none.
   */
  resourceId: string | null;
  /**
   * TextView text as set (not caps-transformed), or the accessibility text. Password fields (password input types,
   * password transformation, password autofill hints) never send their text or content description; text under a
   * custom transformation is sent as displayed.
   */
  text: string | null;
  contentDescription: string | null;
  /** Unclipped bounds. */
  bounds: PixelRect;
  /** Bounds clipped to its ancestors and the screen; null when nothing of it is on screen. */
  visibleBounds: PixelRect | null;
  visibility: 'visible' | 'invisible' | 'gone';
  alpha: number | null;
  enabled: boolean | null;
  clickable: boolean | null;
  focused: boolean | null;
  selected: boolean | null;
  /** Checkable state: true / false when checkable, null otherwise. */
  checked: boolean | null;
  /** [left, top, right, bottom] px, SDK only. */
  padding: PixelRect | null;
  /** MarginLayoutParams margins [left, top, right, bottom] px, SDK only. */
  margin: PixelRect | null;
  /** `match_parent`, `wrap_content` or `<n>px`, SDK only. */
  layoutWidth: string | null;
  layoutHeight: string | null;
  /**
   * The XML layout this view was inflated from (`fragment_home`) and the line of its tag. `line` is where the start
   * tag ENDS (its `>`), as recorded by aapt2, not the `<Tag` line. Null for views built in code, ViewStubs, views
   * inflated off the main thread or before tracking, and for uiautomator nodes.
   */
  source: { layout: string; line: number } | null;
  /** Owning Fragment / Activity (fully-qualified class), SDK only. */
  fragment: string | null;
  activity: string | null;
  /**
   * 0.6.0 (SDK, device protocol v6). Set on composables only: the Kotlin file the composable is CALLED from
   * (`HomeScreen.kt`, no path) and the 1-based line of that call, null when the compiler recorded none. A composable
   * has its name as `className`, no alpha, padding, margin or layout params, and `source` null. `draws` (when the SDK
   * knows) says whether the composable's own layout node paints anything (a background, border, image, text, a
   * drawBehind…): a full-size `Box` that draws nothing, like an idle toast or snackbar host, is let through when
   * picking on the screen.
   */
  composable?: { file: string | null; line: number | null; draws?: boolean };
  /**
   * 0.6.0 (SDK, v6). Set on AndroidComposeView nodes: `read` when its composables follow as its children, else why
   * not (`disabled`: composed before Lionscope enabled Compose inspection, or the app opted out; `no_source`: built
   * without Compose source information; `failed`: reading threw).
   */
  composition?: 'read' | 'disabled' | 'no_source' | 'failed';
  /** 0.6.0 (SDK, v6). The navigation destination (screen name) the node is drawn for, inherited by its subtree. */
  destination?: string | null;
  /**
   * 0.8.0 (SDK, device protocol v8). Set on the app's own Views (never on composables): what editing it live needs.
   * Without it a node is read-only (uiautomator, composables, SDKs before 0.8.0).
   */
  view?: ViewState;
}

export interface InspectorSnapshot {
  /** Server-assigned id; screenshot at `/inspector/<id>.png` (same origin, served while the snapshot is kept). */
  id: string;
  /** Laptop clock when captured. */
  ts: number;
  serial: string;
  packageName: string | null;
  source: InspectorSource;
  /** Top screen name (SDK's view) when captured, null if unknown. */
  screen: string | null;
  /** Device screen size and rotation (0, 90, 180, 270) the bounds and the screenshot use. */
  display: { width: number; height: number; rotation: number };
  windows: InspectorWindow[];
  nodes: InspectorNode[];
  /** More than MAX_INSPECTOR_NODES nodes: the rest were dropped (deepest-first). */
  truncated: boolean;
  /** Main-thread time the SDK spent capturing, ms (SDK source only). */
  captureMs: number | null;
  /**
   * Why the SDK source was not used, when `source` is `uiautomator` (e.g. `no_sdk`, `old_sdk`). 0.5.2 adds
   * `sdk_linking` (the inspect-only link was just mapped and no SDK connected in time: inspect again),
   * `sdk_needs_session` (an SDK older than device protocol v5 is in the app: it links only during a session) and
   * `sdk_link_busy` (another live Lionscope server holds the device's `adb reverse tcp:8700`). `compose`: a Compose
   * top window the SDK cannot read; 0.6.0 says why with `compose_disabled` / `compose_no_source` / `compose_failed`.
   */
  fallbackReason: string | null;
  /**
   * 0.8.0 (SDK, v8). Live edits in effect in the app's process when captured (on any of its views, also ones not in
   * this snapshot); absent for other snapshots.
   */
  liveEdits?: number;
  /**
   * 0.8.0 (SDK, v8). Why the views of this snapshot can't be edited live although the SDK reads them: the app only
   * takes edits from a link with the link proof (LINK_KEY_RECEIVER). `needs_session`: an inspect-only link (it never
   * gets a proof): Start a session. `unverified`: a session link whose welcome carried no proof (the link key could not
   * be handed to the app). Absent when they can be edited.
   */
  editBlocked?: 'needs_session' | 'unverified';
}

/** The element the user picked in the dashboard's Inspector (shared with AI agents via get_inspector_selection). */
export interface InspectorSelection {
  snapshotId: string;
  nodeId: number;
  /** Laptop clock when selected. */
  ts: number;
  /**
   * Who picked it: `user` (a click in a dashboard) or `agent` (select_inspector_node). An agent's own selection only
   * points at an element: get_inspector_selection then returns its structure (class, id, source, owner, bounds)
   * but not its text, content description or image, so an agent cannot read the screen without device control.
   */
  origin: 'user' | 'agent';
}

// ---------------------------------------------------------------------------
// Network (0.7.0): HTTP exchanges captured by the SDK's OkHttp interceptor, and mock rules
//
// Captured only during a profiling session (device protocol v7 session links). Header values, query parameters and
// form fields with sensitive names are redacted on the device and again by the server (`HTTP_REDACTED`); bodies are
// captured for text types only, up to MAX_HTTP_BODY_BYTES. Everything stays in the server's memory.
// ---------------------------------------------------------------------------

/** One header as sent or received, in order: `[name, value]`. Repeated headers are separate entries. */
export type HttpHeader = [name: string, value: string];

/** What replaces a redacted header value, query parameter value or form field value. */
export const HTTP_REDACTED = '‹redacted›';
/** Max UTF-8 bytes of a captured body's text; longer bodies are cut (`HttpBody.truncated`). */
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_HTTP_URL_CHARS = 4096;
/** Summaries (`http`, snapshots) carry at most this much of the URL, so a snapshot of 5000 stays small. */
export const MAX_HTTP_SUMMARY_URL_CHARS = 1024;
/** An HTTP method token (`GET`, `PROPFIND`, …). */
export const MAX_HTTP_METHOD_CHARS = 16;
/** Headers per request or response side; the SDK keeps the first ones that fit MAX_HTTP_HEADER_BYTES. */
export const MAX_HTTP_HEADERS = 64;
export const MAX_HTTP_HEADER_NAME_CHARS = 256;
export const MAX_HTTP_HEADER_VALUE_CHARS = 4096;
/** UTF-8 bytes of all header names and values of one side. */
export const MAX_HTTP_HEADER_BYTES = 16 * 1024;
export const MAX_HTTP_CONTENT_TYPE_CHARS = 256;
export const MAX_HTTP_ERROR_CHARS = 256;
/** Exchanges the SDK records per second at most (a token bucket with HTTP_EXCHANGE_BURST); the rest are counted. */
export const HTTP_EXCHANGES_PER_SECOND = 20;
export const HTTP_EXCHANGE_BURST = 50;

/**
 * Why a body's text was not captured: `type` (not a text type: binary, multipart, unknown), `streaming` (SSE,
 * WebSocket upgrade, duplex), `encoding` (a Content-Encoding the SDK can't decode, e.g. `br`), `one_shot` (a request
 * body that can be written only once), `error` (reading it for the capture failed; the app's call was unaffected).
 */
export type HttpBodyOmission = 'type' | 'streaming' | 'encoding' | 'one_shot' | 'error';

export interface HttpBody {
  /** Bytes of the body as the app sent or read it (after OkHttp's own gzip decoding); null when unknown. */
  size: number | null;
  /** The Content-Type as sent, null when there is none. */
  contentType: string | null;
  /** The captured text (charset-decoded, gunzipped), null when not captured (see `omitted`). */
  text: string | null;
  /** `text` holds only the start of the body. */
  truncated: boolean;
  omitted: HttpBodyOmission | null;
}

/**
 * Why an exchange failed: `timeout`, `connection` (refused, unreachable, DNS), `canceled`, `io` (any other
 * IOException, or an error thrown by another interceptor); `lost` is set by the server when the SDK link closed
 * before the response.
 */
export interface HttpFailure {
  kind: 'timeout' | 'connection' | 'canceled' | 'io' | 'lost';
  /** The exception's class and message (cut to MAX_HTTP_ERROR_CHARS), null when there is none. */
  message: string | null;
}

export type HttpExchangeState = 'pending' | 'complete' | 'failed';

/** One request and its response, as the list, the timeline and get_network show it (laptop clock). */
export interface HttpExchange {
  /** Server-assigned, increasing, unique for the server's lifetime. */
  id: number;
  /** When the call entered the interceptor. */
  ts: number;
  /** ts + durationMs once it ended, null while pending. */
  endTs: number | null;
  method: string;
  /** Redacted; cut to MAX_HTTP_SUMMARY_URL_CHARS (ending in `…`) here, whole in HttpExchangeDetail. */
  url: string;
  state: HttpExchangeState;
  /** HTTP status, null while pending or when it failed before a response. */
  status: number | null;
  /** Call start → response headers. */
  headersMs: number | null;
  /** Call start → end (body read, streaming headers, or failure), null while pending. */
  durationMs: number | null;
  requestSize: number | null;
  responseSize: number | null;
  /** Response Content-Type. */
  responseType: string | null;
  /** The mock rule that answered it (the network was never asked), null for a real exchange. */
  mockId: string | null;
  error: HttpFailure | null;
  /** Top screen when it started (SDK screens), null when unknown. */
  screen: string | null;
}

/** An exchange with its headers and bodies (`httpExchange`, get_network_request). */
export interface HttpExchangeDetail extends HttpExchange {
  /** The whole (redacted) URL. */
  url: string;
  /** `http/1.1`, `h2`, … as OkHttp names it; null for mocks and failures. */
  protocol: string | null;
  requestHeaders: HttpHeader[];
  responseHeaders: HttpHeader[];
  requestBody: HttpBody | null;
  responseBody: HttpBody | null;
}

export type MockMatch = 'exact' | 'prefix' | 'glob';
/** `respond` answers with the rule's response; the others throw an IOException in the app (no network call). */
export type MockAction = 'respond' | 'timeout' | 'connection_error';

export const MAX_NETWORK_MOCKS = 32;
export const MAX_MOCK_URL_CHARS = 2048;
/** `*` wildcards in a glob pattern at most. */
export const MAX_MOCK_GLOB_STARS = 8;
/** UTF-8 bytes of one rule's body, and of all rules' bodies together. */
export const MAX_MOCK_BODY_BYTES = 256 * 1024;
export const MAX_MOCK_SET_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MOCK_HEADERS = 32;
/** UTF-8 bytes of one rule's header names and values. */
export const MAX_MOCK_HEADER_BYTES = 8 * 1024;
export const MAX_MOCK_DELAY_MS = 30_000;

/** What the dashboard (or set_network_mock) sends to create a rule, or to replace the rule with `id`. */
export interface NetworkMockInput {
  /** Replace this rule; absent = a new rule. */
  id?: string;
  /** An HTTP method token, or null for any method. */
  method: string | null;
  match: MockMatch;
  /**
   * `http(s)://host/path…` (glob: `*` may stand anywhere, `*://` too). Compared with the request URL without its
   * query unless the pattern contains `?`.
   */
  url: string;
  action: MockAction;
  /** 100..599 (`respond` only; ignored otherwise). */
  status: number;
  headers: HttpHeader[];
  /** UTF-8 text (`respond` only). */
  body: string;
  /** Wait this long before answering (or failing), 0..MAX_MOCK_DELAY_MS. */
  delayMs: number;
  enabled: boolean;
}

/** A rule as the server keeps it: normalised (scheme and host lower case, default port dropped). */
export interface NetworkMockRule extends Omit<NetworkMockInput, 'id'> {
  /** `m1`, `m2`, … (server-assigned). */
  id: string;
  /** Who set it: a dashboard user or an AI agent (set_network_mock). */
  origin: 'user' | 'agent';
  /** Laptop clock of its last change (newer wins between otherwise equal rules). */
  updatedAt: number;
}

/** The session's mock rules (`networkMocks`); no session = no rules. */
export interface NetworkMocksState {
  /** In precedence order: the first enabled rule that matches answers. */
  rules: NetworkMockRule[];
  /** Increases with every change. */
  rev: number;
  /** The rev the session's SDK confirmed (`mocksApplied`); null while no v7 SDK link is live. */
  appliedRev: number | null;
}

// ---------------------------------------------------------------------------
// Live view edits (0.8.0): change a View's properties from the Inspector, temporarily
//
// Only Views of an SDK snapshot (device protocol v8) of the app on an SDK link of that app; composables and
// uiautomator nodes are read-only. The SDK applies an edit on the main thread with the platform setter (which may
// run the app's own listeners, e.g. a TextWatcher) and keeps the original value, so it can be reverted. An edit lasts
// until it is reverted, the app sets the property itself (a RecyclerView row rebound) or the view is recreated.
// ---------------------------------------------------------------------------

/** What can be edited, in this order everywhere (`ViewState.edited`). Padding and margins are set side by side. */
export const VIEW_PROPERTIES = [
  'visibility',
  'alpha',
  'enabled',
  'paddingLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'marginLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'layoutWidth',
  'layoutHeight',
  'translationX',
  'translationY',
  'elevation',
  'backgroundColor',
  'text',
  'textSize',
  'textColor',
] as const;
export type ViewProperty = (typeof VIEW_PROPERTIES)[number];
/** Names a revert may use for the four sides of padding or margins at once. */
export const VIEW_PROPERTY_GROUPS = {
  padding: ['paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom'],
  margin: ['marginLeft', 'marginTop', 'marginRight', 'marginBottom'],
} as const satisfies Record<string, readonly ViewProperty[]>;
export type ViewPropertyGroup = keyof typeof VIEW_PROPERTY_GROUPS;
/**
 * A property's value on the wire: `visibility` `visible` | `invisible` | `gone`; `alpha` 0-1; `enabled` a boolean;
 * padding (px) 0..MAX_EDIT_PADDING_PX and margins (px) ±MAX_EDIT_MARGIN_PX, integers; `layoutWidth` / `layoutHeight`
 * `match_parent`, `wrap_content` or `<n>px` (0..MAX_EDIT_SIZE_PX); `translationX` / `translationY` (px)
 * ±MAX_EDIT_TRANSLATION_PX; `elevation` (px) 0..MAX_EDIT_ELEVATION_PX; colors `#AARRGGBB` (a solid color); `text` at
 * most MAX_EDIT_TEXT_CHARS UTF-16 units, no control characters but line breaks and tabs, no format characters but
 * the joiners; `textSize` (sp)
 * MIN_EDIT_TEXT_SIZE_SP..MAX_EDIT_TEXT_SIZE_SP.
 */
export type ViewPropertyValue = string | number | boolean;

export const MAX_EDIT_PADDING_PX = 2000;
export const MAX_EDIT_MARGIN_PX = 2000;
export const MAX_EDIT_SIZE_PX = 10_000;
export const MAX_EDIT_TRANSLATION_PX = 10_000;
export const MAX_EDIT_ELEVATION_PX = 1000;
export const MIN_EDIT_TEXT_SIZE_SP = 1;
export const MAX_EDIT_TEXT_SIZE_SP = 200;
export const MAX_EDIT_TEXT_CHARS = 500;
/** Live edits an app's process keeps at most (one per view and property); a further one is refused (`limit`). */
export const MAX_LIVE_EDITS = 256;
/** Edits (and reverts) per device: a burst, then this many per second, from every dashboard and agent together. */
export const VIEW_EDIT_BURST = 10;
export const VIEW_EDITS_PER_SECOND = 5;
/** The server gives up on an SDK's answer to an edit after this long. */
export const VIEW_EDIT_TIMEOUT_MS = 3000;

/** 0.8.0 (SDK, v8). The editable state of one View in a snapshot (`InspectorNode.view`). */
export interface ViewState {
  /**
   * The SDK's id of this View object in its app's process: the same in every snapshot while the object lives, never
   * given to another one. Edits name the view by it.
   */
  key: number;
  /** px */
  translationX: number;
  translationY: number;
  elevation: number;
  /** `#AARRGGBB` when the background is a single color (a ColorDrawable), else null (none, an image, a shape). */
  backgroundColor: string | null;
  /** TextView only (else null): its text size in sp and its current text color (`#AARRGGBB`). */
  textSize: number | null;
  textColor: string | null;
  /** A password field: its text is never sent, read or set (its size and color may be). */
  password: boolean;
  /** Properties changed live and in effect (not reverted, not set by the app since), VIEW_PROPERTIES order. */
  edited?: ViewProperty[];
}

/**
 * Why an edit was refused or failed. `stale`: the snapshot is not the current one, or the view is not in the app's
 * latest capture (recreated, removed): inspect again. `not_editable`: not an SDK View, or the property does not apply
 * to it (margins without MarginLayoutParams, text on a non-TextView, layout size of a window root). `password`: the
 * text of a password field. `invalid_value`: out of bounds or malformed. `old_sdk`: the app's SDK is older than 0.8.0.
 * `no_link`: the app's SDK link is gone. `rate_limited`: too many edits on the device. `limit`: MAX_LIVE_EDITS are in
 * effect: revert some. `timeout`: the SDK did not answer. `failed`: the setter threw, or anything else.
 * `unauthenticated`: the app's SDK link has no link proof (InspectorSnapshot.editBlocked): edits need a profiling
 * session whose link proof checked out.
 */
export type ViewEditError =
  | 'stale'
  | 'not_editable'
  | 'password'
  | 'invalid_value'
  | 'old_sdk'
  | 'no_link'
  | 'rate_limited'
  | 'limit'
  | 'timeout'
  | 'failed'
  | 'unauthenticated';

/** Integer px within ±max (or 0..max when `negative` is false). */
function isPixels(value: ViewPropertyValue, max: number, negative: boolean): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value <= max && value >= (negative ? -max : 0)
  );
}

function isFiniteIn(value: ViewPropertyValue, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LAYOUT_PX = /^(\d{1,5})px$/;
/**
 * Control characters (C0, DEL, C1) other than tab and line feed, format characters (Cf: bidi embeddings, overrides and
 * isolates, zero-width spaces, soft hyphens... they can make text read differently than it is stored, and edited
 * text flows back into snapshots agents read) other than the joiners ZWNJ and ZWJ (emoji and many scripts need
 * them), and lone surrogates.
 */
const BAD_EDIT_TEXT = /[^\P{Cc}\t\n]|[^\P{Cf}\u200c\u200d]|\p{Cs}/u;

/** `#RRGGBB` / `#AARRGGBB` (any case) as `#AARRGGBB` upper case; null when it is not a hex color. */
export function normalizeColor(value: string): string | null {
  if (!HEX_COLOR.test(value)) return null;
  const digits = value.slice(1).toUpperCase();
  return `#${digits.length === 6 ? `FF${digits}` : digits}`;
}

/**
 * `value` as the wire carries it for `property` (a color as `#AARRGGBB`, a layout size given as a number as `<n>px`),
 * or null when it is not a valid value of that property. The server checks every edit with this, the SDK again.
 */
export function normalizeViewValue(
  property: ViewProperty,
  value: ViewPropertyValue,
): ViewPropertyValue | null {
  switch (property) {
    case 'visibility':
      return value === 'visible' || value === 'invisible' || value === 'gone' ? value : null;
    case 'alpha':
      return isFiniteIn(value, 0, 1) ? value : null;
    case 'enabled':
      return typeof value === 'boolean' ? value : null;
    case 'paddingLeft':
    case 'paddingTop':
    case 'paddingRight':
    case 'paddingBottom':
      return isPixels(value, MAX_EDIT_PADDING_PX, false) ? value : null;
    case 'marginLeft':
    case 'marginTop':
    case 'marginRight':
    case 'marginBottom':
      return isPixels(value, MAX_EDIT_MARGIN_PX, true) ? value : null;
    case 'layoutWidth':
    case 'layoutHeight': {
      if (isPixels(value, MAX_EDIT_SIZE_PX, false)) return `${value}px`;
      if (value === 'match_parent' || value === 'wrap_content') return value;
      const px = typeof value === 'string' ? LAYOUT_PX.exec(value) : null;
      return px && Number(px[1]) <= MAX_EDIT_SIZE_PX ? `${Number(px[1])}px` : null;
    }
    case 'translationX':
    case 'translationY':
      return isFiniteIn(value, -MAX_EDIT_TRANSLATION_PX, MAX_EDIT_TRANSLATION_PX) ? value : null;
    case 'elevation':
      return isFiniteIn(value, 0, MAX_EDIT_ELEVATION_PX) ? value : null;
    case 'backgroundColor':
    case 'textColor':
      return typeof value === 'string' ? normalizeColor(value) : null;
    case 'text':
      return typeof value === 'string' && value.length <= MAX_EDIT_TEXT_CHARS && !BAD_EDIT_TEXT.test(value)
        ? value
        : null;
    case 'textSize':
      return isFiniteIn(value, MIN_EDIT_TEXT_SIZE_SP, MAX_EDIT_TEXT_SIZE_SP) ? value : null;
  }
}

/**
 * The properties `node` can be edited live by (VIEW_PROPERTIES order); none without `view`. Margins need
 * MarginLayoutParams (`margin` set), the layout size layout params and a parent (not a window root), the text ones a
 * TextView, and `text` one that is not a password field.
 */
export function editableProperties(node: InspectorNode): ViewProperty[] {
  const view = node.view;
  if (!view) return [];
  return VIEW_PROPERTIES.filter((property) => {
    switch (property) {
      case 'marginLeft':
      case 'marginTop':
      case 'marginRight':
      case 'marginBottom':
        return node.margin !== null;
      case 'layoutWidth':
      case 'layoutHeight':
        return node.parent !== null && node.layoutWidth !== null && node.layoutHeight !== null;
      case 'text':
        return view.textSize !== null && !view.password;
      case 'textSize':
      case 'textColor':
        return view.textSize !== null;
      default:
        return true;
    }
  });
}

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
  | { type: 'inflate'; sample: InflateSample }
  | { type: 'viewtree'; sample: ViewTreeSample }
  /** 0.5.0. A new Inspector snapshot (answer to `inspect`, from any client); replaces the previous one. */
  | { type: 'inspection'; snapshot: InspectorSnapshot }
  /** 0.5.0. The current Inspector selection changed (null = cleared); sent on connect too. */
  | { type: 'inspectorSelection'; selection: InspectorSelection | null }
  /**
   * 0.7.0. An HTTP exchange started or changed (a response arrived, it failed): upsert by `exchange.id`. A live
   * stream; snapshots hold the authoritative list.
   */
  | { type: 'http'; exchange: HttpExchange }
  /** 0.7.0. Answer to `getHttpExchange` (to that client only); `exchange` null when it is no longer kept. */
  | { type: 'httpExchange'; id: number; exchange: HttpExchangeDetail | null }
  /** 0.7.0. The session's mock rules; sent on connect and on every change (including the SDK's confirmation). */
  | { type: 'networkMocks'; mocks: NetworkMocksState }
  /**
   * 0.8.0. The answer to this client's `setViewProperty` or `revertViewProperties` (`requestId` is the client's own).
   * `liveEdits`: the app's live edits in effect after it (when the SDK answered). After a change a new `inspection`
   * of the device follows on its own, keeping the selection on the same view.
   */
  | {
      type: 'viewEdit';
      requestId: number;
      ok: boolean;
      error?: ViewEditError;
      message?: string;
      liveEdits?: number;
    }
  /** `code` includes `inspect_failed` (with a human-readable message) for a failed `inspect`. */
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
  'inspection',
  'inspectorSelection',
  'httpExchange',
  'networkMocks',
  'viewEdit',
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
  | {
      type: 'setSdkOptions';
      stallThresholdMs?: number;
      strictMode?: boolean;
      inflateTracking?: boolean;
      /** 0.9.0 (dashboard protocol 8). */
      rxTracking?: boolean;
    }
  /**
   * 0.5.0. Capture an Inspector snapshot of `serial`'s screen: from the SDK when the session's app on that device is
   * linked at device protocol ≥ 4 and on top, else from uiautomator. Answered with `inspection` (to every client) or
   * `error` code `inspect_failed`. At most one capture runs per device; a second request joins it.
   */
  | { type: 'inspect'; serial: string }
  /** 0.5.0. Select a node of the current snapshot (null clears). Answered with `inspectorSelection` to every client. */
  | { type: 'selectInspectorNode'; snapshotId: string; nodeId: number | null }
  /**
   * 0.5.2. This dashboard shows the Inspector for `serial` (the Inspector view, or the Inspector tab, while the page is
   * visible); null = it no longer does. While any client focuses a device, and for INSPECT_LINK_LINGER_MS after the
   * last `inspect` of it (from any client or agent), the server keeps an inspect-only SDK link to that device, so
   * Inspect gets the SDK tree without a profiling session. Re-sent on reconnect; the latest per client wins.
   */
  | { type: 'inspectorFocus'; serial: string | null }
  /** 0.7.0. Headers and bodies of one exchange; answered with `httpExchange` to this client. */
  | { type: 'getHttpExchange'; id: number }
  /**
   * 0.7.0. Create a mock rule for the running session, or replace the one with `rule.id`. Refused with an `error`
   * (code `setNetworkMock_failed`) without a session, over MAX_NETWORK_MOCKS or MAX_MOCK_SET_BODY_BYTES, or for an
   * unknown id; answered with the `networkMocks` broadcast. May be up to MAX_MOCK_CLIENT_MESSAGE_BYTES.
   */
  | { type: 'setNetworkMock'; rule: NetworkMockInput }
  /** 0.7.0. Remove one rule (`id`), or every rule (`id` absent). Answered with `networkMocks`. */
  | { type: 'clearNetworkMocks'; id?: string }
  /**
   * 0.8.0. Edit a property of a View of the current snapshot live (`editableProperties`), until it is reverted, the app
   * sets it itself or the view is recreated. `requestId` is the client's own (0..2^31-1), echoed in `viewEdit`.
   */
  | {
      type: 'setViewProperty';
      requestId: number;
      snapshotId: string;
      nodeId: number;
      property: ViewProperty;
      value: ViewPropertyValue;
    }
  /**
   * 0.8.0. Revert live edits of the current snapshot's app: one property (or the four sides of `padding` / `margin`)
   * of the view `nodeId`, every property of it (no `property`), or every edit in the app (no `nodeId`).
   */
  | {
      type: 'revertViewProperties';
      requestId: number;
      snapshotId: string;
      nodeId?: number;
      property?: ViewProperty | ViewPropertyGroup;
    };

/** Max accepted size of a dashboard → server frame, in bytes (`setNetworkMock` excepted). */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
/** `setNetworkMock` frames: a 256 KB body, JSON-escaped, and the rest of the rule. */
export const MAX_MOCK_CLIENT_MESSAGE_BYTES = 1024 * 1024;

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
export const DEVICE_PROTOCOL_VERSION = 9;
export const MIN_DEVICE_PROTOCOL_VERSION = 1;
/**
 * Message types per negotiated version. v1: hello, screen, frames, heartbeat / welcome, bye.
 * v2 adds SDK → server `stall` and `strictmode`, and server → SDK `config`. Neither side sends a v2 type on a
 * link negotiated at 1.
 * v3 adds SDK → server `inflate` and `viewtree`, and the `config.inflateTracking` field (a v2 SDK ignores it).
 * v4 adds server → SDK `inspect` and SDK → server `inspectBegin`, `inspectNodes` and `inspectError`.
 * v5 adds `welcome.mode`: `session` (a profiling session: every collector runs, as before) or `inspect` (an
 * inspect-only link outside a session: the SDK sends only `hello`, `screen` and `heartbeat` and answers `inspect`;
 * no FrameMetrics, watchdog, StrictMode, inflate or view-tree reports, and the server sends no `config`). A missing
 * `mode` means `session` (servers before v5 only link during a session). Links below v5 are never welcomed in
 * `inspect` mode.
 * v6 (0.6.0): Inspector nodes may be composables (`composable`, `destination`) under AndroidComposeView nodes
 * (`composition`), and `screen.kind` may be `destination`, in both modes. Both are SDK → server only; an SDK sends
 * none of it on a link negotiated below 6 (a destination is then a `fragment`).
 * v7 adds the network inspector, on `session` links only: SDK → server `httpRequest`, `httpResponse` and
 * `mocksApplied`, and server → SDK `mocks` and `mock` (a rule set, see GatewayMessage). `httpRequest` /
 * `httpResponse` lines may be up to MAX_HTTP_LINE_BYTES.
 * v8 (0.8.0): live view edits. Inspector View nodes carry `view` (their key and editable state) and `inspectBegin`
 * `liveEdits`; server → SDK `setViewProperty` and `revertViewProperties`, answered by `viewPropertyResult`. The SDK
 * applies edits only on a link with the link proof (a v7+ session link), else it answers `unauthenticated`. Below v8
 * neither side sends any of it.
 * v9 (0.9.0): stall origins. `stall` may carry `outerFrames`, `rx` and `coroutine` (all optional), and `config`
 * carries `rxTracking` (appended last, v9 links only). Below v9 neither side sends them.
 */
export const DEVICE_PROTOCOL_V2 = 2;
export const DEVICE_PROTOCOL_V3 = 3;
export const DEVICE_PROTOCOL_V4 = 4;
export const DEVICE_PROTOCOL_V5 = 5;
export const DEVICE_PROTOCOL_V6 = 6;
export const DEVICE_PROTOCOL_V7 = 7;
export const DEVICE_PROTOCOL_V8 = 8;
export const DEVICE_PROTOCOL_V9 = 9;
/** Max bytes of one `httpRequest` / `httpResponse` line on a v7 link (a 64 KB body, JSON-escaped, and headers). */
export const MAX_HTTP_LINE_BYTES = 256 * 1024;
/** Max bytes of one server → SDK line (a `mock` with a 256 KB body in base64); the SDK skips longer ones. */
export const MAX_GATEWAY_LINE_BYTES = 512 * 1024;
/**
 * v7 link proof. Anything on the phone can listen on 127.0.0.1:8700 while no `adb reverse` maps it, and the SDK can't
 * tell that listener from the server; network capture and mocks therefore need proof that the server is the one
 * adb trusts. Before welcoming a v7 `session` link whose hello carries a `nonce`, the server makes a fresh random
 * key (LINK_KEY_BYTES) and hands it to the app over adb: `am broadcast -n <package>/<LINK_KEY_RECEIVER> --es key
 * <hex> --ei pid <hello.pid>`. The receiver is exported but guarded by `android.permission.DUMP`, which only the
 * shell and the system hold, so no other app can set the key; it keeps the key only when `pid` is its own process.
 * Once the broadcast completed, the welcome carries `proof` = hex(HMAC-SHA256(key, `<nonce>:<protocolVersion>:<mode>`)).
 * The SDK turns capture and mocks on only when the proof matches the key it holds. Frames, screens, stalls, layouts
 * and Inspector trees don't need the proof (as before 0.7.0).
 */
export const LINK_KEY_RECEIVER = 'io.github.risyadul.lionscope.LinkKeyReceiver';
export const LINK_KEY_BYTES = 32;
/** `hello.nonce`: 16 random bytes, lower-case hex. */
export const LINK_NONCE_PATTERN = /^[0-9a-f]{32}$/;
/** `welcome.proof`: an HMAC-SHA256, lower-case hex. */
export const LINK_PROOF_PATTERN = /^[0-9a-f]{64}$/;
/** An inspect-only link stays mapped this long after the last `inspect` of its device (and while a client focuses it). */
export const INSPECT_LINK_LINGER_MS = 5 * 60_000;
/**
 * A fresh inspect-only mapping gets this long for an SDK to connect before `inspect` falls back (`sdk_linking`): it
 * covers the SDK's 1 s / 2 s / 5 s reconnect backoff plus its connect timeout.
 */
export const INSPECT_LINK_WAIT_MS = 6000;
/** Max serialized bytes of one `inspectNodes` line (well under MAX_DEVICE_LINE_BYTES). */
export const MAX_INSPECT_CHUNK_BYTES = 32 * 1024;
/** Max total bytes of one `inspect` answer (all its lines); the SDK sends `inspectError failed` instead of more. */
export const MAX_INSPECT_ANSWER_BYTES = 8 * 1024 * 1024;
/** The server gives up on an `inspect` request after this long without the last chunk. */
export const INSPECT_TIMEOUT_MS = 5000;
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
      /** v7. A fresh random challenge for the link proof (LINK_NONCE_PATTERN); absent from older SDKs. */
      nonce?: string;
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
      /** v9. Sent only when `truncated` cut frames off before them (StallSample.outerFrames). */
      outerFrames?: StackFrame[];
      /** v9 (StallSample.rx). */
      rx?: StallRx;
      /** v9 (StallSample.coroutine). */
      coroutine?: string;
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
    }
  /** v3. Coalesced layout inflations per (layout, screen, nested), at most one per key per flush window. */
  | {
      type: 'inflate';
      ts: number;
      layout: string | null;
      label: string | null;
      library: boolean;
      nested: boolean;
      screen: string | null;
      count: number;
      totalMs: number;
      maxMs: number;
      views: number;
    }
  /** v3. A screen's view hierarchy, once per screen visit after its first frame. */
  | {
      type: 'viewtree';
      ts: number;
      screen: string | null;
      window: string;
      views: number;
      viewGroups: number;
      maxDepth: number;
      deepestPath: ViewPathNode[];
      topClasses: { className: string; count: number }[];
    }
  /**
   * v4. Start of the answer to gateway `inspect` with the same `requestId`: the snapshot was taken on the main thread
   * at `ts`; `nodeCount` nodes follow in `inspectNodes` chunks (seq 0, 1, …; the one with `last: true` ends it).
   * Node ids are pre-order indexes; windows are bottom-most first.
   */
  | {
      type: 'inspectBegin';
      requestId: number;
      ts: number;
      screen: string | null;
      display: { width: number; height: number; rotation: number };
      windows: InspectorWindow[];
      nodeCount: number;
      truncated: boolean;
      captureMs: number;
      /**
       * True when a window holds an AndroidComposeView. On v6 its node says whether its composition was read
       * (`composition`); before, the server prefers uiautomator for a Compose top window.
       */
      compose: boolean;
      /** v8. Live edits in effect in the app's process (InspectorSnapshot.liveEdits). */
      liveEdits?: number;
    }
  /** v4. One chunk of the snapshot's nodes (complete InspectorNode objects, in id order), at most MAX_INSPECT_CHUNK_BYTES per line. */
  | { type: 'inspectNodes'; requestId: number; seq: number; last: boolean; nodes: InspectorNode[] }
  /** v4. The snapshot could not be taken (`background`, `no_window`, `disabled`, `failed`). */
  | { type: 'inspectError'; requestId: number; reason: 'background' | 'no_window' | 'disabled' | 'failed' }
  /**
   * v7. A call entered the SDK's OkHttp interceptor (`ts`); its `httpResponse` with the same `id` follows when it
   * ends. `id` is unique per SDK process. `dropped`: calls not recorded since the previous `httpRequest` (over
   * HTTP_EXCHANGES_PER_SECOND). `mockId`: the rule that answers it. Redacted on the device.
   */
  | {
      type: 'httpRequest';
      id: number;
      ts: number;
      method: string;
      url: string;
      headers: HttpHeader[];
      body: HttpBody | null;
      mockId: string | null;
      dropped: number;
    }
  /**
   * v7. The call ended at `ts`: its response body was read to the end or closed, or (bodiless, streaming) its
   * headers arrived, or it failed (`error`, `status` null when no response came). Durations are from the call's
   * start, on a monotonic clock.
   */
  | {
      type: 'httpResponse';
      id: number;
      ts: number;
      status: number | null;
      protocol: string | null;
      headers: HttpHeader[];
      body: HttpBody | null;
      headersMs: number | null;
      durationMs: number;
      error: { kind: 'timeout' | 'connection' | 'canceled' | 'io'; message: string | null } | null;
    }
  /** v7. The mock rule set `rev` (with `count` rules) is now the active one. */
  | { type: 'mocksApplied'; rev: number; count: number }
  /**
   * v8. The answer to `setViewProperty` / `revertViewProperties` with the same `requestId`; `liveEdits` is the
   * number in effect after it. Errors: `stale` (no view with that key in the latest capture, or it is no longer
   * attached), `unsupported` (the property does not apply to that view), `password`, `invalid` (a value out of
   * bounds), `limit` (MAX_LIVE_EDITS in effect), `failed` (the setter threw), `disabled` (no editor in this SDK),
   * `busy` (a flood of requests: past the SDK's own rate limit or queue, nothing was done), `unauthenticated` (the
   * link has no link proof: an inspect-only link, or a session whose link key could not be handed over).
   */
  | {
      type: 'viewPropertyResult';
      requestId: number;
      ok: boolean;
      error?:
        | 'stale'
        | 'unsupported'
        | 'password'
        | 'invalid'
        | 'limit'
        | 'failed'
        | 'disabled'
        | 'busy'
        | 'unauthenticated';
      liveEdits: number;
    };

export type DeviceMessageType = DeviceMessage['type'];

/**
 * Server → SDK. Contract: each line is a flat JSON object serialised with `type` as its FIRST key and with no
 * nested objects that contain `type` or `protocolVersion` keys, because the SDK reads these lines with a
 * dependency-free top-level scan rather than a full JSON parser. New fields must be appended after `type`. The v7
 * `mocks` / `mock` lines and the v8 edit lines are flat objects of strings, numbers and booleans only (their strings
 * may hold any text, JSON-escaped), read whole by the SDK's flat-object parser; golden lines:
 * `protocol/fixtures/gateway-messages.ndjson`, reproduced byte for byte by the server. Lines are at most
 * MAX_GATEWAY_LINE_BYTES.
 */
export type GatewayMessage =
  /** v5 adds `mode` (sent on v5 links only; absent = `session`). */
  | {
      type: 'welcome';
      protocolVersion: number;
      mode?: 'session' | 'inspect';
      /** v7 session links: the link proof over the hello's nonce (LINK_KEY_RECEIVER); absent when no key was handed over. */
      proof?: string;
    }
  /** The server will close the connection; the SDK retries with backoff. */
  | { type: 'bye'; reason: 'no_session' | 'package_mismatch' | 'protocol_error' | 'too_many_connections' }
  /** v2. Current SDK options; sent right after `welcome` and whenever they change. */
  | {
      type: 'config';
      stallThresholdMs: number;
      strictMode: boolean;
      inflateTracking: boolean;
      /** v9 links only, last. */
      rxTracking?: boolean;
    }
  /** v4. Take an Inspector snapshot of the app's windows now; answered with `inspectBegin`/`inspectNodes` or `inspectError`. */
  | { type: 'inspect'; requestId: number }
  /**
   * v7 (session links). A complete mock rule set follows: `count` `mock` lines with this `rev` (index 0..count-1,
   * in precedence order: the first enabled match answers). It replaces the active set once all arrived (count 0:
   * at once); a newer `mocks` discards a set still arriving. Answered with `mocksApplied`.
   */
  | { type: 'mocks'; rev: number; count: number }
  /**
   * v7. One rule of set `rev`, flat for the SDK's scan: `method` `*` = any; `action` `respond` uses `status`,
   * `headers` (`Name: value` lines joined by `\n`) and `bodyBase64` (the UTF-8 body); `timeout` /
   * `connection_error` send status 0 and empty headers and body. See NetworkMockInput for the matching rules.
   */
  | {
      type: 'mock';
      rev: number;
      index: number;
      id: string;
      method: string;
      match: MockMatch;
      url: string;
      action: MockAction;
      status: number;
      headers: string;
      bodyBase64: string;
      delayMs: number;
    }
  /**
   * v8. Set `property` of the view whose `ViewState.key` is `viewKey` (one of the latest capture) to `value`
   * (normalizeViewValue); answered with `viewPropertyResult`. `value` is a string, number or boolean, never an object.
   */
  | {
      type: 'setViewProperty';
      requestId: number;
      viewKey: number;
      property: ViewProperty;
      value: ViewPropertyValue;
    }
  /** v8. Revert live edits: `property` (or a group) of `viewKey`, all of `viewKey`, or all (neither); `viewPropertyResult`. */
  | {
      type: 'revertViewProperties';
      requestId: number;
      viewKey?: number;
      property?: ViewProperty | ViewPropertyGroup;
    };

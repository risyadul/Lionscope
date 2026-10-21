/**
 * Lionscope wire protocol shared by the server and the dashboard.
 *
 * Server → dashboard messages are trusted (same origin, typed only).
 * Dashboard → server messages are untrusted input and MUST be parsed with `parseClientMessage`; lines from the
 * in-app SDK (device gateway) likewise with `parseDeviceMessage`.
 *
 * The dashboard imports `@lionscope/protocol/wire` instead, which has no zod dependency.
 */
import { z } from 'zod';
import {
  AVD_NAME_PATTERN,
  DEVICE_PROTOCOL_V2,
  DEVICE_PROTOCOL_VERSION,
  isValidPackageName,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_DEVICE_PROTOCOL_VERSION,
  MAX_SCREEN_CLIENT_MESSAGE_BYTES,
  MAX_SCREEN_CLIPBOARD_BYTES,
  MAX_SCREEN_KEY_CHARS,
  MAX_SCREEN_SOCKET_FRAME_BYTES,
  MAX_SCREEN_TEXT_CHARS,
  MAX_SDK_FRAMES_PER_BATCH,
  MAX_STACK_FRAMES,
  MAX_TOUCH_POINTS,
  MIN_DEVICE_PROTOCOL_VERSION,
  PACKAGE_NAME_PATTERN,
  SCREEN_SIZES,
  SERIAL_PATTERN,
  STALL_THRESHOLDS_MS,
  type ClientMessage,
  type DeviceMessage,
  type DeviceMessageType,
  type ScreenClientMessage,
} from './wire.ts';

export * from './wire.ts';

export const serialSchema = z.string().regex(SERIAL_PATTERN, 'invalid adb serial');
export const packageNameSchema = z.string().max(255).regex(PACKAGE_NAME_PATTERN, 'invalid package name');
export const avdNameSchema = z.string().regex(AVD_NAME_PATTERN, 'invalid AVD name');

// ---------------------------------------------------------------------------
// Dashboard → server (validated)
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refreshDevices') }).strict(),
  z
    .object({ type: z.literal('bootEmulator'), avdName: avdNameSchema, mode: z.enum(['quick', 'cold']) })
    .strict(),
  z.object({ type: z.literal('shutdownEmulator'), avdName: avdNameSchema }).strict(),
  z.object({ type: z.literal('listApps'), serial: serialSchema }).strict(),
  z
    .object({ type: z.literal('startSession'), serial: serialSchema, packageName: packageNameSchema })
    .strict(),
  z.object({ type: z.literal('stopSession') }).strict(),
  z
    .object({
      type: z.literal('setSdkOptions'),
      stallThresholdMs: z.literal(STALL_THRESHOLDS_MS).optional(),
      strictMode: z.boolean().optional(),
    })
    .strict()
    .refine(
      (message) => message.stallThresholdMs !== undefined || message.strictMode !== undefined,
      'no SDK option given',
    ),
]) satisfies z.ZodType<ClientMessage>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const utf8 = new TextEncoder();

function readJson(raw: string, maxBytes: number): ParseResult<unknown> {
  // Cheap pre-check (a UTF-16 unit encodes to at least one byte), then the real UTF-8 size.
  if (raw.length > maxBytes || utf8.encode(raw).length > maxBytes) {
    return { ok: false, error: 'message too large' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
}

function validate<T>(json: unknown, schema: z.ZodType<T>): ParseResult<T> {
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, value: result.data };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = readJson(raw, MAX_CLIENT_MESSAGE_BYTES);
  return json.ok ? validate(json.value, clientMessageSchema) : json;
}

// ---------------------------------------------------------------------------
// Dashboard → server on the screen socket (validated)
// ---------------------------------------------------------------------------

/**
 * Largest accepted `wheel` dx / dy per message (wire.ts ScreenClientMessage): 100 notches of 120. The server turns
 * the wheel into a touch drag of limited length, so larger values would not scroll further anyway.
 */
export const MAX_SCREEN_WHEEL_DELTA = 12_000;
/** Control (Cc) and format (Cf) characters, except tab and newline in typed or pasted text. */
const KEY_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
const TEXT_FORBIDDEN = /[^\P{Cc}\t\n]|\p{Cf}/u;

// z.number() already rejects NaN and ±Infinity.
const unitInterval = z.number().min(0).max(1);
const wheelDelta = z.number().min(-MAX_SCREEN_WHEEL_DELTA).max(MAX_SCREEN_WHEEL_DELTA);

/** Clipboard text: any Unicode (newlines and tabs included) up to MAX_SCREEN_CLIPBOARD_BYTES in UTF-8, no NUL. */
const clipboardText = z
  .string()
  .min(1)
  .max(MAX_SCREEN_CLIPBOARD_BYTES)
  .refine((text) => !text.includes('\u0000'), 'NUL character')
  .refine((text) => utf8.encode(text).length <= MAX_SCREEN_CLIPBOARD_BYTES, 'clipboard text too large');

const touchPointSchema = z
  .object({
    id: z
      .number()
      .int()
      .min(0)
      .max(MAX_TOUCH_POINTS - 1),
    x: unitInterval,
    y: unitInterval,
    pressure: unitInterval,
  })
  .strict();

export const screenClientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('touch'),
      touches: z
        .array(touchPointSchema)
        .min(1)
        .max(MAX_TOUCH_POINTS)
        .refine(
          (touches) => new Set(touches.map((touch) => touch.id)).size === touches.length,
          'duplicate id',
        ),
    })
    .strict(),
  z
    .object({ type: z.literal('wheel'), x: unitInterval, y: unitInterval, dx: wheelDelta, dy: wheelDelta })
    .strict(),
  z
    .object({
      type: z.literal('key'),
      key: z
        .string()
        .min(1)
        .max(MAX_SCREEN_KEY_CHARS)
        .refine((key) => !KEY_FORBIDDEN.test(key), 'control or format character'),
      eventType: z.enum(['keydown', 'keyup', 'keypress']),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      text: z
        .string()
        .min(1)
        .max(MAX_SCREEN_TEXT_CHARS)
        .refine((text) => !TEXT_FORBIDDEN.test(text), 'control or format character'),
    })
    .strict(),
  z.object({ type: z.literal('nav'), button: z.enum(['back', 'home', 'recents', 'power']) }).strict(),
  z.object({ type: z.literal('rotate'), direction: z.enum(['left', 'right']) }).strict(),
  z.object({ type: z.literal('setSize'), size: z.literal(SCREEN_SIZES) }).strict(),
  z.object({ type: z.literal('screenshot') }).strict(),
  z.object({ type: z.literal('clipboardSync'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('clipboard'), text: clipboardText }).strict(),
  z.object({ type: z.literal('paste'), text: clipboardText }).strict(),
]) satisfies z.ZodType<ScreenClientMessage>;

/** Only these may use the socket's larger frame; every other message keeps MAX_SCREEN_CLIENT_MESSAGE_BYTES. */
const CLIPBOARD_MESSAGE_TYPES: ReadonlySet<string> = new Set(['clipboard', 'paste']);

export function parseScreenClientMessage(raw: string): ParseResult<ScreenClientMessage> {
  const json = readJson(raw, MAX_SCREEN_SOCKET_FRAME_BYTES);
  if (!json.ok) return json;
  const type: unknown =
    typeof json.value === 'object' && json.value !== null && Reflect.get(json.value, 'type');
  const isClipboard = typeof type === 'string' && CLIPBOARD_MESSAGE_TYPES.has(type);
  if (!isClipboard && utf8.encode(raw).length > MAX_SCREEN_CLIENT_MESSAGE_BYTES) {
    return { ok: false, error: 'message too large' };
  }
  return validate(json.value, screenClientMessageSchema);
}

// ---------------------------------------------------------------------------
// In-app SDK → server (validated; anything on the phone can connect through `adb reverse`)
// ---------------------------------------------------------------------------

export const MAX_SDK_TEXT_LENGTH = 256;
const PROCESS_SUFFIX_PATTERN = /^[A-Za-z0-9_.]{1,128}$/;

/** `com.example.app` or `com.example.app:worker` (a private process of the app). */
export function isValidProcessName(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon === -1) return isValidPackageName(value);
  return isValidPackageName(value.slice(0, colon)) && PROCESS_SUFFIX_PATTERN.test(value.slice(colon + 1));
}

/** Latest representable Date (year 275760): anything beyond is not a wall-clock time. */
export const MAX_EPOCH_MS = 8.64e15;
/** Upper bound of one batch's `droppedFrames` (FrameMetrics' drop count since the last batch). */
export const MAX_SDK_DROPPED_FRAMES = 1_000_000;
/**
 * Wire cap for durations: an hour. Longer is no measurement at all; frames over a minute (e.g. a debugger
 * breakpoint) are valid input that the server drops one by one, so the rest of the batch still counts.
 */
export const MAX_SDK_DURATION_MS = 3_600_000;
/** Control (Cc) and format (Cf) characters, e.g. bidi overrides, never belong in a display name. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

// z.number() already rejects NaN and ±Infinity (e.g. `1e999` in JSON).
const epochMs = z.number().positive().max(MAX_EPOCH_MS);
const durationMs = z.number().nonnegative().max(MAX_SDK_DURATION_MS);
const textOf = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !CONTROL_OR_FORMAT.test(value), 'control or format character');
const text = textOf(MAX_SDK_TEXT_LENGTH);

// Objects strip unknown keys (`.strip()`) instead of rejecting them, so a newer SDK that adds an optional
// field keeps working. Parsed values are fresh objects with known keys only (no `__proto__` carried over).
const screenRefSchema = z
  .object({ name: text, className: text, kind: z.enum(['activity', 'fragment', 'dialog']) })
  .strip();

const sdkFrameSchema = z
  .object({
    ts: epochMs,
    totalMs: durationMs,
    inputMs: durationMs,
    animationMs: durationMs,
    layoutMs: durationMs,
    drawMs: durationMs,
    syncMs: durationMs,
    commandMs: durationMs,
    swapMs: durationMs,
    delayMs: durationMs,
    gpuMs: durationMs.nullable(),
    deadlineMs: durationMs.nullable(),
    firstDraw: z.boolean(),
  })
  .strip();

/** Java's `int`: `StackTraceElement.getLineNumber()`. */
const MAX_STACK_LINE = 2_147_483_647;
/** Longest stall the SDK reports (it cuts a block at 30 s; the rest is slack for late delivery). */
export const MAX_STALL_DURATION_MS = 60_000;
/** Upper bounds of a stall's stack sample count and of a coalesced StrictMode violation count. */
export const MAX_STALL_SAMPLES = 10_000;
export const MAX_STRICT_MODE_COUNT = 1_000_000;
/** Runs of control / format characters in diagnostic text become one space (`message`, `violation`). */
const CONTROL_OR_FORMAT_RUNS = /[\p{Cc}\p{Cf}]+/gu;
const sanitized = (value: string): string => value.replace(CONTROL_OR_FORMAT_RUNS, ' ').trim();

const stackFrameSchema = z
  .object({
    className: text,
    method: text,
    file: textOf(128).nullable(),
    // -2 marks a native method; -1 (unknown) is tolerated although the SDK sends null for it.
    line: z.number().int().min(-2).max(MAX_STACK_LINE).nullable(),
    inApp: z.boolean(),
  })
  .strip();

export const deviceMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      // Any version from MIN up: a newer SDK announces its own and the server answers with the lower one.
      protocolVersion: z.number().int().min(MIN_DEVICE_PROTOCOL_VERSION).max(MAX_DEVICE_PROTOCOL_VERSION),
      sdkVersion: textOf(64),
      packageName: packageNameSchema,
      processName: z.string().max(MAX_SDK_TEXT_LENGTH).refine(isValidProcessName, 'invalid process name'),
      pid: z.number().int().positive(),
      apiLevel: z.number().int().positive().max(1000),
      deviceWallMs: epochMs,
      refreshRateHz: z.number().min(1).max(1000),
    })
    .strip(),
  z.object({ type: z.literal('screen'), ts: epochMs, screen: screenRefSchema.nullable() }).strip(),
  z
    .object({
      type: z.literal('frames'),
      window: text,
      intervalMs: z.number().min(1).max(1000),
      frames: z.array(sdkFrameSchema).max(MAX_SDK_FRAMES_PER_BATCH),
      droppedFrames: z.number().int().nonnegative().max(MAX_SDK_DROPPED_FRAMES).optional(),
    })
    .strip(),
  z
    .object({ type: z.literal('heartbeat'), ts: epochMs, droppedMessages: z.number().int().nonnegative() })
    .strip(),
  z
    .object({
      type: z.literal('stall'),
      ts: epochMs,
      durationMs: z.number().nonnegative().max(MAX_STALL_DURATION_MS),
      frames: z.array(stackFrameSchema).max(MAX_STACK_FRAMES),
      samples: z.number().int().min(1).max(MAX_STALL_SAMPLES),
      truncated: z.boolean(),
      screen: text.nullable(),
      debugger: z.boolean(),
    })
    .strip(),
  z
    .object({
      type: z.literal('strictmode'),
      ts: epochMs,
      policy: z.enum(['thread', 'vm']),
      // Free text from the app's StrictMode violation: cleaned up rather than refused. An anonymous violation
      // class has an empty simple name.
      violation: z
        .string()
        .max(128)
        .transform((value) => sanitized(value) || 'Violation'),
      message: z
        .string()
        .max(MAX_SDK_TEXT_LENGTH)
        .transform((value) => sanitized(value) || null)
        .nullable(),
      frames: z.array(stackFrameSchema).max(MAX_STACK_FRAMES),
      count: z.number().int().min(1).max(MAX_STRICT_MODE_COUNT),
      screen: text.nullable(),
    })
    .strip(),
]) satisfies z.ZodType<DeviceMessage>;

/**
 * Diagnostics (v2): a line of these types that fails validation is dropped by the caller (`invalidDiagnostic`),
 * not fatal to the link like a bad v1 message.
 */
const DIAGNOSTIC_TYPES: ReadonlySet<DeviceMessageType> = new Set(['stall', 'strictmode']);

/**
 * Exhaustive over DeviceMessageType: a new message type must be listed here, with the device protocol version
 * that introduced it.
 */
const DEVICE_MESSAGE_VERSIONS: Readonly<Record<DeviceMessageType, number>> = {
  hello: MIN_DEVICE_PROTOCOL_VERSION,
  screen: MIN_DEVICE_PROTOCOL_VERSION,
  frames: MIN_DEVICE_PROTOCOL_VERSION,
  heartbeat: MIN_DEVICE_PROTOCOL_VERSION,
  stall: DEVICE_PROTOCOL_V2,
  strictmode: DEVICE_PROTOCOL_V2,
};

/**
 * Flags of a failed parse; at most one is set:
 * - `unknownType`: a JSON object whose string `type` this build does not know (a newer SDK): skippable.
 * - `unnegotiated`: a known type introduced after the link's negotiated protocol version (`since`): skippable.
 * - `invalidDiagnostic`: a diagnostic (`stall` / `strictmode`) with invalid fields: skippable.
 * - `unsupportedVersion`: a `hello` whose numeric `protocolVersion` is out of range.
 * Anything else that fails (bad JSON, another known type with invalid fields) is a plain error.
 */
export type DeviceParseResult =
  | { ok: true; value: DeviceMessage }
  | {
      ok: false;
      error: string;
      unknownType?: string;
      unnegotiated?: { type: DeviceMessageType; since: number };
      invalidDiagnostic?: DeviceMessageType;
      unsupportedVersion?: number;
    };

function isKnownType(type: string): type is DeviceMessageType {
  return Object.hasOwn(DEVICE_MESSAGE_VERSIONS, type);
}

function isSupportedProtocolVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_DEVICE_PROTOCOL_VERSION &&
    version <= MAX_DEVICE_PROTOCOL_VERSION
  );
}

/**
 * Parse one NDJSON line from the SDK (without its trailing newline). `protocolVersion` is the link's negotiated
 * version: types introduced later are not validated but reported as `unnegotiated`.
 */
export function parseDeviceMessage(
  line: string,
  protocolVersion: number = DEVICE_PROTOCOL_VERSION,
): DeviceParseResult {
  const json = readJson(line, MAX_DEVICE_LINE_BYTES);
  if (!json.ok) return json;
  const object = typeof json.value === 'object' && json.value !== null ? json.value : null;
  const rawType: unknown = object && Reflect.get(object, 'type');
  let type: DeviceMessageType | null = null;
  if (typeof rawType === 'string') {
    if (!isKnownType(rawType)) return { ok: false, error: 'unknown message type', unknownType: rawType };
    type = rawType;
  }
  const since = type === null ? MIN_DEVICE_PROTOCOL_VERSION : DEVICE_MESSAGE_VERSIONS[type];
  if (type !== null && since > protocolVersion) {
    return { ok: false, error: `${type} needs protocol version ${since}`, unnegotiated: { type, since } };
  }
  const version: unknown = object && type === 'hello' ? Reflect.get(object, 'protocolVersion') : undefined;
  if (typeof version === 'number' && !isSupportedProtocolVersion(version)) {
    return { ok: false, error: `unsupported protocol version ${version}`, unsupportedVersion: version };
  }
  const result = validate(json.value, deviceMessageSchema);
  if (!result.ok && type !== null && DIAGNOSTIC_TYPES.has(type))
    return { ...result, invalidDiagnostic: type };
  return result;
}

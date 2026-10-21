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
  isValidPackageName,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_DEVICE_PROTOCOL_VERSION,
  MAX_SDK_FRAMES_PER_BATCH,
  MIN_DEVICE_PROTOCOL_VERSION,
  PACKAGE_NAME_PATTERN,
  SERIAL_PATTERN,
  type ClientMessage,
  type DeviceMessage,
  type DeviceMessageType,
} from './wire.ts';

export * from './wire.ts';

export const serialSchema = z.string().regex(SERIAL_PATTERN, 'invalid adb serial');
export const packageNameSchema = z.string().max(255).regex(PACKAGE_NAME_PATTERN, 'invalid package name');

// ---------------------------------------------------------------------------
// Dashboard → server (validated)
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refreshDevices') }).strict(),
  z.object({ type: z.literal('listApps'), serial: serialSchema }).strict(),
  z
    .object({ type: z.literal('startSession'), serial: serialSchema, packageName: packageNameSchema })
    .strict(),
  z.object({ type: z.literal('stopSession') }).strict(),
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
]) satisfies z.ZodType<DeviceMessage>;

/** Exhaustive over DeviceMessageType: a new message type must be listed here. */
const DEVICE_MESSAGE_TYPES: Readonly<Record<DeviceMessageType, true>> = {
  hello: true,
  screen: true,
  frames: true,
  heartbeat: true,
};

/**
 * `unknownType` is set when the line is a JSON object whose string `type` this build does not know (a newer
 * SDK): the caller may skip it. `unsupportedVersion` is set for a `hello` whose numeric `protocolVersion` is out
 * of range. Anything else that fails (bad JSON, a known type with invalid fields) is a plain error.
 */
export type DeviceParseResult =
  | { ok: true; value: DeviceMessage }
  | { ok: false; error: string; unknownType?: string; unsupportedVersion?: number };

function isSupportedProtocolVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_DEVICE_PROTOCOL_VERSION &&
    version <= MAX_DEVICE_PROTOCOL_VERSION
  );
}

/** Parse one NDJSON line from the SDK (without its trailing newline). */
export function parseDeviceMessage(line: string): DeviceParseResult {
  const json = readJson(line, MAX_DEVICE_LINE_BYTES);
  if (!json.ok) return json;
  const object = typeof json.value === 'object' && json.value !== null ? json.value : null;
  const type: unknown = object && Reflect.get(object, 'type');
  if (typeof type === 'string' && !Object.hasOwn(DEVICE_MESSAGE_TYPES, type)) {
    return { ok: false, error: 'unknown message type', unknownType: type };
  }
  const version: unknown = object && type === 'hello' ? Reflect.get(object, 'protocolVersion') : undefined;
  if (typeof version === 'number' && !isSupportedProtocolVersion(version)) {
    return { ok: false, error: `unsupported protocol version ${version}`, unsupportedVersion: version };
  }
  return validate(json.value, deviceMessageSchema);
}

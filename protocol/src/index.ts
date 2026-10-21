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
  MAX_SDK_FRAMES_PER_BATCH,
  PACKAGE_NAME_PATTERN,
  SERIAL_PATTERN,
  type ClientMessage,
  type DeviceMessage,
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

function parseJson<T>(raw: string, maxBytes: number, schema: z.ZodType<T>): ParseResult<T> {
  // Cheap pre-check (a UTF-16 unit encodes to at least one byte), then the real UTF-8 size.
  if (raw.length > maxBytes || utf8.encode(raw).length > maxBytes) {
    return { ok: false, error: 'message too large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, value: result.data };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseJson(raw, MAX_CLIENT_MESSAGE_BYTES, clientMessageSchema);
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
      protocolVersion: z.number().int().positive(),
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

/** Parse one NDJSON line from the SDK (without its trailing newline). */
export function parseDeviceMessage(line: string): ParseResult<DeviceMessage> {
  return parseJson(line, MAX_DEVICE_LINE_BYTES, deviceMessageSchema);
}

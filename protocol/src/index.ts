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
  DEVICE_PROTOCOL_V3,
  DEVICE_PROTOCOL_V4,
  DEVICE_PROTOCOL_V7,
  DEVICE_PROTOCOL_V8,
  DEVICE_PROTOCOL_VERSION,
  isValidPackageName,
  LINK_NONCE_PATTERN,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_CONTENT_TYPE_CHARS,
  MAX_HTTP_ERROR_CHARS,
  MAX_HTTP_HEADER_BYTES,
  MAX_HTTP_HEADER_NAME_CHARS,
  MAX_HTTP_HEADER_VALUE_CHARS,
  MAX_HTTP_HEADERS,
  MAX_HTTP_LINE_BYTES,
  MAX_HTTP_METHOD_CHARS,
  MAX_HTTP_URL_CHARS,
  MAX_MOCK_BODY_BYTES,
  MAX_MOCK_CLIENT_MESSAGE_BYTES,
  MAX_MOCK_DELAY_MS,
  MAX_MOCK_GLOB_STARS,
  MAX_MOCK_HEADER_BYTES,
  MAX_MOCK_HEADERS,
  MAX_MOCK_URL_CHARS,
  MAX_NETWORK_MOCKS,
  MAX_DEVICE_LINE_BYTES,
  MAX_DEVICE_PROTOCOL_VERSION,
  MAX_EDIT_TEXT_CHARS,
  MAX_INSPECTOR_NODES,
  MAX_LIVE_EDITS,
  MAX_SCREEN_CLIENT_MESSAGE_BYTES,
  MAX_SCREEN_CLIPBOARD_BYTES,
  MAX_SCREEN_KEY_CHARS,
  MAX_SCREEN_SOCKET_FRAME_BYTES,
  MAX_SCREEN_TEXT_CHARS,
  MAX_SDK_FRAMES_PER_BATCH,
  MAX_STACK_FRAMES,
  MAX_VIEW_PATH_NODES,
  MAX_VIEW_TREE_CLASSES,
  MAX_TOUCH_POINTS,
  MIN_DEVICE_PROTOCOL_VERSION,
  normalizeViewValue,
  PACKAGE_NAME_PATTERN,
  SCREEN_SIZES,
  SERIAL_PATTERN,
  STALL_THRESHOLDS_MS,
  VIEW_PROPERTIES,
  VIEW_PROPERTY_GROUPS,
  type ClientMessage,
  type DeviceMessage,
  type DeviceMessageType,
  type HttpBody,
  type HttpHeader,
  type InspectorNode,
  type InspectorWindow,
  type NetworkMockInput,
  type ScreenClientMessage,
  type ViewProperty,
  type ViewPropertyValue,
  type ViewState,
} from './wire.ts';

export * from './wire.ts';

export const serialSchema = z.string().regex(SERIAL_PATTERN, 'invalid adb serial');
export const packageNameSchema = z.string().max(255).regex(PACKAGE_NAME_PATTERN, 'invalid package name');
export const avdNameSchema = z.string().regex(AVD_NAME_PATTERN, 'invalid AVD name');
/** Inspector snapshot ids as the server assigns them (`InspectorSnapshot.id`). */
export const INSPECTOR_SNAPSHOT_ID_PATTERN = /^[0-9a-f]{16}$/;
const inspectorNodeId = z
  .number()
  .int()
  .min(0)
  .max(MAX_INSPECTOR_NODES - 1);
/** Java's `int` (`XmlPullParser.getLineNumber()`, request ids, view keys). */
const MAX_JAVA_INT = 2_147_483_647;
const viewPropertySchema = z.enum(VIEW_PROPERTIES);
const viewPropertyGroupSchema = z.enum(
  Object.keys(VIEW_PROPERTY_GROUPS) as [
    keyof typeof VIEW_PROPERTY_GROUPS,
    ...(keyof typeof VIEW_PROPERTY_GROUPS)[],
  ],
);
const viewPropertyValueSchema = z.union([z.string().max(MAX_EDIT_TEXT_CHARS), z.number(), z.boolean()]);
const snapshotIdSchema = z.string().regex(INSPECTOR_SNAPSHOT_ID_PATTERN, 'invalid snapshot id');
const clientRequestId = z.number().int().min(0).max(MAX_JAVA_INT);

/** A valid `value` for `property` (normalizeViewValue), normalized. */
function viewEdit<T extends { property: ViewProperty; value: ViewPropertyValue }>(
  message: T,
  ctx: z.RefinementCtx,
): T {
  const value = normalizeViewValue(message.property, message.value);
  if (value === null) {
    ctx.addIssue({ code: 'custom', message: `invalid value for ${message.property}` });
    return z.NEVER;
  }
  return { ...message, value };
}

// ---------------------------------------------------------------------------
// Network (0.7.0): shared by the dashboard's mock rules, the device gateway and the agent tools
// ---------------------------------------------------------------------------

const utf8Bytes = (value: string): number => utf8.encode(value).length;
/** UTF-8 size at most `max`: a UTF-16 unit encodes to at least one byte, so longer strings fail without encoding. */
const withinBytes = (value: string, max: number): boolean => value.length <= max && utf8Bytes(value) <= max;
/** An RFC 9110 token: header names and methods. */
export const HTTP_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Control (Cc) and format (Cf) characters never belong in a URL, header or content type on the wire. */
const HTTP_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
/** Mock rule ids as the server assigns them (`NetworkMockRule.id`). */
export const MOCK_ID_PATTERN = /^m[1-9][0-9]{0,8}$/;
/** Mock rule methods: upper-case tokens (`GET`, `PROPFIND`). */
export const MOCK_METHOD_PATTERN = /^[A-Z][A-Z0-9_-]{0,15}$/;
const MOCK_URL_PATTERN = /^(https?|\*):\/\//i;
/** Java's `int`: SDK exchange ids, mock revisions. */
const MAX_INT32 = 2_147_483_647;
/** Upper bound of a byte count (a body's size): beyond any real transfer, below 2^53. */
export const MAX_HTTP_SIZE = 1e15;
/** Calls the SDK may report as not recorded since its previous `httpRequest`. */
export const MAX_HTTP_DROPPED = 1_000_000;

const httpToken = (max: number) => z.string().min(1).max(max).regex(HTTP_TOKEN_PATTERN, 'invalid token');
const httpText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !HTTP_FORBIDDEN.test(value), 'control or format character');

export const httpHeaderSchema = z.tuple([
  httpToken(MAX_HTTP_HEADER_NAME_CHARS),
  httpText(MAX_HTTP_HEADER_VALUE_CHARS),
]) satisfies z.ZodType<HttpHeader>;

const headersBytes = (headers: readonly HttpHeader[]): number =>
  headers.reduce((sum, [name, value]) => sum + utf8Bytes(name) + utf8Bytes(value), 0);

const mockUrl = z
  .string()
  .min(1)
  .max(MAX_MOCK_URL_CHARS)
  .refine((value) => !HTTP_FORBIDDEN.test(value) && !/\s/.test(value), 'control or space character')
  .refine((value) => MOCK_URL_PATTERN.test(value), 'must start with http://, https:// or *://');

/** A mock rule from the dashboard or an agent (validated; the server normalises and orders it). */
export const networkMockInputSchema = z
  .object({
    id: z.string().regex(MOCK_ID_PATTERN, 'invalid mock id').optional(),
    method: z.string().regex(MOCK_METHOD_PATTERN, 'invalid method').nullable(),
    match: z.enum(['exact', 'prefix', 'glob']),
    url: mockUrl,
    action: z.enum(['respond', 'timeout', 'connection_error']),
    status: z.number().int().min(100).max(599),
    headers: z
      .array(httpHeaderSchema)
      .max(MAX_MOCK_HEADERS)
      .refine((headers) => headersBytes(headers) <= MAX_MOCK_HEADER_BYTES, 'headers too large'),
    body: z.string().refine((body) => withinBytes(body, MAX_MOCK_BODY_BYTES), 'body too large'),
    delayMs: z.number().int().min(0).max(MAX_MOCK_DELAY_MS),
    enabled: z.boolean(),
  })
  .strict()
  .refine(
    (rule) => rule.match === 'glob' || !rule.url.startsWith('*'),
    'an exact or prefix pattern needs http:// or https://',
  )
  .refine(
    (rule) => rule.match !== 'glob' || rule.url.split('*').length - 1 <= MAX_MOCK_GLOB_STARS,
    `at most ${MAX_MOCK_GLOB_STARS} * in a glob`,
  ) satisfies z.ZodType<NetworkMockInput>;

// ---------------------------------------------------------------------------
// Dashboard → server (validated)
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refreshDevices') }).strict(),
  z
    .object({ type: z.literal('bootEmulator'), avdName: avdNameSchema, mode: z.enum(['quick', 'cold']) })
    .strict(),
  z
    .object({
      type: z.literal('shutdownEmulator'),
      avdName: avdNameSchema,
      confirmUnmanaged: z.boolean().optional(),
    })
    .strict(),
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
      inflateTracking: z.boolean().optional(),
    })
    .strict()
    .refine(
      (message) =>
        message.stallThresholdMs !== undefined ||
        message.strictMode !== undefined ||
        message.inflateTracking !== undefined,
      'no SDK option given',
    ),
  z.object({ type: z.literal('inspect'), serial: serialSchema }).strict(),
  z
    .object({
      type: z.literal('selectInspectorNode'),
      snapshotId: snapshotIdSchema,
      nodeId: inspectorNodeId.nullable(),
    })
    .strict(),
  z.object({ type: z.literal('inspectorFocus'), serial: serialSchema.nullable() }).strict(),
  z
    .object({ type: z.literal('getHttpExchange'), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
    .strict(),
  z.object({ type: z.literal('setNetworkMock'), rule: networkMockInputSchema }).strict(),
  z
    .object({
      type: z.literal('clearNetworkMocks'),
      id: z.string().regex(MOCK_ID_PATTERN, 'invalid mock id').optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('setViewProperty'),
      requestId: clientRequestId,
      snapshotId: snapshotIdSchema,
      nodeId: inspectorNodeId,
      property: viewPropertySchema,
      value: viewPropertyValueSchema,
    })
    .strict()
    .transform(viewEdit),
  z
    .object({
      type: z.literal('revertViewProperties'),
      requestId: clientRequestId,
      snapshotId: snapshotIdSchema,
      nodeId: inspectorNodeId.optional(),
      property: z.union([viewPropertySchema, viewPropertyGroupSchema]).optional(),
    })
    .strict()
    .refine(
      (message) => message.property === undefined || message.nodeId !== undefined,
      'property needs a nodeId',
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

/** The size cap of a dashboard → server frame: MAX_CLIENT_MESSAGE_BYTES, or the larger one of `setNetworkMock`. */
export const MAX_CLIENT_FRAME_BYTES = MAX_MOCK_CLIENT_MESSAGE_BYTES;

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = readJson(raw, MAX_CLIENT_FRAME_BYTES);
  if (!json.ok) return json;
  const type: unknown =
    typeof json.value === 'object' && json.value !== null && Reflect.get(json.value, 'type');
  if (type !== 'setNetworkMock' && !withinBytes(raw, MAX_CLIENT_MESSAGE_BYTES)) {
    return { ok: false, error: 'message too large' };
  }
  return validate(json.value, clientMessageSchema);
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
  z.object({ type: z.literal('keyFrame') }).strict(),
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
  .object({ name: text, className: text, kind: z.enum(['activity', 'fragment', 'dialog', 'destination']) })
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

/** Bounds of the 0.4.0 layout messages: counts and times are far above anything a window can hold. */
export const MAX_INFLATE_COUNT = 1_000_000;
export const MAX_INFLATE_MS = 60_000;
export const MAX_VIEW_COUNT = 1_000_000;
const MAX_LAYOUT_TEXT_LENGTH = 200;
const layoutText = textOf(MAX_LAYOUT_TEXT_LENGTH);

const viewPathNodeSchema = z.object({ className: layoutText, id: layoutText.nullable() }).strip();
const viewClassCountSchema = z
  .object({ className: layoutText, count: z.number().int().min(1).max(MAX_VIEW_COUNT) })
  .strip();

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

/** Bounds of the 0.5.0 Inspector messages (screen pixels, window counts, strings). */
export const MAX_INSPECTOR_PIXELS = 100_000;
export const MAX_INSPECTOR_WINDOWS = 32;
export const MAX_INSPECTOR_DISPLAY_PX = 20_000;
const MAX_INSPECTOR_TEXT_LENGTH = 500;
/** `WindowManager.LayoutParams.type` values (application 1-99, sub-windows 1000+, system windows 2000+). */
const MAX_WINDOW_TYPE = 10_000;
const LAYOUT_DIMENSION_PATTERN = /^(match_parent|wrap_content|-?\d{1,6}px)$/;
/** Text sizes as read (sp): far above anything legible, below anything absurd. */
export const MAX_VIEW_TEXT_SIZE_SP = 10_000;
const WIRE_COLOR = /^#[0-9A-F]{8}$/;

const pixel = z.number().int().min(-MAX_INSPECTOR_PIXELS).max(MAX_INSPECTOR_PIXELS);
const pixelRect = z.tuple([pixel, pixel, pixel, pixel]);
const inspectorText = textOf(MAX_INSPECTOR_TEXT_LENGTH);
const windowIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_INSPECTOR_WINDOWS - 1);
const requestId = z.number().int().min(0).max(MAX_JAVA_INT);

const inspectorWindowSchema = z
  .object({
    id: windowIndex,
    type: z.number().int().min(0).max(MAX_WINDOW_TYPE).nullable(),
    bounds: pixelRect,
  })
  .strip() satisfies z.ZodType<InspectorWindow>;

const viewPixels = z.number().min(-MAX_INSPECTOR_PIXELS).max(MAX_INSPECTOR_PIXELS);
const wireColor = z.string().regex(WIRE_COLOR, 'invalid color');

const viewStateSchema = z
  .object({
    key: z.number().int().min(1).max(MAX_JAVA_INT),
    translationX: viewPixels,
    translationY: viewPixels,
    elevation: viewPixels,
    backgroundColor: wireColor.nullable(),
    textSize: z.number().min(0).max(MAX_VIEW_TEXT_SIZE_SP).nullable(),
    textColor: wireColor.nullable(),
    password: z.boolean(),
    edited: z.array(viewPropertySchema).max(VIEW_PROPERTIES.length).optional(),
  })
  .strip() satisfies z.ZodType<ViewState>;

const inspectorNodeSchema = z
  .object({
    id: inspectorNodeId,
    parent: inspectorNodeId.nullable(),
    window: windowIndex,
    className: layoutText,
    resourceId: layoutText.nullable(),
    text: inspectorText.nullable(),
    contentDescription: inspectorText.nullable(),
    bounds: pixelRect,
    visibleBounds: pixelRect.nullable(),
    visibility: z.enum(['visible', 'invisible', 'gone']),
    alpha: z.number().min(0).max(1).nullable(),
    enabled: z.boolean().nullable(),
    clickable: z.boolean().nullable(),
    focused: z.boolean().nullable(),
    selected: z.boolean().nullable(),
    checked: z.boolean().nullable(),
    padding: pixelRect.nullable(),
    margin: pixelRect.nullable(),
    layoutWidth: z.string().regex(LAYOUT_DIMENSION_PATTERN, 'invalid layout dimension').nullable(),
    layoutHeight: z.string().regex(LAYOUT_DIMENSION_PATTERN, 'invalid layout dimension').nullable(),
    source: z
      .object({ layout: layoutText, line: z.number().int().min(1).max(MAX_JAVA_INT) })
      .strip()
      .nullable(),
    fragment: layoutText.nullable(),
    activity: layoutText.nullable(),
    composable: z
      .object({
        file: layoutText.nullable(),
        line: z.number().int().min(1).max(MAX_JAVA_INT).nullable(),
        draws: z.boolean().optional(),
      })
      .strip()
      .optional(),
    composition: z.enum(['read', 'disabled', 'no_source', 'failed']).optional(),
    destination: layoutText.nullable().optional(),
    view: viewStateSchema.optional(),
  })
  .strip() satisfies z.ZodType<InspectorNode>;

const httpHeadersSchema = z
  .array(httpHeaderSchema)
  .max(MAX_HTTP_HEADERS)
  .refine((headers) => headersBytes(headers) <= MAX_HTTP_HEADER_BYTES, 'headers too large');

const httpBodySchema = z
  .object({
    size: z.number().int().min(0).max(MAX_HTTP_SIZE).nullable(),
    contentType: httpText(MAX_HTTP_CONTENT_TYPE_CHARS).min(1).nullable(),
    // Body text is the app's own data: newlines, tabs (and any other character) are kept.
    text: z
      .string()
      .refine((text) => withinBytes(text, MAX_HTTP_BODY_BYTES), 'body text too large')
      .nullable(),
    truncated: z.boolean(),
    omitted: z.enum(['type', 'streaming', 'encoding', 'one_shot', 'error']).nullable(),
  })
  .strip() satisfies z.ZodType<HttpBody>;

const httpUrl = httpText(MAX_HTTP_URL_CHARS)
  .min(1)
  .refine((value) => /^https?:\/\//i.test(value), 'not an http(s) URL');
const exchangeId = z.number().int().min(1).max(MAX_INT32);
const mockRev = z.number().int().min(0).max(MAX_INT32);
const HTTP_PROTOCOL_PATTERN = /^[a-z0-9_./-]{1,32}$/;

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
      nonce: z.string().regex(LINK_NONCE_PATTERN, 'invalid nonce').optional(),
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
  z
    .object({
      type: z.literal('inflate'),
      ts: epochMs,
      layout: layoutText.nullable(),
      label: layoutText.nullable(),
      library: z.boolean(),
      nested: z.boolean(),
      screen: layoutText.nullable(),
      count: z.number().int().min(1).max(MAX_INFLATE_COUNT),
      totalMs: z.number().nonnegative().max(MAX_INFLATE_MS),
      maxMs: z.number().nonnegative().max(MAX_INFLATE_MS),
      views: z.number().int().nonnegative().max(MAX_VIEW_COUNT),
    })
    .strip(),
  z
    .object({
      type: z.literal('viewtree'),
      ts: epochMs,
      screen: layoutText.nullable(),
      window: layoutText,
      views: z.number().int().nonnegative().max(MAX_VIEW_COUNT),
      viewGroups: z.number().int().nonnegative().max(MAX_VIEW_COUNT),
      maxDepth: z.number().int().nonnegative().max(MAX_VIEW_COUNT),
      deepestPath: z.array(viewPathNodeSchema).max(MAX_VIEW_PATH_NODES),
      topClasses: z.array(viewClassCountSchema).max(MAX_VIEW_TREE_CLASSES),
    })
    .strip(),
  z
    .object({
      type: z.literal('inspectBegin'),
      requestId,
      ts: epochMs,
      screen: layoutText.nullable(),
      display: z
        .object({
          width: z.number().int().min(1).max(MAX_INSPECTOR_DISPLAY_PX),
          height: z.number().int().min(1).max(MAX_INSPECTOR_DISPLAY_PX),
          rotation: z.literal([0, 90, 180, 270]),
        })
        .strip(),
      windows: z.array(inspectorWindowSchema).max(MAX_INSPECTOR_WINDOWS),
      nodeCount: z.number().int().min(0).max(MAX_INSPECTOR_NODES),
      truncated: z.boolean(),
      captureMs: durationMs,
      compose: z.boolean(),
      liveEdits: z.number().int().min(0).max(MAX_LIVE_EDITS).optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal('inspectNodes'),
      requestId,
      seq: z
        .number()
        .int()
        .min(0)
        .max(MAX_INSPECTOR_NODES - 1),
      last: z.boolean(),
      nodes: z.array(inspectorNodeSchema).max(MAX_INSPECTOR_NODES),
    })
    .strip(),
  z
    .object({
      type: z.literal('inspectError'),
      requestId,
      reason: z.enum(['background', 'no_window', 'disabled', 'failed']),
    })
    .strip(),
  z
    .object({
      type: z.literal('httpRequest'),
      id: exchangeId,
      ts: epochMs,
      method: httpToken(MAX_HTTP_METHOD_CHARS),
      url: httpUrl,
      headers: httpHeadersSchema,
      body: httpBodySchema.nullable(),
      mockId: z.string().regex(MOCK_ID_PATTERN, 'invalid mock id').nullable(),
      dropped: z.number().int().min(0).max(MAX_HTTP_DROPPED),
    })
    .strip(),
  z
    .object({
      type: z.literal('httpResponse'),
      id: exchangeId,
      ts: epochMs,
      status: z.number().int().min(100).max(999).nullable(),
      protocol: z.string().regex(HTTP_PROTOCOL_PATTERN, 'invalid protocol').nullable(),
      headers: httpHeadersSchema,
      body: httpBodySchema.nullable(),
      headersMs: durationMs.nullable(),
      durationMs,
      error: z
        .object({
          kind: z.enum(['timeout', 'connection', 'canceled', 'io']),
          message: z
            .string()
            .max(MAX_HTTP_ERROR_CHARS)
            .transform((value) => sanitized(value) || null)
            .nullable(),
        })
        .strip()
        .nullable(),
    })
    .strip(),
  z
    .object({
      type: z.literal('mocksApplied'),
      rev: mockRev,
      count: z.number().int().min(0).max(MAX_NETWORK_MOCKS),
    })
    .strip(),
  z
    .object({
      type: z.literal('viewPropertyResult'),
      requestId,
      ok: z.boolean(),
      error: z
        .enum(['stale', 'unsupported', 'password', 'invalid', 'limit', 'failed', 'disabled', 'busy'])
        .optional(),
      liveEdits: z.number().int().min(0).max(MAX_LIVE_EDITS),
    })
    .strip(),
]) satisfies z.ZodType<DeviceMessage>;

/**
 * Diagnostics (v2, v3 `inflate` / `viewtree`), the v4 Inspector answers and the v7 network messages: a line of these
 * types that fails validation is dropped by the caller (`invalidDiagnostic`), not fatal to the link like a bad v1
 * message (an invalid Inspector answer fails its request instead).
 */
const DIAGNOSTIC_TYPES: ReadonlySet<DeviceMessageType> = new Set([
  'stall',
  'strictmode',
  'inflate',
  'viewtree',
  'inspectBegin',
  'inspectNodes',
  'inspectError',
  'httpRequest',
  'httpResponse',
  'mocksApplied',
  'viewPropertyResult',
]);

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
  inflate: DEVICE_PROTOCOL_V3,
  viewtree: DEVICE_PROTOCOL_V3,
  inspectBegin: DEVICE_PROTOCOL_V4,
  inspectNodes: DEVICE_PROTOCOL_V4,
  inspectError: DEVICE_PROTOCOL_V4,
  httpRequest: DEVICE_PROTOCOL_V7,
  httpResponse: DEVICE_PROTOCOL_V7,
  mocksApplied: DEVICE_PROTOCOL_V7,
  viewPropertyResult: DEVICE_PROTOCOL_V8,
};

/**
 * Flags of a failed parse; at most one is set:
 * - `unknownType`: a JSON object whose string `type` this build does not know (a newer SDK): skippable.
 * - `unnegotiated`: a known type introduced after the link's negotiated protocol version (`since`): skippable.
 * - `invalidDiagnostic`: a diagnostic (`stall` / `strictmode` / `inflate` / `viewtree`) or an Inspector answer
 *   (`inspectBegin` / `inspectNodes` / `inspectError`) with invalid fields: skippable.
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

const TYPE_PREFIX = '{"type":"';
/** Longer than any known type (`viewPropertyResult` is 18). */
const MAX_PEEKED_TYPE_LENGTH = 32;

/** The `type` of an SDK line without parsing it (the SDK writes it first); null when the line does not start so. */
export function peekLineType(line: string): string | null {
  if (!line.startsWith(TYPE_PREFIX)) return null;
  const end = line.indexOf('"', TYPE_PREFIX.length);
  if (end === -1 || end - TYPE_PREFIX.length > MAX_PEEKED_TYPE_LENGTH) return null;
  return line.slice(TYPE_PREFIX.length, end);
}

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

/** Lines of these types may be up to MAX_HTTP_LINE_BYTES on a v7 link; every other line, MAX_DEVICE_LINE_BYTES. */
export const LARGE_DEVICE_MESSAGE_TYPES: ReadonlySet<DeviceMessageType> = new Set([
  'httpRequest',
  'httpResponse',
]);

/** The line size cap for a line of `type` (as peeked) on a link negotiated at `protocolVersion`. */
export function maxDeviceLineBytes(type: string | null, protocolVersion: number): number {
  return protocolVersion >= DEVICE_PROTOCOL_V7 &&
    type !== null &&
    LARGE_DEVICE_MESSAGE_TYPES.has(type as DeviceMessageType)
    ? MAX_HTTP_LINE_BYTES
    : MAX_DEVICE_LINE_BYTES;
}

/**
 * Parse one NDJSON line from the SDK (without its trailing newline). `protocolVersion` is the link's negotiated
 * version: types introduced later are not validated but reported as `unnegotiated`.
 */
export function parseDeviceMessage(
  line: string,
  protocolVersion: number = DEVICE_PROTOCOL_VERSION,
): DeviceParseResult {
  const json = readJson(line, maxDeviceLineBytes(peekLineType(line), protocolVersion));
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

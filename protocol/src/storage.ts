/**
 * The storage inspector's shared rules (0.13.0): validation of typed values (StorageValue) as the SDK sends them and as
 * a write may carry them, their canonical JSON (what the server puts in a `storageWrite` line for the SDK's strict
 * codec), and the server's second redaction pass (the SDK redacts first, with the same rules).
 */
import { z } from 'zod';
import { isSensitiveName, redactFreeText, redactJsonText } from './insights/network.ts';
import {
  HTTP_REDACTED,
  MAX_STORAGE_CURSOR_CHARS,
  MAX_STORAGE_NAME_CHARS,
  MAX_STORAGE_PAGES,
  MAX_STORAGE_ROWS,
  MAX_STORAGE_SET_ELEMENTS,
  MAX_STORAGE_KEYS,
  MAX_STORAGE_VALUE_UNITS,
  STORAGE_CURSOR_PATTERN,
  STORAGE_FLOAT_BITS_PATTERN,
  STORAGE_INTEGER_PATTERN,
  STORAGE_REAL_BITS_PATTERN,
  STORAGE_VALUE_TYPES,
  type StoragePage,
  type StoragePageRequest,
  type StorageReadInput,
  type StorageTarget,
  type StorageValue,
  type StorageValueType,
  type StorageWriteInput,
} from './wire.ts';

const INT_RANGE = [-(2n ** 31n), 2n ** 31n - 1n] as const;
const LONG_RANGE = [-(2n ** 63n), 2n ** 63n - 1n] as const;

/** A decimal integer string within the range of `type` (`int`: 32-bit, `long` / `integer`: 64-bit). */
export function isStorageInteger(text: string, type: 'int' | 'long' | 'integer'): boolean {
  if (text.length > 20 || !STORAGE_INTEGER_PATTERN.test(text)) return false;
  const value = BigInt(text);
  const [min, max] = type === 'int' ? INT_RANGE : LONG_RANGE;
  return value >= min && value <= max;
}

/** `bits` (0x + hex) of a `float` / `real` is a NaN (any payload). */
export function isNanBits(type: 'float' | 'real', bits: string): boolean {
  const value = BigInt(bits);
  if (type === 'float') return (value & 0x7f800000n) === 0x7f800000n && (value & 0x007fffffn) !== 0n;
  return (value & 0x7ff0000000000000n) === 0x7ff0000000000000n && (value & 0x000fffffffffffffn) !== 0n;
}

/** `text` has a high surrogate not followed by a low one, or a low one not preceded by a high one. */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Bytes a standard base64 string decodes to. */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

const storageText = z.string().max(MAX_STORAGE_VALUE_UNITS);
const displayText = z.string().max(64);
const valueType = z.enum(STORAGE_VALUE_TYPES as [StorageValueType, ...StorageValueType[]]);

const stringValue = z
  .object({
    t: z.literal('string'),
    v: storageText,
    complete: z.literal(false).optional(),
    length: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const integerValue = z
  .object({ t: z.enum(['int', 'long', 'integer']), v: z.string().max(20) })
  .strict()
  .refine((value) => isStorageInteger(value.v, value.t), 'integer out of range or not a decimal string');
const floatValue = z
  .object({ t: z.enum(['float', 'real']), v: displayText, bits: z.string().max(18) })
  .strict()
  .refine(
    (value) =>
      (value.t === 'float' ? STORAGE_FLOAT_BITS_PATTERN : STORAGE_REAL_BITS_PATTERN).test(value.bits),
    'invalid bits',
  );
const boolValue = z.object({ t: z.literal('bool'), v: z.boolean() }).strict();
const stringSetValue = z
  .object({
    t: z.literal('stringSet'),
    v: z.array(storageText).max(MAX_STORAGE_SET_ELEMENTS),
    complete: z.literal(false).optional(),
  })
  .strict();
const blobValue = z
  .object({
    t: z.literal('blob'),
    b64: z
      .string()
      .max(Math.ceil(MAX_STORAGE_VALUE_UNITS / 3) * 4)
      .regex(BASE64_PATTERN, 'invalid base64'),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    complete: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      base64Bytes(value.b64) <= value.size &&
      (value.complete ? base64Bytes(value.b64) === value.size : base64Bytes(value.b64) < value.size),
    'blob size does not match',
  );
const nullValue = z.object({ t: z.literal('null') }).strict();
const redactedValue = z
  .object({ t: z.literal('redacted'), orig: valueType, preview: storageText.optional() })
  .strict();

/** A value as the SDK sends it (any type, possibly cut or redacted). */
export const storageValueSchema = z.union([
  stringValue,
  integerValue,
  floatValue,
  boolValue,
  stringSetValue,
  blobValue,
  nullValue,
  redactedValue,
]) satisfies z.ZodType<StorageValue>;

/**
 * A value a write may name (`expected`, `value`, a primary key value): complete, never redacted. Integers given as
 * JSON numbers fail here (`invalid_value`): only decimal strings survive the trip.
 */
export const storageWriteValueSchema = storageValueSchema.refine(
  (value) =>
    value.t !== 'redacted' &&
    !('complete' in value && value.complete === false) &&
    !(value.t === 'string' && value.length !== undefined),
  'redacted or cut values cannot be written or compared',
);

const storageName = z.string().min(1).max(MAX_STORAGE_NAME_CHARS);
const storageCursorInput = z
  .string()
  .max(MAX_STORAGE_CURSOR_CHARS)
  .regex(STORAGE_CURSOR_PATTERN, 'invalid cursor: pass back a nextCursor as it came');
export const storageTargetSchema = z
  .object({
    serial: z.string().min(1).max(256),
    packageName: z.string().min(1).max(256),
    link: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict() satisfies z.ZodType<StorageTarget>;
const opIdOf = z.string().regex(/^[0-9a-f-]{36}$/, 'invalid opId');
export const ROW_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const pageRequestSchema = z
  .object({
    table: storageName,
    columns: z.array(storageName).min(1).max(256).optional(),
    cursor: storageCursorInput.nullable().optional(),
    limit: z.number().int().min(1).max(MAX_STORAGE_ROWS).optional(),
  })
  .strict() satisfies z.ZodType<StoragePageRequest>;

export const storageReadInputSchema = z.discriminatedUnion('store', [
  z
    .object({
      store: z.literal('prefs'),
      name: storageName,
      cursor: storageCursorInput.nullable().optional(),
      limit: z.number().int().min(1).max(MAX_STORAGE_KEYS).optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal('db'),
      name: storageName,
      pages: z.array(pageRequestSchema).min(1).max(MAX_STORAGE_PAGES).optional(),
    })
    .strict(),
]) satisfies z.ZodType<StorageReadInput>;

export const storageWriteInputSchema = z.union([
  z
    .object({
      store: z.literal('prefs'),
      name: storageName,
      op: z.literal('update'),
      key: storageName,
      expected: storageWriteValueSchema,
      value: storageWriteValueSchema,
      undoOf: opIdOf.optional(),
      target: storageTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal('prefs'),
      name: storageName,
      op: z.literal('remove'),
      key: storageName,
      expected: storageWriteValueSchema,
      target: storageTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal('db'),
      name: storageName,
      op: z.literal('update'),
      table: storageName,
      column: storageName,
      pk: z.array(storageWriteValueSchema).min(1).max(64),
      expected: storageWriteValueSchema,
      value: storageWriteValueSchema,
      undoOf: opIdOf.optional(),
      target: storageTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal('db'),
      name: storageName,
      op: z.literal('delete'),
      table: storageName,
      pk: z.array(storageWriteValueSchema).min(1).max(64),
      rowDigest: z.string().regex(ROW_DIGEST_PATTERN, 'invalid row digest'),
      target: storageTargetSchema.optional(),
    })
    .strict(),
]) satisfies z.ZodType<StorageWriteInput>;

/** The one NaN Android SharedPreferences stores (`Float.NaN`, what `Float.floatToIntBits` gives every NaN). */
export const CANONICAL_FLOAT_NAN_BITS = '0x7fc00000';

/**
 * Why a write can't go out, judged before anything is sent (null: fine): a NaN for a database cell
 * (`invalid_value:nan_not_storable`, SQLite stores it as NULL), text with a lone surrogate, in a database TEXT, a
 * prefs string or a prefs string set element (`invalid_value:lone_surrogate`: Android's SQLite binding mangles it,
 * and SharedPreferences write it to the file as `?`), a prefs NaN other than the canonical one
 * (`invalid_value:nan_payload`, prefs keep a single NaN), types that can't be stored where they go
 * (`type_mismatch`: prefs types in a database, SQLite storage classes in prefs).
 */
export function storageWriteProblem(write: StorageWriteInput): string | null {
  const prefsTypes: readonly string[] = ['string', 'int', 'long', 'float', 'bool', 'stringSet'];
  const dbTypes: readonly string[] = ['string', 'integer', 'real', 'blob', 'null'];
  const allowed = write.store === 'prefs' ? prefsTypes : dbTypes;
  const values: StorageValue[] = [];
  if ('expected' in write) values.push(write.expected);
  if ('value' in write) values.push(write.value);
  if (write.store === 'db') values.push(...write.pk);
  if (values.some((value) => !allowed.includes(value.t))) return 'type_mismatch';
  if (
    write.store === 'db' &&
    'value' in write &&
    write.value.t === 'real' &&
    isNanBits('real', write.value.bits)
  ) {
    return 'invalid_value:nan_not_storable';
  }
  // Android's SQLite binding (UTF-16 → UTF-8) mangles a lone surrogate and the code unit after it; SharedPreferences
  // keep it in memory but write it to the file as '?', so the app reads another value after a restart.
  if ('value' in write) {
    const texts =
      write.value.t === 'string' ? [write.value.v] : write.value.t === 'stringSet' ? write.value.v : [];
    if (texts.some(hasLoneSurrogate)) return 'invalid_value:lone_surrogate';
  }
  // Android prefs keep one NaN: Float.equals (canonical bits) makes another payload a no-op, and the XML says "NaN".
  if (
    write.store === 'prefs' &&
    'value' in write &&
    write.value.t === 'float' &&
    isNanBits('float', write.value.bits) &&
    write.value.bits.toLowerCase() !== CANONICAL_FLOAT_NAN_BITS
  ) {
    return 'invalid_value:nan_payload';
  }
  return null;
}

/** The value as canonical JSON (fixed key order per type), what the SDK's strict codec reads. */
export function canonicalStorageJson(value: StorageValue): string {
  switch (value.t) {
    case 'string':
      return JSON.stringify(
        value.complete === false
          ? { t: value.t, v: value.v, complete: false, length: value.length }
          : { t: value.t, v: value.v },
      );
    case 'int':
    case 'long':
    case 'integer':
      return JSON.stringify({ t: value.t, v: value.v });
    case 'float':
    case 'real':
      return JSON.stringify({ t: value.t, v: value.v, bits: value.bits });
    case 'bool':
      return JSON.stringify({ t: value.t, v: value.v });
    case 'stringSet':
      return JSON.stringify(
        value.complete === false
          ? { t: value.t, v: value.v, complete: false }
          : { t: value.t, v: [...value.v].sort(compareUtf16) },
      );
    case 'blob':
      return JSON.stringify({ t: value.t, b64: value.b64, size: value.size, complete: value.complete });
    case 'null':
      return JSON.stringify({ t: 'null' });
    case 'redacted':
      return JSON.stringify(
        value.preview === undefined
          ? { t: value.t, orig: value.orig }
          : { t: value.t, orig: value.orig, preview: value.preview },
      );
  }
}

/** A primary key as canonical JSON: an array of canonical values. */
export function canonicalPkJson(pk: readonly StorageValue[]): string {
  return `[${pk.map(canonicalStorageJson).join(',')}]`;
}

/** Code-unit order (Java's String.compareTo): how both sides sort a `stringSet`. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Two values are the same typed value, as compare-and-set compares them on the device (StorageValue.same): the same
 * type and, per type, integers by value, floats by raw `bits` only (`v` is display text: `0` and `0.0` with the same
 * bits are the same, `0.0` and `-0.0` are not), strings by UTF-16 code unit, blobs by byte, sets by set equality.
 * A cut (`complete: false`) or redacted value is never the same as anything.
 */
export function sameStorageValue(a: StorageValue, b: StorageValue): boolean {
  if (a.t !== b.t || a.t === 'redacted') return false;
  if (('complete' in a && a.complete === false) || ('complete' in b && b.complete === false)) return false;
  switch (a.t) {
    case 'float':
    case 'real':
      return a.bits === (b as typeof a).bits;
    case 'stringSet': {
      const other = new Set((b as typeof a).v);
      const mine = new Set(a.v);
      return mine.size === other.size && [...mine].every((element) => other.has(element));
    }
    case 'blob':
      return a.size === (b as typeof a).size && a.b64 === (b as typeof a).b64;
    default:
      return canonicalStorageJson(a) === canonicalStorageJson(b);
  }
}

// ---------------------------------------------------------------------------
// Redaction (the server's second pass; StorageRedaction.kt on the device applies the same rules first)
// ---------------------------------------------------------------------------

/** A JWT (three base64url segments, the header starting `eyJ`). */
const JWT = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;

/**
 * Text with what looks like a credential replaced: inside JSON (values of sensitive keys), JWTs, `Bearer …`, sensitive
 * `name=value` pairs and URLs' sensitive query parameters and userinfo.
 */
export function redactStorageText(text: string): string {
  let out = text;
  const trimmed = out.trimStart();
  // JSON-looking text (valid or not, cut or not): the values of sensitive keys go, whatever their depth.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) out = redactJsonText(out);
  out = out.replace(JWT, HTTP_REDACTED);
  return redactFreeText(out);
}

/**
 * `value` as it may be shown, for a key or column called `name`: a credential-looking name hides it whole, a string
 * with a credential inside shows the rest (`preview`). Read-only either way.
 */
export function redactStorageValue(name: string, value: StorageValue): StorageValue {
  if (value.t === 'null') return value;
  if (value.t === 'redacted') {
    if (isSensitiveName(name) || value.preview === undefined) return { t: 'redacted', orig: value.orig };
    return { t: 'redacted', orig: value.orig, preview: redactStorageText(value.preview) };
  }
  if (isSensitiveName(name)) return { t: 'redacted', orig: value.t };
  if (value.t === 'string') {
    const redacted = redactStorageText(value.v);
    return redacted === value.v ? value : { t: 'redacted', orig: 'string', preview: redacted };
  }
  if (value.t === 'stringSet' && value.v.some((element) => redactStorageText(element) !== element)) {
    return { t: 'redacted', orig: 'stringSet' };
  }
  return value;
}

/** Kinds of table whose values can't be traced to a table column: redaction by column name doesn't hold there. */
const PROVENANCE_UNKNOWN: ReadonlySet<string> = new Set(['view', 'virtual']);

/**
 * A page as it may be shown: every value redacted again by its column; a view's or virtual table's values hidden whole
 * (a view can rename a credential column, `SELECT access_token AS value`); a cursor that is not an opaque token
 * dropped (it could carry a key value).
 */
export function redactStoragePage(page: StoragePage, kind?: string): StoragePage {
  const hidden =
    PROVENANCE_UNKNOWN.has(kind ?? '') || page.readOnly === 'view' || page.readOnly === 'virtual';
  return {
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell, index): StorageValue => {
        if (hidden && cell.t !== 'null')
          return { t: 'redacted', orig: cell.t === 'redacted' ? cell.orig : cell.t };
        return redactStorageValue(page.columns[index] ?? '', cell);
      }),
    })),
    nextCursor:
      page.nextCursor !== null && STORAGE_CURSOR_PATTERN.test(page.nextCursor) ? page.nextCursor : null,
  };
}

export { isSensitiveName as isSensitiveStorageName };

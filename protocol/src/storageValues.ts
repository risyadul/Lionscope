/** Pure value identity and encoding, shared with the dashboard without loading validators. */
import type { StorageValue } from './wire.ts';

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

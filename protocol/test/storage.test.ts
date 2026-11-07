// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalPkJson,
  canonicalStorageJson,
  DEVICE_PROTOCOL_V10,
  DEVICE_PROTOCOL_V11,
  DEVICE_PROTOCOL_VERSION,
  hasLoneSurrogate,
  isNanBits,
  isStorageInteger,
  MAX_DEVICE_LINE_BYTES,
  MAX_STORAGE_LINE_BYTES,
  MAX_STORAGE_REPLY_BYTES,
  maxDeviceLineBytes,
  parseClientMessage,
  parseDeviceMessage,
  redactStoragePage,
  PROTOCOL_VERSION,
  redactStorageValue,
  sameStorageValue,
  storageValueSchema,
  storageWriteInputSchema,
  storageWriteProblem,
} from '../src/index.ts';
import type { StorageValue, StorageWriteInput } from '../src/index.ts';

const lines = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');

const RESULTS = lines('storage-results.ndjson');
const REQUESTS = lines('gateway-messages.ndjson').filter((line) => line.startsWith('{"type":"storage'));

describe('storage protocol v11', () => {
  it('raises both protocol versions to 11', () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe(DEVICE_PROTOCOL_V11);
    expect(PROTOCOL_VERSION).toBe(11);
  });

  it('parses every golden SDK answer on a v11 link, and none below it', () => {
    expect(RESULTS.length).toBeGreaterThanOrEqual(9);
    for (const line of RESULTS) {
      const parsed = parseDeviceMessage(line, DEVICE_PROTOCOL_V11);
      expect(parsed.ok, `${line}: ${parsed.ok ? '' : parsed.error}`).toBe(true);
      const old = parseDeviceMessage(line, DEVICE_PROTOCOL_V10);
      expect(old.ok).toBe(false);
      if (!old.ok) expect(old.unnegotiated?.since).toBe(DEVICE_PROTOCOL_V11);
    }
  });

  it('answers each golden request with the matching result type and request id', () => {
    const answers = RESULTS.map(
      (line) => JSON.parse(line) as { type: string; requestId: number; opId?: string },
    );
    for (const line of REQUESTS) {
      const request = JSON.parse(line) as { type: string; requestId: number; opId?: string };
      const answer = answers.find((candidate) => candidate.requestId === request.requestId);
      expect(answer?.type).toBe(`${request.type}Result`);
      if (request.opId) expect(answer?.opId).toBe(request.opId);
    }
  });

  it('keeps 64-bit integers and float bits exact through the golden lines', () => {
    const write = RESULTS.map((line) => JSON.parse(line) as Record<string, unknown>).find(
      (message) => message.requestId === 33,
    );
    expect(write?.stored).toEqual({ t: 'float', v: '1.5', bits: '0x3fc00000' });
    const request = JSON.parse(REQUESTS.find((line) => line.includes('"requestId":35'))!) as { pk: string };
    expect(JSON.parse(request.pk)).toEqual([{ t: 'integer', v: '9223372036854775807' }]);
  });

  it('gives storage answers the larger line cap on v11 links only', () => {
    expect(MAX_STORAGE_REPLY_BYTES).toBeLessThan(MAX_STORAGE_LINE_BYTES);
    expect(maxDeviceLineBytes('storageReadResult', DEVICE_PROTOCOL_V11)).toBe(MAX_STORAGE_LINE_BYTES);
    expect(maxDeviceLineBytes('storageReadResult', DEVICE_PROTOCOL_V10)).toBe(MAX_DEVICE_LINE_BYTES);
    expect(maxDeviceLineBytes('stall', DEVICE_PROTOCOL_V11)).toBe(MAX_DEVICE_LINE_BYTES);
  });
});

describe('typed storage values', () => {
  it('takes integers only as decimal strings within the range of their type', () => {
    expect(isStorageInteger('9223372036854775807', 'long')).toBe(true);
    expect(isStorageInteger('-9223372036854775808', 'integer')).toBe(true);
    expect(isStorageInteger('9223372036854775808', 'long')).toBe(false);
    expect(isStorageInteger('2147483648', 'int')).toBe(false);
    expect(isStorageInteger('-0', 'long')).toBe(false);
    expect(isStorageInteger('007', 'long')).toBe(false);
    // A JSON number never passes: it would have been rounded already (2^53 + 1 → 2^53).
    expect(storageValueSchema.safeParse({ t: 'long', v: Number('9007199254740993') }).success).toBe(false);
    expect(storageValueSchema.safeParse({ t: 'long', v: '9007199254740993' }).success).toBe(true);
    const parsed = storageValueSchema.parse(JSON.parse('{"t":"integer","v":"9223372036854775806"}'));
    expect(canonicalStorageJson(parsed)).toBe('{"t":"integer","v":"9223372036854775806"}');
  });

  it('compares floating point by bits: 0.0 is not -0.0, NaN is recognized by any payload', () => {
    const zero: StorageValue = { t: 'real', v: '0.0', bits: '0x0000000000000000' };
    const minusZero: StorageValue = { t: 'real', v: '-0.0', bits: '0x8000000000000000' };
    expect(sameStorageValue(zero, minusZero)).toBe(false);
    // By bits only: `v` is display text.
    expect(sameStorageValue(zero, { ...zero, v: '0' })).toBe(true);
    expect(sameStorageValue({ t: 'stringSet', v: ['a', 'b'] }, { t: 'stringSet', v: ['b', 'a'] })).toBe(true);
    expect(sameStorageValue({ t: 'stringSet', v: ['a'] }, { t: 'stringSet', v: ['a', 'b'] })).toBe(false);
    // Never the same: a cut value, a redacted one, another type with the same text.
    const cut: StorageValue = { t: 'string', v: 'a', complete: false, length: 20000 };
    expect(sameStorageValue(cut, cut)).toBe(false);
    expect(sameStorageValue({ t: 'redacted', orig: 'string' }, { t: 'redacted', orig: 'string' })).toBe(
      false,
    );
    expect(sameStorageValue({ t: 'int', v: '3' }, { t: 'long', v: '3' })).toBe(false);
    expect(sameStorageValue({ t: 'string', v: '3' }, { t: 'string', v: '3' })).toBe(true);
    expect(isNanBits('real', '0x7ff8000000000000')).toBe(true);
    expect(isNanBits('real', '0xfff0000000000001')).toBe(true);
    expect(isNanBits('real', '0x7ff0000000000000')).toBe(false);
    expect(isNanBits('float', '0x7fc00000')).toBe(true);
    expect(isNanBits('float', '0xff800000')).toBe(false);
    expect(storageValueSchema.safeParse({ t: 'real', v: '1', bits: '0x3f800000' }).success).toBe(false);
    expect(storageValueSchema.safeParse({ t: 'float', v: '1', bits: '0x3F800000' }).success).toBe(false);
  });

  it('checks a blob against its size and base64', () => {
    expect(storageValueSchema.safeParse({ t: 'blob', b64: 'AP8=', size: 2, complete: true }).success).toBe(
      true,
    );
    expect(storageValueSchema.safeParse({ t: 'blob', b64: 'AP8=', size: 3, complete: true }).success).toBe(
      false,
    );
    expect(storageValueSchema.safeParse({ t: 'blob', b64: 'AP8=', size: 3, complete: false }).success).toBe(
      true,
    );
    expect(storageValueSchema.safeParse({ t: 'blob', b64: 'AP8', size: 2, complete: true }).success).toBe(
      false,
    );
  });

  it('writes canonical JSON (key order per type, sets sorted by code unit, lone surrogates kept)', () => {
    expect(canonicalStorageJson({ t: 'stringSet', v: ['b', 'B', 'a'] })).toBe(
      '{"t":"stringSet","v":["B","a","b"]}',
    );
    expect(canonicalStorageJson({ v: 'x', t: 'string' } as StorageValue)).toBe('{"t":"string","v":"x"}');
    const lone = canonicalStorageJson({ t: 'string', v: 'a\ud800b' });
    expect((JSON.parse(lone) as { v: string }).v).toBe('a\ud800b');
    expect(
      canonicalPkJson([
        { t: 'string', v: 'x' },
        { t: 'integer', v: '1' },
      ]),
    ).toBe('[{"t":"string","v":"x"},{"t":"integer","v":"1"}]');
  });
});

describe('storage writes', () => {
  const prefsUpdate = (expected: unknown, value: unknown) =>
    storageWriteInputSchema.safeParse({
      store: 'prefs',
      name: 'app',
      op: 'update',
      key: 'count',
      expected,
      value,
    });

  it('never takes a redacted or cut value, nor an integer as a JSON number', () => {
    expect(prefsUpdate({ t: 'int', v: '1' }, { t: 'int', v: '2' }).success).toBe(true);
    expect(prefsUpdate({ t: 'int', v: '1' }, { t: 'int', v: 2 }).success).toBe(false);
    expect(prefsUpdate({ t: 'redacted', orig: 'string' }, { t: 'string', v: 'x' }).success).toBe(false);
    expect(
      prefsUpdate({ t: 'string', v: 'x', complete: false, length: 20000 }, { t: 'string', v: 'y' }).success,
    ).toBe(false);
  });

  it('refuses NaN for a database cell and types of the other store before anything is sent', () => {
    const db = (value: StorageValue): StorageWriteInput => ({
      store: 'db',
      name: 'app.db',
      op: 'update',
      table: 't',
      column: 'c',
      pk: [{ t: 'integer', v: '1' }],
      expected: { t: 'real', v: '1.0', bits: '0x3ff0000000000000' },
      value,
    });
    expect(storageWriteProblem(db({ t: 'real', v: 'NaN', bits: '0x7ff8000000000000' }))).toBe(
      'invalid_value:nan_not_storable',
    );
    expect(storageWriteProblem(db({ t: 'real', v: '-0.0', bits: '0x8000000000000000' }))).toBeNull();
    expect(storageWriteProblem(db({ t: 'long', v: '1' }))).toBe('type_mismatch');
    // Android's SQLite binding mangles a lone surrogate (and the unit after it): refused for TEXT cells.
    for (const v of ['lone \ud800 high', 'low \udc00', 'end \ud800', '\udc00\ud800']) {
      expect(storageWriteProblem(db({ t: 'string', v }))).toBe('invalid_value:lone_surrogate');
    }
    expect(storageWriteProblem(db({ t: 'string', v: 'emoji \ud83d\ude00 nul \u0000' }))).toBeNull();
    // Prefs too: Android writes a lone surrogate to the XML file as '?' (a prefs string and each string set element).
    const prefs = (expected: StorageValue, value: StorageValue): StorageWriteInput => ({
      store: 'prefs',
      name: 'p',
      op: 'update',
      key: 'k',
      expected,
      value,
    });
    expect(storageWriteProblem(prefs({ t: 'string', v: 'a' }, { t: 'string', v: 'lone \ud800 high' }))).toBe(
      'invalid_value:lone_surrogate',
    );
    expect(
      storageWriteProblem(prefs({ t: 'stringSet', v: ['a'] }, { t: 'stringSet', v: ['a', 'low \udc00'] })),
    ).toBe('invalid_value:lone_surrogate');
    expect(
      storageWriteProblem(
        prefs({ t: 'stringSet', v: ['a'] }, { t: 'stringSet', v: ['emoji \ud83d\ude00', 'nul \u0000'] }),
      ),
    ).toBeNull();
    // Only the new value counts: a lone surrogate the app holds can be the expected one (edited away).
    expect(
      storageWriteProblem(prefs({ t: 'string', v: 'app \ud800' }, { t: 'string', v: 'fixed' })),
    ).toBeNull();
    expect(hasLoneSurrogate('\ud800\ud800\udc00')).toBe(true);
    expect(hasLoneSurrogate('\ud83d\ude00\ud83d\ude00')).toBe(false);
    expect(hasLoneSurrogate('')).toBe(false);
    const prefsNan = (bits: string): StorageWriteInput => ({
      store: 'prefs',
      name: 'p',
      op: 'update',
      key: 'k',
      expected: { t: 'float', v: '0.0', bits: '0x00000000' },
      value: { t: 'float', v: 'NaN', bits },
    });
    // Prefs keep a single NaN (Float.equals, and "NaN" in the XML): another payload would silently not be written.
    expect(storageWriteProblem(prefsNan('0x7fc00001'))).toBe('invalid_value:nan_payload');
    expect(storageWriteProblem(prefsNan('0xffc00000'))).toBe('invalid_value:nan_payload');
    expect(storageWriteProblem(prefsNan('0x7fc00000'))).toBeNull();
    expect(
      storageWriteProblem({
        store: 'prefs',
        name: 'p',
        op: 'update',
        key: 'k',
        expected: { t: 'float', v: '0.0', bits: '0x00000000' },
        value: { t: 'float', v: 'NaN', bits: '0x7fc00000' },
      }),
    ).toBeNull();
  });

  it('lets only storageWrite frames be larger than the default cap', () => {
    const big = 'x'.repeat(16 * 1024);
    const frame = JSON.stringify({
      type: 'storageWrite',
      requestId: 1,
      write: {
        store: 'prefs',
        name: 'p',
        op: 'update',
        key: 'k',
        expected: { t: 'string', v: big },
        value: { t: 'string', v: big },
      },
    });
    expect(parseClientMessage(frame).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'storageList', requestId: 1, pad: big })).ok).toBe(
      false,
    );
  });
});

describe('storage redaction (second pass)', () => {
  it('hides a credential-looking name whole and never lets alias tricks through', () => {
    expect(redactStorageValue('access_token', { t: 'string', v: 'abc' })).toEqual({
      t: 'redacted',
      orig: 'string',
    });
    expect(redactStorageValue('session_token', { t: 'long', v: '7' })).toEqual({
      t: 'redacted',
      orig: 'long',
    });
    expect(redactStorageValue('name', { t: 'string', v: 'Ana' })).toEqual({ t: 'string', v: 'Ana' });
    expect(redactStorageValue('anything', { t: 'null' })).toEqual({ t: 'null' });
  });

  it('redacts credentials inside values: JSON keys, JWTs, Bearer and URL query parameters', () => {
    const json = redactStorageValue('user_json', { t: 'string', v: '{"token":"s3cr3t","name":"x"}' });
    expect(json.t).toBe('redacted');
    expect(json.t === 'redacted' && json.preview).toContain('"name":"x"');
    expect(JSON.stringify(json)).not.toContain('s3cr3t');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(JSON.stringify(redactStorageValue('note', { t: 'string', v: `token is ${jwt}` }))).not.toContain(
      jwt,
    );
    expect(
      JSON.stringify(redactStorageValue('auth_header', { t: 'string', v: 'Bearer abc.def' })),
    ).not.toContain('abc.def');
    const url = redactStorageValue('callback', {
      t: 'string',
      v: 'https://example.com/cb?sig=deadbeef&id=7',
    });
    expect(JSON.stringify(url)).not.toContain('deadbeef');
    expect(JSON.stringify(url)).toContain('id=7');
    const set = redactStorageValue('ids', { t: 'stringSet', v: ['a', `x ${jwt}`] });
    expect(set).toEqual({ t: 'redacted', orig: 'stringSet' });
  });

  it('keeps an already redacted value redacted, dropping its preview under a sensitive name', () => {
    expect(redactStorageValue('token', { t: 'redacted', orig: 'string', preview: 'p' })).toEqual({
      t: 'redacted',
      orig: 'string',
    });
  });
});

describe('storage cursors and keys', () => {
  const page = (nextCursor: string | null) =>
    JSON.stringify({
      type: 'storageReadResult',
      requestId: 1,
      code: 'ok',
      pages: [
        { table: 't', columns: ['k'], pk: ['k'], readOnly: null, rows: [], nextCursor, truncated: false },
      ],
      txMs: 1,
    });

  it('takes only an opaque cursor token from the SDK: an answer carrying a key value as cursor is refused whole', () => {
    expect(parseDeviceMessage(page('c1.0123456789abcdef0123456789abcdef'), DEVICE_PROTOCOL_V11).ok).toBe(
      true,
    );
    expect(
      parseDeviceMessage(page('{"k":[{"t":"string","v":"fixture-secret"}]}'), DEVICE_PROTOCOL_V11).ok,
    ).toBe(false);
    expect(parseDeviceMessage(page('count'), DEVICE_PROTOCOL_V11).ok).toBe(false);
  });

  it('takes only a token as a read cursor from a client, and a cut prefs key with its length', () => {
    const read = (cursor: string) =>
      parseClientMessage(
        JSON.stringify({ type: 'storageRead', requestId: 1, read: { store: 'prefs', name: 'p', cursor } }),
      );
    expect(read('c1.0123456789abcdef0123456789abcdef').ok).toBe(true);
    expect(read('count').ok).toBe(false);
    const line = JSON.stringify({
      type: 'storageReadResult',
      requestId: 1,
      code: 'ok',
      entries: [{ key: 'k'.repeat(1024), keyLength: 5000, value: { t: 'int', v: '1' } }],
      nextCursor: null,
      truncated: false,
    });
    expect(parseDeviceMessage(line, DEVICE_PROTOCOL_V11).ok).toBe(true);
  });

  it('hides the values of views and virtual tables in the second pass', () => {
    const shown = redactStoragePage({
      table: 'v',
      columns: ['id', 'value'],
      pk: [],
      readOnly: 'view',
      rows: [{ cells: [{ t: 'integer', v: '1' }, { t: 'null' }], digest: null }],
      nextCursor: 'not-a-token',
      truncated: false,
    });
    expect(shown.rows[0]!.cells).toEqual([{ t: 'redacted', orig: 'integer' }, { t: 'null' }]);
    expect(shown.nextCursor).toBeNull();
  });

  it('carries the answering link in a write and an audit request', () => {
    const write = {
      store: 'prefs',
      name: 'p',
      op: 'update',
      key: 'k',
      expected: { t: 'int', v: '1' },
      value: { t: 'int', v: '2' },
      target: { serial: 'emulator-5554', packageName: 'com.example.shop', link: 3 },
    };
    expect(parseClientMessage(JSON.stringify({ type: 'storageWrite', requestId: 1, write })).ok).toBe(true);
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'storageWrite', requestId: 1, write: { ...write, target: { link: 3 } } }),
      ).ok,
    ).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'storageAudit', requestId: 2 })).ok).toBe(true);
  });
});

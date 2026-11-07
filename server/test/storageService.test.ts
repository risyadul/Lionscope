import type { ServerMessage, StorageResponse, StorageWriteInput } from '@lionscope/protocol';
import { STORAGE_WRITE_BURST } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { SdkStorageError } from '../src/device/sdkLink.ts';
import type { SdkStorageRequest, SdkStorageResult } from '../src/device/sdkLink.ts';
import type { StorageSessionTarget } from '../src/session/sessionManager.ts';
import { StorageService } from '../src/storage/storageService.ts';
import { storageConsentOf } from '../src/storage/consent.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const SERIAL = 'emulator-5640';
const PKG = 'com.example.shop';
const LONG_MAX = '9223372036854775807';
const SECRET = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

type WriteResult = Extract<SdkStorageResult, { type: 'storageWriteResult' }>;

function harness(options: { consent?: 'off' | 'read' | 'read_write'; version?: number } = {}) {
  const link = new FakeLink(options.version ?? 11);
  let now = 1_000_000;
  let ids = 0;
  let target: StorageSessionTarget | null = { serial: SERIAL, packageName: PKG, link, ready: true };
  const broadcasts: ServerMessage[] = [];
  const service = new StorageService({
    consent: options.consent ?? 'read_write',
    target: () => target,
    broadcast: (message) => broadcasts.push(message),
    now: () => now,
    newOpId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
  return {
    link,
    service,
    broadcasts,
    setTarget: (next: StorageSessionTarget | null) => (target = next),
    advance: (ms: number) => (now += ms),
    /** The SDK answers every write with `answer` (its opId filled in). */
    answerWrites: (
      answer: (request: Extract<SdkStorageRequest, { type: 'storageWrite' }>) => Partial<WriteResult>,
    ) => {
      link.answerStorage = (request) => {
        if (request.type !== 'storageWrite') return Promise.reject(new SdkStorageError('invalid'));
        return Promise.resolve({
          type: 'storageWriteResult',
          requestId: 1,
          opId: request.opId,
          phase: 'final',
          code: 'ok',
          ...answer(request),
        } as WriteResult);
      };
    },
  };
}

const prefsUpdate = (expected: string, value: string, key = 'count'): StorageWriteInput => ({
  store: 'prefs',
  name: 'app_settings',
  op: 'update',
  key,
  expected: { t: 'long', v: expected },
  value: { t: 'long', v: value },
});

const cellUpdate = (expected: string, value: string): StorageWriteInput => ({
  store: 'db',
  name: 'app.db',
  op: 'update',
  table: 'user',
  column: 'name',
  pk: [{ t: 'string', v: 'ana@example.com' }],
  expected: { t: 'string', v: expected },
  value: { t: 'string', v: value },
});

const outcomeOf = (response: StorageResponse) => {
  if (!response.ok || response.kind !== 'write') throw new Error(`not a write: ${JSON.stringify(response)}`);
  return response.outcome;
};

describe('storage consent and link gates', () => {
  it('maps the flags: write alone is off', () => {
    expect(storageConsentOf(false, false)).toBe('off');
    expect(storageConsentOf(false, true)).toBe('off');
    expect(storageConsentOf(true, false)).toBe('read');
    expect(storageConsentOf(true, true)).toBe('read_write');
  });

  it('refuses everything without consent and sends nothing to the device', async () => {
    const { service, link } = harness({ consent: 'off' });
    await expect(service.list()).resolves.toMatchObject({ ok: false, code: 'consent_required' });
    await expect(service.read({ store: 'prefs', name: 'p' })).resolves.toMatchObject({
      code: 'consent_required',
    });
    await expect(service.write(prefsUpdate('1', '2'))).resolves.toMatchObject({ code: 'consent_required' });
    expect(link.storageRequests).toEqual([]);
    // Refused writes are audited too (without values).
    expect(service.auditEntries().map((entry) => entry.code)).toEqual(['consent_required']);
  });

  it('reads but never writes with read consent', async () => {
    const { service, link } = harness({ consent: 'read' });
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageListResult',
        requestId: 1,
        code: 'ok',
        prefs: [],
        prefsTruncated: false,
        databases: [],
      });
    await expect(service.list()).resolves.toMatchObject({ ok: true, kind: 'list' });
    await expect(service.write(prefsUpdate('1', '2'))).resolves.toMatchObject({
      ok: false,
      code: 'consent_required',
    });
    expect(link.storageRequests.map((request) => request.type)).toEqual(['storageList']);
  });

  it('needs a ready session, a v11 session link with the link proof, in that order', async () => {
    const { service, link, setTarget } = harness();
    setTarget(null);
    await expect(service.list()).resolves.toMatchObject({ code: 'needs_profiling_session' });
    setTarget({ serial: SERIAL, packageName: PKG, link, ready: false });
    await expect(service.list()).resolves.toMatchObject({ code: 'needs_profiling_session' });
    setTarget({ serial: SERIAL, packageName: PKG, link: null, ready: true });
    await expect(service.list()).resolves.toMatchObject({ code: 'needs_sdk' });
    link.mode = 'inspect';
    setTarget({ serial: SERIAL, packageName: PKG, link, ready: true });
    await expect(service.list()).resolves.toMatchObject({ code: 'needs_profiling_session' });
    link.mode = 'session';
    link.proven = false;
    await expect(service.list()).resolves.toMatchObject({ code: 'unauthenticated' });
    await expect(service.write(prefsUpdate('1', '2'))).resolves.toMatchObject({ code: 'unauthenticated' });
    expect(link.storageRequests).toEqual([]);

    const old = harness({ version: 10 });
    await expect(old.service.list()).resolves.toMatchObject({ code: 'needs_sdk' });
    expect(old.link.storageRequests).toEqual([]);
  });
});

describe('storage reads', () => {
  it('redacts what the SDK sent once more (a credential in a value, a sensitive column)', async () => {
    const { service, link } = harness({ consent: 'read' });
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        pages: [
          {
            table: 'user',
            columns: ['email', 'access_token', 'note'],
            pk: ['email'],
            readOnly: null,
            rows: [
              {
                cells: [
                  { t: 'string', v: 'ana@example.com' },
                  { t: 'string', v: 'raw-token' },
                  { t: 'string', v: `Bearer ${SECRET}` },
                ],
                digest: 'a'.repeat(64),
              },
            ],
            nextCursor: null,
            truncated: false,
          },
        ],
        txMs: 3,
      });
    const response = await service.read({ store: 'db', name: 'app.db', pages: [{ table: 'user' }] });
    expect(response).toMatchObject({ ok: true, kind: 'pages', txMs: 3 });
    const text = JSON.stringify(response);
    expect(text).not.toContain('raw-token');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('ana@example.com');
    expect(link.storageRequests[0]).toEqual({
      type: 'storageRead',
      store: 'db',
      name: 'app.db',
      pages: '[{"table":"user"}]',
    });
  });

  it('keeps a cut key told apart from the key its prefix names (keyLength)', async () => {
    const { service, link } = harness({ consent: 'read' });
    const prefix = 'k'.repeat(1024);
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        entries: [
          { key: prefix, value: { t: 'int', v: '3' } },
          { key: prefix, keyLength: 1030, value: { t: 'int', v: '3' } },
        ],
        nextCursor: null,
        truncated: false,
      });
    const response = await service.read({ store: 'prefs', name: 'app' });
    if (!response.ok || response.kind !== 'prefs') throw new Error('not prefs');
    expect(response.entries.map((entry) => entry.keyLength)).toEqual([undefined, 1030]);
    expect(response.entries[0]).not.toHaveProperty('keyLength');
  });

  it('answers one request per device at a time, and says what a lost link or timeout means', async () => {
    const { service, link } = harness({ consent: 'read' });
    let release: (value: SdkStorageResult) => void = () => undefined;
    link.answerStorage = () => new Promise((resolve) => (release = resolve));
    const first = service.list();
    await expect(service.list()).resolves.toMatchObject({ code: 'busy' });
    release({
      type: 'storageListResult',
      requestId: 1,
      code: 'ok',
      prefs: [],
      prefsTruncated: false,
      databases: [],
    });
    await expect(first).resolves.toMatchObject({ ok: true });
    link.answerStorage = () => Promise.reject(new SdkStorageError('timeout'));
    await expect(service.list()).resolves.toMatchObject({ code: 'timeout' });
    link.answerStorage = () => Promise.reject(new SdkStorageError('closed'));
    await expect(service.list()).resolves.toMatchObject({ code: 'failed' });
    link.answerStorage = () =>
      Promise.resolve({ type: 'storageReadResult', requestId: 1, code: 'unsupported:encrypted' });
    await expect(service.read({ store: 'prefs', name: 'secure' })).resolves.toMatchObject({
      ok: false,
      code: 'unsupported:encrypted',
    });
    // The SDK's own read budget ran out: rolled back, so the answer does not speak of a write.
    link.answerStorage = () => Promise.resolve({ type: 'storageReadResult', requestId: 1, code: 'timeout' });
    const overrun = await service.read({ store: 'db', name: 'app.db', pages: [{ table: 'item' }] });
    expect(overrun).toMatchObject({ ok: false, code: 'timeout' });
    expect(overrun.ok === false && overrun.message).toMatch(/rolled back: nothing changed/);
    expect(overrun.ok === false && overrun.message).not.toMatch(/write/);
  });
});

describe('storage writes', () => {
  it('sends canonical JSON fields, keeps Long max exact and offers undo only after an ok final answer', async () => {
    const { service, link, answerWrites } = harness();
    answerWrites(() => ({
      memory: 'applied',
      persisted: true,
      observers: 'posted_unverified',
      stored: { t: 'long', v: '9223372036854775806' },
    }));
    const outcome = outcomeOf(await service.write(prefsUpdate(LONG_MAX, '9223372036854775806')));
    expect(link.storageRequests[0]).toMatchObject({
      type: 'storageWrite',
      store: 'prefs',
      op: 'update',
      key: 'count',
      expected: `{"t":"long","v":"${LONG_MAX}"}`,
      value: '{"t":"long","v":"9223372036854775806"}',
    });
    expect(outcome).toMatchObject({ code: 'ok', phase: 'final', late: false, persisted: true });
    expect(outcome.undo).toEqual({
      ...prefsUpdate('9223372036854775806', LONG_MAX),
      undoOf: outcome.opId,
      // Bound to the link it was made on.
      target: { serial: SERIAL, packageName: PKG, link: 1 },
    });
    // The undo goes out once, as a CAS back from the stored value.
    const undone = outcomeOf(await service.write(outcome.undo!));
    expect(undone.code).toBe('ok');
    expect(link.storageRequests[1]).toMatchObject({ expected: '{"t":"long","v":"9223372036854775806"}' });
    await expect(service.write(outcome.undo!)).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('offers no undo for a prefs write not persisted, a conflict, a retry or a delete', async () => {
    const { service, answerWrites } = harness();
    answerWrites(() => ({
      memory: 'applied',
      persisted: false,
      observers: 'posted_unverified',
      stored: { t: 'long', v: '2' },
    }));
    const notPersisted = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(notPersisted.undo).toBeUndefined();
    expect(notPersisted.message).toMatch(/memory only/);

    answerWrites(() => ({ code: 'already_applied_or_concurrent' }));
    const retry = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(retry).toMatchObject({ code: 'already_applied_or_concurrent' });
    expect(retry.undo).toBeUndefined();

    answerWrites(() => ({ code: 'conflict', current: { t: 'long', v: '9' } }));
    expect(outcomeOf(await service.write(prefsUpdate('1', '2')))).toMatchObject({
      code: 'conflict',
      current: { t: 'long', v: '9' },
    });

    answerWrites(() => ({ changes: 1, totalChangesDelta: 2, observers: 'room_invalidation' }));
    const deleted = outcomeOf(
      await service.write({
        store: 'db',
        name: 'app.db',
        op: 'delete',
        table: 'user',
        pk: [{ t: 'integer', v: '1' }],
        rowDigest: 'b'.repeat(64),
      }),
    );
    expect(deleted).toMatchObject({ code: 'ok', changes: 1, totalChangesDelta: 2 });
    expect(deleted.undo).toBeUndefined();
  });

  it('reports REAL -0.0 as stored +0.0 and undoes from the stored value', async () => {
    const { service, answerWrites } = harness();
    answerWrites(() => ({
      stored: { t: 'real', v: '0.0', bits: '0x0000000000000000' },
      normalized: true,
      changes: 1,
      totalChangesDelta: 1,
      observers: 'room_invalidation',
    }));
    const outcome = outcomeOf(
      await service.write({
        store: 'db',
        name: 'app.db',
        op: 'update',
        table: 'm',
        column: 'x',
        pk: [{ t: 'integer', v: '1' }],
        expected: { t: 'real', v: '1.5', bits: '0x3ff8000000000000' },
        value: { t: 'real', v: '-0.0', bits: '0x8000000000000000' },
      }),
    );
    expect(outcome).toMatchObject({ normalized: true, stored: { bits: '0x0000000000000000' } });
    expect(outcome.undo).toMatchObject({
      expected: { bits: '0x0000000000000000' },
      value: { bits: '0x3ff8000000000000' },
    });
  });

  it('refuses before sending: NaN or a lone surrogate (database and prefs), prefs types in a database, a sensitive column', async () => {
    const { service, link } = harness();
    const nan = await service.write({
      ...(cellUpdate('a', 'b') as Extract<StorageWriteInput, { store: 'db'; op: 'update' }>),
      expected: { t: 'real', v: '1.0', bits: '0x3ff0000000000000' },
      value: { t: 'real', v: 'NaN', bits: '0x7ff8000000000000' },
    });
    expect(nan).toMatchObject({ ok: false, code: 'invalid_value:nan_not_storable' });
    const lone = await service.write({
      ...(cellUpdate('a', 'b') as Extract<StorageWriteInput, { store: 'db'; op: 'update' }>),
      value: { t: 'string', v: 'lone \ud800 high' },
    });
    expect(lone).toMatchObject({ ok: false, code: 'invalid_value:lone_surrogate' });
    const prefsLone = await service.write({
      store: 'prefs',
      name: 'app_settings',
      op: 'update',
      key: 'name',
      expected: { t: 'string', v: 'Ana' },
      value: { t: 'string', v: 'lone \ud800 x' },
    });
    expect(prefsLone).toMatchObject({ ok: false, code: 'invalid_value:lone_surrogate' });
    const setLone = await service.write({
      store: 'prefs',
      name: 'app_settings',
      op: 'update',
      key: 'tags',
      expected: { t: 'stringSet', v: ['a'] },
      value: { t: 'stringSet', v: ['a', 'lone \udc00'] },
    });
    expect(setLone).toMatchObject({ ok: false, code: 'invalid_value:lone_surrogate' });
    const wrongType = await service.write({
      ...(cellUpdate('a', 'b') as Extract<StorageWriteInput, { store: 'db'; op: 'update' }>),
      value: { t: 'long', v: '5' },
    });
    expect(wrongType).toMatchObject({ code: 'type_mismatch' });
    const sensitive = await service.write({
      ...(cellUpdate('a', 'b') as Extract<StorageWriteInput, { store: 'db'; op: 'update' }>),
      column: 'password',
    });
    expect(sensitive).toMatchObject({ code: 'read_only:redacted' });
    expect(link.storageRequests).toEqual([]);
  });

  it('rate-limits writes per device: a burst, then busy', async () => {
    const { service, answerWrites, advance } = harness();
    answerWrites(() => ({ code: 'conflict', current: { t: 'long', v: '0' } }));
    const codes: string[] = [];
    for (let i = 0; i <= STORAGE_WRITE_BURST; i += 1) {
      const response = await service.write(prefsUpdate('1', '2'));
      codes.push(response.ok ? outcomeOf(response).code : response.code);
    }
    expect(codes.slice(0, STORAGE_WRITE_BURST).every((code) => code === 'conflict')).toBe(true);
    expect(codes.at(-1)).toBe('busy');
    advance(1000);
    await expect(service.write(prefsUpdate('1', '2'))).resolves.toMatchObject({ ok: true });
  });

  it('keeps a timeout a timeout: the late final answer is audited late, broadcast, never undoable', async () => {
    const { service, link, broadcasts } = harness();
    link.answerStorage = () => Promise.reject(new SdkStorageError('timeout'));
    const timedOut = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(timedOut).toMatchObject({ code: 'timeout', late: false });
    expect(timedOut.undo).toBeUndefined();
    service.onLateResult(
      { serial: SERIAL, packageName: PKG, link, ready: true },
      {
        type: 'storageWriteResult',
        requestId: 1,
        opId: timedOut.opId,
        phase: 'final',
        code: 'ok',
        memory: 'applied',
        persisted: true,
        observers: 'posted_unverified',
        stored: { t: 'long', v: '2' },
      },
    );
    expect(broadcasts).toEqual([
      {
        type: 'storageOutcome',
        serial: SERIAL,
        outcome: expect.objectContaining({ opId: timedOut.opId, code: 'ok', late: true, phase: 'final' }),
      },
    ]);
    const late = broadcasts[0] as Extract<ServerMessage, { type: 'storageOutcome' }>;
    expect(late.outcome.undo).toBeUndefined();
    expect(service.auditEntries(timedOut.opId).map((entry) => [entry.code, entry.late])).toEqual([
      ['timeout', false],
      ['ok', true],
    ]);
    // A second final, or one for another device, changes nothing.
    service.onLateResult(
      { serial: SERIAL, packageName: PKG, link, ready: true },
      {
        type: 'storageWriteResult',
        requestId: 1,
        opId: timedOut.opId,
        phase: 'final',
        code: 'ok',
      },
    );
    expect(broadcasts).toHaveLength(1);
    // Retry by hand after the lost answer: the SDK finds the value already there.
    link.answerStorage = (request) =>
      Promise.resolve({
        type: 'storageWriteResult',
        requestId: 2,
        opId: (request as { opId: string }).opId,
        phase: 'final',
        code: 'already_applied_or_concurrent',
      });
    const retry = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(retry.code).toBe('already_applied_or_concurrent');
    expect(new Set(service.auditEntries().map((entry) => entry.opId)).size).toBe(2);
  });

  it('follows a provisional prefs answer with its final one, not late, still without undo', async () => {
    const { service, link, broadcasts } = harness();
    link.answerStorage = (request) =>
      Promise.resolve({
        type: 'storageWriteResult',
        requestId: 1,
        opId: (request as { opId: string }).opId,
        phase: 'provisional',
        code: 'ok',
        memory: 'applied',
        persisted: 'timeout',
        observers: 'posted_unverified',
        stored: { t: 'long', v: '2' },
      });
    const provisional = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(provisional).toMatchObject({ phase: 'provisional', persisted: 'timeout' });
    expect(provisional.undo).toBeUndefined();
    service.onLateResult(
      { serial: SERIAL, packageName: PKG, link, ready: true },
      {
        type: 'storageWriteResult',
        requestId: 1,
        opId: provisional.opId,
        phase: 'final',
        code: 'ok',
        persisted: true,
        memory: 'applied',
      },
    );
    expect(broadcasts[0]).toMatchObject({ outcome: { phase: 'final', persisted: true, late: false } });
    expect(
      (broadcasts[0] as Extract<ServerMessage, { type: 'storageOutcome' }>).outcome.undo,
    ).toBeUndefined();
  });

  describe('a final answer that comes while its request is still settling here', () => {
    const target = (link: unknown): StorageSessionTarget =>
      ({ serial: SERIAL, packageName: PKG, link, ready: true }) as StorageSessionTarget;
    const result = (
      opId: string,
      phase: 'provisional' | 'final',
      extra: Partial<WriteResult> = {},
    ): WriteResult =>
      ({
        type: 'storageWriteResult',
        requestId: 1,
        opId,
        phase,
        code: 'ok',
        memory: 'applied',
        persisted: phase === 'final' ? true : 'timeout',
        observers: 'posted_unverified',
        stored: { t: 'long', v: '2' },
        ...extra,
      }) as WriteResult;

    it('keeps a final that arrives with its provisional (one chunk) and records it once the provisional is', async () => {
      const { service, link, broadcasts } = harness();
      link.answerStorage = (request) => {
        const opId = (request as { opId: string }).opId;
        // The gateway settles the request with the provisional line and hands the final line of the same chunk
        // on at once: before write() gets to run on.
        queueMicrotask(() => service.onLateResult(target(link), result(opId, 'final')));
        return Promise.resolve(result(opId, 'provisional'));
      };
      const response = outcomeOf(await service.write(prefsUpdate('1', '2')));
      expect(response).toMatchObject({ phase: 'provisional', persisted: 'timeout', late: false });
      expect(response.undo).toBeUndefined();
      expect(
        service.auditEntries(response.opId).map((entry) => [entry.phase, entry.late, entry.persisted]),
      ).toEqual([
        ['provisional', false, 'timeout'],
        ['final', false, true],
      ]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        type: 'storageOutcome',
        outcome: { opId: response.opId, phase: 'final', persisted: true, late: false },
      });
      expect(
        (broadcasts[0] as Extract<ServerMessage, { type: 'storageOutcome' }>).outcome.undo,
      ).toBeUndefined();
    });

    it('records a final that arrives right as the request times out as late, never undoable', async () => {
      const { service, link, broadcasts } = harness();
      link.answerStorage = (request) => {
        const opId = (request as { opId: string }).opId;
        queueMicrotask(() => service.onLateResult(target(link), result(opId, 'final')));
        return Promise.reject(new SdkStorageError('timeout'));
      };
      const response = outcomeOf(await service.write(prefsUpdate('1', '2')));
      expect(response).toMatchObject({ code: 'timeout', late: false });
      expect(response.undo).toBeUndefined();
      expect(service.auditEntries(response.opId).map((entry) => [entry.code, entry.late])).toEqual([
        ['timeout', false],
        ['ok', true],
      ]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({ outcome: { opId: response.opId, late: true, phase: 'final' } });
    });

    it('takes one final per write: a duplicate, or a provisional after it, changes nothing', async () => {
      const { service, link, broadcasts } = harness();
      link.answerStorage = (request) => {
        const opId = (request as { opId: string }).opId;
        queueMicrotask(() => {
          service.onLateResult(target(link), result(opId, 'final'));
          service.onLateResult(target(link), result(opId, 'final', { persisted: false }));
          service.onLateResult(target(link), result(opId, 'provisional'));
        });
        return Promise.resolve(result(opId, 'provisional'));
      };
      const response = outcomeOf(await service.write(prefsUpdate('1', '2')));
      service.onLateResult(target(link), result(response.opId, 'final', { persisted: false }));
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({ outcome: { persisted: true } });
      expect(service.auditEntries(response.opId)).toHaveLength(2);
    });

    it('drops the final of a request already answered final (the usual case: no second record)', async () => {
      const { service, link, broadcasts } = harness();
      link.answerStorage = (request) => {
        const opId = (request as { opId: string }).opId;
        queueMicrotask(() => service.onLateResult(target(link), result(opId, 'final')));
        return Promise.resolve(result(opId, 'final'));
      };
      const response = outcomeOf(await service.write(prefsUpdate('1', '2')));
      expect(response.phase).toBe('final');
      expect(response.undo).toBeDefined();
      expect(broadcasts).toHaveLength(0);
      expect(service.auditEntries(response.opId)).toHaveLength(1);
    });
  });

  it('offers no undo when what is stored now came back cut (a trigger grew it)', async () => {
    const { service, answerWrites } = harness();
    answerWrites(() => ({
      changes: 1,
      totalChangesDelta: 2,
      normalized: true,
      observers: 'room_invalidation',
      stored: { t: 'string', v: 'x'.repeat(16), complete: false, length: 300000 },
    }));
    const outcome = outcomeOf(await service.write(cellUpdate('Ana', 'Ann')));
    expect(outcome).toMatchObject({
      code: 'ok',
      normalized: true,
      stored: { complete: false, length: 300000 },
    });
    expect(outcome.undo).toBeUndefined();
    answerWrites(() => ({ stored: { t: 'blob', b64: 'AA==', size: 300000, complete: false }, changes: 1 }));
    expect(outcomeOf(await service.write(cellUpdate('Ann', 'Ana'))).undo).toBeUndefined();
  });

  it('audits every write without values: names of credentials replaced, the key as a digest', async () => {
    const { service, answerWrites } = harness();
    answerWrites(() => ({ code: 'conflict', current: { t: 'string', v: 'zz-current' } }));
    await service.write(cellUpdate('Ana', 'Ann'));
    await service.write(prefsUpdate(LONG_MAX, '1', 'auth_token'));
    const audit = JSON.stringify(service.auditEntries());
    for (const value of ['Ana', 'Ann', 'zz-current', 'ana@example.com', LONG_MAX]) {
      expect(audit).not.toContain(value);
    }
    const [cell, secret] = service.auditEntries();
    expect(cell).toMatchObject({ store: 'db', table: 'user', field: 'name', op: 'update', code: 'conflict' });
    expect(cell?.pkDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).toMatchObject({ field: '[redacted-name]', code: 'read_only:redacted' });
  });
});

describe('storage identity: what was read or offered on one link never goes to another', () => {
  const okWrite = (link: FakeLink) => {
    link.answerStorage = (request) =>
      Promise.resolve({
        type: 'storageWriteResult',
        requestId: 1,
        opId: (request as { opId: string }).opId,
        phase: 'final',
        code: 'ok',
        memory: 'applied',
        persisted: true,
        observers: 'posted_unverified',
        stored: { t: 'long', v: '2' },
      } as WriteResult);
  };

  it('tells links apart in every answer', async () => {
    const { service, link, setTarget } = harness({ consent: 'read' });
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageListResult',
        requestId: 1,
        code: 'ok',
        prefs: [],
        prefsTruncated: false,
        databases: [],
      });
    await expect(service.list()).resolves.toMatchObject({
      target: { serial: SERIAL, packageName: PKG, link: 1 },
    });
    await expect(service.list()).resolves.toMatchObject({ target: { link: 1 } });
    const next = new FakeLink(11);
    next.answerStorage = link.answerStorage;
    setTarget({ serial: SERIAL, packageName: PKG, link: next, ready: true });
    await expect(service.list()).resolves.toMatchObject({ target: { link: 2 } });
  });

  it('refuses an undo on another app of the same device, before sending it', async () => {
    const { service, link, setTarget } = harness();
    okWrite(link);
    const outcome = outcomeOf(await service.write(prefsUpdate('1', '2')));
    expect(outcome.undo).toBeDefined();
    const second = new FakeLink(11);
    okWrite(second);
    setTarget({ serial: SERIAL, packageName: 'com.example.second', link: second, ready: true });
    // The undo as offered (naming its target), and the same without it: both refused, nothing sent.
    await expect(service.write(outcome.undo!)).resolves.toMatchObject({ ok: false, code: 'failed' });
    const { target: _target, ...bare } = outcome.undo as Extract<StorageWriteInput, { op: 'update' }>;
    const refused = await service.write(bare);
    expect(refused).toMatchObject({ ok: false, code: 'failed' });
    expect(refused.ok === false && refused.message).toMatch(/cannot be undone/);
    expect(second.storageRequests).toEqual([]);
  });

  it('refuses an undo and a bound edit after a restart or reconnect of the same app (a new link)', async () => {
    const { service, link, setTarget } = harness();
    okWrite(link);
    const outcome = outcomeOf(
      await service.write({
        ...prefsUpdate('1', '2'),
        target: { serial: SERIAL, packageName: PKG, link: 1 },
      }),
    );
    expect(outcome.undo).toBeDefined();
    const restarted = new FakeLink(11);
    okWrite(restarted);
    setTarget({ serial: SERIAL, packageName: PKG, link: restarted, ready: true });
    await expect(service.write(outcome.undo!)).resolves.toMatchObject({ ok: false, code: 'failed' });
    const stale = await service.write({
      ...prefsUpdate('2', '3'),
      target: { serial: SERIAL, packageName: PKG, link: 1 },
    });
    expect(stale).toMatchObject({ ok: false, code: 'failed' });
    expect(stale.ok === false && stale.message).toMatch(
      /another one than the one these values were read from/,
    );
    expect(restarted.storageRequests).toEqual([]);
    // Read again (the new link's target): it goes.
    await expect(
      service.write({ ...prefsUpdate('2', '3'), target: { serial: SERIAL, packageName: PKG, link: 2 } }),
    ).resolves.toMatchObject({ ok: true });
    expect(restarted.storageRequests).toHaveLength(1);
  });

  it('refuses an undo after the session stopped and another started', async () => {
    const { service, link, setTarget } = harness();
    okWrite(link);
    const outcome = outcomeOf(await service.write(prefsUpdate('1', '2')));
    setTarget(null);
    await expect(service.write(outcome.undo!)).resolves.toMatchObject({ code: 'needs_profiling_session' });
    const fresh = new FakeLink(11);
    okWrite(fresh);
    setTarget({ serial: SERIAL, packageName: PKG, link: fresh, ready: true });
    await expect(service.write(outcome.undo!)).resolves.toMatchObject({ ok: false, code: 'failed' });
    expect(fresh.storageRequests).toEqual([]);
  });
});

describe('storage pages: cursors and views', () => {
  const page = (overrides: Record<string, unknown>) => ({
    table: 't',
    columns: ['id', 'value'],
    pk: ['id'],
    readOnly: null,
    rows: [
      {
        cells: [
          { t: 'integer', v: '1' },
          { t: 'string', v: 'fixture-secret-in-view' },
        ],
        digest: null,
      },
    ],
    nextCursor: null,
    truncated: false,
    ...overrides,
  });

  it('hides every value of a view or virtual table, whatever its columns are called', async () => {
    const { service, link } = harness({ consent: 'read' });
    for (const readOnly of ['view', 'virtual']) {
      link.answerStorage = () =>
        Promise.resolve({
          type: 'storageReadResult',
          requestId: 1,
          code: 'ok',
          pages: [page({ readOnly })],
          txMs: 1,
        } as SdkStorageResult);
      const response = await service.read({ store: 'db', name: 'app.db', pages: [{ table: 't' }] });
      expect(JSON.stringify(response)).not.toContain('fixture-secret');
      expect(response).toMatchObject({
        kind: 'pages',
        pages: [
          {
            rows: [
              {
                cells: [
                  { t: 'redacted', orig: 'integer' },
                  { t: 'redacted', orig: 'string' },
                ],
              },
            ],
          },
        ],
      });
    }
  });

  it('passes only an opaque cursor token on, never one that could carry a key value', async () => {
    const { service, link } = harness({ consent: 'read' });
    const token = 'c1.00000000000000000000000000000abc';
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        pages: [page({ nextCursor: token })],
        txMs: 1,
      } as SdkStorageResult);
    await expect(
      service.read({ store: 'db', name: 'app.db', pages: [{ table: 't' }] }),
    ).resolves.toMatchObject({
      pages: [{ nextCursor: token }],
    });
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        pages: [page({ nextCursor: '{"k":[{"t":"string","v":"fixture-secret-alpha"}]}' })],
        txMs: 1,
      } as SdkStorageResult);
    const response = await service.read({ store: 'db', name: 'app.db', pages: [{ table: 't' }] });
    expect(JSON.stringify(response)).not.toContain('fixture-secret-alpha');
  });

  it('serves the write audit to readers only', async () => {
    expect(harness({ consent: 'off' }).service.auditResponse()).toMatchObject({
      ok: false,
      code: 'consent_required',
    });
    const { service } = harness({ consent: 'read' });
    await service.write(prefsUpdate('1', '2'));
    expect(service.auditResponse()).toMatchObject({
      ok: true,
      kind: 'audit',
      entries: [{ code: 'consent_required' }],
    });
  });
});

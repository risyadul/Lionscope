import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GatewayMessage, ServerMessage, StorageQueryInput } from '@lionscope/protocol';
import { gatewayLine } from '../src/device/deviceGateway.ts';
import { SdkStorageError } from '../src/device/sdkLink.ts';
import type { SdkStorageResult } from '../src/device/sdkLink.ts';
import { StorageService } from '../src/storage/storageService.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const query: StorageQueryInput = {
  name: 'shop.db',
  sql: 'SELECT 1',
  target: { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 },
};

function setup(consent: 'off' | 'read' | 'read_write' = 'read_write', version = 13) {
  const link = new FakeLink(version);
  const target = { serial: query.target.serial, packageName: query.target.packageName, link, ready: true };
  const broadcasts: ServerMessage[] = [];
  const service = new StorageService({
    consent,
    target: () => target,
    broadcast: (message) => broadcasts.push(message),
  });
  link.answerStorage = async (request) => {
    if (request.type !== 'storageQuery') throw new SdkStorageError('invalid');
    return {
      type: 'storageWriteResult',
      requestId: 1,
      opId: request.opId,
      code: 'ok',
      phase: 'final',
      changes: 1,
      query: {
        readOnly: request.sql.startsWith('SELECT'),
        columns: [],
        rows: [],
        hasMore: false,
        truncated: false,
        offset: request.offset,
      },
    };
  };
  return { link, service, target, broadcasts };
}

describe('SQL service', () => {
  it('sends registered-database SQL only with proof, consent, v13 and the original target', async () => {
    const read = setup('read');
    expect(await read.service.query(query)).toMatchObject({
      ok: true,
      kind: 'query',
      outcome: { code: 'ok' },
    });
    expect(read.service.auditEntries()).toEqual([]);
    expect(
      await read.service.query({ ...query, sql: 'WITH x AS (SELECT 1) DELETE FROM item' }),
    ).toMatchObject({ ok: false, code: 'consent_required' });
    expect(await setup('off').service.query(query)).toMatchObject({ ok: false, code: 'consent_required' });
    expect(await setup('read_write', 12).service.query(query)).toMatchObject({
      ok: false,
      code: 'needs_sdk',
    });
    const stale = setup();
    expect(await stale.service.query({ ...query, target: { ...query.target, link: 2 } })).toMatchObject({
      ok: false,
    });
    expect(stale.link.storageRequests).toHaveLength(0);
    stale.link.proven = false;
    expect(await stale.service.query(query)).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('audits mutations without SQL, literal values or undo', async () => {
    const { service } = setup();
    const response = await service.query({ ...query, sql: "UPDATE item SET password='synthetic-secret'" });
    expect(response).toMatchObject({ ok: true, kind: 'query', outcome: { code: 'ok', changes: 1 } });
    if (response.ok && response.kind === 'query') expect(response.outcome.undo).toBeUndefined();
    expect(service.auditEntries()).toMatchObject([
      { op: 'query', table: 'item', field: null, pkDigest: null },
    ]);
    expect(JSON.stringify(service.auditEntries())).not.toContain('synthetic-secret');
    expect(JSON.stringify(service.auditEntries())).not.toContain('UPDATE');
  });

  it('never retries a timed-out mutation and publishes its final outcome once', async () => {
    const { service, link, target, broadcasts } = setup();
    let opId = '';
    link.answerStorage = async (request) => {
      if (request.type === 'storageQuery') opId = request.opId;
      throw new SdkStorageError('timeout');
    };
    expect(await service.query({ ...query, sql: 'DELETE FROM item' })).toMatchObject({
      ok: true,
      kind: 'query',
      outcome: { code: 'timeout' },
    });
    const late: Extract<SdkStorageResult, { type: 'storageWriteResult' }> = {
      type: 'storageWriteResult',
      requestId: 1,
      opId,
      phase: 'final',
      code: 'ok',
      changes: 4,
    };
    service.onLateResult(target, late);
    service.onLateResult(target, late);
    expect(link.storageRequests).toHaveLength(1);
    expect(broadcasts).toMatchObject([{ type: 'storageOutcome', outcome: { late: true, changes: 4 } }]);
    expect(service.auditEntries()).toHaveLength(2);
  });

  it('rejects multiple statements and invalid paging without sending them', async () => {
    const { service, link } = setup();
    expect(await service.query({ ...query, sql: 'SELECT 1; DELETE FROM item' })).toHaveProperty('ok', false);
    expect(await service.query({ ...query, offset: -1 })).toHaveProperty('ok', false);
    expect(link.storageRequests).toHaveLength(0);
  });

  it('serializes the v13 flat golden requests byte for byte', () => {
    const lines = readFileSync(
      new URL('../../protocol/fixtures/gateway-storage-query.ndjson', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n');
    for (const line of lines) {
      const request: GatewayMessage = JSON.parse(line);
      expect(gatewayLine(request)).toBe(line + '\n');
    }
  });
});

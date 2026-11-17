import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, StorageQueryInput } from '@lionscope/protocol';
import { AGENT_TOOLS, availableTools, callTool } from '../src/agent/registry.ts';
import { UNTRUSTED_NOTE } from '../src/agent/tool.ts';
import { SdkStorageError } from '../src/device/sdkLink.ts';
import { log } from '../src/log.ts';
import { StorageService } from '../src/storage/storageService.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const query: StorageQueryInput = {
  name: 'shop.db',
  sql: 'SELECT id FROM item',
  target: { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 },
};

function setup(consent: 'off' | 'read' | 'read_write' = 'read_write', version = 13) {
  const agent = fakeAgent();
  const link = new FakeLink(version);
  const target = { serial: query.target.serial, packageName: query.target.packageName, link, ready: true };
  const broadcasts: ServerMessage[] = [];
  const service = new StorageService({
    consent,
    target: () => target,
    broadcast: (message) => broadcasts.push(message),
  });
  agent.ctx.storage = service;
  link.answerStorage = async (request) => {
    if (request.type !== 'storageQuery') throw new SdkStorageError('invalid');
    return {
      type: 'storageWriteResult',
      requestId: 1,
      opId: request.opId,
      code: 'ok',
      phase: 'final',
      changes: 3,
      query: {
        readOnly: true,
        columns: ['id'],
        rows: [[{ t: 'integer', v: '9007199254740993' }]],
        hasMore: true,
        truncated: false,
        offset: request.offset,
      },
    };
  };
  return { agent, link, service, target, broadcasts };
}

afterEach(() => vi.restoreAllMocks());

describe('SQL agent tools', () => {
  it('lists read and mutation tools only under their respective server consent', () => {
    for (const deviceControl of [false, true]) {
      const names = (consent: 'off' | 'read' | 'read_write') =>
        availableTools(deviceControl, consent).map((t) => t.name);
      expect(names('off')).not.toContain('query_storage_sql');
      expect(names('off')).not.toContain('execute_storage_sql');
      expect(names('read')).toContain('query_storage_sql');
      expect(names('read')).not.toContain('execute_storage_sql');
      expect(names('read_write')).toEqual(
        expect.arrayContaining(['query_storage_sql', 'execute_storage_sql']),
      );
    }
    expect(AGENT_TOOLS.find((t) => t.name === 'query_storage_sql')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(AGENT_TOOLS.find((t) => t.name === 'execute_storage_sql')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it.each(['SELECT id FROM item', '/* synthetic */ WITH x AS (SELECT id FROM item) SELECT * FROM x'])(
    'returns typed rows and paging for %s',
    async (sql) => {
      const { agent, link, service } = setup('read');
      const result = await callTool(
        agent.ctx,
        'query_storage_sql',
        { ...query, sql, limit: 2, offset: 4 },
        false,
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          untrusted: UNTRUSTED_NOTE,
          target: query.target,
          readOnly: true,
          outcome: {
            code: 'ok',
            query: { rows: [[{ t: 'integer', v: '9007199254740993' }]], hasMore: true, offset: 4 },
          },
        },
      });
      expect(link.storageRequests).toMatchObject([
        { type: 'storageQuery', name: 'shop.db', sql, limit: 2, offset: 4 },
      ]);
      expect(service.auditEntries()).toEqual([]);
    },
  );

  it('keeps SQL mutation outcomes, operation ids and audit metadata without literals or undo', async () => {
    const { agent, link, service } = setup();
    const sql = "UPDATE item SET password='synthetic-secret' WHERE id=1";
    const result = await callTool(agent.ctx, 'execute_storage_sql', { ...query, sql }, false);
    expect(result).toMatchObject({
      ok: true,
      result: {
        readOnly: false,
        outcome: { code: 'ok', phase: 'final', changes: 3, opId: expect.any(String) },
      },
    });
    if (!result.ok) throw new Error('Expected mutation outcome');
    expect(result.result).not.toHaveProperty('outcome.undo');
    expect(link.storageRequests).toHaveLength(1);
    expect(service.auditEntries()).toMatchObject([{ op: 'query', table: 'item', changes: 3 }]);
    expect(JSON.stringify(service.auditEntries())).not.toMatch(/synthetic-secret|UPDATE/);
  });

  it.each([
    'INSERT INTO item(id) VALUES(1)',
    'UPDATE item SET qty=1',
    'DELETE FROM item',
    'WITH x AS (SELECT 1) DELETE FROM item',
  ])('blocks mutation SQL on the read tool: %s', async (sql) => {
    const { agent, link } = setup();
    expect(await callTool(agent.ctx, 'query_storage_sql', { ...query, sql }, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('reads only'),
    });
    expect(link.storageRequests).toHaveLength(0);
  });

  it('blocks read SQL on the destructive tool and rejects SQL outside the console grammar', async () => {
    const { agent, link } = setup();
    expect(await callTool(agent.ctx, 'execute_storage_sql', query, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('INSERT/UPDATE/DELETE only'),
    });
    for (const sql of [
      'SELECT 1; DELETE FROM item',
      'PRAGMA user_version',
      'CREATE TABLE x(id)',
      'BEGIN',
      "ATTACH DATABASE 'x' AS x",
      'UPDATE OR ROLLBACK item SET qty=1',
      'SELECT ?',
    ]) {
      expect(await callTool(agent.ctx, 'query_storage_sql', { ...query, sql }, false)).toMatchObject({
        ok: false,
      });
    }
    expect(link.storageRequests).toHaveLength(0);
  });

  it('requires consent independently of device control and blocks unsupported/proofless/stale links', async () => {
    const off = setup('off');
    expect(await callTool(off.agent.ctx, 'query_storage_sql', query, true)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const read = setup('read');
    expect(
      await callTool(read.agent.ctx, 'execute_storage_sql', { ...query, sql: 'DELETE FROM item' }, true),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    const old = setup('read_write', 12);
    expect(await callTool(old.agent.ctx, 'query_storage_sql', query, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('needs_sdk'),
    });
    const noProof = setup();
    noProof.link.proven = false;
    expect(await callTool(noProof.agent.ctx, 'query_storage_sql', query, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unauthenticated'),
    });
    const stale = setup();
    await callTool(stale.agent.ctx, 'query_storage_sql', query, false);
    stale.target.link = new FakeLink(13);
    expect(
      await callTool(stale.agent.ctx, 'execute_storage_sql', { ...query, sql: 'DELETE FROM item' }, false),
    ).toMatchObject({ ok: false, error: expect.stringContaining('link') });
    expect(stale.target.link.storageRequests).toHaveLength(0);
    expect(
      off.link.storageRequests.concat(
        read.link.storageRequests,
        old.link.storageRequests,
        noProof.link.storageRequests,
      ),
    ).toHaveLength(0);
  });

  it.each([{ target: undefined }, { limit: 201 }, { offset: -1 }, { sql: 'x'.repeat(16_385) }])(
    'validates required target and read bounds: %j',
    async (overrides) => {
      const { agent, link } = setup();
      expect(await callTool(agent.ctx, 'query_storage_sql', { ...query, ...overrides }, false)).toMatchObject(
        { ok: false, code: 'invalid_arguments' },
      );
      expect(link.storageRequests).toHaveLength(0);
    },
  );

  it('returns uncertain mutation outcomes once and makes a late final discoverable by opId', async () => {
    const { agent, link, service, target, broadcasts } = setup();
    let opId = '';
    link.answerStorage = async (request) => {
      if (request.type === 'storageQuery') opId = request.opId;
      throw new SdkStorageError('timeout');
    };
    expect(
      await callTool(agent.ctx, 'execute_storage_sql', { ...query, sql: 'DELETE FROM item' }, false),
    ).toMatchObject({
      ok: true,
      result: {
        outcome: { code: 'timeout', opId: expect.any(String) },
        note: expect.stringContaining('never retry'),
      },
    });
    expect(link.storageRequests).toHaveLength(1);
    const late = {
      type: 'storageWriteResult' as const,
      requestId: 1,
      opId,
      phase: 'final' as const,
      code: 'ok' as const,
      changes: 4,
    };
    service.onLateResult(target, late);
    service.onLateResult(target, late);
    const audit = await callTool(agent.ctx, 'get_storage_audit', { opId }, false);
    expect(audit).toMatchObject({
      ok: true,
      result: { entries: [{ code: 'timeout' }, { code: 'ok', late: true, changes: 4 }] },
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).not.toHaveProperty('outcome.undo');
    expect(link.storageRequests).toHaveLength(1);
  });

  it('does not leak SQL through unexpected exception messages or registry logging', async () => {
    const { agent, service } = setup();
    const warn = vi.spyOn(log, 'warn');
    vi.spyOn(service, 'query').mockRejectedValueOnce(new Error('UPDATE item SET password=synthetic-secret'));
    const result = await callTool(
      agent.ctx,
      'execute_storage_sql',
      { ...query, sql: 'DELETE FROM item' },
      false,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('may already have committed') });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(warn).not.toHaveBeenCalled();
  });
});

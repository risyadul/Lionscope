import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runQueryCommand } from '../src/cli/queryCommand.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { StorageService } from '../src/storage/storageService.ts';
import { SdkStorageError } from '../src/device/sdkLink.ts';
import { connectStdio } from './helpers/agentProcess.ts';
import { FakeLink } from './helpers/sdkSession.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { FakeAdb } from './helpers/fakes.ts';

describe('SQL over MCP and CLI against a running server', () => {
  let server: LionscopeServer;
  let port: number;
  const link = new FakeLink(13);
  const target = { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 };

  beforeAll(async () => {
    server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb: new FakeAdb(() => ''),
      emulatorHost: noEmulatorHost(),
      dashboardDir: '/nonexistent/dist',
      allowStorageRead: true,
      allowStorageWrite: true,
    });
    port = (await server.listen()).port;
    const service = new StorageService({
      consent: 'read_write',
      target: () => ({ serial: target.serial, packageName: target.packageName, link, ready: true }),
    });
    server.agent.storage = service;
    link.answerStorage = async (request) => {
      if (request.type === 'storageList')
        return {
          type: 'storageListResult',
          requestId: 1,
          code: 'ok',
          prefs: [],
          prefsTruncated: false,
          databases: [{ name: 'shop.db', status: 'ok' }],
        };
      if (request.type !== 'storageQuery') throw new SdkStorageError('invalid');
      return {
        type: 'storageWriteResult',
        requestId: 1,
        opId: request.opId,
        code: 'ok',
        phase: 'final',
        changes: 2,
        query: {
          readOnly: request.sql.startsWith('SELECT'),
          columns: ['qty'],
          rows: [[{ t: 'integer', v: '42' }]],
          hasMore: false,
          truncated: false,
          offset: request.offset,
        },
      };
    };
  });

  afterAll(async () => {
    await server?.close();
  });

  it('discovers both SQL tools over MCP and round-trips rows, target-bound mutations and audit', async () => {
    const { client } = await connectStdio([
      '--port',
      String(port),
      '--allow-storage-read',
      '--allow-storage-write',
    ]);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['query_storage_sql', 'execute_storage_sql']),
      );
      const listed = await client.callTool({ name: 'list_storage', arguments: {} });
      expect(listed.structuredContent).toMatchObject({ target, databases: [{ name: 'shop.db' }] });
      const data = listed.structuredContent;
      if (typeof data !== 'object' || data === null || !('target' in data)) throw new Error('Missing target');
      const currentTarget = data.target;
      const read = await client.callTool({
        name: 'query_storage_sql',
        arguments: { name: 'shop.db', sql: 'SELECT qty FROM item', target: currentTarget },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        readOnly: true,
        outcome: { code: 'ok', query: { rows: [[{ t: 'integer', v: '42' }]] } },
      });
      const write = await client.callTool({
        name: 'execute_storage_sql',
        arguments: { name: 'shop.db', sql: 'UPDATE item SET qty=42', target: currentTarget },
      });
      expect(write.isError).not.toBe(true);
      expect(write.structuredContent).toMatchObject({ readOnly: false, outcome: { code: 'ok', changes: 2 } });
      expect(write.structuredContent).not.toHaveProperty('outcome.undo');
      const audit = await client.callTool({ name: 'get_storage_audit', arguments: { last: 1 } });
      expect(audit.structuredContent).toMatchObject({
        entries: [{ op: 'query', table: 'item', code: 'ok' }],
      });
      expect(JSON.stringify(audit.structuredContent)).not.toContain('UPDATE item');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('keeps a read-only MCP client from listing or invoking the mutation tool', async () => {
    const { client } = await connectStdio(['--port', String(port), '--allow-storage-read']);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('query_storage_sql');
      expect(names).not.toContain('execute_storage_sql');
      const count = link.storageRequests.length;
      await expect(
        client.callTool({
          name: 'execute_storage_sql',
          arguments: { name: 'shop.db', sql: 'DELETE FROM item', target },
        }),
      ).rejects.toThrow();
      expect(link.storageRequests).toHaveLength(count);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('accepts SQL/target JSON through CLI aliases and returns typed results', async () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      const code = await runQueryCommand(
        [
          'query-storage-sql',
          '--port',
          String(port),
          '--json',
          JSON.stringify({ name: 'shop.db', sql: 'SELECT qty FROM item', target, limit: 1 }),
        ],
        {},
      );
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        readOnly: true,
        outcome: { query: { rows: [[{ t: 'integer', v: '42' }]] } },
      });
      output = '';
      expect(
        await runQueryCommand(
          [
            'execute-storage-sql',
            '--port',
            String(port),
            '--json',
            JSON.stringify({ name: 'shop.db', sql: 'DELETE FROM item WHERE qty=0', target }),
          ],
          {},
        ),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ readOnly: false, outcome: { code: 'ok', changes: 2 } });
    } finally {
      spy.mockRestore();
    }
  });

  it('discovers and executes read and mutation SQL through MCP HTTP', async () => {
    const client = new Client({ name: 'storage-sql-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['query_storage_sql', 'execute_storage_sql']),
      );
      const read = await client.callTool({
        name: 'query_storage_sql',
        arguments: { name: 'shop.db', sql: 'SELECT qty FROM item', target },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ target, readOnly: true, outcome: { code: 'ok' } });
      const write = await client.callTool({
        name: 'execute_storage_sql',
        arguments: { name: 'shop.db', sql: 'UPDATE item SET qty=42', target },
      });
      expect(write.isError).not.toBe(true);
      expect(write.structuredContent).toMatchObject({
        target,
        readOnly: false,
        outcome: { code: 'ok', phase: 'final', changes: 2 },
      });
    } finally {
      await client.close();
    }
  });
});

it('does not reconnect and replay a Storage mutation when the attached server disappears', async () => {
  const server = createLionscopeServer({
    port: 0,
    devicePort: 0,
    adb: new FakeAdb(() => ''),
    emulatorHost: noEmulatorHost(),
    dashboardDir: '/nonexistent/dist',
    allowStorageRead: true,
    allowStorageWrite: true,
  });
  const { port } = await server.listen();
  const { client, stderr } = await connectStdio([
    '--port',
    String(port),
    '--device-port',
    '0',
    '--adb',
    '/nonexistent/adb',
    '--allow-storage-read',
    '--allow-storage-write',
  ]);
  try {
    await server.close();
    const result = await client.callTool({
      name: 'execute_storage_sql',
      arguments: {
        name: 'shop.db',
        sql: 'DELETE FROM item',
        target: { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not replayed automatically');
    expect(stderr()).not.toContain('reconnecting');
  } finally {
    await client.close();
    await server.close();
  }
}, 30_000);

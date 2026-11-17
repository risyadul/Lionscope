import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_PERMISSIONS } from '@lionscope/protocol';
import { loadConfig, parseCliArgs } from '../src/config.ts';
import { mergePermissions, PermissionSettings, permissionSettings } from '../src/permissions.ts';
import { requestPermissions, runPermissionsCommand } from '../src/cli/permissionsCommand.ts';
import { callRemoteTool } from '../src/cli/agentClient.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { FakeAdb } from './helpers/fakes.ts';
import { connectStdio, freePort } from './helpers/agentProcess.ts';

const servers: LionscopeServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(dev = false) {
  const saved: unknown[] = [];
  const server = createLionscopeServer({
    dev,
    port: 0,
    devicePort: 0,
    adb: new FakeAdb(() => ''),
    emulatorHost: noEmulatorHost(),
    dashboardDir: '/nonexistent',
    savePermissions: async (value) => {
      saved.push(value);
    },
  });
  servers.push(server);
  const { port } = await server.listen();
  return { server, port, saved };
}

describe('runtime permissions', () => {
  it('does not use MCP client allow flags to replace saved restrictions when starting its own server', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lionscope-mcp-permissions-'));
    directories.push(directory);
    const port = await freePort();
    const saved = permissionSettings(port, { LIONSCOPE_STATE_DIR: directory });
    const disabled = { deviceControl: false, networkBodies: false, storageRead: false, storageWrite: false };
    await saved.save(disabled);
    const { client } = await connectStdio(
      [
        '--port',
        String(port),
        '--device-port',
        '0',
        '--adb',
        '/nonexistent/adb',
        '--allow-device-control',
        '--allow-network-bodies',
        '--allow-storage-read',
        '--allow-storage-write',
      ],
      directory,
    );
    try {
      expect(await requestPermissions(port)).toEqual(disabled);
      const response = await client.callTool({ name: 'list_storage', arguments: {} });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('Storage is disabled');
      expect(await saved.load()).toEqual(disabled);
    } finally {
      await client.close();
    }
  });
  it('keeps MCP client restrictions separate from the defaults of the server it starts', async () => {
    const port = await freePort();
    const { client } = await connectStdio([
      '--port',
      String(port),
      '--device-port',
      '0',
      '--adb',
      '/nonexistent/adb',
      '--disable-device-control',
      '--disable-network-bodies',
      '--disable-storage-write',
    ]);
    try {
      expect(await requestPermissions(port)).toEqual(DEFAULT_PERMISSIONS);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('screenshot');
      expect(names).not.toContain('execute_storage_sql');
      expect(names).toContain('query_storage_sql');
      const status = await client.callTool({ name: 'status', arguments: {} });
      expect(status.structuredContent).toMatchObject({
        server: { deviceControl: false, networkBodies: false },
      });
    } finally {
      await client.close();
    }
  });
  it('accepts the own dashboard Origin and accepts the Vite Origin only in dev mode', async () => {
    const { port } = await setup();
    const headers = { 'X-Lionscope-Settings': '1', Origin: `http://localhost:${port}` };
    expect((await fetch(`http://localhost:${port}/api/permissions`, { headers })).status).toBe(200);
    const vite = { ...headers, Origin: 'http://localhost:5173' };
    expect((await fetch(`http://localhost:${port}/api/permissions`, { headers: vite })).status).toBe(403);
    const dev = await setup(true);
    expect((await fetch(`http://localhost:${dev.port}/api/permissions`, { headers: vite })).status).toBe(200);
  });
  it('enforces revocation and re-enabling on a connected MCP stdio client', async () => {
    const { port } = await setup();
    const { client } = await connectStdio(['--port', String(port)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('execute_storage_sql');
      await requestPermissions(port, { storageRead: false, deviceControl: false });
      const refused = await client.callTool({ name: 'list_storage', arguments: {} });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('Storage is disabled');
      const device = await client.callTool({ name: 'screenshot', arguments: {} });
      expect(device.isError).toBe(true);
      expect(JSON.stringify(device.content)).toContain('Device control is disabled');
      await requestPermissions(port, { storageRead: true });
      const read = await client.callTool({ name: 'list_storage', arguments: {} });
      expect(JSON.stringify(read.content)).toContain('needs_profiling_session');
    } finally {
      await client.close();
    }
  });
  it('enables all permissions by default, supports disable flags, dependencies and allow aliases', () => {
    expect(loadConfig({}, parseCliArgs([]))).toMatchObject({
      allowDeviceControl: true,
      allowNetworkBodies: true,
      allowStorageRead: true,
      allowStorageWrite: true,
    });
    expect(loadConfig({}, parseCliArgs(['--disable-storage-read']))).toMatchObject({
      allowStorageRead: false,
      allowStorageWrite: false,
    });
    expect(
      loadConfig(
        {},
        parseCliArgs(['--disable-storage-write', '--disable-device-control', '--disable-network-bodies']),
      ),
    ).toMatchObject({
      allowStorageRead: true,
      allowStorageWrite: false,
      allowDeviceControl: false,
      allowNetworkBodies: false,
    });
    expect(() => parseCliArgs(['--disable-device-control', '--allow-device-control'])).toThrow(/Conflicting/);
    expect(() => loadConfig({}, parseCliArgs(['--disable-storage-read', '--allow-storage-write']))).toThrow();
    expect(
      mergePermissions(
        { ...DEFAULT_PERMISSIONS, storageRead: false, storageWrite: false },
        { storageWrite: true },
      ),
    ).toEqual(DEFAULT_PERMISSIONS);
  });

  it('serializes partial updates and leaves live permissions unchanged when saving fails', async () => {
    const changed = vi.fn();
    let rejectSave = false;
    const settings = new PermissionSettings(
      { ...DEFAULT_PERMISSIONS },
      {
        save: async () => {
          if (rejectSave) throw new Error('disk full');
          await Promise.resolve();
        },
        changed,
      },
    );
    await Promise.all([settings.update({ networkBodies: false }), settings.update({ storageRead: false })]);
    expect(settings.value).toMatchObject({ networkBodies: false, storageRead: false, storageWrite: false });
    rejectSave = true;
    await expect(settings.update({ storageWrite: true })).rejects.toThrow('disk full');
    expect(settings.value.storageWrite).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    rejectSave = false;
    await settings.update({ storageWrite: true });
    expect(settings.value).toMatchObject({ networkBodies: false, storageRead: true, storageWrite: true });
  });

  it('persists choices privately by server port and refuses corrupt settings', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lionscope-permissions-'));
    directories.push(directory);
    const env = { LIONSCOPE_STATE_DIR: directory };
    const settings = permissionSettings(18740, env);
    expect(await settings.load()).toEqual(DEFAULT_PERMISSIONS);
    const value = mergePermissions(DEFAULT_PERMISSIONS, { storageRead: false });
    await settings.save(value);
    expect(await permissionSettings(18740, env).load()).toEqual(value);
    expect(await permissionSettings(18741, env).load()).toEqual(DEFAULT_PERMISSIONS);
    if (process.platform !== 'win32')
      expect((await stat(path.join(directory, '18740.permissions.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(directory, '18740.permissions.json'), 'utf8')).not.toContain('token');
    await writeFile(path.join(directory, '18740.permissions.json'), '{}');
    await expect(settings.load()).rejects.toThrow('Cannot read permission settings');
  });

  it('updates SDK consent and all tool entry points without restarting or bypass via legacy allow headers', async () => {
    const { server, port, saved } = await setup();
    const consent = vi.spyOn(server.manager, 'setStorageConsent');
    expect(await requestPermissions(port)).toEqual(DEFAULT_PERMISSIONS);
    expect(server.agent.storage?.consent).toBe('read_write');
    await requestPermissions(port, { deviceControl: false, networkBodies: false, storageRead: false });
    expect(consent).toHaveBeenLastCalledWith('off');
    expect(server.agent.storage?.consent).toBe('off');
    expect(await callRemoteTool(port, 'screenshot', {}, { deviceControl: true })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await callRemoteTool(port, 'list_storage', {})).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await callRemoteTool(port, 'status', {}, { networkBodies: true })).toMatchObject({
      ok: true,
      result: { server: { networkBodies: false, permissions: { deviceControl: false, storageRead: false } } },
    });
    await requestPermissions(port, { storageWrite: true });
    expect(consent).toHaveBeenLastCalledWith('read_write');
    expect(server.agent.storage?.consent).toBe('read_write');
    expect(saved).toHaveLength(2);
  });

  it('enforces changed permissions on an already connected MCP HTTP client', async () => {
    const { port } = await setup();
    const client = new Client({ name: 'permission-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('execute_storage_sql');
      await requestPermissions(port, { deviceControl: false, storageRead: false });
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('execute_storage_sql');
      expect(names).not.toContain('screenshot');
      await expect(client.callTool({ name: 'list_storage', arguments: {} })).rejects.toThrow();
      await requestPermissions(port, { storageWrite: true });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('execute_storage_sql');
    } finally {
      await client.close();
    }
  });

  it('supports changing running permissions through the CLI command', async () => {
    const { port, server } = await setup();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runPermissionsCommand(['--port', String(port), '--disable-storage-write']);
    expect(server.agent.storage?.consent).toBe('read');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"storageWrite": false'));
    await runPermissionsCommand(['--port', String(port), '--allow-storage-write']);
    expect(server.agent.storage?.consent).toBe('read_write');
  });

  it('rejects cross-origin, missing-header, invalid and oversized settings requests without changing permissions', async () => {
    const { port, server } = await setup();
    const url = `http://localhost:${port}/api/permissions`;
    const headers = { 'Content-Type': 'application/json', 'X-Lionscope-Settings': '1' };
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com' },
          body: '{"storageRead":false}',
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    for (const body of [
      '{}',
      '{"unknown":false}',
      '{"storageRead":"false"}',
      '{"storageRead":false,"storageWrite":true}',
    ]) {
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(400);
    }
    expect((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(4097) })).status).toBe(413);
    expect(server.permissions.value).toEqual(DEFAULT_PERMISSIONS);
  });
});

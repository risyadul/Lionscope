import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveTool, runQueryCommand } from '../src/cli/queryCommand.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import type { Json } from './helpers/agentFixtures.ts';
import { connectStdio, freePort } from './helpers/agentProcess.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';

/** Text of a tool result's first text block, parsed. */
function json(result: { content: unknown }): Json {
  const blocks = result.content as { type: string; text?: string }[];
  return JSON.parse(blocks.find((block) => block.type === 'text')?.text ?? 'null');
}

describe('lionscope query and lionscope mcp against a running server', () => {
  let server: LionscopeServer;
  let port: number;

  beforeAll(async () => {
    const adb = new FakeAdb((args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : ''));
    server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb,
      emulatorHost: noEmulatorHost(),
      dashboardDir: '/nonexistent/dist',
    });
    port = (await server.listen()).port;
    await server.manager.refreshDevices();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('query', () => {
    let output: string;
    beforeAll(() => {
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
    });
    afterEach(() => {
      output = '';
    });
    afterAll(() => {
      vi.restoreAllMocks();
    });
    const query = async (...argv: string[]) => {
      output = '';
      const code = await runQueryCommand(argv, {});
      return { code, value: JSON.parse(output) as Json };
    };

    it('resolves short names', () => {
      expect(resolveTool('stalls')?.name).toBe('get_stalls');
      expect(resolveTool('logcat')?.name).toBe('search_logcat');
      expect(resolveTool('list-apps')?.name).toBe('list_apps');
      expect(resolveTool('summary')?.name).toBe('get_summary');
      expect(resolveTool('nope')).toBeUndefined();
    });

    it('lists every tool with its input schema, without a server', async () => {
      const { code, value } = await query('--list', '--port', String(await freePort()));
      expect(code).toBe(0);
      expect(value.map((tool: { name: string }) => tool.name)).toContain('search_logcat');
      const tap = value.find((tool: { name: string }) => tool.name === 'tap');
      expect(tap).toMatchObject({ access: 'device', requires: '--allow-device-control' });
      expect(tap.inputSchema.properties.x.type).toBe('number');
    });

    it('prints a tool result, typing flags by the schema', async () => {
      const status = await query('status', '--port', String(port));
      expect(status.code).toBe(0);
      expect(status.value.devices.map((device: { serial: string }) => device.serial)).toContain(
        'emulator-5554',
      );
      const logs = await query('logcat', '--port', String(port), '--level', 'E', '--limit', '5');
      expect(logs).toMatchObject({ code: 0, value: { matched: 0, lines: [] } });
      const layouts = await query('layouts', `--port=${port}`, '--include-library', '--json', '{"limit":3}');
      expect(layouts).toMatchObject({ code: 0, value: { total: 0 } });
    });

    it('asks for network bodies with --allow-network-bodies', async () => {
      expect((await query('status', '--port', String(port))).value.server.networkBodies).toBe(false);
      const allowed = await query('status', '--allow-network-bodies', '--port', String(port));
      expect(allowed).toMatchObject({
        code: 0,
        value: { server: { networkBodies: true, deviceControl: false } },
      });
      expect(
        await query('network-request', '--id', '1', '--allow-network-bodies', '--port', String(port)),
      ).toMatchObject({ code: 1, value: { error: expect.stringContaining('No HTTP exchange 1') } });
    });

    it('never lets a bare boolean flag swallow the next word', async () => {
      const layouts = await query('--include-library', 'layouts', '--port', String(port));
      expect(layouts).toMatchObject({ code: 0, value: { total: 0 } });
      const explicit = await query('stalls', '--include-stacks', 'false', '--port', String(port));
      expect(explicit.code).toBe(0);
    });

    it('fails with a JSON error and exit code 1', async () => {
      expect(await query('stalls', '--port', String(port), '--limit', '500')).toMatchObject({
        code: 1,
        value: { ok: false, error: expect.stringContaining('limit') },
      });
      expect(await query('nope', '--port', String(port))).toMatchObject({ code: 1, value: { ok: false } });
      expect(await query('press-key', '--port', String(port), '--key', 'home')).toMatchObject({
        code: 1,
        value: { error: expect.stringContaining('--allow-device-control') },
      });
      expect(await query('status', '--port', String(await freePort()))).toMatchObject({
        code: 1,
        value: { error: expect.stringContaining('No Lionscope server on') },
      });
    });
  });

  it('mcp attaches to the running server and forwards tool calls (with its --allow-network-bodies)', async () => {
    const { client, stderr } = await connectStdio(['--port', String(port), '--allow-network-bodies']);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('get_summary');
      expect(names).not.toContain('screenshot');
      const status = json(await client.callTool({ name: 'status', arguments: {} }));
      // The attached server's fake adb lists emulator-5554; a server of its own would see no device.
      expect(status.devices.map((device: { serial: string }) => device.serial)).toContain('emulator-5554');
      expect(status.server.dashboardUrl).toBe(`http://localhost:${port}`);
      expect(status.server.networkBodies).toBe(true);
      expect(stderr()).toContain('Attached to the Lionscope');
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('lionscope mcp when the server comes and goes', () => {
  it('takes the port over when the server it attached to stops', async () => {
    const own = createLionscopeServer({
      port: await freePort(),
      devicePort: 0,
      adb: new FakeAdb((args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : '')),
      emulatorHost: noEmulatorHost(),
      dashboardDir: '/nonexistent/dist',
    });
    const port = (await own.listen()).port;
    const { client, stderr } = await connectStdio([
      '--port',
      String(port),
      '--device-port',
      '0',
      '--adb',
      '/nonexistent/adb',
    ]);
    try {
      expect(stderr()).toContain('Attached');
      await own.close();
      const status = json(await client.callTool({ name: 'status', arguments: {} }));
      // Its own server: no fake adb devices any more, same port.
      expect(status.server.dashboardUrl).toBe(`http://localhost:${port}`);
      expect(status.devices).toEqual([]);
      expect(stderr()).toContain('reconnecting');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('two clients starting at once share one server', async () => {
    const port = await freePort();
    const args = ['--port', String(port), '--device-port', '0', '--adb', '/nonexistent/adb'];
    const [a, b] = await Promise.all([connectStdio(args), connectStdio(args)]);
    try {
      for (const { client } of [a, b]) {
        const status = json(await client.callTool({ name: 'status', arguments: {} }));
        expect(status.server.dashboardUrl).toBe(`http://localhost:${port}`);
      }
      expect([a.stderr(), b.stderr()].filter((text) => text.includes('Attached'))).toHaveLength(1);
    } finally {
      await Promise.all([a.client.close(), b.client.close()]);
    }
  }, 30_000);

  it('prints its version without starting anything', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'mcp', '--version'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);
});

describe('lionscope mcp without a running server', () => {
  it('starts one in-process; --allow-device-control and --allow-network-bodies apply to this client only', async () => {
    const port = await freePort();
    const { client, stderr } = await connectStdio([
      '--port',
      String(port),
      '--device-port',
      '0',
      '--adb',
      '/nonexistent/adb',
      '--allow-device-control',
      '--allow-network-bodies',
    ]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['screenshot', 'tap', 'boot_emulator', 'set_network_mock']),
      );
      const status = json(await client.callTool({ name: 'status', arguments: {} }));
      expect(status.server).toMatchObject({
        dashboardUrl: `http://localhost:${port}`,
        deviceControl: true,
        networkBodies: true,
      });
      expect(status.devices).toEqual([]);
      const summary = await client.callTool({ name: 'get_summary', arguments: { window: '5m' } });
      expect(json(summary).window.label).toBe('5m');
      // Its HTTP endpoints keep device control off.
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lionscope-Agent': '1' },
        body: '{}',
      });
      expect(((await response.json()) as Json).result.server).toMatchObject({
        deviceControl: false,
        networkBodies: false,
      });
      expect(stderr()).toContain(`Lionscope running at http://localhost:${port}`);
    } finally {
      await client.close();
    }
  }, 30_000);
});

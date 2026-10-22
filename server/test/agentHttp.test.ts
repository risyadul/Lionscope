import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callRemoteTool, probeServer } from '../src/cli/agentClient.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';
import { freePort } from './helpers/agentProcess.ts';

function startServer(allowDeviceControl: boolean): Promise<{ server: LionscopeServer; port: number }> {
  const adb = new FakeAdb((args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : ''));
  const server = createLionscopeServer({
    port: 0,
    devicePort: 0,
    adb,
    emulatorHost: noEmulatorHost(),
    dashboardDir: '/nonexistent/dist',
    allowDeviceControl,
  });
  return server.listen().then((address) => ({ server, port: address.port }));
}

/** node:http rather than fetch: fetch can't set Host. */
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body = '{}',
  method = 'POST',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? body : undefined);
  });
}

const API = { 'Content-Type': 'application/json', 'X-Lionscope-Agent': '1' };
const MCP = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function mcpClient(port: number): Promise<Client> {
  const client = new Client({ name: 'lionscope-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
  return client;
}

describe('agent HTTP endpoints', () => {
  let server: LionscopeServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(false));
  });

  afterAll(async () => {
    await server.close();
  });

  it('answers the JSON tool API', async () => {
    const response = await post(port, '/api/agent/status', API);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body: unknown = JSON.parse(response.body);
    expect(body).toMatchObject({ ok: true, result: { server: { deviceControl: false } } });
    expect((await post(port, '/api/agent/get_stalls', API, '{"limit":99}')).status).toBe(400);
    expect((await post(port, '/api/agent/no_such_tool', API)).status).toBe(404);
    expect((await post(port, '/api/agent/status', API, '[1]')).status).toBe(400);
    const huge = JSON.stringify({ padding: 'x'.repeat(70_000) });
    expect((await post(port, '/api/agent/status', API, huge)).status).toBe(413);
  });

  it('refuses requests a browser page could make', async () => {
    const statuses = await Promise.all([
      // A simple (preflight-free) cross-site POST: text/plain, no custom header.
      post(port, '/api/agent/status', { 'Content-Type': 'text/plain' }),
      post(port, '/api/agent/status', { 'Content-Type': 'application/json' }),
      post(port, '/api/agent/status', { ...API, Origin: 'http://evil.example' }),
      post(port, '/mcp', { ...MCP, Origin: 'http://evil.example' }),
      post(port, '/mcp', { ...MCP, Origin: `http://localhost:${port + 1}` }),
      post(port, '/mcp', { ...MCP, Host: `evil.example:${port}` }),
      post(port, '/api/agent/status', { ...API, Host: `localhost:${port + 1}` }),
      post(port, '/api/agent/status', API, '', 'GET'),
      post(port, '/api/agent/status', { Origin: 'http://evil.example' }, '', 'OPTIONS'),
    ]).then((responses) => responses.map((response) => response.status));
    expect(statuses).toEqual([415, 403, 403, 403, 403, 403, 403, 405, 403]);
    // The JSON API refuses every Origin, even the dashboard's; /mcp accepts the dashboard's own.
    const own = await post(port, '/api/agent/status', { ...API, Origin: `http://localhost:${port}` });
    expect(own.status).toBe(403);
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const mcp = await post(port, '/mcp', { ...MCP, Origin: `http://localhost:${port}` }, initialize);
    expect(mcp.status).toBe(200);
    expect(mcp.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps device tools off, except for an explicit JSON API opt-in', async () => {
    expect(await callRemoteTool(port, 'press_key', { key: 'home' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    // The opt-in reaches the tool: it then fails on the device, not on the gate.
    expect(
      await callRemoteTool(port, 'press_key', { key: 'home', serial: 'R58M123ABC' }, { deviceControl: true }),
    ).toMatchObject({ ok: false, code: 'failed' });
    const client = await mcpClient(port);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('get_summary');
    expect(names).not.toContain('tap');
    await client.close();
  });

  it('serves MCP: initialize, tools/list with annotations, a read tool call', async () => {
    const client = await mcpClient(port);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'get_stalls')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const result = await client.callTool({ name: 'status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ server: { dashboardUrl: `http://localhost:${port}` } });
    const devices = (result.structuredContent as { devices: { serial: string }[] }).devices;
    expect(devices.map((device) => device.serial)).toContain('emulator-5554');
    const failed = await client.callTool({ name: 'set_sdk_options', arguments: { strictMode: true } });
    expect(failed.isError).toBe(true);
    await client.close();
  });

  it('is found by the probe `lionscope mcp` uses to attach', async () => {
    expect(await probeServer(port)).toEqual({ kind: 'lionscope', version: expect.any(String) });
    expect(await probeServer(await freePort())).toEqual({ kind: 'none' });
  });
});

describe('agent endpoints with --allow-device-control', () => {
  it('lists the device tools over MCP', async () => {
    const { server, port } = await startServer(true);
    try {
      const client = await mcpClient(port);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['screenshot', 'tap', 'swipe', 'type_text', 'press_key']));
      await client.close();
    } finally {
      await server.close();
    }
  });
});

import type { HttpExchange, HttpExchangeDetail, SessionState } from '@lionscope/protocol';
import { describe, expect, it, vi } from 'vitest';
import { mcpInstructions } from '../src/agent/mcpServer.ts';
import { DISCONNECTED_SDK } from '../src/device/sdkBridge.ts';
import { BODIES_HIDDEN, BODIES_UNTRUSTED, NO_CAPTURE } from '../src/agent/networkTools.ts';
import { AGENT_TOOLS, availableTools, callTool, DEVICE_CONTROL_DISABLED } from '../src/agent/registry.ts';
import { MOCK_PUSH_DEBOUNCE_MS, NO_SESSION_MOCKS_MESSAGE } from '../src/session/mockRules.ts';
import { fakeAgent, RUNNING, T0 } from './helpers/agentFixtures.ts';
import type { FakeAgent, Json } from './helpers/agentFixtures.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const NOW = T0 + 10 * 60_000;
const V7_SESSION: SessionState = {
  ...RUNNING,
  sdk: {
    connected: true,
    sdkVersion: '0.7.0',
    processName: 'com.example.shop',
    apiLevel: 35,
    framesActive: false,
    protocolVersion: 7,
    network: 'active',
  },
};

function exchange(id: number, ts: number, overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    id,
    ts,
    endTs: ts + 120,
    method: 'GET',
    url: `https://api.example.com/v1/items/${id}?page=1`,
    state: 'complete',
    status: 200,
    headersMs: 80.04,
    durationMs: 120.06,
    requestSize: null,
    responseSize: 512,
    responseType: 'application/json',
    mockId: null,
    error: null,
    screen: 'Home',
    ...overrides,
  };
}

const EXCHANGES: HttpExchange[] = [
  exchange(1, NOW - 9 * 60_000), // outside the 5 min window
  exchange(2, NOW - 4 * 60_000, { method: 'POST', url: 'https://api.example.com/v1/cart', status: 201 }),
  exchange(3, NOW - 3 * 60_000, { status: 404 }),
  exchange(4, NOW - 2 * 60_000, { url: 'https://cdn.example.net/img/1.png', responseType: 'image/png' }),
  exchange(5, NOW - 60_000, { state: 'failed', status: null, error: { kind: 'timeout', message: null } }),
  exchange(6, NOW - 30_000, { mockId: 'm1', status: 503 }),
  exchange(7, NOW - 1000, { state: 'pending', status: null, endTs: null, durationMs: null, headersMs: null }),
];

const DETAIL: HttpExchangeDetail = {
  ...exchange(3, NOW - 3 * 60_000, { status: 404, requestSize: 13 }),
  protocol: 'h2',
  requestHeaders: [
    ['Accept', 'application/json'],
    ['Authorization', '‹redacted›'],
  ],
  responseHeaders: [['Content-Type', 'application/json']],
  requestBody: {
    size: 13,
    contentType: 'application/json',
    text: '{"q":"beans"}',
    truncated: false,
    omitted: null,
  },
  responseBody: { size: 48213, contentType: 'image/png', text: null, truncated: false, omitted: 'type' },
};

function agent(session: SessionState = RUNNING): FakeAgent {
  const fake = fakeAgent({ http: EXCHANGES }, { session, now: NOW });
  fake.httpDetails.set(DETAIL.id, DETAIL);
  return fake;
}

async function run(
  fake: FakeAgent,
  name: string,
  args: unknown = {},
  access: { deviceControl?: boolean; networkBodies?: boolean } = {},
) {
  const outcome = await callTool(fake.ctx, name, args, access.deviceControl ?? false, {
    networkBodies: access.networkBodies ?? false,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.result as Json;
}

describe('network tool definitions', () => {
  it('offers the mock tools with device control only, and describes app data as untrusted', () => {
    const names = (on: boolean) => availableTools(on).map((tool) => tool.name);
    expect(names(false)).toEqual(expect.arrayContaining(['get_network', 'get_network_request']));
    expect(names(false)).not.toContain('set_network_mock');
    expect(names(true)).toEqual(expect.arrayContaining(['set_network_mock', 'clear_network_mocks']));
    for (const name of ['get_network', 'get_network_request']) {
      expect(AGENT_TOOLS.find((tool) => tool.name === name)?.description).toContain(
        'HTTP URLs, headers and bodies',
      );
    }
    expect(mcpInstructions(false)).toContain('--allow-network-bodies');
    expect(mcpInstructions(false)).not.toContain('set_network_mock');
    expect(mcpInstructions(true)).toContain('clear them when you are done');
  });
});

describe('get_network', () => {
  it('lists the window’s exchanges newest first, with counts per status class', async () => {
    const result = await run(agent(), 'get_network');
    expect(result.untrusted).toBeDefined();
    expect(result.window).toMatchObject({ label: '5m', live: true });
    expect(result.total).toBe(6);
    expect(result.counts).toEqual({
      '1xx': 0,
      '2xx': 2,
      '3xx': 0,
      '4xx': 1,
      '5xx': 1,
      failed: 1,
      pending: 1,
    });
    expect(result.exchanges.map((row: Json) => row.id)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(result.exchanges[3]).toEqual({
      id: 4,
      startedAt: new Date(NOW - 2 * 60_000).toISOString(),
      method: 'GET',
      url: 'https://cdn.example.net/img/1.png',
      host: 'cdn.example.net',
      path: '/img/1.png',
      state: 'complete',
      status: 200,
      headersMs: 80,
      durationMs: 120.1,
      requestSize: null,
      responseSize: 512,
      responseType: 'image/png',
      mockId: null,
      error: null,
      screen: 'Home',
    });
    expect(result.truncated).toBe(false);
    expect(result.capture).toBe(false);
    expect(result.captureNote).toBe(NO_CAPTURE);
    expect(result.bodiesAvailable).toBe(false);
    expect(result.mocks).toEqual({ total: 0, enabled: 0, applied: false, rules: [] });
    expect((await run(agent(), 'get_network', { window: '10m' })).total).toBe(7);
  });

  it('filters by method, status class, host, URL text and mocked, keeping the newest up to limit', async () => {
    const ids = async (args: object) =>
      (await run(agent(), 'get_network', args)).exchanges.map((row: Json) => row.id);
    expect(await ids({ method: 'post' })).toEqual([2]);
    expect(await ids({ status: '4xx' })).toEqual([3]);
    expect(await ids({ status: 'failed' })).toEqual([5]);
    expect(await ids({ status: 'pending' })).toEqual([7]);
    expect(await ids({ host: 'CDN.example' })).toEqual([4]);
    expect(await ids({ text: '/V1/ITEMS/3' })).toEqual([3]);
    expect(await ids({ mocked: true })).toEqual([6]);
    expect(await ids({ mocked: false, status: '5xx' })).toEqual([]);
    const limited = await run(agent(), 'get_network', { limit: 2 });
    expect(limited.exchanges.map((row: Json) => row.id)).toEqual([7, 6]);
    expect(limited).toMatchObject({ matching: 6, truncated: true });
    const tooMany = await callTool(agent().ctx, 'get_network', { limit: 501 }, false);
    expect(tooMany).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('says capture is on with a v7 SDK link, and reports the active mocks', async () => {
    const fake = agent(V7_SESSION);
    fake.mocks.linkUp(new FakeLink(7));
    await run(fake, 'set_network_mock', { url: 'https://api.example.com/v1/items' }, { deviceControl: true });
    const result = await run(fake, 'get_network', {}, { networkBodies: true });
    expect(result.capture).toBe(true);
    expect(result).not.toHaveProperty('captureNote');
    expect(result.bodiesAvailable).toBe(true);
    expect(result.mocks).toMatchObject({
      total: 1,
      enabled: 1,
      applied: false,
      rules: [{ id: 'm1', method: 'any' }],
    });
  });
});

describe('get_network_request', () => {
  it('returns headers and timings, with body texts only when network bodies are allowed', async () => {
    const hidden = await run(agent(), 'get_network_request', { id: 3 });
    expect(hidden).toMatchObject({
      id: 3,
      url: 'https://api.example.com/v1/items/3?page=1',
      status: 404,
      protocol: 'h2',
      endedAt: new Date(NOW - 3 * 60_000 + 120).toISOString(),
      requestHeaders: ['Accept: application/json', 'Authorization: ‹redacted›'],
      responseHeaders: ['Content-Type: application/json'],
      bodies: BODIES_HIDDEN,
    });
    expect(hidden.requestBody).toEqual({
      size: 13,
      contentType: 'application/json',
      captured: true,
      truncated: false,
      omitted: null,
    });
    expect(hidden.responseBody).toMatchObject({ captured: false, omitted: 'type' });
    expect(JSON.stringify(hidden)).not.toContain('beans');

    const shown = await run(agent(), 'get_network_request', { id: 3 }, { networkBodies: true });
    expect(shown.requestBody).toEqual(DETAIL.requestBody);
    expect(shown.responseBody).toEqual(DETAIL.responseBody);
    expect(shown.bodies).toBe(BODIES_UNTRUSTED);
  });

  it('fails for an unknown or expired id', async () => {
    expect(await callTool(agent().ctx, 'get_network_request', { id: 99 }, false)).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('No HTTP exchange 99'),
    });
  });
});

describe('set_network_mock and clear_network_mocks', () => {
  it('need device control', async () => {
    for (const name of ['set_network_mock', 'clear_network_mocks']) {
      expect(await callTool(agent().ctx, name, { url: 'https://api.example.com/' }, false)).toEqual({
        ok: false,
        code: 'forbidden',
        error: DEVICE_CONTROL_DISABLED,
      });
    }
  });

  it('build a rule from friendly arguments, validated like the dashboard’s', async () => {
    const fake = agent();
    const device = { deviceControl: true };
    const result = await run(
      fake,
      'set_network_mock',
      {
        method: 'get',
        url: 'https://API.example.com/v1/items',
        headers: { 'content-type': 'text/plain', 'X-Mock': '1' },
        contentType: 'application/json',
        body: '{"items":[]}',
        delayMs: 1500,
      },
      device,
    );
    expect(result.rule).toMatchObject({
      id: 'm1',
      enabled: true,
      method: 'GET',
      match: 'prefix',
      url: 'https://api.example.com/v1/items',
      action: 'respond',
      status: 200,
      bodyBytes: 12,
      delayMs: 1500,
      origin: 'agent',
    });
    expect(fake.mocks.state.rules[0]?.headers).toEqual([
      ['X-Mock', '1'],
      ['Content-Type', 'application/json'],
    ]);
    expect(result.delivery).toEqual({
      applied: false,
      reason: `${NO_CAPTURE} The rules are sent once it connects.`,
    });

    const failure = await run(
      fake,
      'set_network_mock',
      { method: '*', match: 'glob', url: 'https://*.example.com/*', action: 'timeout' },
      device,
    );
    expect(failure.rule).toMatchObject({ id: 'm2', method: 'any', status: null, bodyBytes: null });
    expect(failure.mocks.rules.map((rule: Json) => rule.id)).toEqual(['m1', 'm2']);

    const replaced = await run(
      fake,
      'set_network_mock',
      { id: 'm2', url: 'https://api.example.com/v2' },
      device,
    );
    expect(replaced.rule).toMatchObject({ id: 'm2', action: 'respond', match: 'prefix' });
    expect(await callTool(fake.ctx, 'set_network_mock', { url: 'ftp://example.com/' }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('must start with http://, https:// or *://'),
    });
    expect(
      await callTool(fake.ctx, 'set_network_mock', { id: 'm9', url: 'https://a.example.com/' }, true),
    ).toMatchObject({
      ok: false,
      error: 'No mock rule m9',
    });
  });

  it('report whether the SDK applied the rules', async () => {
    const fake = agent(V7_SESSION);
    const link = new FakeLink(7);
    fake.mocks.linkUp(link);
    const sent = await run(
      fake,
      'set_network_mock',
      { url: 'https://api.example.com/' },
      { deviceControl: true },
    );
    expect(sent.delivery.applied).toBe(false);
    expect(sent.delivery.reason).toContain('Sent to the app');
    await vi.waitFor(() => expect(link.mockSets).toHaveLength(1), { timeout: MOCK_PUSH_DEBOUNCE_MS * 20 });
    fake.mocks.applied(1);
    expect((await run(fake, 'status')).network.mocks).toEqual({ total: 1, enabled: 1, applied: true });
  });

  it('fail without a session; clear one rule or all of them', async () => {
    const idle = agent({ ...RUNNING, status: 'idle' });
    expect(
      await callTool(idle.ctx, 'set_network_mock', { url: 'https://api.example.com/' }, true),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: NO_SESSION_MOCKS_MESSAGE,
    });
    expect(await run(idle, 'clear_network_mocks', {}, { deviceControl: true })).toMatchObject({ removed: 0 });

    const fake = agent();
    for (const url of ['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/']) {
      await run(fake, 'set_network_mock', { url }, { deviceControl: true });
    }
    const one = await run(fake, 'clear_network_mocks', { id: 'm2' }, { deviceControl: true });
    expect(one).toMatchObject({ removed: 1, mocks: { total: 2 } });
    expect(await callTool(fake.ctx, 'clear_network_mocks', { id: 'm2' }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('No mock rule m2'),
    });
    expect(await run(fake, 'clear_network_mocks', {}, { deviceControl: true })).toMatchObject({
      removed: 2,
      mocks: { total: 0, rules: [] },
    });
  });
});

describe('status network section', () => {
  it('reports capture, exchanges kept, mocks and the network-bodies flag', async () => {
    const off = await run(agent(), 'status');
    expect(off.network).toEqual({
      capture: false,
      exchanges: 7,
      mocks: { total: 0, enabled: 0, applied: false },
    });
    expect(off.server.networkBodies).toBe(false);
    const fake = agent(V7_SESSION);
    fake.mocks.linkUp(new FakeLink(7));
    await run(
      fake,
      'set_network_mock',
      { url: 'https://api.example.com/', enabled: false },
      { deviceControl: true },
    );
    const on = await run(fake, 'status', {}, { networkBodies: true });
    expect(on.network).toEqual({
      capture: true,
      exchanges: 7,
      mocks: { total: 1, enabled: 0, applied: false },
    });
    expect(on.server.networkBodies).toBe(true);
  });

  it('reports no capture on a v7 link without a link proof, and the SDK network state', async () => {
    const unverified = agent({
      ...V7_SESSION,
      sdk: { ...(V7_SESSION.sdk ?? DISCONNECTED_SDK), network: 'unverified' },
    });
    const status = await run(unverified, 'status');
    expect(status.network.capture).toBe(false);
    expect(status.sdk).toMatchObject({ connected: true, protocolVersion: 7, network: 'unverified' });
    expect(NO_CAPTURE).toContain('link key');
    expect((await run(agent(V7_SESSION), 'status')).sdk.network).toBe('active');
  });
});

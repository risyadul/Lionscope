import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CONTROL_SERVER_MESSAGE_TYPES } from '@lionscope/protocol';
import type { CpuSample, HttpExchangeDetail, InspectorSnapshot, Snapshot } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAllowedOrigins, createWsGateway, MAX_CLIENT_BUFFERED_BYTES } from '../src/http/wsGateway.ts';
import type {
  GatewayEmulators,
  GatewayInspectLinks,
  GatewayInspector,
  GatewayManager,
  WsGateway,
} from '../src/http/wsGateway.ts';
import { PublicError } from '../src/errors.ts';
import { EMPTY_MOCKS, NO_SESSION_MOCKS_MESSAGE } from '../src/session/mockRules.ts';
import { IDLE_SESSION } from '../src/session/sessionManager.ts';
import { Client } from './helpers/net.ts';
import { mockInput } from './helpers/networkFixtures.ts';

const SNAPSHOT: Snapshot = {
  cpu: [{ ts: 1, percent: 1, percentSingleCore: 4, threads: 2 }],
  memory: [],
  frames: [],
  logs: [],
  events: [],
  screens: [{ start: 1, end: null, screen: { name: 'home', className: 'a.Home', kind: 'activity' } }],
  breakdown: [],
};

const manager: GatewayManager = {
  getDevices: () => [],
  getSessionState: () => IDLE_SESSION,
  getSnapshot: () => SNAPSHOT,
  refreshDevices: async () => [],
  listApps: async () => [],
  startSession: async () => IDLE_SESSION,
  stopSession: async () => IDLE_SESSION,
  setSdkOptions: () => false,
  getHttpExchange: () => null,
  getNetworkMocks: () => EMPTY_MOCKS,
  setNetworkMock: () => {
    throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
  },
  clearNetworkMocks: () => false,
};

const emulators: GatewayEmulators = {
  getEmulators: () => [],
  refresh: async () => [],
  boot: async () => undefined,
  shutdown: async () => undefined,
};

const inspector: GatewayInspector = {
  inspect: () => Promise.reject(new PublicError('no device')),
  select: () => null,
  current: null,
  selection: null,
};

/** Stop reading on the client side so the server's send buffer fills up. */
function socketOf(client: Client): Socket {
  return (client.ws as unknown as { _socket: Socket })._socket;
}

function cpu(ts: number, filler = ''): { type: 'cpu'; sample: CpuSample & { filler?: string } } {
  return { type: 'cpu', sample: { ts, percent: 1, percentSingleCore: 1, threads: 1, filler } };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WebSocket gateway back-pressure', () => {
  let server: Server;
  let gateway: WsGateway;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    gateway = createWsGateway({
      server,
      manager,
      emulators,
      inspector,
      serverVersion: '0.0.0',
      bufferWindowMs: 1000,
      allowedOrigins: () => buildAllowedOrigins(port, false),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('skips live samples for a slow client, then resyncs it with a snapshot once drained', async () => {
    const client = await Client.open(port);
    await client.waitFor('snapshot');
    socketOf(client).pause();
    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 24; i += 1) gateway.broadcast(cpu(i, big)); // ~12 MB, well past 4 MB
    gateway.broadcast(cpu(1000));

    socketOf(client).resume();
    await waitUntil(() => client.messages.filter((m) => m.type === 'cpu').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const received = client.messages.filter((m) => m.type === 'cpu').length;
    expect(received).toBeLessThan(25);
    expect(client.messages.some((m) => m.type === 'cpu' && m.sample.ts === 1000)).toBe(false);

    const resync = client.next('snapshot');
    gateway.broadcast(cpu(2000));
    expect((await resync).snapshot).toEqual(SNAPSHOT);
    const live = client.next('cpu');
    gateway.broadcast(cpu(3000));
    expect((await live).sample.ts).toBe(3000);
    client.close();
  });

  it('always delivers control messages to a slow client; every other type is droppable', async () => {
    expect([...CONTROL_SERVER_MESSAGE_TYPES].sort()).toEqual([
      'apps',
      'devices',
      'emulators',
      'error',
      'hello',
      'httpExchange',
      'inspection',
      'inspectorSelection',
      'networkMocks',
      'session',
      'snapshot',
    ]);
    const client = await Client.open(port);
    await client.waitFor('snapshot');
    socketOf(client).pause();
    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 24; i += 1) gateway.broadcast(cpu(i, big));
    gateway.broadcast({ type: 'event', event: { ts: 5, kind: 'process_died', pid: 1 } });
    gateway.broadcast({ type: 'session', session: { ...IDLE_SESSION, serial: 'emulator-5554' } });
    socketOf(client).resume();

    const control = await client.waitFor('session', (m) => m.session.serial === 'emulator-5554');
    expect(control.session.status).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.messages.some((m) => m.type === 'event')).toBe(false); // recovered via the snapshot
    const resync = client.next('snapshot');
    gateway.broadcast({ type: 'event', event: { ts: 6, kind: 'process_start', pid: 2 } });
    await resync;
    client.close();
  });

  it('treats SDK screen and breakdown messages as live data, resynced with the new streams', async () => {
    const client = await Client.open(port);
    await client.waitFor('snapshot');
    socketOf(client).pause();
    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 24; i += 1) gateway.broadcast(cpu(i, big));
    gateway.broadcast({ type: 'screen', span: { start: 5, end: null, screen: null } });
    gateway.broadcast({
      type: 'breakdown',
      sample: {
        ts: 5,
        screen: null,
        frameCount: 1,
        jankCount: 0,
        slowCount: 0,
        meanStageMs: {
          input: 0,
          animation: 0,
          layout: 0,
          draw: 0,
          sync: 0,
          command: 0,
          swap: 0,
          delay: 0,
          gpu: 0,
        },
        p90TotalMs: 1,
        maxTotalMs: 1,
        frameIntervalMs: 16.67,
      },
    });
    socketOf(client).resume();
    await waitUntil(() => client.messages.filter((m) => m.type === 'cpu').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.messages.some((m) => m.type === 'screen' || m.type === 'breakdown')).toBe(false);

    const resync = client.next('snapshot');
    gateway.broadcast({ type: 'screen', span: { start: 6, end: null, screen: null } });
    const { snapshot } = await resync;
    expect(snapshot.screens).toEqual(SNAPSHOT.screens);
    expect(snapshot.breakdown).toEqual([]);
    client.close();
  });

  it(`disconnects a client with more than ${MAX_CLIENT_BUFFERED_BYTES / 1024 / 1024} MB unsent, on any message type`, async () => {
    const client = await Client.open(port);
    await client.waitFor('snapshot');
    const closed = client.closed();
    socketOf(client).pause();
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 40 && client.ws.readyState === client.ws.OPEN; i += 1) {
      gateway.broadcast({ type: 'error', code: 'test', message: big });
      await new Promise((resolve) => setImmediate(resolve));
    }
    socketOf(client).resume();
    expect(await closed).toBe(1006);
  });
});

describe('WebSocket gateway refreshDevices', () => {
  it('answers with an error, and leaves no unhandled rejection, when both listings fail', async () => {
    const server = createServer();
    let port = 0;
    const gateway = createWsGateway({
      server,
      manager: { ...manager, refreshDevices: () => Promise.reject(new Error('adb gone')) },
      emulators: { ...emulators, refresh: () => Promise.reject(new Error('emulator gone')) },
      inspector,
      serverVersion: '0.0.0',
      bufferWindowMs: 1000,
      allowedOrigins: () => buildAllowedOrigins(port, false),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      client.send({ type: 'refreshDevices' });
      expect(await client.waitFor('error')).toMatchObject({ code: 'refreshDevices_failed' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      client.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('WebSocket gateway shutdownEmulator', () => {
  it('passes confirmUnmanaged on, false when absent', async () => {
    const server = createServer();
    let port = 0;
    const calls: [string, boolean][] = [];
    const gateway = createWsGateway({
      server,
      manager,
      emulators: {
        ...emulators,
        shutdown: async (avdName, confirmUnmanaged) => {
          calls.push([avdName, confirmUnmanaged ?? false]);
        },
      },
      inspector,
      serverVersion: '0.0.0',
      bufferWindowMs: 1000,
      allowedOrigins: () => buildAllowedOrigins(port, false),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    try {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      client.send({ type: 'shutdownEmulator', avdName: 'Pixel_9a' });
      client.send({ type: 'shutdownEmulator', avdName: 'Tablet', confirmUnmanaged: true });
      await waitUntil(() => calls.length === 2);
      expect(calls).toEqual([
        ['Pixel_9a', false],
        ['Tablet', true],
      ]);
      client.close();
    } finally {
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('WebSocket gateway Inspector', () => {
  const snapshot: InspectorSnapshot = {
    id: '0123456789abcdef',
    ts: 1,
    serial: 'emulator-5554',
    packageName: 'com.example.shop',
    source: 'uiautomator',
    screen: null,
    display: { width: 1080, height: 2424, rotation: 0 },
    windows: [],
    nodes: [],
    truncated: false,
    captureMs: null,
    fallbackReason: 'no_sdk',
  };

  async function withGateway(
    fake: GatewayInspector,
    run: (port: number) => Promise<void>,
    inspectLinks?: GatewayInspectLinks,
  ): Promise<void> {
    const server = createServer();
    let port = 0;
    const gateway = createWsGateway({
      server,
      manager,
      emulators,
      inspector: fake,
      ...(inspectLinks ? { inspectLinks } : {}),
      serverVersion: '0.0.0',
      bufferWindowMs: 1000,
      allowedOrigins: () => buildAllowedOrigins(port, false),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    try {
      await run(port);
    } finally {
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('sends the current snapshot and selection on connect, the selection even when there is none', async () => {
    const selection = { snapshotId: snapshot.id, nodeId: 0, ts: 2, origin: 'user' as const };
    await withGateway({ ...inspector, current: snapshot, selection }, async (port) => {
      const client = await Client.open(port);
      expect(await client.waitFor('inspectorSelection')).toEqual({ type: 'inspectorSelection', selection });
      const types = client.messages.map((message) => message.type);
      expect(types.slice(-2)).toEqual(['inspection', 'inspectorSelection']);
      client.close();
    });
    await withGateway(inspector, async (port) => {
      const client = await Client.open(port);
      expect(await client.waitFor('inspectorSelection')).toEqual({
        type: 'inspectorSelection',
        selection: null,
      });
      expect(client.messages.some((message) => message.type === 'inspection')).toBe(false);
      client.close();
    });
  });

  it('passes inspect and selectInspectorNode on and answers failures with their codes', async () => {
    const calls: unknown[] = [];
    const fake: GatewayInspector = {
      ...inspector,
      inspect: async (serial) => {
        calls.push(['inspect', serial]);
        throw new PublicError('Device emulator-5554 is not connected');
      },
      select: (snapshotId, nodeId, origin) => {
        calls.push(['select', snapshotId, nodeId, origin]);
        throw new PublicError('That Inspector snapshot is not the current one');
      },
    };
    await withGateway(fake, async (port) => {
      const client = await Client.open(port);
      await client.waitFor('inspectorSelection');
      client.send({ type: 'inspect', serial: 'emulator-5554' });
      expect(await client.waitFor('error')).toEqual({
        type: 'error',
        code: 'inspect_failed',
        message: 'Device emulator-5554 is not connected',
      });
      client.send({ type: 'selectInspectorNode', snapshotId: snapshot.id, nodeId: null });
      await waitUntil(() => client.messages.filter((message) => message.type === 'error').length === 2);
      expect(client.messages.at(-1)).toMatchObject({ code: 'selectInspectorNode_failed' });
      expect(calls).toEqual([
        ['inspect', 'emulator-5554'],
        ['select', snapshot.id, null, 'user'],
      ]);
      client.close();
    });
  });

  it('passes inspectorFocus on per client, and drops a closed client’s focus', async () => {
    const focus: [object, string | null][] = [];
    const inspectLinks: GatewayInspectLinks = { setFocus: (client, serial) => focus.push([client, serial]) };
    await withGateway(
      inspector,
      async (port) => {
        const first = await Client.open(port);
        const second = await Client.open(port);
        await first.waitFor('inspectorSelection');
        await second.waitFor('inspectorSelection');
        first.send({ type: 'inspectorFocus', serial: 'emulator-5554' });
        second.send({ type: 'inspectorFocus', serial: 'R58M123ABC' });
        await waitUntil(() => focus.length === 2);
        first.send({ type: 'inspectorFocus', serial: null });
        await waitUntil(() => focus.length === 3);
        second.close();
        await waitUntil(() => focus.length === 4);
        expect(focus.map(([, serial]) => serial)).toEqual(['emulator-5554', 'R58M123ABC', null, null]);
        // One client object per connection: the first and third calls are the same client, the fourth the other.
        expect(focus[0]?.[0]).toBe(focus[2]?.[0]);
        expect(focus[1]?.[0]).toBe(focus[3]?.[0]);
        expect(focus[0]?.[0]).not.toBe(focus[1]?.[0]);
        // No answer, and an invalid serial is a bad request.
        first.send({ type: 'inspectorFocus', serial: 'emulator-5554; reboot' });
        expect(await first.waitFor('error')).toMatchObject({ code: 'bad_request' });
        expect(focus).toHaveLength(4);
        first.close();
      },
      inspectLinks,
    );
  });
});

describe('WebSocket gateway network', () => {
  const detail: HttpExchangeDetail = {
    id: 12,
    ts: 1,
    endTs: 2,
    method: 'GET',
    url: 'https://api.example.com/v1/items',
    state: 'complete',
    status: 200,
    headersMs: 1,
    durationMs: 1,
    requestSize: null,
    responseSize: 2,
    responseType: 'application/json',
    mockId: null,
    error: null,
    screen: null,
    protocol: 'h2',
    requestHeaders: [],
    responseHeaders: [],
    requestBody: null,
    responseBody: { size: 2, contentType: 'application/json', text: '[]', truncated: false, omitted: null },
  };

  async function withGateway(fake: GatewayManager, run: (port: number) => Promise<void>): Promise<void> {
    const server = createServer();
    let port = 0;
    const gateway = createWsGateway({
      server,
      manager: fake,
      emulators,
      inspector,
      serverVersion: '0.0.0',
      bufferWindowMs: 1000,
      allowedOrigins: () => buildAllowedOrigins(port, false),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    try {
      await run(port);
    } finally {
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('sends the mock rules on connect, after the snapshot', async () => {
    const mocks = { rules: [], rev: 4, appliedRev: 4 };
    await withGateway({ ...manager, getNetworkMocks: () => mocks }, async (port) => {
      const client = await Client.open(port);
      expect(await client.waitFor('networkMocks')).toEqual({ type: 'networkMocks', mocks });
      const types = client.messages.map((message) => message.type);
      expect(types.indexOf('networkMocks')).toBe(types.indexOf('snapshot') + 1);
      client.close();
    });
  });

  it('answers getHttpExchange to the asking client only, null when unknown', async () => {
    await withGateway({ ...manager, getHttpExchange: (id) => (id === 12 ? detail : null) }, async (port) => {
      const asking = await Client.open(port);
      const other = await Client.open(port);
      await asking.waitFor('networkMocks');
      await other.waitFor('networkMocks');
      asking.send({ type: 'getHttpExchange', id: 12 });
      expect(await asking.waitFor('httpExchange')).toEqual({
        type: 'httpExchange',
        id: 12,
        exchange: detail,
      });
      asking.send({ type: 'getHttpExchange', id: 13 });
      expect(await asking.waitFor('httpExchange', (message) => message.id === 13)).toEqual({
        type: 'httpExchange',
        id: 13,
        exchange: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(other.messages.some((message) => message.type === 'httpExchange')).toBe(false);
      asking.close();
      other.close();
    });
  });

  it('passes setNetworkMock and clearNetworkMocks on; without a session setNetworkMock fails', async () => {
    const calls: unknown[] = [];
    let running = false;
    const fake: GatewayManager = {
      ...manager,
      setNetworkMock: (input, origin) => {
        calls.push(['set', input, origin]);
        if (!running) throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
        return { ...mockInput(), id: 'm1', origin, updatedAt: 1 };
      },
      clearNetworkMocks: (id) => {
        calls.push(['clear', id]);
        return false;
      },
    };
    await withGateway(fake, async (port) => {
      const client = await Client.open(port);
      await client.waitFor('networkMocks');
      client.send({ type: 'setNetworkMock', rule: mockInput() });
      expect(await client.waitFor('error')).toEqual({
        type: 'error',
        code: 'setNetworkMock_failed',
        message: NO_SESSION_MOCKS_MESSAGE,
      });
      running = true;
      client.send({ type: 'setNetworkMock', rule: mockInput({ body: 'x'.repeat(200_000) }) });
      client.send({ type: 'clearNetworkMocks', id: 'm1' });
      client.send({ type: 'clearNetworkMocks' });
      await waitUntil(() => calls.length === 4);
      expect(calls.map((call) => (call as unknown[])[0])).toEqual(['set', 'set', 'clear', 'clear']);
      expect(calls[1]).toEqual(['set', mockInput({ body: 'x'.repeat(200_000) }), 'user']);
      expect(calls.slice(2)).toEqual([
        ['clear', 'm1'],
        ['clear', undefined],
      ]);
      // Only setNetworkMock may be larger than 4 KB.
      client.send({ type: 'getHttpExchange', id: 1, padding: 'x'.repeat(5000) });
      expect(await client.waitFor('error', (message) => message.code === 'bad_request')).toMatchObject({
        message: 'message too large',
      });
      expect(client.messages.filter((message) => message.type === 'error')).toHaveLength(2);
      client.close();
    });
  });
});

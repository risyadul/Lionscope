import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CONTROL_SERVER_MESSAGE_TYPES } from '@lionscope/protocol';
import type { CpuSample, Snapshot } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAllowedOrigins, createWsGateway, MAX_CLIENT_BUFFERED_BYTES } from '../src/http/wsGateway.ts';
import type { GatewayEmulators, GatewayManager, WsGateway } from '../src/http/wsGateway.ts';
import { IDLE_SESSION } from '../src/session/sessionManager.ts';
import { Client } from './helpers/net.ts';

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
};

const emulators: GatewayEmulators = {
  getEmulators: () => [],
  refresh: async () => [],
  boot: async () => undefined,
  shutdown: async () => undefined,
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

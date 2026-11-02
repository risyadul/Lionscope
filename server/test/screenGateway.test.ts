import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_SCREEN_INPUT_PER_SECOND, SCREEN_BINARY_KIND, SCREEN_WS_PATH } from '@lionscope/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Secret } from '../src/emulator/discovery.ts';
import { createEmulatorClientFactory, loadEmulatorController } from '../src/emulator/emulatorClient.ts';
import type { EmulatorClientFactory } from '../src/emulator/emulatorClient.ts';
import type { EmulatorHost } from '../src/emulator/emulatorHost.ts';
import {
  createScreenGateway,
  MAX_SCREEN_SOCKETS,
  SCREEN_ABUSE_FACTOR,
  SCREEN_CLIPBOARD_PER_SECOND,
  SCREEN_CONTROLS_PER_SECOND,
} from '../src/emulator/screenGateway.ts';
import type { ScreenGateway } from '../src/emulator/screenGateway.ts';
import { buildAllowedOrigins } from '../src/http/wsGateway.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { FAKE_TOKEN, FakeEmulator, FIXTURE_PROTO } from './helpers/fakeEmulator.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';
import { handshakeStatus, rawRequest } from './helpers/net.ts';

const SERIAL = 'emulator-5554';

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A screen socket client that records text (parsed) and binary ([kind, payload]) messages in order. */
class ScreenClient {
  readonly received: (Record<string, unknown> | [number, string])[] = [];
  closeCode: number | null = null;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.received.push(
        isBinary
          ? [data[0] ?? -1, data.subarray(1).toString()]
          : (JSON.parse(String(data)) as Record<string, unknown>),
      );
    });
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static open(port: number, query: string): Promise<ScreenClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SCREEN_WS_PATH}?${query}`, {
      origin: `http://localhost:${port}`,
    });
    const client = new ScreenClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  get texts(): Record<string, unknown>[] {
    return this.received.filter((message): message is Record<string, unknown> => !Array.isArray(message));
  }

  get binaries(): [number, string][] {
    return this.received.filter((message): message is [number, string] => Array.isArray(message));
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async closed(): Promise<number> {
    await waitUntil(() => this.closeCode !== null);
    return this.closeCode ?? -1;
  }

  close(): void {
    this.ws.close();
  }
}

describe('screen gateway', () => {
  const emulator = new FakeEmulator();
  let dir: string;
  let server: LionscopeServer;
  let port: number;
  let grpcPort: number;
  const open: ScreenClient[] = [];

  const writeDiscovery = (token = FAKE_TOKEN) =>
    writeFileSync(
      path.join(dir, `pid_${process.pid}.ini`),
      `avd.id=Pixel_9a\nport.serial=5554\navd.name=Pixel 9a\ngrpc.port=${grpcPort}\ngrpc.token=${token}\n` +
        'cmdline="/sdk/qemu" "-avd" "Pixel_9a" "-gpu" "host"\n',
    );
  const connect = async (query = `serial=${SERIAL}`) => {
    const client = await ScreenClient.open(port, query);
    open.push(client);
    return client;
  };
  const running = () => server.emulators.getEmulators().find((info) => info.avdName === 'Pixel_9a')?.state;

  beforeAll(async () => {
    grpcPort = await emulator.start();
    dir = mkdtempSync(path.join(tmpdir(), 'lionscope-screen-'));
    writeDiscovery();
    const host: EmulatorHost = {
      emulatorPath: '/sdk/emulator/emulator',
      createClient: createEmulatorClientFactory(loadEmulatorController(FIXTURE_PROTO)),
      avdHome: path.join(dir, 'avd'),
      discoveryDirs: [dir],
      runEmulator: async () => 'Pixel_9a\n',
      spawnEmulator: () => {
        throw new Error('not in this test');
      },
      isAlive: (pid) => pid === process.pid,
      isPortFree: async () => true,
    };
    const adb = new FakeAdb((args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : ''));
    server = createLionscopeServer({ port: 0, devicePort: 0, adb, emulatorHost: host });
    port = (await server.listen()).port;
    await waitUntil(() => running() === 'running');
  });

  afterEach(async () => {
    for (const client of open.splice(0)) client.close();
    await waitUntil(() => emulator.openStreams.length === 0);
    emulator.rotation = 'PORTRAIT';
    emulator.rotationZ = 0;
  });

  afterAll(async () => {
    await server.close();
    emulator.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends screenInfo, then PNG frames scaled to the short-edge preset', async () => {
    const client = await connect(`serial=${SERIAL}&size=360`);
    await waitUntil(() => client.binaries.length === 1);
    expect(emulator.streams.at(-1)?.request).toMatchObject({ format: 'PNG', width: 360, height: 808 });
    expect(client.received).toEqual([
      {
        type: 'screenInfo',
        serial: SERIAL,
        codec: 'png',
        displayWidth: 1080,
        displayHeight: 2424,
        rotation: 0,
        frameWidth: 360,
        frameHeight: 808,
      },
      [SCREEN_BINARY_KIND.frame, 'png 360x808'],
    ]);
    emulator.pushFrame();
    await waitUntil(() => client.binaries.length === 2);
    expect(client.texts).toHaveLength(1);
  });

  it('defaults to 540 px and follows setSize and rotation', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length === 1);
    expect(emulator.streams.at(-1)?.request).toMatchObject({ width: 540, height: 1212 });
    client.send({ type: 'setSize', size: 720 });
    await waitUntil(() => emulator.openStreams.at(-1)?.request.width === 720);
    emulator.rotation = 'REVERSE_LANDSCAPE';
    emulator.pushFrame({ width: 720, height: 321 });
    await waitUntil(() => emulator.openStreams.at(-1)?.request.height === 720);
    expect(emulator.openStreams.at(-1)?.request).toMatchObject({ width: 1616, height: 720 });
    await waitUntil(() => client.texts.some((info) => info.frameWidth === 1616));
    expect(client.texts.at(-1)).toMatchObject({ rotation: 90, frameWidth: 1616, frameHeight: 720 });
    expect(emulator.openStreams).toHaveLength(1);
  });

  it('paces frames at the fps from the URL, follows setFpsCap, and always sends the last frame', async () => {
    const client = await connect(`serial=${SERIAL}&fps=15`);
    await waitUntil(() => client.binaries.length === 1);
    const arrivals = new Map<string, number>();
    client.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) arrivals.set(data.subarray(1).toString(), performance.now());
    });
    // The fake emulator writes every frame at once (no flow control), so the burst shows the pacing.
    const burst = async (name: string): Promise<number> => {
      for (let i = 1; i <= 5; i += 1) emulator.pushFrame({ bytes: Buffer.from(`${name} ${i}`) });
      await waitUntil(() => client.binaries.at(-1)?.[1] === `${name} 5`);
      return (arrivals.get(`${name} 5`) ?? 0) - (arrivals.get(`${name} 1`) ?? 0);
    };
    // 4 intervals of 15 fps, less the half interval a late frame may catch up.
    expect(await burst('slow')).toBeGreaterThan(200);
    client.send({ type: 'setFpsCap', fps: 60 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await burst('fast')).toBeLessThan(200);
    expect(client.closeCode).toBeNull();
  });

  it('takes a custom cap (45) from the URL and setFpsCap, switches preset <-> custom live, ignores invalid caps', async () => {
    const client = await connect(`serial=${SERIAL}&fps=45`);
    await waitUntil(() => client.binaries.length === 1);
    const arrivals = new Map<string, number>();
    client.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) arrivals.set(data.subarray(1).toString(), performance.now());
    });
    const burst = async (name: string): Promise<number> => {
      for (let i = 1; i <= 5; i += 1) emulator.pushFrame({ bytes: Buffer.from(`${name} ${i}`) });
      await waitUntil(() => client.binaries.at(-1)?.[1] === `${name} 5`);
      return (arrivals.get(`${name} 5`) ?? 0) - (arrivals.get(`${name} 1`) ?? 0);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    // 4 intervals of 45 fps (~89 ms), less the half interval a late frame may catch up; well under 15 fps's ~267.
    const custom = await burst('custom');
    expect(custom).toBeGreaterThan(70);
    expect(custom).toBeLessThan(200);
    // Out of range or not a whole number: ignored like any invalid message, the socket and the cap stay.
    for (const fps of [4, 61, 0, 12.5, '15']) client.send({ type: 'setFpsCap', fps });
    await settle();
    expect(await burst('still-custom')).toBeLessThan(200);
    // Custom -> preset -> custom on the same socket and stream.
    client.send({ type: 'setFpsCap', fps: 15 });
    await settle();
    expect(await burst('preset')).toBeGreaterThan(200);
    client.send({ type: 'setFpsCap', fps: 45 });
    await settle();
    expect(await burst('custom-again')).toBeLessThan(200);
    expect(emulator.openStreams).toHaveLength(1);
    expect(client.closeCode).toBeNull();
  });

  it('injects touch and key input in native display coordinates, and wheel as a touch drag', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length === 1);
    let before = emulator.inputEvents.length;
    client.send({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -120 });
    await waitUntil(() => emulator.inputEvents.length === before + 6);
    const drag = emulator.inputEvents
      .slice(before)
      .map(
        (event) =>
          (event.touch_event as { touches: { y: number; identifier: number; pressure: number }[] })
            .touches[0],
      );
    expect(drag.map((touch) => [touch?.identifier, touch?.y, (touch?.pressure ?? 0) > 0])).toEqual([
      [9, 1212, true],
      [9, 1174, true],
      [9, 1137, true],
      [9, 1099, true],
      [9, 1061, true],
      [9, 1061, false],
    ]);

    before = emulator.inputEvents.length;
    client.send({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.25, pressure: 1 }] });
    client.send({ type: 'nav', button: 'back' });
    await waitUntil(() => emulator.inputEvents.length === before + 2);
    expect(emulator.inputEvents.slice(before)).toEqual([
      {
        touch_event: {
          touches: [expect.objectContaining({ x: 540, y: 606, identifier: 0, pressure: 1024 })],
          display: 0,
        },
      },
      { key_event: expect.objectContaining({ eventType: 'keypress', key: 'GoBack' }) },
    ]);
    expect(emulator.inputCalls.filter((call) => !call.destroyed)).toHaveLength(1);
    // Closing mid-gesture lifts the finger.
    client.close();
    await waitUntil(() => emulator.inputEvents.length === before + 3);
    expect(emulator.inputEvents.at(-1)).toEqual({
      touch_event: { touches: [expect.objectContaining({ identifier: 0, pressure: 0 })], display: 0 },
    });
  });

  it('answers screenshot with a full-resolution PNG (kind 2) and rotates on request', async () => {
    const client = await connect();
    client.send({ type: 'screenshot' });
    await waitUntil(() => client.binaries.some(([kind]) => kind === SCREEN_BINARY_KIND.screenshot));
    expect(client.binaries.find(([kind]) => kind === SCREEN_BINARY_KIND.screenshot)).toEqual([
      SCREEN_BINARY_KIND.screenshot,
      'png 1080x2424',
    ]);
    emulator.rotationZ = 0;
    client.send({ type: 'rotate', direction: 'right' });
    await waitUntil(() => emulator.physicalModelWrites.length > 0);
    expect(emulator.physicalModelWrites.at(-1)).toMatchObject({ value: { data: [-4.75, 0, -90] } });
  });

  it('shows the new orientation after a rotation even when the stream stays silent', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length >= 1);
    const streamsBefore = emulator.streams.length;
    // The fake changes only the skin rotation: no stream frame follows, like an emulator whose content stays.
    client.send({ type: 'rotate', direction: 'right' });
    await waitUntil(() => client.texts.some((info) => info.rotation === 90));
    await waitUntil(() => client.binaries.at(-1)?.[1] === 'png 1212x540');
    expect(client.texts.at(-1)).toMatchObject({ rotation: 90, frameWidth: 1212, frameHeight: 540 });
    await waitUntil(() => emulator.openStreams.at(-1)?.request.width === 1212);
    expect(emulator.streams.length).toBeGreaterThan(streamsBefore);
    expect(emulator.physicalModelWrites.at(-1)).toMatchObject({ interpolation: 'STEP' });

    // A half turn: same box, so no stream restart at all.
    client.send({ type: 'rotate', direction: 'right' });
    await waitUntil(() => client.texts.at(-1)?.rotation === 180);
    await waitUntil(() => client.binaries.at(-1)?.[1] === 'png 540x1212');
    expect(client.texts.at(-1)).toMatchObject({ frameWidth: 540, frameHeight: 1212 });
    const before = emulator.inputEvents.length;
    client.send({ type: 'touch', touches: [{ id: 1, x: 0.25, y: 0.75, pressure: 0 }] });
    await waitUntil(() => emulator.inputEvents.length === before + 1);
    expect(emulator.inputEvents.at(-1)).toEqual({
      touch_event: { touches: [expect.objectContaining({ x: 810, y: 606, identifier: 1 })], display: 0 },
    });
  });

  it('ignores invalid and binary input without closing', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length === 1);
    const before = emulator.inputEvents.length;
    client.send({ type: 'touch', touches: [{ id: 0, x: 2, y: 0, pressure: 1 }] });
    client.send({ type: 'startSession', serial: SERIAL, packageName: 'a.b' });
    client.ws.send('{nope');
    client.ws.send(Buffer.from([1, 2, 3]));
    client.send({ type: 'text', text: 'ok' });
    await waitUntil(() => emulator.inputEvents.length === before + 1);
    expect(emulator.inputEvents.at(-1)).toEqual({ key_event: expect.objectContaining({ text: 'ok' }) });
    expect(client.closeCode).toBeNull();
  });

  it(`drops input over ${MAX_SCREEN_INPUT_PER_SECOND}/s, and disconnects a client far over it`, async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length === 1);
    const before = emulator.inputEvents.length;
    const burst = MAX_SCREEN_INPUT_PER_SECOND * 2;
    for (let i = 0; i < burst; i += 1) client.send({ type: 'key', key: 'a', eventType: 'keypress' });
    await waitUntil(() => emulator.inputEvents.length - before >= MAX_SCREEN_INPUT_PER_SECOND);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(emulator.inputEvents.length - before).toBeLessThan(burst * 0.75);
    expect(client.closeCode).toBeNull();
    for (let i = 0; i < MAX_SCREEN_INPUT_PER_SECOND * SCREEN_ABUSE_FACTOR; i += 1) {
      client.send({ type: 'key', key: 'a', eventType: 'keypress' });
    }
    expect(await client.closed()).toBe(1008);
  });

  it(`limits rotate and setSize to ${SCREEN_CONTROLS_PER_SECOND} per second`, async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length >= 1);
    const writes = emulator.physicalModelWrites.length;
    for (let i = 0; i < 6; i += 1) {
      client.send({ type: 'rotate', direction: i % 2 === 0 ? 'left' : 'right' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(emulator.physicalModelWrites.length - writes).toBeLessThanOrEqual(SCREEN_CONTROLS_PER_SECOND + 1);
    expect(emulator.physicalModelWrites.length - writes).toBeGreaterThan(0);
    expect(client.closeCode).toBeNull();
  });

  it('shares the clipboard only while sync is on, skipping the initial state and our own echo', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length >= 1);
    const clips = () => client.texts.filter((message) => message.type === 'clipboard');

    // Off: nothing forwarded, desktop copies ignored.
    emulator.guestCopy('copied while off');
    client.send({ type: 'clipboard', text: 'ignored while off' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clips()).toEqual([]);
    expect(emulator.clipboardSets).not.toContain('ignored while off');

    client.send({ type: 'clipboardSync', enabled: true });
    await waitUntil(() => emulator.clipboardCalls.some((call) => !call.cancelled));
    emulator.guestCopy('héllo from Android 👋');
    await waitUntil(() => clips().length === 1);
    expect(clips()).toEqual([{ type: 'clipboard', text: 'héllo from Android 👋' }]);

    client.send({ type: 'clipboard', text: 'from the desktop\nline 2' });
    await waitUntil(() => emulator.clipboardSets.at(-1) === 'from the desktop\nline 2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clips()).toHaveLength(1);

    client.send({ type: 'clipboardSync', enabled: false });
    await waitUntil(() => emulator.clipboardCalls.every((call) => call.cancelled));
    emulator.guestCopy('after off');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clips()).toHaveLength(1);
  });

  it('pastes: puts the text (up to 32 KB) on the clipboard, then presses Paste', async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length >= 1);
    const before = emulator.inputEvents.length;
    const text = 'é'.repeat(10_000);
    client.send({ type: 'paste', text });
    await waitUntil(() => emulator.inputEvents.length === before + 1);
    expect(emulator.clipboardSets.at(-1)).toBe(text);
    expect(emulator.inputEvents.at(-1)).toEqual({
      key_event: expect.objectContaining({ eventType: 'keypress', key: 'Paste' }),
    });
    // Other messages keep the small cap.
    client.send({ type: 'text', text: 'a', pad: 'x'.repeat(4000) });
    client.send({ type: 'text', text: 'ok' });
    await waitUntil(() => emulator.inputEvents.length === before + 2);
    expect(emulator.inputEvents.at(-1)).toEqual({ key_event: expect.objectContaining({ text: 'ok' }) });
    expect(client.closeCode).toBeNull();
  });

  it(`limits clipboard messages to ${SCREEN_CLIPBOARD_PER_SECOND} per second`, async () => {
    const client = await connect();
    await waitUntil(() => client.binaries.length >= 1);
    const before = emulator.clipboardSets.length;
    for (let i = 0; i < 20; i += 1) client.send({ type: 'paste', text: `p${i}` });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(emulator.clipboardSets.length - before).toBeLessThanOrEqual(SCREEN_CLIPBOARD_PER_SECOND + 1);
    expect(emulator.clipboardSets.length - before).toBeGreaterThan(0);
  });

  it(`turns away screen socket number ${MAX_SCREEN_SOCKETS + 1} with busy`, async () => {
    const clients = await Promise.all(Array.from({ length: MAX_SCREEN_SOCKETS }, () => connect()));
    const extra = await connect();
    expect(await extra.closed()).toBe(1000);
    expect(extra.texts).toEqual([{ type: 'screenError', code: 'busy', message: expect.any(String) }]);
    expect(clients.every((client) => client.closeCode === null)).toBe(true);
  });

  it('refuses serials that are not running emulators', async () => {
    for (const [query, code] of [
      ['serial=emulator-5556', 'not_emulator'],
      ['serial=R58M123ABC', 'not_emulator'],
      ['serial=a%20b', 'not_emulator'],
      ['', 'not_emulator'],
    ] as const) {
      const client = await connect(query);
      expect(await client.closed()).toBe(1000);
      expect(client.texts).toEqual([{ type: 'screenError', code, message: expect.any(String) }]);
    }
  });

  it('checks Host and Origin like the main socket, and refuses unknown sizes and fps caps', async () => {
    const pathname = `${SCREEN_WS_PATH}?serial=${SERIAL}`;
    const good = { Host: `localhost:${port}`, Origin: `http://localhost:${port}` };
    expect(await handshakeStatus(port, good, pathname)).toBe(101);
    expect(await handshakeStatus(port, { ...good, Origin: 'http://evil.example' }, pathname)).toBe(403);
    expect(await handshakeStatus(port, { Host: `localhost:${port}` }, pathname)).toBe(403);
    expect(await handshakeStatus(port, { ...good, Host: `evil.example:${port}` }, pathname)).toBe(403);
    expect(await handshakeStatus(port, good, `${pathname}&size=1080`)).toBe(400);
    // fps: a plain decimal whole number from 5 to 60; anything else is refused, never clamped.
    for (const fps of ['5', '45', '60'])
      expect(await handshakeStatus(port, good, `${pathname}&fps=${fps}`)).toBe(101);
    for (const fps of ['4', '61', '120', '0', '-5', '45.5', '45.0', '045', '+45', '1e1', '%2045', '', 'abc'])
      expect(await handshakeStatus(port, good, `${pathname}&fps=${fps}`)).toBe(400);
    expect((await rawRequest(port, SCREEN_WS_PATH)).status).toBe(426);
    await waitUntil(() => emulator.openStreams.length === 0);
  });

  it('ends with screenError ended when the stream ends or the emulator goes away', async () => {
    const client = await connect();
    await waitUntil(() => emulator.openStreams.length === 1);
    emulator.openStreams[0]?.call.end();
    expect(await client.closed()).toBe(1000);
    expect(client.texts.at(-1)).toMatchObject({ type: 'screenError', code: 'ended' });

    const second = await connect();
    await waitUntil(() => second.binaries.length === 1);
    unlinkSync(path.join(dir, `pid_${process.pid}.ini`));
    try {
      await server.emulators.refresh();
      expect(await second.closed()).toBe(1000);
      expect(second.texts.at(-1)).toMatchObject({ type: 'screenError', code: 'ended' });
    } finally {
      writeDiscovery();
      await server.emulators.refresh();
    }
  });

  it('reports a refused token as auth', async () => {
    writeDiscovery('stale-token');
    try {
      await server.emulators.refresh();
      const client = await connect();
      expect(await client.closed()).toBe(1000);
      expect(client.texts).toEqual([{ type: 'screenError', code: 'auth', message: expect.any(String) }]);
    } finally {
      writeDiscovery();
      await server.emulators.refresh();
    }
  });
});

describe('screen gateway lifecycle', () => {
  let http: Server;
  let port: number;
  let gateway: ScreenGateway | null;
  let clients: FakeEmulatorClient[];

  const start = async (createClient: EmulatorClientFactory | null, pingIntervalMs = 60_000) => {
    gateway = createScreenGateway({
      server: http,
      emulators: {
        mirrorTarget: () => ({ ok: true, endpoint: { port: 1, token: new Secret('t') } }),
        onChange: () => () => undefined,
      },
      createClient,
      allowedOrigins: () => buildAllowedOrigins(port, false),
      pingIntervalMs,
    });
  };

  beforeEach(async () => {
    clients = [];
    gateway = null;
    http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await gateway?.close();
    await new Promise((resolve) => http.close(resolve));
  });

  const factory: EmulatorClientFactory = () => {
    const client = new FakeEmulatorClient();
    clients.push(client);
    return client;
  };

  it('answers unavailable when mirroring cannot work at all', async () => {
    await start(null);
    const client = await ScreenClient.open(port, `serial=${SERIAL}`);
    expect(await client.closed()).toBe(1000);
    expect(client.texts).toEqual([{ type: 'screenError', code: 'unavailable', message: expect.any(String) }]);
  });

  it('pings sockets and drops the ones that stop answering', async () => {
    await start(factory, 20);
    const client = await ScreenClient.open(port, `serial=${SERIAL}`);
    let pings = 0;
    client.ws.on('ping', () => (pings += 1));
    await waitUntil(() => pings >= 2);
    expect(client.closeCode).toBeNull();
    // Stop answering pings (ws answers them automatically): the next round terminates the socket.
    Object.assign(client.ws, { pong: () => undefined });
    expect(await client.closed()).toBe(1006);
    expect(clients[0]?.closed).toBe(true);
  });

  it('closes every screen socket and its emulator client on close', async () => {
    await start(factory);
    const client = await ScreenClient.open(port, `serial=${SERIAL}`);
    await waitUntil(() => clients[0]?.stream !== undefined);
    await gateway?.close();
    gateway = null;
    expect(await client.closed()).toBe(1006);
    expect(clients[0]?.closed).toBe(true);
    expect(clients[0]?.stream?.cancelled).toBe(true);
  });

  it('leaves other paths and malformed URLs to the other upgrade listeners', async () => {
    await start(factory);
    for (const url of ['/ws', '//[', '/ws/screen/x']) {
      const socket = new PassThrough();
      http.emit('upgrade', { url, headers: { host: `localhost:${port}` } }, socket, Buffer.alloc(0));
      expect(socket.writableEnded).toBe(false);
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    }
  });
});

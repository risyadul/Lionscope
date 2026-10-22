import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCREEN_BINARY_KIND, SCREEN_WS_PATH } from '@lionscope/protocol';
import type { DeviceInfo } from '@lionscope/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Secret } from '../src/emulator/discovery.ts';
import type { EmulatorHost } from '../src/emulator/emulatorHost.ts';
import { chooseScreenBackend, SCREEN_INPUT_FAILED_MESSAGE } from '../src/emulator/screenGateway.ts';
import { DeviceScreenSession } from '../src/scrcpy/deviceScreenSession.ts';
import { injectKeycode, injectTouch, KEY_ACTION, MOTION_ACTION, resetVideo } from '../src/scrcpy/protocol.ts';
import { AKEYCODE } from '../src/scrcpy/keycodes.ts';
import { LIST_LEFTOVERS_COMMAND } from '../src/scrcpy/scrcpyServer.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { FakeScrcpyAdb, FakeScrcpyDevice, PHYSICAL_SERIAL } from './helpers/fakeScrcpy.ts';

const PKG = 'com.example.app';
/**
 * Every wait is on its condition (socket events, else polled); this is only the give-up point. A real scrcpy
 * launch (push, forward, two sockets) shares the CPU with the whole suite, so it gets plenty of headroom.
 */
const WAIT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

class Client {
  readonly texts: Record<string, unknown>[] = [];
  readonly videos: Buffer[] = [];
  closed = false;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) this.texts.push(JSON.parse(String(data)) as Record<string, unknown>);
      else if (data[0] === SCREEN_BINARY_KIND.video) this.videos.push(data);
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolves once `condition` holds: checked now and after every message and the close (no polling). */
  waitFor(condition: () => boolean, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEvent = (): void => {
        if (!condition()) return;
        stop();
        resolve();
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`));
      }, WAIT_MS);
      const stop = (): void => {
        clearTimeout(timer);
        this.ws.off('message', onEvent);
        this.ws.off('close', onEvent);
      };
      // Registered after the constructor's listeners, so texts, videos and closed are up to date here.
      this.ws.on('message', onEvent);
      this.ws.on('close', onEvent);
      onEvent();
    });
  }
}

/** Device- and server-side state has no event to wait on: polled until it holds. */
const eventually = (device: FakeScrcpyDevice, condition: () => boolean) => device.waitFor(condition, WAIT_MS);

describe('screen gateway with a physical device (fake scrcpy device)', { timeout: TEST_TIMEOUT_MS }, () => {
  const device = new FakeScrcpyDevice();
  const adb = new FakeScrcpyAdb(device);
  let dir: string;
  let server: LionscopeServer;
  let port: number;
  const clients: Client[] = [];

  const connect = async (serial = PHYSICAL_SERIAL) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SCREEN_WS_PATH}?serial=${serial}&size=540`, {
      origin: `http://localhost:${port}`,
    });
    const client = new Client(ws);
    clients.push(client);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
  };
  /** The control socket got the RESET_VIDEO that opens a stream (control bytes add up over the tests). */
  const streamOpened = (start: number) =>
    eventually(device, () => device.controlBytes.subarray(start).equals(resetVideo()));

  beforeAll(async () => {
    await device.start();
    dir = mkdtempSync(path.join(tmpdir(), 'lionscope-device-screen-'));
    const host: EmulatorHost = {
      emulatorPath: null,
      createClient: null,
      avdHome: path.join(dir, 'avd'),
      discoveryDirs: [dir],
      runEmulator: async () => '',
      spawnEmulator: () => {
        throw new Error('not in this test');
      },
      isAlive: () => false,
      isPortFree: async () => true,
    };
    server = createLionscopeServer({ port: 0, devicePort: 0, adb, emulatorHost: host });
    port = (await server.listen()).port;
    await eventually(device, () => server.manager.getDevices().length === 1);
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.close();
    await eventually(device, () => adb.liveServers.length === 0);
    adb.deviceState = 'device';
    await server.manager.refreshDevices();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    await device.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors through scrcpy and injects input', async () => {
    await server.manager.startSession(PHYSICAL_SERIAL, PKG);
    const start = device.controlBytes.length;
    const client = await connect();
    await client.waitFor(() => client.videos.length === 2, 'the first two video packets');
    await streamOpened(start);
    expect(client.texts[0]).toMatchObject({
      type: 'screenInfo',
      codec: 'h264',
      frameWidth: 540,
      frameHeight: 1200,
    });
    const before = device.controlBytes.length;
    client.send({ type: 'touch', touches: [{ id: 0, x: 0, y: 1, pressure: 1 }] });
    await eventually(device, () => device.controlBytes.length === before + 32);
    expect(device.controlBytes.subarray(before)).toEqual(
      injectTouch({
        action: MOTION_ACTION.down,
        pointerId: 0n,
        position: { x: 0, y: 1199, width: 540, height: 1200 },
        pressure: 1,
      }),
    );
    client.ws.close();
    await eventually(device, () => adb.liveServers.length === 0);
    await server.manager.stopSession();
  });

  it('rate-limits keyFrame requests on their own budget, without starving input', async () => {
    const start = device.controlBytes.length;
    const client = await connect();
    await client.waitFor(() => client.videos.length === 2, 'the first two video packets');
    await streamOpened(start);
    const before = device.controlBytes.length;
    for (let i = 0; i < 50; i += 1) client.send({ type: 'keyFrame' });
    client.send({ type: 'nav', button: 'home' });
    // A sentinel after them on the same socket: once its key is in, everything sent before it has arrived.
    client.send({ type: 'nav', button: 'recents' });
    const keys = (keycode: number) =>
      Buffer.concat([injectKeycode(KEY_ACTION.down, keycode), injectKeycode(KEY_ACTION.up, keycode)]);
    const sentinel = keys(AKEYCODE.APP_SWITCH);
    await eventually(device, () => device.controlBytes.subarray(-sentinel.length).equals(sentinel));
    // One RESET_VIDEO at most (the bucket admits 3, the session sends one per second), and the key still goes out.
    expect(device.controlBytes.subarray(before)).toEqual(
      Buffer.concat([resetVideo(), keys(AKEYCODE.HOME), sentinel]),
    );
    expect(client.closed).toBe(false);
  });

  it('fails only the socket whose input handling throws; the server keeps running', async () => {
    const handle = vi.spyOn(DeviceScreenSession.prototype, 'handle').mockImplementationOnce(() => {
      throw new RangeError('boom');
    });
    const client = await connect();
    await client.waitFor(() => client.videos.length === 2, 'the first two video packets');
    client.send({ type: 'nav', button: 'home' });
    await client.waitFor(() => client.closed, 'the socket to close');
    expect(client.texts.at(-1)).toEqual({
      type: 'screenError',
      code: 'ended',
      message: SCREEN_INPUT_FAILED_MESSAGE,
    });
    await eventually(device, () => adb.liveServers.length === 0);
    handle.mockRestore();
    const next = await connect();
    await next.waitFor(() => next.videos.length === 2, 'the first two video packets');
  });

  it('refuses devices that are not ready and serials that are not connected', async () => {
    adb.deviceState = 'unauthorized';
    await server.manager.refreshDevices();
    const unauthorized = await connect();
    await unauthorized.waitFor(() => unauthorized.closed, 'the refusal');
    expect(unauthorized.texts).toEqual([
      { type: 'screenError', code: 'not_emulator', message: `${PHYSICAL_SERIAL} is unauthorized` },
    ]);
    const unknown = await connect('FAKEPHYS0002');
    await unknown.waitFor(() => unknown.closed, 'the refusal');
    expect(unknown.texts).toEqual([
      { type: 'screenError', code: 'not_emulator', message: 'FAKEPHYS0002 is not connected' },
    ]);
    // An emulator serial never goes to scrcpy.
    const emulator = await connect('emulator-5554');
    await emulator.waitFor(() => emulator.closed, 'the refusal');
    expect(emulator.texts[0]).toMatchObject({
      code: 'not_emulator',
      message: 'emulator-5554 is not a running emulator',
    });
    expect(adb.servers.filter((entry) => !entry.child.exited)).toEqual([]);
  });
});

describe('server lifecycle with a physical device', { timeout: TEST_TIMEOUT_MS }, () => {
  it('cleans up scrcpy leftovers on start, and closes promptly even during a stuck push', async () => {
    const device = new FakeScrcpyDevice();
    await device.start();
    const adb = new FakeScrcpyAdb(device);
    adb.pushHangs = true;
    const dir = mkdtempSync(path.join(tmpdir(), 'lionscope-device-close-'));
    const host: EmulatorHost = {
      emulatorPath: null,
      createClient: null,
      avdHome: path.join(dir, 'avd'),
      discoveryDirs: [dir],
      runEmulator: async () => '',
      spawnEmulator: () => {
        throw new Error('not in this test');
      },
      isAlive: () => false,
      isPortFree: async () => true,
    };
    const server = createLionscopeServer({ port: 0, devicePort: 0, adb, emulatorHost: host });
    const { port } = await server.listen();
    await eventually(device, () => adb.calls.some((args) => args[3] === LIST_LEFTOVERS_COMMAND));
    expect(adb.calls.filter((args) => args[3] === LIST_LEFTOVERS_COMMAND).map((args) => args[1])).toEqual([
      PHYSICAL_SERIAL,
    ]);
    expect(adb.calls).toContainEqual(['forward', '--list']);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${SCREEN_WS_PATH}?serial=${PHYSICAL_SERIAL}`, {
      origin: `http://localhost:${port}`,
    });
    ws.on('error', () => undefined);
    await eventually(device, () => adb.pushes.length === 1);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(adb.pushes[0]?.child.killed).toBe(true);
    expect(adb.servers).toEqual([]);
    await device.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('chooseScreenBackend', () => {
  const devices: DeviceInfo[] = [
    { serial: PHYSICAL_SERIAL, state: 'device' },
    { serial: 'emulator-5554', state: 'device' },
  ];
  const mirroring = { devices: () => devices };
  const notEmulator = (serial: string) => ({
    ok: false as const,
    code: 'not_emulator' as const,
    message: `${serial} is not a running emulator`,
  });

  it('picks gRPC for mirrorable emulators and scrcpy for other ready adb devices', () => {
    const target = { ok: true as const, endpoint: { port: 8554, token: new Secret('secret') } };
    expect(chooseScreenBackend('emulator-5554', target, mirroring)).toEqual({ kind: 'emulator', target });
    expect(chooseScreenBackend(PHYSICAL_SERIAL, notEmulator(PHYSICAL_SERIAL), mirroring)).toEqual({
      kind: 'device',
      mirroring,
    });
    expect(
      chooseScreenBackend('192.168.1.20:5555', notEmulator('192.168.1.20:5555'), mirroring),
    ).toMatchObject({
      kind: 'refused',
      message: '192.168.1.20:5555 is not connected',
    });
  });

  it('keeps the emulator reasons, and refuses devices when physical mirroring is off', () => {
    expect(chooseScreenBackend('emulator-5554', notEmulator('emulator-5554'), mirroring)).toEqual({
      kind: 'refused',
      code: 'not_emulator',
      message: 'emulator-5554 is not a running emulator',
    });
    const unavailable = { ok: false as const, code: 'unavailable' as const, message: 'no gRPC' };
    expect(chooseScreenBackend(PHYSICAL_SERIAL, unavailable, mirroring)).toMatchObject({
      code: 'unavailable',
    });
    expect(chooseScreenBackend(PHYSICAL_SERIAL, notEmulator(PHYSICAL_SERIAL), undefined)).toMatchObject({
      kind: 'refused',
      code: 'not_emulator',
    });
  });
});

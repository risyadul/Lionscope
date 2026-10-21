import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeviceInfo, EmulatorInfo, ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GrpcEndpoint } from '../src/emulator/discovery.ts';
import type { EmulatorHost, EmulatorProcess } from '../src/emulator/emulatorHost.ts';
import { AVD_NAME_RETRY_MS } from '../src/emulator/avdNameLookup.ts';
import {
  CLOSE_OPERATIONS_WAIT_MS,
  EmulatorManager,
  NO_EMULATOR_MESSAGE,
} from '../src/emulator/emulatorManager.ts';
import { STALE_INSTANCE_MS } from '../src/emulator/instanceProbe.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { FakeAdb } from './helpers/fakes.ts';

const HOST_GLES = 'GLES: Google (Apple), Android Emulator OpenGL ES Translator (Apple M4), OpenGL ES 3.0\n';

class FakeProcess extends EventEmitter implements EmulatorProcess {
  readonly signals: (NodeJS.Signals | undefined)[] = [];

  /** Spawned emulators get pids 10, 11, …: the pid their discovery file names. */
  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function device(serial: string, state: DeviceInfo['state'] = 'device'): DeviceInfo {
  return { serial, state };
}

describe('EmulatorManager', () => {
  let root: string;
  let discoveryDir: string;
  let avdHome: string;
  let messages: ServerMessage[];
  let alive: Set<number>;
  let avdList: string;
  let spawned: { args: readonly string[]; process: FakeProcess }[];
  let clients: { endpoint: GrpcEndpoint; client: FakeEmulatorClient }[];
  let nextClient: () => FakeEmulatorClient;
  let adb: FakeAdb;
  let host: EmulatorHost;
  let manager: EmulatorManager;
  let surfaceFlinger: string;
  let bootCompleted: string;
  let busyPorts: Set<number>;

  const emulators = (): EmulatorInfo[] => manager.getEmulators();
  const stateOf = (avdName: string) => emulators().find((info) => info.avdName === avdName);
  const errors = () => messages.filter((message) => message.type === 'error');

  /** An emulator writes its discovery file once its gRPC endpoint is up. */
  const discover = (pid: number, avdName: string, port: number, extra = '') => {
    alive.add(pid);
    writeFileSync(
      path.join(discoveryDir, `pid_${pid}.ini`),
      `avd.id=${avdName}\nport.serial=${port}\navd.name=${avdName.replace('_', ' ')}\ngrpc.port=${port + 3000}\n` +
        `grpc.token=t-${pid}\ncmdline="/sdk/qemu" "-avd" "${avdName}"${extra}\n`,
    );
  };
  const vanish = (pid: number) => {
    alive.delete(pid);
    unlinkSync(path.join(discoveryDir, `pid_${pid}.ini`));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lionscope-emulators-'));
    discoveryDir = path.join(root, 'running');
    avdHome = path.join(root, 'avd');
    mkdirSync(discoveryDir);
    mkdirSync(path.join(avdHome, 'Pixel_9a.avd'), { recursive: true });
    writeFileSync(path.join(avdHome, 'Pixel_9a.avd', 'config.ini'), 'avd.ini.displayname=Pixel 9a\n');
    messages = [];
    alive = new Set();
    avdList = 'Pixel_9a\nTablet\n';
    spawned = [];
    clients = [];
    nextClient = () => new FakeEmulatorClient();
    surfaceFlinger = HOST_GLES;
    bootCompleted = '1\n';
    busyPorts = new Set();
    adb = new FakeAdb((args) => {
      if (args.includes('emu') && args.includes('avd')) return 'Undiscovered_AVD\r\nOK\r\n';
      if (args.includes('emu') && args.includes('kill')) return 'OK';
      if (args.at(-1) === 'dumpsys SurfaceFlinger') return surfaceFlinger;
      if (args.at(-1) === 'getprop sys.boot_completed') return bootCompleted;
      throw new Error(`unexpected adb ${args.join(' ')}`);
    });
    host = {
      emulatorPath: '/sdk/emulator/emulator',
      createClient: (endpoint) => {
        const client = nextClient();
        clients.push({ endpoint, client });
        return client;
      },
      avdHome,
      discoveryDirs: [discoveryDir],
      runEmulator: async (args) => {
        expect(args).toEqual(['-list-avds']);
        return avdList;
      },
      spawnEmulator: (args) => {
        const process = new FakeProcess(10 + spawned.length);
        spawned.push({ args, process });
        return process;
      },
      isAlive: (pid) => alive.has(pid),
      isPortFree: async (port) => !busyPorts.has(port),
    };
    manager = new EmulatorManager({
      adb,
      host,
      broadcast: (message) => messages.push(message),
      pollMs: 10,
      // The tests change the AVD list between calls.
      avdListTtlMs: 0,
    });
  });

  afterEach(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists AVDs that are off with their display names', async () => {
    expect(await manager.refresh()).toEqual([
      {
        avdName: 'Pixel_9a',
        displayName: 'Pixel 9a',
        state: 'off',
        serial: null,
        managed: false,
        canMirror: false,
        renderer: 'unknown',
      },
      expect.objectContaining({ avdName: 'Tablet', displayName: null, state: 'off' }),
    ]);
    expect(messages).toEqual([{ type: 'emulators', emulators: emulators() }]);
    await manager.refresh();
    expect(messages).toHaveLength(1);
  });

  it('shows a running emulator (unmanaged) with its serial, mirror endpoint and renderer', async () => {
    discover(4242, 'Pixel_9a', 5554);
    manager.setDevices([device('emulator-5554')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toEqual({
      avdName: 'Pixel_9a',
      displayName: 'Pixel 9a',
      state: 'running',
      serial: 'emulator-5554',
      managed: false,
      canMirror: true,
      renderer: 'host',
    });
    expect(clients[0]?.endpoint.port).toBe(8554);
    expect(clients[0]?.endpoint.token.reveal()).toBe('t-4242');
    expect(manager.mirrorTarget('emulator-5554')).toEqual({ ok: true, endpoint: clients[0]?.endpoint });
    // The renderer is read once per running instance.
    await manager.refresh();
    expect(adb.execCalls.filter((args) => args.at(-1) === 'dumpsys SurfaceFlinger')).toHaveLength(1);
  });

  it('flags software rendering from the command line or from SurfaceFlinger', async () => {
    avdList = 'Pixel_9a\nTablet\nTV\n';
    discover(1, 'Pixel_9a', 5554, ' "-gpu" "swiftshader_indirect"');
    discover(2, 'Tablet', 5556);
    discover(3, 'TV', 5558);
    surfaceFlinger = 'GLES: Google Inc., Android Emulator OpenGL ES Translator (Google SwiftShader)\n';
    manager.setDevices([device('emulator-5554'), device('emulator-5556')]);
    await manager.refresh();
    expect(emulators().map((info) => [info.avdName, info.renderer])).toEqual([
      ['Pixel_9a', 'software'],
      ['Tablet', 'software'],
      // Not (yet) usable over adb: checked on a later pass.
      ['TV', 'unknown'],
    ]);
    expect(adb.execCalls.some((args) => args.includes('emulator-5554'))).toBe(false);
  });

  it('keeps the renderer unknown when dumpsys fails, and retries later', async () => {
    discover(1, 'Pixel_9a', 5554);
    manager.setDevices([device('emulator-5554')]);
    surfaceFlinger = '';
    adb.execHandler = (args) => {
      if (args.at(-1) === 'dumpsys SurfaceFlinger') throw new Error('device offline');
      return '';
    };
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.renderer).toBe('unknown');
    adb.execHandler = () => HOST_GLES;
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.renderer).toBe('host');
  });

  it('is booting until the emulator says it booted', async () => {
    const client = new FakeEmulatorClient();
    client.booted = false;
    nextClient = () => client;
    discover(1, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', canMirror: true });
    expect(manager.mirrorTarget('emulator-5554')).toMatchObject({ ok: false, code: 'not_emulator' });
    client.booted = true;
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('running');
    // Once booted it stays booted (no more status calls needed).
    client.booted = new Error('busy');
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('running');
  });

  it('falls back to sys.boot_completed when gRPC does not answer', async () => {
    const client = new FakeEmulatorClient();
    client.booted = new Error('UNAVAILABLE');
    nextClient = () => client;
    discover(1, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('booting');
    bootCompleted = '0\n';
    manager.setDevices([device('emulator-5554')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('booting');
    bootCompleted = '1\n';
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('running');
  });

  it('cannot mirror an emulator without a token, or without a usable proto', async () => {
    writeFileSync(path.join(discoveryDir, 'pid_7.ini'), 'avd.id=Pixel_9a\nport.serial=5554\n');
    alive.add(7);
    manager.setDevices([device('emulator-5554')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'running', canMirror: false });
    expect(manager.mirrorTarget('emulator-5554')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(manager.mirrorTarget('emulator-5556')).toMatchObject({ ok: false, code: 'not_emulator' });
    expect(manager.mirrorTarget('R58M123ABC')).toMatchObject({ ok: false, code: 'not_emulator' });
  });

  it('names emulators adb lists without a discovery file, and never asks physical devices', async () => {
    manager.setDevices([device('emulator-5580'), device('R58M123ABC'), device('emulator-5582', 'offline')]);
    await manager.refresh();
    expect(stateOf('Undiscovered_AVD')).toMatchObject({
      state: 'running',
      serial: 'emulator-5580',
      canMirror: false,
      managed: false,
    });
    expect(adb.execCalls.filter((args) => args.includes('emu')).map((args) => args[1])).toEqual([
      'emulator-5580',
    ]);
    await manager.refresh();
    expect(adb.execCalls.filter((args) => args.includes('emu'))).toHaveLength(1);
    expect(adb.execCalls.some((args) => args.includes('R58M123ABC'))).toBe(false);
  });

  it('boots an AVD headless with the chosen mode and tracks it until it runs', async () => {
    await manager.refresh();
    await manager.boot('Pixel_9a', 'cold');
    expect(spawned.map((entry) => entry.args)).toEqual([
      [
        '-avd',
        'Pixel_9a',
        '-port',
        '5554',
        '-grpc',
        '8554',
        '-grpc-use-token',
        '-no-window',
        '-gpu',
        'host',
        '-no-boot-anim',
        '-no-snapshot-load',
      ],
    ]);
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', managed: true, serial: null });
    discover(10, 'Pixel_9a', 5554);
    manager.setDevices([device('emulator-5554')]);
    // Polled on its own while booting.
    await waitUntil(() => stateOf('Pixel_9a')?.state === 'running');
    expect(stateOf('Pixel_9a')).toMatchObject({ managed: true, serial: 'emulator-5554', renderer: 'host' });
    expect(messages.filter((message) => message.type === 'emulators').length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to boot unknown, invalid or already running AVDs', async () => {
    await expect(manager.boot('Nope', 'quick')).rejects.toThrow('No AVD named Nope');
    await expect(manager.boot('-wipe-data', 'quick')).rejects.toThrow('invalid AVD name');
    await expect(manager.boot('a b', 'quick')).rejects.toThrow('invalid AVD name');
    discover(1, 'Tablet', 5556);
    await expect(manager.boot('Tablet', 'quick')).rejects.toThrow('Tablet is already running');
    await manager.boot('Pixel_9a', 'quick');
    await expect(manager.boot('Pixel_9a', 'quick')).rejects.toThrow('Pixel_9a is already booting');
    expect(spawned).toHaveLength(1);
  });

  it('refuses to boot without an emulator, and after close', async () => {
    const bare = new EmulatorManager({
      adb,
      host: { ...host, emulatorPath: null },
      broadcast: () => undefined,
    });
    await expect(bare.boot('Pixel_9a', 'quick')).rejects.toThrow(NO_EMULATOR_MESSAGE);
    expect(await bare.refresh()).toEqual([]);
    await bare.close();
    const closing = new EmulatorManager({ adb, host, broadcast: () => undefined });
    await closing.close();
    await expect(closing.boot('Pixel_9a', 'quick')).rejects.toThrow('server is shutting down');
  });

  it('keeps the last AVD list when -list-avds fails', async () => {
    await manager.refresh();
    host.runEmulator = () => Promise.reject(new Error('timeout'));
    await manager.refresh();
    expect(emulators().map((info) => info.avdName)).toEqual(['Pixel_9a', 'Tablet']);
  });

  it('reports a boot that exits before the emulator came up', async () => {
    await manager.boot('Pixel_9a', 'quick');
    spawned[0]?.process.emit('exit', 1, null);
    await waitUntil(() => errors().length === 1);
    expect(errors()[0]).toMatchObject({
      code: 'emulator_exited',
      message: expect.stringContaining('exit code 1'),
    });
    await waitUntil(() => stateOf('Pixel_9a')?.state === 'off');
    expect(stateOf('Pixel_9a')?.managed).toBe(false);
  });

  it('reports a launcher that cannot start', async () => {
    await manager.boot('Pixel_9a', 'quick');
    spawned[0]?.process.emit('error', new Error('spawn EACCES'));
    spawned[0]?.process.emit('exit', null, null);
    await waitUntil(() => errors().length === 1);
    expect(errors()[0]?.message).toBe("Pixel_9a exited. The server log names the emulator's log file.");
  });

  it('shuts down only emulators it booted, gracefully over gRPC', async () => {
    discover(1, 'Tablet', 5556);
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    await expect(manager.shutdown('Tablet')).rejects.toThrow('Tablet was not started by Lionscope');

    await manager.shutdown('Pixel_9a');
    const shutdowns = clients.filter(({ client }) => client.shutdowns > 0);
    expect(shutdowns.map(({ endpoint }) => endpoint.port)).toEqual([8554]);
    expect(stateOf('Pixel_9a')?.state).toBe('shutting_down');
    await manager.shutdown('Pixel_9a');
    expect(clients.filter(({ client }) => client.shutdowns > 0)).toHaveLength(1);

    vanish(10);
    spawned[0]?.process.emit('exit', 0, null);
    await waitUntil(() => stateOf('Pixel_9a')?.state === 'off');
    expect(stateOf('Pixel_9a')?.managed).toBe(false);
    expect(errors()).toEqual([]);
  });

  it('falls back to adb emu kill, then to a signal, when gRPC shutdown fails', async () => {
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    nextClient = () => Object.assign(new FakeEmulatorClient(), { shutdownResult: new Error('UNAVAILABLE') });
    await manager.shutdown('Pixel_9a');
    expect(adb.execCalls.filter((args) => args.includes('kill'))).toEqual([
      ['-s', 'emulator-5554', 'emu', 'kill'],
    ]);
    expect(spawned[0]?.process.signals).toEqual([]);

    await manager.boot('Tablet', 'quick');
    await manager.shutdown('Tablet');
    // Not discovered yet: neither gRPC nor the console is up.
    expect(spawned[1]?.process.signals).toEqual(['SIGTERM']);
  });

  it('on close shuts down the emulators it booted (with a timeout per step), never the others', async () => {
    discover(1, 'Tablet', 5556);
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    nextClient = () => Object.assign(new FakeEmulatorClient(), { shutdownResult: 'hang' as const });
    adb.execHandler = (args) => {
      if (args.includes('kill')) throw new Error('console not reachable');
      return '';
    };
    const before = messages.length;
    await manager.close();
    const used = clients.filter(({ client }) => client.shutdowns > 0).map(({ endpoint }) => endpoint.port);
    expect(used).toEqual([8554]);
    expect(adb.execCalls.filter((args) => args.includes('kill'))).toEqual([
      ['-s', 'emulator-5554', 'emu', 'kill'],
    ]);
    expect(spawned[0]?.process.signals).toEqual(['SIGTERM']);
    expect(clients.every(({ client }) => client.closed)).toBe(true);
    expect(messages.slice(before).filter((message) => message.type === 'emulators')).toEqual([]);
  }, 10_000);

  it('still shuts down an emulator whose launcher exited early, and reports clean exits quietly', async () => {
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    spawned[0]?.process.emit('exit', 0, null);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'running', managed: true });
    await manager.close();
    expect(clients.filter(({ client }) => client.shutdowns > 0)).toHaveLength(1);

    const other = new EmulatorManager({ adb, host, broadcast: (message) => messages.push(message) });
    await other.boot('Tablet', 'quick');
    spawned[1]?.process.emit('exit', 0, null);
    await other.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors()).toEqual([]);
    await other.close();
  });

  it('pins a boot to a console port nothing else uses', async () => {
    discover(1, 'Tablet', 5554);
    manager.setDevices([device('emulator-5554'), device('emulator-5558')]);
    busyPorts = new Set([5557]);
    await manager.boot('Pixel_9a', 'quick');
    expect(spawned[0]?.args.slice(2, 4)).toEqual(['-port', '5560']);
    busyPorts = new Set(Array.from({ length: 200 }, (_, i) => 5554 + i));
    avdList = 'Pixel_9a\nTablet\nTV\n';
    await expect(manager.boot('TV', 'quick')).rejects.toThrow('No free emulator console port (5554-5682)');
  });

  it('never shuts down or mirrors another instance of an AVD it booted, only its own serial', async () => {
    await manager.boot('Pixel_9a', 'quick');
    // A stale or planted discovery file names the same AVD on another serial.
    discover(77, 'Pixel_9a', 5556);
    manager.setDevices([device('emulator-5556')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', serial: null, managed: true });
    expect(manager.mirrorTarget('emulator-5556')).toMatchObject({ ok: false, code: 'not_emulator' });

    await manager.shutdown('Pixel_9a');
    expect(clients.some(({ client }) => client.shutdowns > 0)).toBe(false);
    expect(adb.execCalls.some((args) => args.includes('kill'))).toBe(false);
    expect(spawned[0]?.process.signals).toEqual(['SIGTERM']);

    // Its own instance, once it shows up on the pinned serial, is the one shut down.
    const other = new EmulatorManager({ adb, host, broadcast: () => undefined });
    vanish(77);
    await other.boot('Tablet', 'quick');
    discover(11, 'Tablet', 5554);
    await other.refresh();
    await other.shutdown('Tablet');
    expect(clients.filter(({ client }) => client.shutdowns > 0).map(({ endpoint }) => endpoint.port)).toEqual(
      [8554],
    );
    await other.close();
  });

  it('on POSIX takes only the instance with the pid it spawned, on Windows the serial alone', async () => {
    await manager.boot('Pixel_9a', 'quick');
    // Right serial, but another process (a stale file whose pid was reused, or a planted one).
    discover(99, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', serial: null });
    await manager.shutdown('Pixel_9a');
    expect(clients.some(({ client }) => client.shutdowns > 0)).toBe(false);
    expect(adb.execCalls.some((args) => args.includes('kill'))).toBe(false);

    const windows = new EmulatorManager({ adb, host, broadcast: () => undefined, platform: 'win32' });
    vanish(99);
    await windows.boot('Pixel_9a', 'quick');
    discover(98, 'Pixel_9a', 5554);
    await windows.refresh();
    expect(windows.getEmulators().find((info) => info.avdName === 'Pixel_9a')).toMatchObject({
      state: 'running',
      serial: 'emulator-5554',
    });
    await windows.close();
  });

  it('ignores a stale discovery file of a dead emulator on the serial it boots on', async () => {
    // `adb emu kill` left pid_28195.ini (serial 5554) behind; that process is gone.
    discover(28195, 'Pixel_9a', 5554);
    alive.delete(28195);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'off', serial: null });
    await manager.boot('Pixel_9a', 'quick');
    expect(spawned[0]?.args.slice(2, 7)).toEqual(['-port', '5554', '-grpc', '8554', '-grpc-use-token']);
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'running', serial: 'emulator-5554', managed: true });
    expect(manager.mirrorTarget('emulator-5554')).toMatchObject({ ok: true, endpoint: { port: 8554 } });
  });

  it('refuses a second operation for a busy AVD and a full queue, and skips queued work on close', async () => {
    avdList = 'A1\nA2\nA3\nA4\nA5\n';
    let release: (output: string) => void = () => undefined;
    host.runEmulator = () => new Promise((resolve) => (release = resolve));
    const first = manager.boot('A1', 'quick');
    await expect(manager.boot('A1', 'cold')).rejects.toThrow(
      'A1 is busy: a boot or shutdown is still in progress',
    );
    await expect(manager.shutdown('A1')).rejects.toThrow('A1 is busy');
    const queued = ['A2', 'A3', 'A4'].map((name) => manager.boot(name, 'quick'));
    await expect(manager.boot('A5', 'quick')).rejects.toThrow('Emulator operations are busy');
    const closing = manager.close();
    release(avdList);
    await expect(first).rejects.toThrow('server is shutting down');
    for (const boot of queued) await expect(boot).rejects.toThrow('server is shutting down');
    await closing;
    expect(spawned).toEqual([]);
  });

  it('tells how to shut down an emulator it did not boot', async () => {
    discover(1, 'Tablet', 5556);
    await manager.refresh();
    await expect(manager.shutdown('Tablet')).rejects.toThrow(
      'Tablet was not started by Lionscope: run adb -s emulator-5556 emu kill, or close it where it was started',
    );
  });

  it('on close waits at most CLOSE_OPERATIONS_WAIT_MS for a hung operation, then still shuts down', async () => {
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    host.runEmulator = () => new Promise(() => undefined);
    const hung = manager.boot('Tablet', 'quick');
    hung.catch(() => undefined);
    const started = Date.now();
    await manager.close();
    expect(Date.now() - started).toBeLessThan(CLOSE_OPERATIONS_WAIT_MS + 1000);
    expect(clients.filter(({ client }) => client.shutdowns > 0)).toHaveLength(1);
  });

  it('kills an emulator that ignores the shutdown after the grace period', async () => {
    const graceful = new EmulatorManager({
      adb,
      host,
      broadcast: () => undefined,
      avdListTtlMs: 0,
      shutdownGraceMs: 30,
    });
    await graceful.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await graceful.refresh();
    adb.execHandler = (args) => {
      if (args.includes('kill')) {
        // The console kill works: the emulator goes away.
        vanish(10);
        spawned[0]?.process.emit('exit', 0, null);
        return 'OK';
      }
      return '';
    };
    await graceful.shutdown('Pixel_9a');
    expect(adb.execCalls.some((args) => args.includes('kill'))).toBe(false);
    await waitUntil(() => adb.execCalls.some((args) => args.includes('kill')));
    expect(adb.execCalls.find((args) => args.includes('kill'))).toEqual([
      '-s',
      'emulator-5554',
      'emu',
      'kill',
    ]);
    await waitUntil(
      () => graceful.getEmulators().find((info) => info.avdName === 'Pixel_9a')?.state === 'off',
    );
    expect(spawned[0]?.process.signals).toEqual([]);
    await graceful.close();
  });

  it('forces the shutdown when asked a second time, killing the process group if the console fails', async () => {
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    await manager.refresh();
    adb.execHandler = (args) => {
      if (args.includes('kill')) throw new Error('console not reachable');
      return '';
    };
    await manager.shutdown('Pixel_9a');
    expect(spawned[0]?.process.signals).toEqual([]);
    await manager.shutdown('Pixel_9a');
    expect(adb.execCalls.filter((args) => args.includes('kill'))).toHaveLength(1);
    expect(spawned[0]?.process.signals).toEqual(['SIGKILL']);
  }, 10_000);

  it('drops a discovered instance that neither adb nor gRPC ever answered for 30 s (reused pid)', async () => {
    let now = 1_000_000;
    const stale = new EmulatorManager({
      adb,
      host,
      broadcast: () => undefined,
      avdListTtlMs: 0,
      now: () => now,
    });
    nextClient = () => Object.assign(new FakeEmulatorClient(), { booted: new Error('UNAVAILABLE') });
    discover(4321, 'Pixel_9a', 5554);
    await stale.refresh();
    expect(stale.getEmulators().find((info) => info.avdName === 'Pixel_9a')?.state).toBe('booting');
    now += STALE_INSTANCE_MS;
    await stale.refresh();
    expect(stale.getEmulators().find((info) => info.avdName === 'Pixel_9a')?.state).toBe('off');
    await stale.boot('Pixel_9a', 'quick');
    expect(spawned).toHaveLength(1);
    await stale.close();
  });

  it('keeps an instance that answered gRPC once, however long it boots', async () => {
    let now = 0;
    const client = new FakeEmulatorClient();
    client.booted = false;
    nextClient = () => client;
    const slow = new EmulatorManager({
      adb,
      host,
      broadcast: () => undefined,
      avdListTtlMs: 0,
      now: () => now,
    });
    discover(1, 'Pixel_9a', 5554);
    await slow.refresh();
    now += 10 * STALE_INSTANCE_MS;
    await slow.refresh();
    expect(slow.getEmulators().find((info) => info.avdName === 'Pixel_9a')?.state).toBe('booting');
    await slow.close();
  });

  it('retries a failed AVD name lookup after a back-off instead of hiding the emulator for good', async () => {
    let now = 0;
    const lookup = new EmulatorManager({
      adb,
      host,
      broadcast: () => undefined,
      avdListTtlMs: 0,
      now: () => now,
    });
    let fail = true;
    adb.execHandler = (args) => {
      if (args.includes('avd') && args.includes('name')) {
        if (fail) throw new Error('console busy');
        return 'Spare_AVD\nOK\n';
      }
      return args.at(-1) === 'getprop sys.boot_completed' ? '1\n' : '';
    };
    lookup.setDevices([device('emulator-5580')]);
    await lookup.refresh();
    expect(lookup.getEmulators().some((info) => info.avdName === 'Spare_AVD')).toBe(false);
    fail = false;
    await lookup.refresh();
    expect(adb.execCalls.filter((args) => args.includes('name'))).toHaveLength(1);
    now += AVD_NAME_RETRY_MS;
    await lookup.refresh();
    expect(lookup.getEmulators().find((info) => info.avdName === 'Spare_AVD')).toMatchObject({
      state: 'running',
    });
    await lookup.close();
  });

  it('does not take a failed signal for a failed start', async () => {
    await manager.boot('Pixel_9a', 'quick');
    spawned[0]?.process.emit('error', new Error('kill EPERM'));
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', managed: true });
    expect(errors()).toEqual([]);
  });

  it('matches its own instance by gRPC port too, and reports when its own instance exits', async () => {
    await manager.boot('Pixel_9a', 'quick');
    // Right serial and pid, but another gRPC port than the one it was booted with.
    alive.add(10);
    writeFileSync(
      path.join(discoveryDir, 'pid_10.ini'),
      'avd.id=Pixel_9a\nport.serial=5554\ngrpc.port=9999\ngrpc.token=t\n',
    );
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'booting', serial: null });
    // Another instance of the same AVD keeps running elsewhere: our crash is still reported.
    discover(50, 'Pixel_9a', 5560);
    spawned[0]?.process.emit('exit', 3, null);
    await waitUntil(() => errors().length === 1);
    expect(errors()[0]?.message).toContain('exit code 3');
  });

  it('does nothing more after close: no polling, no new gRPC channels', async () => {
    await manager.refresh();
    await manager.close();
    const calls = adb.execCalls.length;
    const channels = clients.length;
    discover(1, 'Pixel_9a', 5554);
    manager.setDevices([device('emulator-5554')]);
    await manager.refresh();
    expect(adb.execCalls.length).toBe(calls);
    expect(clients.length).toBe(channels);
  });

  it('closes the status channel once an instance has booted', async () => {
    discover(1, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(stateOf('Pixel_9a')?.state).toBe('running');
    expect(clients[0]?.client.closed).toBe(true);
  });

  it('notifies listeners on every change until unsubscribed', async () => {
    let calls = 0;
    const unsubscribe = manager.onChange(() => (calls += 1));
    await manager.refresh();
    expect(calls).toBe(1);
    unsubscribe();
    discover(1, 'Pixel_9a', 5554);
    await manager.refresh();
    expect(calls).toBe(1);
  });
});

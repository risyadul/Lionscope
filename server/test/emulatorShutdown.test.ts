import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeviceInfo, ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GrpcEndpoint } from '../src/emulator/discovery.ts';
import type { EmulatorHost, EmulatorProcess } from '../src/emulator/emulatorHost.ts';
import { EmulatorManager } from '../src/emulator/emulatorManager.ts';
import type { EmulatorManagerOptions } from '../src/emulator/emulatorManager.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { FakeAdb } from './helpers/fakes.ts';

class FakeProcess extends EventEmitter implements EmulatorProcess {
  readonly signals: (NodeJS.Signals | undefined)[] = [];

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

/** Shutting down emulators this server did not boot (Android Studio, a terminal), and the session on one. */
describe('EmulatorManager shutdown of any emulator', () => {
  let root: string;
  let discoveryDir: string;
  let messages: ServerMessage[];
  let alive: Set<number>;
  let spawned: FakeProcess[];
  let clients: { endpoint: GrpcEndpoint; client: FakeEmulatorClient }[];
  let nextClient: () => FakeEmulatorClient;
  let adb: FakeAdb;
  let host: EmulatorHost;
  let events: string[];
  let manager: EmulatorManager;

  const create = (options: Partial<EmulatorManagerOptions> = {}) =>
    new EmulatorManager({
      adb,
      host,
      broadcast: (message) => messages.push(message),
      pollMs: 10,
      avdListTtlMs: 0,
      stopSessionOn: async (serial) => {
        events.push(`stop session on ${serial}`);
      },
      ...options,
    });
  const stateOf = (avdName: string) => manager.getEmulators().find((info) => info.avdName === avdName);
  const grpcShutdowns = () =>
    clients.filter(({ client }) => client.shutdowns > 0).map(({ endpoint }) => endpoint.port);
  const kills = () => adb.execCalls.filter((args) => args.includes('kill'));
  const discover = (pid: number, avdName: string, port: number) => {
    alive.add(pid);
    writeFileSync(
      path.join(discoveryDir, `pid_${pid}.ini`),
      `avd.id=${avdName}\nport.serial=${port}\ngrpc.port=${port + 3000}\ngrpc.token=t-${pid}\n`,
    );
  };
  const vanish = (pid: number) => {
    alive.delete(pid);
    unlinkSync(path.join(discoveryDir, `pid_${pid}.ini`));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lionscope-shutdown-'));
    discoveryDir = path.join(root, 'running');
    mkdirSync(discoveryDir);
    messages = [];
    alive = new Set();
    spawned = [];
    clients = [];
    events = [];
    nextClient = () => new FakeEmulatorClient();
    adb = new FakeAdb((args) => {
      if (args.includes('emu') && args.includes('avd')) return 'Undiscovered_AVD\r\nOK\r\n';
      if (args.includes('emu') && args.includes('kill')) {
        events.push(`emu kill ${args[1]}`);
        return 'OK';
      }
      if (args.at(-1) === 'getprop sys.boot_completed') return '1\n';
      return '';
    });
    host = {
      emulatorPath: '/sdk/emulator/emulator',
      createClient: (endpoint) => {
        const client = nextClient();
        const shutdown = client.shutdown.bind(client);
        client.shutdown = () => {
          events.push(`gRPC shutdown ${endpoint.port}`);
          return shutdown();
        };
        clients.push({ endpoint, client });
        return client;
      },
      avdHome: path.join(root, 'avd'),
      discoveryDirs: [discoveryDir],
      runEmulator: async () => 'Pixel_9a\nTablet\n',
      spawnEmulator: () => {
        const process = new FakeProcess(10 + spawned.length);
        spawned.push(process);
        return process;
      },
      isAlive: (pid) => alive.has(pid),
      isPortFree: async () => true,
    };
    manager = create();
  });

  afterEach(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Pixel_9a runs on emulator-5554 (from Android Studio), Tablet on emulator-5556. */
  const runTwo = async () => {
    discover(4242, 'Pixel_9a', 5554);
    discover(4343, 'Tablet', 5556);
    manager.setDevices([device('emulator-5554'), device('emulator-5556')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'running', managed: false });
  };

  it('refuses an emulator it did not boot without confirmUnmanaged, touching nothing', async () => {
    await runTwo();
    await expect(manager.shutdown('Pixel_9a')).rejects.toThrow(
      'Pixel_9a was not started by Lionscope: run adb -s emulator-5554 emu kill',
    );
    expect(grpcShutdowns()).toEqual([]);
    expect(kills()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('shuts a confirmed one down over its own gRPC endpoint, tracked as shutting down until it is gone', async () => {
    await runTwo();
    await manager.shutdown('Pixel_9a', true);
    expect(grpcShutdowns()).toEqual([8554]);
    expect(kills()).toEqual([]);
    expect(stateOf('Pixel_9a')?.state).toBe('shutting_down');
    expect(stateOf('Tablet')?.state).toBe('running');

    vanish(4242);
    manager.setDevices([device('emulator-5556')]);
    await waitUntil(() => stateOf('Pixel_9a')?.state === 'off');
    expect(messages.filter((message) => message.type === 'error')).toEqual([]);
  });

  it('falls back to adb emu kill on its serial only, and never signals a process', async () => {
    await runTwo();
    nextClient = () => Object.assign(new FakeEmulatorClient(), { shutdownResult: new Error('UNAVAILABLE') });
    await manager.shutdown('Pixel_9a', true);
    expect(grpcShutdowns()).toEqual([8554]);
    expect(kills()).toEqual([['-s', 'emulator-5554', 'emu', 'kill']]);
    expect(stateOf('Pixel_9a')?.state).toBe('shutting_down');
  });

  it('reports a shutdown neither gRPC nor the console took, and shows it running again', async () => {
    await runTwo();
    nextClient = () => Object.assign(new FakeEmulatorClient(), { shutdownResult: new Error('UNAVAILABLE') });
    adb.execHandler = (args) => {
      if (args.includes('kill')) throw new Error('console not reachable');
      return '';
    };
    await expect(manager.shutdown('Pixel_9a', true)).rejects.toThrow(
      'Pixel_9a did not accept the shutdown: close it where it was started',
    );
    expect(stateOf('Pixel_9a')?.state).toBe('running');
  });

  it('kills it over its console when asked again, or after the grace period', async () => {
    await runTwo();
    await manager.shutdown('Pixel_9a', true);
    await manager.shutdown('Pixel_9a', true);
    expect(kills()).toEqual([['-s', 'emulator-5554', 'emu', 'kill']]);
    expect(grpcShutdowns()).toEqual([8554]);

    const graceful = create({ shutdownGraceMs: 30 });
    await graceful.refresh();
    graceful.setDevices([device('emulator-5554'), device('emulator-5556')]);
    await graceful.refresh();
    await graceful.shutdown('Tablet', true);
    await waitUntil(() => kills().length === 2);
    expect(kills()[1]).toEqual(['-s', 'emulator-5556', 'emu', 'kill']);
    await graceful.close();
  });

  it('refuses an instance it cannot identify: none, several, adb-only or not ready in adb', async () => {
    await manager.refresh();
    await expect(manager.shutdown('Pixel_9a', true)).rejects.toThrow('Pixel_9a is not running');

    discover(4242, 'Pixel_9a', 5554);
    discover(4444, 'Pixel_9a', 5558);
    manager.setDevices([device('emulator-5554'), device('emulator-5558')]);
    await manager.refresh();
    await expect(manager.shutdown('Pixel_9a', true)).rejects.toThrow(
      'Pixel_9a runs 2 times (emulator-5554, emulator-5558)',
    );

    discover(4343, 'Tablet', 5556);
    manager.setDevices([device('emulator-5556', 'offline')]);
    await manager.refresh();
    await expect(manager.shutdown('Tablet', true)).rejects.toThrow(
      'Tablet (emulator-5556) is not ready in adb yet',
    );

    // Named by `adb emu avd name` alone: no discovery file to confirm which process it is.
    manager.setDevices([device('emulator-5560')]);
    await manager.refresh();
    await expect(manager.shutdown('Undiscovered_AVD', true)).rejects.toThrow(
      'Undiscovered_AVD (emulator-5560) has no emulator discovery file',
    );
    expect(grpcShutdowns()).toEqual([]);
    expect(kills()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('stops a session on the emulator first, managed or not', async () => {
    await manager.boot('Pixel_9a', 'quick');
    discover(10, 'Pixel_9a', 5554);
    discover(4343, 'Tablet', 5556);
    manager.setDevices([device('emulator-5554'), device('emulator-5556')]);
    await manager.refresh();
    expect(stateOf('Pixel_9a')).toMatchObject({ state: 'running', managed: true });
    await manager.shutdown('Pixel_9a');
    await manager.shutdown('Tablet', true);
    expect(events).toEqual([
      'stop session on emulator-5554',
      'gRPC shutdown 8554',
      'stop session on emulator-5556',
      'gRPC shutdown 8556',
    ]);
    expect(spawned[0]?.signals).toEqual([]);
  });

  it('never touches an emulator it did not boot on close, even one it is shutting down', async () => {
    const graceful = create({ shutdownGraceMs: 30 });
    discover(4242, 'Pixel_9a', 5554);
    discover(4343, 'Tablet', 5556);
    graceful.setDevices([device('emulator-5554'), device('emulator-5556')]);
    await graceful.refresh();
    await graceful.shutdown('Pixel_9a', true);
    expect(events).toEqual(['stop session on emulator-5554', 'gRPC shutdown 8554']);
    await graceful.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual(['stop session on emulator-5554', 'gRPC shutdown 8554']);
    expect(kills()).toEqual([]);
  });
});

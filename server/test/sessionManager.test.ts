import type { ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicError } from '../src/errors.ts';
import {
  ADB_UNAVAILABLE_MESSAGE,
  DEVICE_GONE_LISTINGS,
  IDLE_SESSION,
  SESSION_ADB_UNAVAILABLE,
  SessionManager,
} from '../src/session/sessionManager.ts';
import { FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';

const PKG = 'com.google.android.apps.nexuslauncher';
const EMPTY_SNAPSHOT = {
  cpu: [],
  memory: [],
  frames: [],
  logs: [],
  events: [],
  breakdown: [],
  stalls: [],
  strictMode: [],
  inflates: [],
  viewTrees: [],
  screens: [],
};
const DEVICES = fixture('adb-devices.txt');

function setup() {
  const device = new FakeDevice();
  let devicesOutput = DEVICES;
  let devicesError: Error | null = null;
  const adb = new FakeAdb(
    (args) => {
      if (args[0] === 'devices') {
        if (devicesError) throw devicesError;
        return devicesOutput;
      }
      const command = args.at(-1);
      if (command === 'pm list packages') return fixture('pm-list-packages.txt');
      if (command === 'pm list packages -3') return fixture('pm-list-packages-3.txt');
      if (command === 'ps -A -o PID,NAME') return fixture('ps.txt');
      return '';
    },
    (command) => device.handle(command),
  );
  const messages: ServerMessage[] = [];
  const manager = new SessionManager({ adb, broadcast: (message) => messages.push(message) });
  return {
    adb,
    device,
    manager,
    messages,
    setDevices(output: string) {
      devicesOutput = output;
    },
    failDevices(error: Error | null) {
      devicesError = error;
    },
    devicesCalls: () => adb.execCalls.filter((args) => args[0] === 'devices').length,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager', () => {
  it('starts idle with an empty snapshot', () => {
    const { manager } = setup();
    expect(manager.getSessionState()).toEqual(IDLE_SESSION);
    expect(manager.getSnapshot()).toEqual(EMPTY_SNAPSHOT);
    expect(manager.getDevices()).toEqual([]);
  });

  it('polls devices every 2 s and broadcasts only on change', async () => {
    const { manager, messages, setDevices, devicesCalls } = setup();
    manager.startDevicePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual([
      { type: 'devices', devices: [expect.objectContaining({ serial: 'emulator-5554' })] },
    ]);

    await vi.advanceTimersByTimeAsync(4000);
    expect(devicesCalls()).toBe(3);
    expect(messages).toHaveLength(1);

    setDevices('List of devices attached\nemulator-5554 offline\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages.at(-1)).toEqual({
      type: 'devices',
      devices: [{ serial: 'emulator-5554', state: 'offline' }],
    });
    await manager.close();
    const calls = devicesCalls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(devicesCalls()).toBe(calls);
  });

  it('coalesces concurrent device refreshes into one adb call', async () => {
    const { manager, devicesCalls } = setup();
    const results = await Promise.all([
      manager.refreshDevices(),
      manager.refreshDevices(),
      manager.refreshDevices(),
    ]);
    expect(devicesCalls()).toBe(1);
    expect(results[0]).toBe(results[2]);
    await manager.refreshDevices();
    expect(devicesCalls()).toBe(2);
  });

  it('keeps the last device list on adb failure and reports a path-free error once', async () => {
    const { manager, messages, failDevices } = setup();
    const before = await manager.refreshDevices();
    failDevices(new Error('spawn /secret/sdk/platform-tools/adb ENOENT'));
    expect(await manager.refreshDevices()).toBe(before);
    await manager.refreshDevices();
    expect(messages.filter((message) => message.type === 'devices')).toHaveLength(1);
    const errors = messages.filter((message) => message.type === 'error');
    expect(errors).toEqual([{ type: 'error', code: 'adb_unavailable', message: ADB_UNAVAILABLE_MESSAGE }]);
    expect(JSON.stringify(errors)).not.toContain('/secret');
    failDevices(null);
    expect(await manager.refreshDevices()).toHaveLength(1);
  });

  it('keeps a session running through transient adb failures, then errors after 3 in a row', async () => {
    const { manager, failDevices } = setup();
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(1100);
    failDevices(new Error('adb server restarting'));
    await manager.refreshDevices();
    await manager.refreshDevices();
    expect(manager.getSessionState().status).toBe('running');
    failDevices(null);
    await manager.refreshDevices(); // success resets the counter
    failDevices(new Error('adb server gone'));
    await manager.refreshDevices();
    await manager.refreshDevices();
    expect(manager.getSessionState().status).toBe('running');
    await manager.refreshDevices();
    expect(manager.getSessionState()).toMatchObject({ status: 'error', error: SESSION_ADB_UNAVAILABLE });
    await manager.close();
  });

  it('lists apps with running state, third-party flag and ordering', async () => {
    const { manager, adb } = setup();
    const apps = await manager.listApps('emulator-5554');
    expect(apps[0]).toEqual({
      packageName: 'com.example.shop',
      pid: 4081,
      thirdParty: true,
    });
    expect(apps.find((app) => app.packageName === PKG)).toEqual({
      packageName: PKG,
      pid: 1105,
      thirdParty: false,
    });
    expect(adb.execCalls.filter((args) => args[0] === '-s').map((args) => args.slice(0, 3))).toEqual([
      ['-s', 'emulator-5554', 'shell'],
      ['-s', 'emulator-5554', 'shell'],
      ['-s', 'emulator-5554', 'shell'],
    ]);
  });

  it('coalesces concurrent listApps for the same serial', async () => {
    const { manager, adb } = setup();
    const [a, b] = await Promise.all([manager.listApps('emulator-5554'), manager.listApps('emulator-5554')]);
    expect(a).toBe(b);
    expect(adb.execCalls.filter((args) => args.at(-1) === 'pm list packages')).toHaveLength(1);
  });

  it('only lists apps of a connected device in state "device"', async () => {
    const { manager, setDevices, adb, failDevices } = setup();
    await expect(manager.listApps('bad serial')).rejects.toThrow('invalid adb serial');
    await expect(manager.listApps('emulator-9999')).rejects.toThrow(
      new PublicError('Device emulator-9999 is not connected'),
    );
    setDevices('List of devices attached\nemulator-5554 unauthorized\n');
    await expect(manager.listApps('emulator-5554')).rejects.toThrow('Device emulator-5554 is unauthorized');
    failDevices(new Error('boom'));
    await expect(manager.listApps('emulator-5554')).rejects.toThrow(ADB_UNAVAILABLE_MESSAGE);
    expect(adb.execCalls.filter((args) => args[0] === '-s')).toEqual([]);
  });

  it('refuses to start on unknown, offline or invalid targets with public errors', async () => {
    const { manager, setDevices } = setup();
    await expect(manager.startSession('emulator-9999', PKG)).rejects.toBeInstanceOf(PublicError);
    await expect(manager.startSession('emulator-9999', PKG)).rejects.toThrow(
      'Device emulator-9999 is not connected',
    );
    await expect(manager.startSession('emulator-5554', 'nope')).rejects.toThrow('invalid package name');
    await expect(manager.startSession('$(id)', PKG)).rejects.toThrow('invalid adb serial');
    setDevices('List of devices attached\nemulator-5554 unauthorized\n');
    await expect(manager.startSession('emulator-5554', PKG)).rejects.toThrow(
      'Device emulator-5554 is unauthorized',
    );
    expect(manager.getSessionState()).toEqual(IDLE_SESSION);
  });

  it('starts a session: broadcasts session + empty snapshot, then live data', async () => {
    const { manager, messages } = setup();
    const state = await manager.startSession('emulator-5554', PKG);
    expect(state).toMatchObject({ status: 'waiting_for_process', serial: 'emulator-5554', packageName: PKG });
    const start = messages.findIndex((message) => message.type === 'session');
    expect(messages.slice(start, start + 2)).toEqual([
      { type: 'session', session: state },
      { type: 'snapshot', snapshot: EMPTY_SNAPSHOT },
    ]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(manager.getSessionState()).toMatchObject({ status: 'running', pid: 1105 });
    expect(messages.map((message) => message.type)).toContain('cpu');
    expect(manager.getSnapshot().cpu.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('only keeps one session: a new start stops the old one and clears buffers', async () => {
    const { manager, adb, messages } = setup();
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(2100);
    const firstShells = [...adb.shells];
    await manager.startSession('emulator-5554', 'com.android.settings');
    expect(firstShells.every((shell) => shell.killed)).toBe(true);
    expect(manager.getSessionState()).toMatchObject({ packageName: 'com.android.settings' });
    expect(manager.getSnapshot().cpu).toEqual([]);

    // Messages from the stopped session are never broadcast after the switch.
    const switchIndex = messages.findLastIndex((message) => message.type === 'snapshot');
    await vi.advanceTimersByTimeAsync(2100);
    const later = messages.slice(switchIndex + 1);
    expect(later.some((message) => message.type === 'session' && message.session.packageName === PKG)).toBe(
      false,
    );
    await manager.close();
  });

  it('stops the session on request and keeps its data for review', async () => {
    const { manager } = setup();
    expect(await manager.stopSession()).toEqual(IDLE_SESSION);
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(2100);
    const state = await manager.stopSession();
    expect(state).toMatchObject({ status: 'idle', serial: 'emulator-5554', packageName: PKG, pid: null });
    expect(manager.getSnapshot().cpu.length).toBeGreaterThan(0);
    await manager.close();
  });

  it('stops the session only when it profiles the emulator that is shutting down', async () => {
    const { manager } = setup();
    await manager.startSession('emulator-5554', PKG);
    await manager.stopSessionOn('emulator-5556');
    expect(manager.getSessionState().status).not.toBe('idle');
    await manager.stopSessionOn('emulator-5554');
    expect(manager.getSessionState()).toMatchObject({ status: 'idle', serial: 'emulator-5554' });
    await manager.close();
  });

  it(`puts the session in error after ${DEVICE_GONE_LISTINGS} successful listings without its device`, async () => {
    const { manager, setDevices, messages } = setup();
    manager.startDevicePolling();
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(2100);
    setDevices('List of devices attached\n');
    await vi.advanceTimersByTimeAsync(2000); // listing 1 without the device
    await vi.advanceTimersByTimeAsync(2000); // listing 2
    expect(manager.getSessionState().status).toBe('running');
    await vi.advanceTimersByTimeAsync(2000); // listing 3
    expect(manager.getSessionState()).toMatchObject({
      status: 'error',
      error: 'Device emulator-5554 disconnected',
    });
    expect(messages.filter((m) => m.type === 'devices').at(-1)).toEqual({ type: 'devices', devices: [] });
    expect(messages.at(-1)).toEqual({ type: 'session', session: manager.getSessionState() });
    await manager.close();
  });

  it('rides out a short USB flicker (device missing or offline for < 3 listings)', async () => {
    const { manager, setDevices } = setup();
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(1100);
    setDevices('List of devices attached\n');
    await manager.refreshDevices();
    setDevices('List of devices attached\nemulator-5554 offline\n');
    await manager.refreshDevices();
    setDevices(DEVICES);
    await manager.refreshDevices(); // back: the streak resets
    setDevices('List of devices attached\n');
    await manager.refreshDevices();
    await manager.refreshDevices();
    expect(manager.getSessionState().status).toBe('running');
    await manager.close();
  });

  it('reports a device that went offline', async () => {
    const { manager, setDevices } = setup();
    await manager.startSession('emulator-5554', PKG);
    setDevices('List of devices attached\nemulator-5554 offline\n');
    for (let i = 0; i < DEVICE_GONE_LISTINGS; i += 1) await manager.refreshDevices();
    expect(manager.getSessionState()).toMatchObject({
      status: 'error',
      error: 'Device emulator-5554 is offline',
    });
    await manager.close();
  });

  it('refuses to start after close()', async () => {
    const { manager } = setup();
    await manager.close();
    await expect(manager.startSession('emulator-5554', PKG)).rejects.toThrow('shutting down');
  });
});

import type { ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkHello, SdkLink } from '../src/device/sdkLink.ts';
import { log } from '../src/log.ts';
import {
  DEVICE_GONE_LISTINGS,
  REMAP_INTERVAL_MS,
  SDK_GATEWAY_DOWN,
  SDK_LINK_UNAVAILABLE,
  SessionManager,
} from '../src/session/sessionManager.ts';
import { execShellCommand, FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';
import { NO_EDITS } from './helpers/sdkSession.ts';

const PKG = 'com.google.android.apps.nexuslauncher';
const GATEWAY_PORT = 9123;
const REVERSE = ['-s', 'emulator-5554', 'reverse', 'tcp:8700', `tcp:${GATEWAY_PORT}`];
const REMOVE = ['-s', 'emulator-5554', 'reverse', '--remove', 'tcp:8700'];

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 1,
  sdkVersion: '0.1.0',
  packageName: PKG,
  processName: PKG,
  pid: 1105,
  apiLevel: 35,
  deviceWallMs: 1,
  refreshRateHz: 60,
};
const link: SdkLink = {
  protocolVersion: 1,
  close: () => undefined,
  sendConfig: () => undefined,
  sendMocks: () => undefined,
  inspect: () => Promise.reject(new Error('unsupported')),
  ...NO_EDITS,
};

function setup(
  gatewayPort: (() => number | null) | null = () => GATEWAY_PORT,
  livePorts: readonly number[] = [],
) {
  const device = new FakeDevice();
  device.clockSkewMs = -5000;
  let devicesOutput = fixture('adb-devices.txt');
  let devicesError: Error | null = null;
  let reverseList = '';
  const adb = new FakeAdb(
    (args) => {
      if (args[0] === 'devices') {
        if (devicesError) throw devicesError;
        return devicesOutput;
      }
      // The PID check of a hello (`adb shell pidof`) asks the fake device.
      const command = execShellCommand(args);
      if (command?.startsWith('pidof ')) return String(device.handle(command));
      return args.includes('--list') ? reverseList : '';
    },
    (command) => device.handle(command),
  );
  const messages: ServerMessage[] = [];
  const manager = new SessionManager({
    adb,
    broadcast: (message) => messages.push(message),
    ...(gatewayPort ? { deviceGatewayPort: gatewayPort } : {}),
    isHostPortLive: (port) => Promise.resolve(livePorts.includes(port)),
  });
  /** Start a session and let its device probe finish. */
  const start = async (packageName = PKG) => {
    await manager.startSession('emulator-5554', packageName);
    await vi.advanceTimersByTimeAsync(50);
  };
  return {
    adb,
    device,
    manager,
    messages,
    start,
    errors: () => messages.filter((message) => message.type === 'error'),
    setDevices(output: string) {
      devicesOutput = output;
    },
    failDevices(error: Error | null) {
      devicesError = error;
    },
    setReverseList(output: string) {
      reverseList = output;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionManager SDK link', () => {
  it('only attaches an SDK of the ready session’s app, answering no_session otherwise', async () => {
    const info = vi.spyOn(log, 'info');
    const { manager, start } = setup();
    expect(await manager.attachSdk(HELLO, link)).toEqual({ ok: false, reason: 'no_session' });
    await start();
    const other = { ...HELLO, packageName: 'com.other.app' };
    // No oracle: a foreign package gets the same answer as "no session"; the reason is only logged.
    expect(await manager.attachSdk(other, link)).toEqual({ ok: false, reason: 'no_session' });
    expect(await manager.attachSdk(other, link)).toEqual({ ok: false, reason: 'no_session' });
    expect(info.mock.calls.filter((call) => String(call[0]).includes('com.other.app'))).toHaveLength(1);
    expect(await manager.attachSdk(HELLO, link)).toMatchObject({ ok: true, mode: 'session' });
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    await manager.stopSession();
    expect(await manager.attachSdk(HELLO, link)).toEqual({ ok: false, reason: 'no_session' });
    await manager.close();
  });

  it('sets the SDK options of the running session only, announcing them with the session', async () => {
    const { manager, messages, start } = setup();
    expect(manager.setSdkOptions({ strictMode: true })).toBe(false);
    await start();
    expect(manager.setSdkOptions({ stallThresholdMs: 250 })).toBe(true);
    const options = { stallThresholdMs: 250, strictMode: false, inflateTracking: true, rxTracking: true };
    expect(manager.getSessionState().sdk?.options).toEqual(options);
    const last = messages.at(-1);
    expect(last?.type === 'session' && last.session.sdk?.options).toEqual(options);
    await manager.stopSession();
    expect(manager.setSdkOptions({ strictMode: true })).toBe(false);
    expect(manager.getSessionState().sdk?.options).toEqual(options);
    await manager.close();
  });

  it('refuses SDK links and adb reverse while the device probe runs; logcat gets the measured offset', async () => {
    const { adb, device, manager } = setup();
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command === 'getconf CLK_TCK' ? { output: '100\n', delayMs: 500 } : original(command);
    await manager.startSession('emulator-5554', PKG);
    await vi.advanceTimersByTimeAsync(100);
    // An SDK hello arriving now must not trigger a pidof (and logcat) before the clock offset is known.
    expect(await manager.attachSdk({ ...HELLO, pid: 4321 }, link)).toEqual({
      ok: false,
      reason: 'no_session',
    });
    expect(device.commands.some((command) => command.startsWith('pidof'))).toBe(false);
    expect(adb.reverseCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(adb.reverseCalls).toEqual([REVERSE]);
    const logcat = adb.liveLogcats[0]?.child;
    const deviceTs = Date.now() - 5000;
    logcat?.stdout.write(
      `   ${Math.floor(deviceTs / 1000)}.${String(deviceTs % 1000).padStart(3, '0')}  1105  1105 I Tag: hi\n`,
    );
    await vi.advanceTimersByTimeAsync(300);
    const entry = manager.getSnapshot().logs[0];
    expect(entry?.message).toBe('hi');
    expect(Math.abs((entry?.ts ?? 0) - (deviceTs + 5000))).toBeLessThanOrEqual(1);
    await manager.close();
  });

  it('maps adb reverse once the session is ready and removes it on stop', async () => {
    const { adb, manager, start } = setup();
    await start();
    expect(adb.reverseCalls).toEqual([REVERSE]);
    await manager.stopSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.reverseCalls).toEqual([REVERSE, REMOVE]);
    await manager.stopSession(); // nothing mapped any more
    await manager.close();
    expect(adb.reverseCalls).toEqual([REVERSE, REMOVE]);
  });

  it('replaces the mapping on a new session strictly in order, and removes it on shutdown', async () => {
    const { adb, manager, start } = setup();
    const order: string[] = [];
    adb.reverseHandler = async (args) => {
      const name = args.includes('--remove') ? 'remove' : 'reverse';
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, name === 'remove' ? 300 : 10));
      order.push(`${name}:end`);
    };
    await start();
    await start('com.android.settings');
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([
      'reverse:start',
      'reverse:end',
      'remove:start',
      'remove:end',
      'reverse:start',
      'reverse:end',
    ]);
    const closed = manager.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(adb.reverseCalls.at(-1)).toEqual(REMOVE);
  });

  it('removes the mapping when the session ends because its device disappeared', async () => {
    const { adb, manager, setDevices, start } = setup();
    await start();
    setDevices('List of devices attached\n');
    for (let i = 0; i < DEVICE_GONE_LISTINGS; i += 1) await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getSessionState().status).toBe('error');
    expect(adb.reverseCalls).toEqual([REVERSE, REMOVE]);
    await manager.close();
  });

  it('re-maps after a USB flicker and after adb listings recover', async () => {
    const { adb, manager, setDevices, failDevices, start } = setup();
    await start();
    await manager.refreshDevices();
    expect(adb.reverseCalls).toEqual([REVERSE]); // steady state: nothing to do

    setDevices('List of devices attached\nemulator-5554 offline\n');
    await manager.refreshDevices();
    setDevices(fixture('adb-devices.txt'));
    await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.reverseCalls).toEqual([REVERSE, REVERSE]);

    failDevices(new Error('adb server restarting'));
    await manager.refreshDevices();
    failDevices(null);
    await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.reverseCalls).toEqual([REVERSE, REVERSE, REVERSE]);
    await manager.close();
  });

  it(`re-applies the mapping every ${REMAP_INTERVAL_MS / 1000} s while no SDK is connected`, async () => {
    const { adb, manager, start } = setup();
    await start();
    const reverses = () => adb.reverseCalls.filter((args) => !args.includes('--remove')).length;
    await vi.advanceTimersByTimeAsync(REMAP_INTERVAL_MS - 1000);
    await manager.refreshDevices();
    expect(reverses()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await manager.refreshDevices();
    await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(reverses()).toBe(2);

    await manager.attachSdk(HELLO, link);
    await vi.advanceTimersByTimeAsync(REMAP_INTERVAL_MS * 2);
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    await manager.refreshDevices();
    expect(reverses()).toBe(2); // connected: the mapping evidently works
    await manager.close();
  });

  it('keeps the session running ADB-only when adb reverse fails, with one public error', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { adb, manager, errors, start } = setup();
    adb.reverseHandler = (args) => {
      if (!args.includes('--remove')) throw new Error('adb: error: device offline at /secret/path');
    };
    await start();
    await vi.advanceTimersByTimeAsync(1100);
    await start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(manager.getSessionState().status).toBe('running');
    expect(errors()).toEqual([
      { type: 'error', code: 'sdk_link_unavailable', message: SDK_LINK_UNAVAILABLE },
    ]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('device offline'))).toBe(true);
    // The intent was recorded before calling adb: stopping still attempts the removal.
    await manager.stopSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.reverseCalls.at(-1)).toEqual(REMOVE);
    await manager.close();
  });

  it('logs a failed removal and carries on', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { adb, manager, start } = setup();
    await start();
    adb.reverseHandler = () => Promise.reject(new Error('device not found'));
    await manager.close();
    expect(adb.reverseCalls.at(-1)).toEqual(REMOVE);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('Could not remove adb reverse'))).toBe(
      true,
    );
  });

  it('without an SDK gateway there is no adb reverse at all', async () => {
    const { adb, manager, errors, start } = setup(null);
    await start();
    await manager.refreshDevices();
    await manager.stopSession();
    await manager.close();
    expect(adb.reverseCalls).toEqual([]);
    expect(adb.execCalls.some((args) => args.includes('reverse'))).toBe(false);
    expect(errors()).toEqual([]);
  });

  it('reports once when the SDK gateway is not listening', async () => {
    const { adb, manager, errors, start } = setup(() => null);
    await start();
    await start();
    expect(adb.reverseCalls).toEqual([]);
    expect(errors()).toEqual([{ type: 'error', code: 'sdk_link_unavailable', message: SDK_GATEWAY_DOWN }]);
    await manager.close();
  });

  it('removes stale tcp:8700 mappings of an earlier run on the first device listing', async () => {
    const { adb, manager, setReverseList } = setup();
    setReverseList('UsbFfs tcp:8700 tcp:8711\nUsbFfs tcp:9000 tcp:9000\n');
    await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.execCalls.filter((args) => args.includes('--list'))).toEqual([
      ['-s', 'emulator-5554', 'reverse', '--list'],
    ]);
    expect(adb.reverseCalls).toEqual([REMOVE]);
    await manager.refreshDevices(); // only once per run
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.execCalls.filter((args) => args.includes('--list'))).toHaveLength(1);
    await manager.close();
  });

  it("keeps another live server's tcp:8700 mapping and removes this server's own leftover", async () => {
    const info = vi.spyOn(log, 'info');
    const other = setup(() => GATEWAY_PORT, [8700]);
    other.setReverseList('UsbFfs tcp:8700 tcp:8700\n');
    await other.manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(other.adb.reverseCalls).toEqual([]);
    expect(info.mock.calls.some((call) => String(call[0]).includes('another server listens on 8700'))).toBe(
      true,
    );

    // A mapping to this server's own gateway port is a leftover even though that port is live (it's ours).
    const own = setup(() => GATEWAY_PORT, [GATEWAY_PORT]);
    own.setReverseList(`UsbFfs tcp:8700 tcp:${GATEWAY_PORT}\n`);
    await own.manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(own.adb.reverseCalls).toEqual([REMOVE]);
    await other.manager.close();
    await own.manager.close();
  });

  it('leaves other mappings alone and survives a failing listing', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { adb, manager, setReverseList } = setup();
    setReverseList('UsbFfs tcp:9000 tcp:8700\n');
    await manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.reverseCalls).toEqual([]);

    const second = setup();
    second.adb.execHandler = (args) => {
      if (args.includes('--list')) throw new Error('device offline');
      return args[0] === 'devices' ? fixture('adb-devices.txt') : '';
    };
    await second.manager.refreshDevices();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('Could not check adb reverse'))).toBe(
      true,
    );
    await manager.close();
    await second.manager.close();
  });
});

import type { AddressInfo } from 'node:net';
import type { ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectLinks } from '../src/device/inspectLinks.ts';
import type { InspectLinkListener } from '../src/device/inspectLinks.ts';
import type { SdkHello } from '../src/device/sdkLink.ts';
import { DEVICE_GONE_LISTINGS, SessionManager } from '../src/session/sessionManager.ts';
import { execShellCommand, FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const SERIAL = 'emulator-5554';
const PHONE = 'R58M123ABC';
const PKG = 'com.example.shop';
const OTHER = 'com.example.other';
const GATEWAY_PORT = 9123;
const LISTENER_PORT = 41_001;
const PHONE_LINE = `${PHONE}             device product:x model:x device:x transport_id:5\n`;
const DEVICES = `${fixture('adb-devices.txt')}${PHONE_LINE}`;
const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 5,
  sdkVersion: '0.5.2',
  packageName: PKG,
  processName: PKG,
  pid: 1105,
  apiLevel: 35,
  deviceWallMs: 1,
  refreshRateHz: 60,
};
const OTHER_HELLO: SdkHello = { ...HELLO, packageName: OTHER, processName: OTHER, pid: 2222 };
const SESSION_MAP = ['-s', SERIAL, 'reverse', 'tcp:8700', `tcp:${GATEWAY_PORT}`];
const INSPECT_MAP = ['-s', SERIAL, 'reverse', 'tcp:8700', `tcp:${LISTENER_PORT}`];
const REMOVE = ['-s', SERIAL, 'reverse', '--remove', 'tcp:8700'];

class FakeListener implements InspectLinkListener {
  address: AddressInfo | null = null;
  async listen(): Promise<AddressInfo> {
    this.address = { address: '127.0.0.1', family: 'IPv4', port: LISTENER_PORT };
    return this.address;
  }
  async close(): Promise<void> {
    this.address = null;
  }
}

function setup() {
  const device = new FakeDevice();
  device.clockSkewMs = -5000;
  /** `serial package` → its PIDs on that device (the session app runs on the emulator as FakeDevice's pid). */
  const pids = new Map([
    [`${SERIAL} ${PKG}`, '1105'],
    [`${SERIAL} ${OTHER}`, '2222'],
  ]);
  const mappings = new Map<string, string>();
  /** Debuggable apps (as `dumpsys package` reports them). */
  const debuggable = new Set([PKG, OTHER]);
  let devices = DEVICES;
  const adb = new FakeAdb(
    (args) => {
      if (args[0] === 'devices') return devices;
      const command = execShellCommand(args);
      if (command?.startsWith('pidof ')) {
        const pid = pids.get(`${args[1]} ${command.slice('pidof '.length)}`);
        return pid === undefined ? '' : `${pid}\n`;
      }
      if (command?.startsWith('dumpsys package ')) {
        const packageName = command.slice('dumpsys package '.length);
        const flags = debuggable.has(packageName) ? 'DEBUGGABLE HAS_CODE' : 'HAS_CODE';
        return `Packages:\n  Package [${packageName}] (1a2b3c):\n    flags=[ ${flags} ]\n`;
      }
      const target = mappings.get(args[1] ?? '');
      return args.includes('--list') && target !== undefined ? `UsbFfs tcp:8700 ${target}\n` : '';
    },
    (command) => device.handle(command),
  );
  adb.reverseHandler = (args) => {
    if (args.includes('--remove')) mappings.delete(args[1] ?? '');
    else mappings.set(args[1] ?? '', args[4] ?? '');
  };
  const messages: ServerMessage[] = [];
  const links: InspectLinks = new InspectLinks({
    adb,
    createListener: () => new FakeListener(),
    route: (serial, hello, link) => manager.attachSdkOn(serial, hello, link),
    sessionPort: () => GATEWAY_PORT,
    isHostPortLive: async () => false,
  });
  const manager: SessionManager = new SessionManager({
    adb,
    broadcast: (message) => messages.push(message),
    deviceGatewayPort: () => GATEWAY_PORT,
    isHostPortLive: async () => false,
    inspectLinks: links,
  });
  const client = {};
  return {
    adb,
    manager,
    links,
    mappings,
    client,
    pids,
    debuggable,
    setDevices: (output: string) => {
      devices = output;
    },
    settle: () => vi.advanceTimersByTimeAsync(0),
    /** The device listing feeds the inspect-only links (and clears stale mappings once). */
    list: async () => {
      await manager.refreshDevices();
      await vi.advanceTimersByTimeAsync(0);
    },
    start: async () => {
      await manager.startSession(SERIAL, PKG);
      await vi.advanceTimersByTimeAsync(50);
    },
    pidofs: () => adb.execCalls.filter((args) => execShellCommand(args)?.startsWith('pidof ')),
    reverses: () => adb.reverseCalls,
    attach: async (hello: SdkHello, serial: string | null = SERIAL) => {
      const link = new FakeLink(hello.protocolVersion);
      return { link, result: await manager.attachSdkOn(serial, hello, link) };
    },
    /** A hello on the session gateway (its device: the one the session mapped). */
    attachViaSession: async (hello: SdkHello) => {
      const link = new FakeLink(hello.protocolVersion);
      return { link, result: await manager.attachSdk(hello, link) };
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

describe('SessionManager routing of SDK hellos', () => {
  it('checks the PID on the device the hello arrived from, for the session app too', async () => {
    const { manager, start, attach, pidofs } = setup();
    await start();
    // The profiled app's package and PID, but from the phone: not its process there.
    expect((await attach(HELLO, PHONE)).result).toEqual({ ok: false, reason: 'no_session' });
    expect(pidofs()).toEqual([['-s', PHONE, 'shell', `pidof ${PKG}`]]);
    expect(manager.getSessionState().sdk?.connected).toBe(false);
    expect((await attach(HELLO, SERIAL)).result).toMatchObject({ ok: true, mode: 'session' });
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    await manager.close();
  });

  it('no oracle: a wrong PID for the profiled app and for another app get the same answer after the same check', async () => {
    const { manager, links, client, list, start, attach, pidofs } = setup();
    await list();
    links.setFocus(client, SERIAL);
    // Nothing maps the session gateway yet: a hello there comes from no known device, refused before any check.
    expect(await manager.attachSdk(HELLO, new FakeLink(5))).toEqual({ ok: false, reason: 'no_session' });
    expect(pidofs()).toEqual([]);
    await start();
    const profiled = await attach({ ...HELLO, pid: 9999 });
    const other = await attach({ ...OTHER_HELLO, pid: 9999 });
    expect(profiled.result).toEqual({ ok: false, reason: 'no_session' });
    expect(other.result).toEqual(profiled.result);
    expect(pidofs()).toEqual([
      ['-s', SERIAL, 'shell', `pidof ${PKG}`],
      ['-s', SERIAL, 'shell', `pidof ${OTHER}`],
    ]);
    expect(manager.getSessionState().sdk?.connected).toBe(false);
    await manager.close();
  });

  it('gives another verified app an inspect-only link only while the Inspector wants the device', async () => {
    const { manager, links, client, list, start, attach } = setup();
    await list();
    await start();
    expect((await attach(OTHER_HELLO)).result).toEqual({ ok: false, reason: 'no_session' });
    links.setFocus(client, SERIAL);
    await list();
    expect((await attach(OTHER_HELLO)).result).toMatchObject({ ok: true, mode: 'inspect' });
    // An SDK below v5 is refused outside the session, and remembered.
    expect((await attach({ ...OTHER_HELLO, protocolVersion: 4 })).result).toEqual({
      ok: false,
      reason: 'no_session',
    });
    expect(links.needsSession(SERIAL, OTHER)).toBe(true);
    await manager.close();
    await links.close();
  });

  it("closes the session app's inspect-only link when the session maps the device, so it rejoins the session", async () => {
    const { manager, links, client, list, start, attach } = setup();
    await list();
    links.setFocus(client, SERIAL);
    await list();
    const before = await attach(HELLO);
    expect(before.result).toMatchObject({ ok: true, mode: 'inspect' });
    const other = await attach(OTHER_HELLO);
    await start();
    expect(before.link.closedWith).toBe('no_session');
    expect(other.link.closedWith).toBeNull();
    expect((await attach(HELLO)).result).toMatchObject({ ok: true, mode: 'session' });
    await manager.close();
    await links.close();
  });
});

describe('SessionManager and inspect-only links: what may link', () => {
  it('refuses a release (non-debuggable) app outside the session, checked with dumpsys package', async () => {
    const { manager, links, client, list, attach, debuggable, adb } = setup();
    await list();
    links.setFocus(client, SERIAL);
    await list();
    debuggable.delete(OTHER);
    expect((await attach(OTHER_HELLO)).result).toEqual({ ok: false, reason: 'no_session' });
    expect(adb.execCalls).toContainEqual(['-s', SERIAL, 'shell', `dumpsys package ${OTHER}`]);
    debuggable.add(OTHER);
    expect((await attach({ ...OTHER_HELLO })).result).toEqual({ ok: false, reason: 'no_session' }); // cached
    expect((await attach(HELLO)).result).toMatchObject({ ok: true, mode: 'inspect' });
    await manager.close();
    await links.close();
  });

  it('leaves the session gateway room for the session app: other apps link through it only up to a cap', async () => {
    const { manager, links, client, list, start, attachViaSession, pids, debuggable } = setup();
    await list();
    links.setFocus(client, SERIAL);
    await list();
    await start();
    const results: boolean[] = [];
    for (const [index, packageName] of [
      'com.example.one',
      'com.example.two',
      'com.example.three',
    ].entries()) {
      // Debuggable apps with their own process on the session device.
      pids.set(`${SERIAL} ${packageName}`, String(3000 + index));
      debuggable.add(packageName);
      const hello = { ...OTHER_HELLO, packageName, processName: packageName, pid: 3000 + index };
      results.push((await attachViaSession(hello)).result.ok);
    }
    expect(results).toEqual([true, true, false]);
    expect((await attachViaSession(HELLO)).result).toMatchObject({ ok: true, mode: 'session' });
    await manager.close();
    await links.close();
  });
});

describe('SessionManager and inspect-only mappings', () => {
  it('re-maps the device to the inspect listener when it is back after its session ended while it was away', async () => {
    const { manager, links, client, list, start, reverses, mappings, setDevices } = setup();
    await list();
    links.setFocus(client, SERIAL);
    await list();
    await start();
    expect(reverses()).toEqual([INSPECT_MAP, SESSION_MAP]);
    setDevices(`List of devices attached\n${PHONE_LINE}`); // the emulator drops off
    for (let index = 0; index < DEVICE_GONE_LISTINGS; index++) await list();
    expect(manager.getSessionState().status).toBe('error');
    mappings.delete(SERIAL); // gone with the USB link
    setDevices(DEVICES);
    await list();
    expect(reverses().at(-1)).toEqual(INSPECT_MAP);
    expect(mappings.get(SERIAL)).toBe(`tcp:${LISTENER_PORT}`);
    await manager.close();
    await links.close();
  });

  it('re-points the mapping to the inspect listener when a session stops with Inspector demand', async () => {
    const { manager, links, client, list, start, reverses, mappings, settle } = setup();
    await list();
    links.setFocus(client, SERIAL);
    await list();
    expect(reverses()).toEqual([INSPECT_MAP]);
    await start();
    expect(reverses()).toEqual([INSPECT_MAP, SESSION_MAP]);
    await manager.stopSession();
    await settle();
    expect(reverses()).toEqual([INSPECT_MAP, SESSION_MAP, INSPECT_MAP]);
    expect(mappings.get(SERIAL)).toBe(`tcp:${LISTENER_PORT}`);
    // The session's tunnel forgot it: closing the manager does not remove the inspect mapping.
    await manager.close();
    expect(reverses()).not.toContainEqual(REMOVE);
    await links.close();
    expect(reverses().at(-1)).toEqual(REMOVE);
  });

  it('removes the session mapping as before when nothing wants the device', async () => {
    const { manager, links, list, start, reverses, settle } = setup();
    await list();
    await start();
    await manager.stopSession();
    await settle();
    expect(reverses()).toEqual([SESSION_MAP, REMOVE]);
    await manager.close();
    await links.close();
  });

  it('a linger from an inspect during the session also keeps the device mapped after it', async () => {
    const { manager, links, list, start, reverses, settle } = setup();
    await list();
    await start();
    links.noteInspect(SERIAL);
    await settle();
    expect(reverses()).toEqual([SESSION_MAP]); // the session's mapping serves meanwhile
    await manager.stopSession();
    await settle();
    expect(reverses()).toEqual([SESSION_MAP, INSPECT_MAP]);
    await manager.close();
    await links.close();
  });
});

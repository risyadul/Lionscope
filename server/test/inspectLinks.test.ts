import type { AddressInfo } from 'node:net';
import { INSPECT_LINK_LINGER_MS, INSPECT_LINK_WAIT_MS } from '@lionscope/protocol';
import type { DeviceInfo, ScreenRef } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceGateway } from '../src/device/deviceGateway.ts';
import {
  INSPECT_REMAP_INTERVAL_MS,
  INSPECT_TEARDOWN_DELAY_MS,
  InspectLinks,
  isDebuggablePackage,
  MAX_INSPECT_LINKS,
  MAX_INSPECT_LINKS_VIA_SESSION,
  OLD_SDK_MEMORY_MS,
} from '../src/device/inspectLinks.ts';
import type { InspectLinkListener } from '../src/device/inspectLinks.ts';
import type { SdkAttachResult, SdkHello, SdkLink, SdkLinkTarget } from '../src/device/sdkLink.ts';
import { log } from '../src/log.ts';
import { DeviceClient } from './helpers/deviceClient.ts';
import { FakeAdb } from './helpers/fakes.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const SERIAL = 'emulator-5554';
const PHONE = 'R58M123ABC';
const SESSION_PORT = 9123;
const FOREIGN_PORT = 8700;
const DEVICES: DeviceInfo[] = [
  { serial: SERIAL, state: 'device' },
  { serial: PHONE, state: 'device' },
];
const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 5,
  sdkVersion: '0.5.2',
  packageName: 'com.example.shop',
  processName: 'com.example.shop',
  pid: 4242,
  apiLevel: 35,
  deviceWallMs: 1_800_000_000_000,
  refreshRateHz: 60,
};
const OTHER_HELLO: SdkHello = {
  ...HELLO,
  packageName: 'com.example.other',
  processName: 'com.example.other',
};
const MAP_SERIAL = ['-s', SERIAL, 'reverse', 'tcp:8700', 'tcp:41001'];
const REMOVE_SERIAL = ['-s', SERIAL, 'reverse', '--remove', 'tcp:8700'];
const HOME: ScreenRef = { name: 'home', className: 'com.example.shop.HomeActivity', kind: 'activity' };

class FakeListener implements InspectLinkListener {
  address: AddressInfo | null = null;
  closed = false;
  constructor(
    readonly target: SdkLinkTarget,
    private readonly port: number,
  ) {}
  async listen(): Promise<AddressInfo> {
    this.address = { address: '127.0.0.1', family: 'IPv4', port: this.port };
    return this.address;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.address = null;
  }
}

/**
 * An InspectLinks on a fake adb whose `reverse` mappings are kept per device, like adb's. Every app is debuggable
 * unless `debuggable` says otherwise.
 */
function setup(
  livePorts: readonly number[] = [FOREIGN_PORT],
  debuggable: (serial: string, packageName: string) => Promise<boolean> = async () => true,
) {
  const mappings = new Map<string, string>();
  const adb = new FakeAdb((args) => {
    const serial = args[1] ?? '';
    if (!args.includes('--list')) return '';
    const target = mappings.get(serial);
    return target === undefined ? '' : `UsbFfs tcp:8700 ${target}\n`;
  });
  adb.reverseHandler = (args) => {
    const serial = args[1] ?? '';
    if (args.includes('--remove')) mappings.delete(serial);
    else mappings.set(serial, args[4] ?? '');
  };
  const listeners: FakeListener[] = [];
  const links: InspectLinks = new InspectLinks({
    adb,
    createListener: (target) => {
      const listener = new FakeListener(target, 41_001 + listeners.length);
      listeners.push(listener);
      return listener;
    },
    route: async (serial, hello, link) => links.attach(serial, hello, link),
    sessionPort: () => SESSION_PORT,
    isHostPortLive: async (port) => livePorts.includes(port),
    isDebuggable: debuggable,
  });
  links.onDevices(DEVICES, false);
  const client = {};
  return {
    adb,
    links,
    listeners,
    mappings,
    client,
    /** Let the queued adb steps run. */
    settle: () => vi.advanceTimersByTimeAsync(0),
    reverses: () => adb.reverseCalls.filter((args) => !args.includes('--remove')),
    removes: () => adb.reverseCalls.filter((args) => args.includes('--remove')),
    lists: () => adb.execCalls.filter((args) => args.includes('--list')).length,
    /** A verified hello from `serial`, as the session manager hands it over. */
    connect: async (
      hello: SdkHello = HELLO,
      serial = SERIAL,
      viaSession = false,
    ): Promise<{ link: FakeLink; result: SdkAttachResult }> => {
      const link = new FakeLink(hello.protocolVersion);
      return { link, result: await links.attach(serial, hello, link, viaSession) };
    },
    /** Demand ended: the teardown runs INSPECT_TEARDOWN_DELAY_MS later. */
    afterTeardown: () => vi.advanceTimersByTimeAsync(INSPECT_TEARDOWN_DELAY_MS),
  };
}

function onScreen(result: SdkAttachResult, screen: ScreenRef | null): void {
  if (!result.ok) throw new Error('not linked');
  result.handler.onMessage({ type: 'screen', ts: 1_800_000_000_000, screen });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InspectLinks mapping', () => {
  it('maps a device with demand to its own listener (reading the mapping back), and nothing without demand', async () => {
    const { links, listeners, reverses, lists, mappings, client, settle } = setup();
    await settle();
    expect(listeners).toHaveLength(0);
    links.setFocus(client, SERIAL);
    await settle();
    expect(listeners).toHaveLength(1);
    expect(reverses()).toEqual([MAP_SERIAL]);
    expect(mappings.get(SERIAL)).toBe('tcp:41001');
    expect(lists()).toBe(2); // before and after mapping
    await links.close();
  });

  it("leaves another live server's mapping alone (busy) and retries only on a demand change or inspect", async () => {
    const info = vi.spyOn(log, 'info');
    const { links, mappings, reverses, lists, client, settle } = setup();
    mappings.set(SERIAL, `tcp:${FOREIGN_PORT}`);
    links.setFocus(client, SERIAL);
    expect(await links.prepare(SERIAL)).toMatchObject({ sources: [], reason: 'sdk_link_busy' });
    expect(reverses()).toEqual([]);
    expect(info.mock.calls.some((call) => String(call[0]).includes('another server holds adb reverse'))).toBe(
      true,
    );

    // Device listings don't retry a busy device…
    const listed = lists();
    await vi.advanceTimersByTimeAsync(INSPECT_REMAP_INTERVAL_MS * 2);
    links.onDevices(DEVICES, true);
    await settle();
    expect(lists()).toBe(listed);
    // …an inspect does, and so does a new demand (another client focusing it).
    links.noteInspect(SERIAL);
    await settle();
    expect(lists()).toBe(listed + 1);
    links.setFocus({}, SERIAL);
    await settle();
    expect(lists()).toBe(listed + 2);
    expect(reverses()).toEqual([]);

    // Once the other server is gone, the next inspect maps.
    mappings.delete(SERIAL);
    links.noteInspect(SERIAL);
    await settle();
    expect(reverses()).toEqual([MAP_SERIAL]);
    await links.close();
  });

  it("takes over a dead server's mapping, a non-TCP one counts as another server's", async () => {
    const dead = setup([]);
    dead.mappings.set(SERIAL, 'tcp:8711');
    dead.links.setFocus(dead.client, SERIAL);
    await dead.settle();
    expect(dead.reverses()).toEqual([MAP_SERIAL]);

    const abstract = setup([]);
    abstract.mappings.set(SERIAL, 'localabstract:other');
    abstract.links.setFocus(abstract.client, SERIAL);
    expect((await abstract.links.prepare(SERIAL)).reason).toBe('sdk_link_busy');
    expect(abstract.reverses()).toEqual([]);
    await dead.links.close();
    await abstract.links.close();
  });

  it('marks the device busy when another server mapped it right after us (read back)', async () => {
    const { adb, links, mappings, client, settle } = setup();
    adb.reverseHandler = () => {
      // Another server's `adb reverse` lands just after ours.
      mappings.set(SERIAL, `tcp:${FOREIGN_PORT}`);
    };
    links.setFocus(client, SERIAL);
    await settle();
    expect((await links.prepare(SERIAL)).reason).toBe('sdk_link_busy');
    await links.close();
  });

  it("treats a mapping to this server's session gateway as its own, and doesn't re-map its own listener", async () => {
    const { links, mappings, reverses, lists, client, settle } = setup([FOREIGN_PORT, SESSION_PORT]);
    mappings.set(SERIAL, `tcp:${SESSION_PORT}`);
    links.setFocus(client, SERIAL);
    await settle();
    expect(reverses()).toHaveLength(1);
    links.onDevices(DEVICES, true); // adb listings recovered: checked, still ours
    await settle();
    expect(lists()).toBe(3);
    expect(reverses()).toHaveLength(1);
    await links.close();
  });

  it('removes the mapping only while it still points at its listener', async () => {
    const own = setup();
    own.links.setFocus(own.client, SERIAL);
    await own.settle();
    own.links.setFocus(own.client, null);
    await own.afterTeardown();
    expect(own.removes()).toEqual([REMOVE_SERIAL]);
    expect(own.listeners[0]?.closed).toBe(true);

    // Another server took the device port over meanwhile: its mapping stays.
    const taken = setup();
    taken.links.setFocus(taken.client, SERIAL);
    await taken.settle();
    taken.mappings.set(SERIAL, `tcp:${FOREIGN_PORT}`);
    taken.links.setFocus(taken.client, null);
    await taken.afterTeardown();
    expect(taken.removes()).toEqual([]);
    expect(taken.mappings.get(SERIAL)).toBe(`tcp:${FOREIGN_PORT}`);
    expect(taken.listeners[0]?.closed).toBe(true);
  });

  it('removes a mapping to the session gateway a handed-over session left behind, not a live session’s', async () => {
    const left = setup();
    left.adb.reverseHandler = () => {
      throw new Error('device offline'); // the re-map after the session failed
    };
    left.links.setFocus(left.client, SERIAL);
    left.mappings.set(SERIAL, `tcp:${SESSION_PORT}`);
    left.links.sessionMapped(SERIAL, HELLO.packageName);
    expect(left.links.sessionEnded(SERIAL)).toBe(true);
    await left.settle();
    left.adb.reverseHandler = (args) => {
      if (args.includes('--remove')) left.mappings.delete(SERIAL);
    };
    left.links.setFocus(left.client, null);
    await left.afterTeardown();
    expect(left.removes()).toEqual([REMOVE_SERIAL]);

    const running = setup();
    running.links.setFocus(running.client, SERIAL);
    running.mappings.set(SERIAL, `tcp:${SESSION_PORT}`);
    running.links.sessionMapped(SERIAL, HELLO.packageName);
    running.links.setFocus(running.client, null);
    await running.afterTeardown();
    expect(running.removes()).toEqual([]);
  });

  it('re-maps after a USB flicker, after adb listings recover and now and then while nothing is linked', async () => {
    const { links, mappings, reverses, client, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    mappings.delete(SERIAL); // lost, e.g. adb restarted
    links.onDevices([DEVICES[1] as DeviceInfo], false);
    links.onDevices(DEVICES, false);
    await settle();
    expect(reverses()).toHaveLength(2);

    mappings.delete(SERIAL);
    links.onDevices(DEVICES, true);
    await settle();
    expect(reverses()).toHaveLength(3);

    mappings.delete(SERIAL);
    links.onDevices(DEVICES, false);
    await settle();
    expect(reverses()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(INSPECT_REMAP_INTERVAL_MS);
    links.onDevices(DEVICES, false);
    await settle();
    expect(reverses()).toHaveLength(4);
    await links.close();
  });

  it('logs a failed adb reverse and leaves the device unmapped until the next inspect', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { adb, links, reverses, client, settle } = setup();
    adb.reverseHandler = () => {
      throw new Error('device offline');
    };
    links.setFocus(client, SERIAL);
    expect(await links.prepare(SERIAL)).toMatchObject({ sources: [], reason: null });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('No inspect-only SDK link on'))).toBe(
      true,
    );
    adb.reverseHandler = () => undefined;
    links.noteInspect(SERIAL);
    await settle();
    expect(reverses()).toHaveLength(2);
    await links.close();
  });

  it('runs each device in its own queue: a hanging device does not hold up another', async () => {
    const { adb, links, reverses, client, settle } = setup();
    const original = adb.execHandler;
    adb.execHandler = (args) => (args[1] === PHONE ? new Promise<string>(() => undefined) : original(args));
    links.setFocus({}, PHONE);
    links.setFocus(client, SERIAL);
    await settle();
    // (The phone's listener came first: the emulator's is the second.)
    expect(reverses()).toEqual([['-s', SERIAL, 'reverse', 'tcp:8700', 'tcp:41002']]);
    void links.close();
  });

  it('keeps at most one check waiting per device, however often it is asked for', async () => {
    const { adb, links, mappings, lists, client, settle } = setup();
    mappings.set(SERIAL, `tcp:${FOREIGN_PORT}`);
    links.setFocus(client, SERIAL);
    await settle();
    let release: () => void = () => undefined;
    const original = adb.execHandler;
    adb.execHandler = (args) =>
      new Promise<string>((resolve) => {
        release = () => resolve(String(original(args)));
      });
    const before = lists();
    for (let index = 0; index < 50; index++) links.noteInspect(SERIAL);
    await settle(); // one check runs (and hangs)…
    for (let index = 0; index < 50; index++) links.noteInspect(SERIAL);
    await settle(); // …and one more waits behind it
    adb.execHandler = original;
    release();
    await settle();
    expect(lists() - before).toBe(2);
    await links.close();
  });
});

describe('InspectLinks demand', () => {
  it('keeps the link while any client focuses the device; a closed client drops its focus', async () => {
    const { links, listeners, removes, settle, afterTeardown } = setup();
    const first = {};
    const second = {};
    links.setFocus(first, SERIAL);
    links.setFocus(second, SERIAL);
    await settle();
    links.setFocus(first, null);
    await afterTeardown();
    expect(removes()).toEqual([]);
    links.setFocus(second, PHONE); // the latest focus per client wins
    await afterTeardown();
    expect(removes()).toEqual([REMOVE_SERIAL]);
    expect(listeners.map((listener) => listener.closed)).toEqual([true, false]);
    links.setFocus(second, null);
    await afterTeardown();
    expect(listeners.every((listener) => listener.closed)).toBe(true);
    await links.close();
  });

  it(`tears down ${INSPECT_TEARDOWN_DELAY_MS / 1000} s after the demand ended: focus churn costs no adb steps`, async () => {
    const { links, listeners, removes, reverses, lists, client, settle, connect } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    const shop = await connect();
    const listed = lists();
    for (let index = 0; index < 50; index++) {
      links.setFocus(client, null);
      links.setFocus(client, SERIAL);
    }
    links.setFocus(client, null);
    await vi.advanceTimersByTimeAsync(INSPECT_TEARDOWN_DELAY_MS - 1);
    expect(shop.link.closedWith).toBeNull(); // still linked: the demand may come back
    expect(lists()).toBe(listed);
    // A link arriving while the teardown is pending is refused.
    expect((await connect(OTHER_HELLO)).result).toEqual({ ok: false, reason: 'no_session' });
    await vi.advanceTimersByTimeAsync(1);
    expect(shop.link.closedWith).toBe('no_session');
    expect([listeners.length, reverses().length, removes().length]).toEqual([1, 1, 1]);
    await links.close();
  });

  it(`lingers ${INSPECT_LINK_LINGER_MS / 60_000} min after the last inspect, each inspect restarting it`, async () => {
    const { links, removes, reverses, settle, afterTeardown } = setup();
    links.noteInspect(SERIAL);
    await settle();
    expect(reverses()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_LINGER_MS - 1000);
    links.noteInspect(SERIAL);
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_LINGER_MS - 1000);
    expect(removes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await afterTeardown();
    expect(removes()).toHaveLength(1);
    expect(reverses()).toHaveLength(1);
    await links.close();
  });

  it('records no demand for a device that is not connected, and maps a focused one once it appears', async () => {
    const { links, reverses, client, settle } = setup();
    links.onDevices([], false);
    links.noteInspect(SERIAL);
    links.setFocus(client, SERIAL);
    await settle();
    expect(reverses()).toEqual([]);
    links.onDevices(DEVICES, false);
    await settle();
    expect(reverses()).toEqual([MAP_SERIAL]);
    await links.close();
  });

  it('closes its links with no_session when the demand ends, and refuses new ones', async () => {
    const { links, client, connect, settle, afterTeardown } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    const { link, result } = await connect();
    expect(result).toMatchObject({ ok: true, mode: 'inspect' });
    links.setFocus(client, null);
    await afterTeardown();
    expect(link.closedWith).toBe('no_session');
    expect((await connect(HELLO, PHONE)).result).toEqual({ ok: false, reason: 'no_session' });
    await links.close();
  });
});

describe('InspectLinks links', () => {
  it('links only debuggable apps, checked once per device, package and process', async () => {
    const checks: string[] = [];
    const { links, client, connect, settle } = setup([FOREIGN_PORT], async (serial, packageName) => {
      checks.push(`${serial} ${packageName}`);
      return packageName === HELLO.packageName;
    });
    links.setFocus(client, SERIAL);
    await settle();
    expect((await connect()).result).toMatchObject({ ok: true, mode: 'inspect' });
    expect((await connect()).result.ok).toBe(true); // reconnected: same process, no new check
    // A release app (not debuggable) gets the same answer as any other refusal.
    expect((await connect(OTHER_HELLO)).result).toEqual({ ok: false, reason: 'no_session' });
    expect((await connect({ ...HELLO, pid: 4343 })).result.ok).toBe(true); // restarted: checked again
    expect(checks).toEqual([
      `${SERIAL} ${HELLO.packageName}`,
      `${SERIAL} ${OTHER_HELLO.packageName}`,
      `${SERIAL} ${HELLO.packageName}`,
    ]);
    await links.close();
  });

  it('refuses when the debuggable check fails, and checks again next time', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let fail = true;
    const { links, client, connect, settle } = setup([FOREIGN_PORT], async () => {
      if (fail) throw new Error('device offline');
      return true;
    });
    links.setFocus(client, SERIAL);
    await settle();
    expect((await connect()).result).toEqual({ ok: false, reason: 'no_session' });
    fail = false;
    expect((await connect()).result.ok).toBe(true);
    await links.close();
  });

  it('reads DEBUGGABLE from the package’s own dumpsys section', () => {
    const dumpsys = (packageName: string, flags: string) =>
      [
        'Packages:',
        `  Package [${packageName}] (1a2b3c):`,
        '    userId=10123',
        `    flags=[ ${flags} ]`,
        `    pkgFlags=[ ${flags} ]`,
        '    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE ]',
        '',
        'Queries:',
      ].join('\n');
    expect(
      isDebuggablePackage(
        dumpsys('com.example.shop', 'DEBUGGABLE HAS_CODE ALLOW_BACKUP'),
        'com.example.shop',
      ),
    ).toBe(true);
    expect(
      isDebuggablePackage(dumpsys('com.example.shop', 'HAS_CODE ALLOW_BACKUP'), 'com.example.shop'),
    ).toBe(false);
    // Another package's section (or a later one) says nothing about this one.
    expect(isDebuggablePackage(dumpsys('com.example.other', 'DEBUGGABLE HAS_CODE'), 'com.example.shop')).toBe(
      false,
    );
    const two = `${dumpsys('com.example.shop', 'HAS_CODE')}\n${dumpsys('com.example.other', 'DEBUGGABLE')}`;
    expect(isDebuggablePackage(two, 'com.example.shop')).toBe(false);
    expect(isDebuggablePackage('', 'com.example.shop')).toBe(false);
  });

  it('is not fooled by a permission name that imitates a flags line', () => {
    const release = [
      'Packages:',
      '  Package [com.example.shop] (1a2b3c):',
      '    userId=10123',
      '    flags=[ HAS_CODE ALLOW_BACKUP ]',
      '    declared permissions:',
      '      flags=[ DEBUGGABLE ]: prot=signature, INSTALLED',
      '    requested permissions:',
      '      flags=[ DEBUGGABLE ]',
      '    pkgFlags=[ DEBUGGABLE ]',
    ].join('\n');
    expect(isDebuggablePackage(release, 'com.example.shop')).toBe(false);
    // No flags line before the permission lists: not debuggable, whatever follows.
    const noFlags = release.replace('    flags=[ HAS_CODE ALLOW_BACKUP ]\n', '');
    expect(isDebuggablePackage(noFlags, 'com.example.shop')).toBe(false);
    // A word that merely contains DEBUGGABLE is not the flag.
    const lookalike = release.replace('HAS_CODE ALLOW_BACKUP', 'HAS_CODE NOT_DEBUGGABLE');
    expect(isDebuggablePackage(lookalike, 'com.example.shop')).toBe(false);
    const debug = release.replace('HAS_CODE ALLOW_BACKUP', 'DEBUGGABLE HAS_CODE');
    expect(isDebuggablePackage(debug, 'com.example.shop')).toBe(true);
  });

  it('refuses an SDK below v5 and remembers it for a while (sdk_needs_session)', async () => {
    const { links, client, connect, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    expect((await connect({ ...HELLO, protocolVersion: 4 })).result).toEqual({
      ok: false,
      reason: 'no_session',
    });
    expect(links.needsSession(SERIAL, HELLO.packageName)).toBe(true);
    expect(links.needsSession(PHONE, HELLO.packageName)).toBe(false);
    expect(links.needsSession(SERIAL, OTHER_HELLO.packageName)).toBe(false);
    await vi.advanceTimersByTimeAsync(OLD_SDK_MEMORY_MS);
    expect(links.needsSession(SERIAL, HELLO.packageName)).toBe(false);
    await links.close();
  });

  it('replaces the link of an app that reconnected, and caps the links of all devices', async () => {
    const { links, client, connect, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    const first = await connect();
    const second = await connect();
    expect(first.link.closedWith).toBe('none');
    expect(second.result.ok).toBe(true);
    for (let index = 1; index < MAX_INSPECT_LINKS; index++) {
      const packageName = `com.example.app${index}`;
      expect((await connect({ ...HELLO, packageName, processName: packageName })).result.ok).toBe(true);
    }
    const over = { ...HELLO, packageName: 'com.example.one.more', processName: 'com.example.one.more' };
    expect((await connect(over)).result).toEqual({ ok: false, reason: 'no_session' });
    expect((await connect()).result.ok).toBe(true); // a reconnect replaces, it is not one more
    await links.close();
  });

  it(`keeps the session gateway's slots for the session app: ${MAX_INSPECT_LINKS_VIA_SESSION} inspect links through it at most`, async () => {
    const { links, client, connect, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    for (let index = 0; index < MAX_INSPECT_LINKS_VIA_SESSION; index++) {
      const packageName = `com.example.app${index}`;
      expect(
        (await connect({ ...HELLO, packageName, processName: packageName }, SERIAL, true)).result.ok,
      ).toBe(true);
    }
    expect((await connect(OTHER_HELLO, SERIAL, true)).result).toEqual({ ok: false, reason: 'no_session' });
    expect((await connect(OTHER_HELLO, SERIAL, false)).result.ok).toBe(true); // through its own listener
    await links.close();
  });

  it('offers the linked apps on top, the one that came to the front last first', async () => {
    const { links, client, connect, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_WAIT_MS);
    const shop = await connect();
    const other = await connect(OTHER_HELLO);
    expect((await links.prepare(SERIAL)).sources).toEqual([]);
    onScreen(shop.result, HOME);
    await vi.advanceTimersByTimeAsync(10);
    onScreen(other.result, { ...HOME, name: 'other' });
    const ready = await links.prepare(SERIAL);
    expect(ready.sources.map((source) => [source.packageName, source.screen])).toEqual([
      ['com.example.other', 'other'],
      ['com.example.shop', 'home'],
    ]);
    onScreen(other.result, null); // to the background
    expect((await links.prepare(SERIAL)).sources.map((source) => source.packageName)).toEqual([
      'com.example.shop',
    ]);
    if (shop.result.ok) shop.result.handler.onClose();
    expect((await links.prepare(SERIAL)).sources).toEqual([]);
    await links.close();
  });
});

describe('InspectLinks wait window', () => {
  it(`waits until ${INSPECT_LINK_WAIT_MS / 1000} s after mapping, then falls back with sdk_linking`, async () => {
    const { links, settle } = setup();
    links.noteInspect(SERIAL);
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    const ready = links.prepare(SERIAL);
    let done = false;
    void ready.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_WAIT_MS - 2000 - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ready).toEqual({ sources: [], reason: 'sdk_linking', waited: true });
    // Later: no more waiting.
    expect(await links.prepare(SERIAL)).toEqual({ sources: [], reason: null, waited: false });
    await links.close();
  });

  it('says it waited when a mapping step was still pending (an earlier screenshot is stale)', async () => {
    const { links } = setup();
    await vi.advanceTimersByTimeAsync(0);
    links.noteInspect(SERIAL); // schedules the mapping
    const ready = links.prepare(SERIAL);
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_WAIT_MS);
    expect((await ready).waited).toBe(true);
    expect((await links.prepare(SERIAL)).waited).toBe(false);
    await links.close();
  });

  it('stops waiting as soon as a linked app is on top', async () => {
    const { links, connect, settle } = setup();
    links.noteInspect(SERIAL);
    await settle();
    const ready = links.prepare(SERIAL);
    await vi.advanceTimersByTimeAsync(1000);
    const shop = await connect();
    onScreen(shop.result, HOME);
    await vi.advanceTimersByTimeAsync(0);
    const result = await ready;
    expect(result).toMatchObject({ reason: null, waited: true });
    expect(result.sources.map((source) => source.packageName)).toEqual(['com.example.shop']);
    expect(Date.now() - 1_800_000_000_000).toBeLessThan(INSPECT_LINK_WAIT_MS);
    await links.close();
  });

  it('stops waiting when an SDK too old to link is refused', async () => {
    const { links, connect, settle } = setup();
    links.noteInspect(SERIAL);
    await settle();
    const ready = links.prepare(SERIAL);
    await vi.advanceTimersByTimeAsync(1000);
    await connect({ ...HELLO, protocolVersion: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await ready).toEqual({ sources: [], reason: 'sdk_linking', waited: true });
    expect(Date.now() - 1_800_000_000_000).toBeLessThan(INSPECT_LINK_WAIT_MS);
    await links.close();
  });
});

describe('InspectLinks and the session', () => {
  it("serves the session's mapping, closing its own app's inspect link so it joins the session", async () => {
    const { links, reverses, client, connect, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    const shop = await connect();
    const other = await connect(OTHER_HELLO);
    links.sessionMapped(SERIAL, HELLO.packageName);
    expect(shop.link.closedWith).toBe('no_session');
    expect(other.link.closedWith).toBeNull();
    links.noteInspect(SERIAL);
    links.onDevices(DEVICES, true);
    await settle();
    expect(reverses()).toHaveLength(1); // the session's mapping is left to the session
    await links.close();
  });

  it('never overwrites a session mapping made while its own mapping step was in flight', async () => {
    const { adb, links, reverses, client, settle } = setup();
    let release: () => void = () => undefined;
    const original = adb.execHandler;
    adb.execHandler = (args) =>
      new Promise<string>((resolve) => {
        release = () => resolve(String(original(args)));
      });
    links.setFocus(client, SERIAL);
    await settle(); // listing in flight
    links.sessionMapped(SERIAL, HELLO.packageName);
    adb.execHandler = original;
    release();
    await settle();
    expect(reverses()).toEqual([]);
    await links.close();
  });

  it('takes the mapping over when the session ends with demand, not without', async () => {
    const { links, mappings, reverses, client, settle } = setup([FOREIGN_PORT, SESSION_PORT]);
    links.setFocus(client, SERIAL);
    await settle();
    mappings.set(SERIAL, `tcp:${SESSION_PORT}`); // the session's Start re-pointed it
    links.sessionMapped(SERIAL, HELLO.packageName);
    expect(links.sessionEnded(SERIAL)).toBe(true);
    await settle();
    expect(reverses().at(-1)).toEqual(MAP_SERIAL);
    expect(mappings.get(SERIAL)).toBe('tcp:41001');

    links.sessionMapped(PHONE, HELLO.packageName);
    expect(links.sessionEnded(PHONE)).toBe(false);
    await links.close();
    expect(links.sessionEnded(SERIAL)).toBe(false);
  });

  it('re-maps a device whose session ended while it was away, once it is back', async () => {
    const { links, mappings, reverses, client, settle } = setup();
    links.setFocus(client, SERIAL);
    await settle();
    links.sessionMapped(SERIAL, HELLO.packageName);
    links.onDevices([DEVICES[1] as DeviceInfo], false); // unplugged…
    expect(links.sessionEnded(SERIAL)).toBe(false); // …and the session stopped meanwhile
    mappings.delete(SERIAL); // a USB drop loses the mappings
    links.onDevices(DEVICES, false);
    await settle();
    expect(reverses()).toEqual([MAP_SERIAL, MAP_SERIAL]);
    expect(mappings.get(SERIAL)).toBe('tcp:41001');
    await links.close();
  });

  it('a session mapping counts for the wait window from when it was made', async () => {
    const late = setup();
    late.links.sessionMapped(SERIAL, HELLO.packageName);
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_WAIT_MS);
    late.links.noteInspect(SERIAL);
    await late.settle();
    expect(await late.links.prepare(SERIAL)).toMatchObject({ reason: null, waited: false });
    await late.links.close();

    // Within the window, an inspect waits for the other apps' SDKs to reconnect into the session's mapping.
    const early = setup();
    early.links.sessionMapped(SERIAL, HELLO.packageName);
    await vi.advanceTimersByTimeAsync(2000);
    early.links.noteInspect(SERIAL);
    await early.settle();
    const ready = early.links.prepare(SERIAL);
    await vi.advanceTimersByTimeAsync(INSPECT_LINK_WAIT_MS - 2000);
    expect(await ready).toEqual({ sources: [], reason: 'sdk_linking', waited: true });
    await early.links.close();
  });
});

describe('InspectLinks listeners', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands each hello over with the serial of the listener it arrived on', async () => {
    vi.useRealTimers();
    const routed: { serial: string; hello: SdkHello; link: SdkLink }[] = [];
    const mappings = new Map<string, string>();
    const adb = new FakeAdb((args) => {
      const target = mappings.get(args[1] ?? '');
      return args.includes('--list') && target ? `UsbFfs tcp:8700 ${target}\n` : '';
    });
    adb.reverseHandler = (args) => {
      mappings.set(args[1] ?? '', args[4] ?? '');
    };
    const links: InspectLinks = new InspectLinks({
      adb,
      createListener: (target) => createDeviceGateway({ port: 0, target }),
      route: async (serial, hello, link) => {
        routed.push({ serial, hello, link });
        return links.attach(serial, hello, link);
      },
      sessionPort: () => null,
      isHostPortLive: async () => false,
      isDebuggable: async () => true,
    });
    links.onDevices(DEVICES, false);
    links.setFocus({}, SERIAL);
    links.setFocus({}, PHONE);
    await links.queues.idle(); // both mapped
    const port = (serial: string) => Number((mappings.get(serial) ?? '').slice('tcp:'.length));
    expect(new Set([port(SERIAL), port(PHONE)]).size).toBe(2);

    const phone = await DeviceClient.open(port(PHONE));
    phone.send(HELLO);
    await phone.waitFor((message) => message.type === 'welcome');
    expect(phone.received).toEqual([{ type: 'welcome', protocolVersion: 5, mode: 'inspect' }]);
    expect(routed.map((entry) => entry.serial)).toEqual([PHONE]);

    const emulator = await DeviceClient.open(port(SERIAL));
    emulator.send({ ...HELLO, protocolVersion: 4 });
    await emulator.closed;
    expect(emulator.received).toEqual([{ type: 'bye', reason: 'no_session' }]);
    expect(routed.map((entry) => entry.serial)).toEqual([PHONE, SERIAL]);
    expect(links.needsSession(SERIAL, HELLO.packageName)).toBe(true);
    await links.close();
    await phone.closed;
  });
});

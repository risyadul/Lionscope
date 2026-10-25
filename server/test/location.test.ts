import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, ServerMessage } from '@lionscope/protocol';
import {
  hostId,
  isLionscopeProcess,
  LOCATION_OFF_WARNING,
  LocationService,
} from '../src/location/locationService.ts';
import {
  formatDegrees,
  MARKER_PATH,
  parseAppOpMode,
  parseMarker,
  parseProbe,
} from '../src/location/mockProviders.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { execShellCommand, FakeAdb } from './helpers/fakes.ts';

const PHONE = 'FAKEPHONE01';
const EMULATOR = 'emulator-5554';
const OUR_PID = 4242;
const HOST = 'a1b2c3d4e5f6';
const marker = (pid: number, mode: string, host = HOST) =>
  `lionscope-location pid=${pid} host=${host} mode=${mode}`;

/** A physical device as far as `cmd location`, `appops` and the marker file go. */
class FakeLocationDevice {
  sdk = 34;
  locationEnabled = true;
  appOp = 'default';
  marker: string | null = null;
  readonly providers = new Set<string>();
  readonly pushes: string[] = [];
  /** Providers whose add-test-provider fails. */
  refuse = new Set<string>();
  /** false: writing the marker file fails (a read-only or full /data/local/tmp). */
  markerWritable = true;
  /** Make the next command matching this fail (adb throws). */
  failOn: RegExp | null = null;
  readonly commands: string[] = [];

  run(command: string): string {
    this.commands.push(command);
    if (this.failOn?.test(command)) throw new Error('adb: device offline');
    const install =
      /^if echo '(.*?)' > (\S+) && appops set \S+ android:mock_location allow; then (.*); else .*; fi$/.exec(
        command,
      );
    if (install) {
      if (!this.markerWritable) return `error: could not write ${MARKER_PATH}`;
      this.marker = install[1] ?? null;
      this.appOp = 'allow';
      return this.steps(install[3] ?? '');
    }
    return this.steps(command);
  }

  private steps(command: string): string {
    const out: string[] = [];
    for (const part of command.split('; ')) out.push(this.step(part));
    return out.filter(Boolean).join('\n');
  }

  private step(part: string): string {
    if (part.startsWith('echo "LS_SDK=')) return `LS_SDK=${this.sdk}`;
    if (part.startsWith('echo "LS_ENABLED=')) return `LS_ENABLED=${this.locationEnabled}`;
    if (part.startsWith('echo "LS_MARKER=')) return `LS_MARKER=${this.marker ?? ''}`;
    if (part.startsWith('appops get')) {
      return this.appOp === 'default'
        ? 'No operations.\nDefault mode: deny'
        : `MOCK_LOCATION: ${this.appOp}; time=+1s ago`;
    }
    if (part.startsWith('appops set')) {
      this.appOp = part.split(' ').at(-1) ?? '';
      return '';
    }
    if (part === `rm -f ${MARKER_PATH}`) {
      this.marker = null;
      return '';
    }
    let match = /add-test-provider (\w+)/.exec(part);
    if (match?.[1]) {
      const provider = match[1];
      if (this.appOp !== 'allow' || this.refuse.has(provider)) {
        return 'java.lang.SecurityException: android from uid 2000 not allowed to perform MOCK_LOCATION';
      }
      this.providers.add(provider);
      return `LS_ADDED=${provider}`;
    }
    match = /remove-test-provider (\w+)/.exec(part);
    if (match?.[1]) {
      this.providers.delete(match[1]);
      return '';
    }
    match = /set-test-provider-location (\w+) --location (\S+)/.exec(part);
    if (match?.[1] && match[2]) {
      this.pushes.push(`${match[1]}@${match[2]}`);
      return '';
    }
    return '';
  }
}

function setup(options: { alive?: (pid: number) => boolean; withGrpc?: boolean } = {}) {
  const device = new FakeLocationDevice();
  const emulator = new FakeEmulatorClient();
  const adb = new FakeAdb((args) => {
    const command = execShellCommand(args);
    if (command !== null && args[1] === PHONE) return device.run(command);
    if (command !== null && args[1] === EMULATOR) return 'LS_SDK=36\nLS_ENABLED=true\nLS_MARKER=';
    return '';
  });
  const messages: ServerMessage[] = [];
  const service = new LocationService({
    adb,
    emulatorClient: () => (options.withGrpc === false ? null : emulator),
    broadcast: (message) => messages.push(message),
    now: () => 1000,
    refreshMs: 1000,
    pid: OUR_PID,
    host: HOST,
    isProcessAlive: options.alive ?? (() => false),
  });
  return { device, emulator, adb, messages, service };
}

const ready = (serial: string): DeviceInfo => ({ serial, state: 'device' });

describe('mock provider commands', () => {
  it('formats degrees without exponents', () => {
    expect(formatDegrees(1e-8)).toBe('0.0000000');
    expect(formatDegrees(-6.2088)).toBe('-6.2088000');
  });

  it('parses the app op mode, the marker and the probe', () => {
    expect(parseAppOpMode('No operations.\nDefault mode: deny')).toBe('default');
    expect(parseAppOpMode('MOCK_LOCATION: allow; time=+64ms ago')).toBe('allow');
    expect(parseMarker(marker(12, 'ignore'))).toEqual({ pid: 12, host: HOST, mode: 'ignore' });
    expect(parseMarker(marker(12, 'rm -rf'))).toBeNull();
    expect(parseMarker(marker(12, 'allow', 'not;hex'))).toBeNull();
    expect(parseMarker('lionscope-location pid=12 mode=ignore')).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseProbe('LS_SDK=30\r\nLS_ENABLED=false\r\nLS_MARKER=\r\nNo operations.')).toEqual({
      sdk: 30,
      locationEnabled: false,
      appOp: 'default',
      marker: null,
    });
  });
});

describe('LocationService on emulators', () => {
  it('moves the GPS fix over gRPC and restores the one from before on clear', async () => {
    const { emulator, messages, service } = setup();
    const location = await service.setLocation(EMULATOR, { latitude: -6.2, longitude: 106.8 });
    expect(location).toEqual({
      serial: EMULATOR,
      latitude: -6.2,
      longitude: 106.8,
      method: 'emulator',
      since: 1000,
      warning: null,
    });
    await service.setLocation(EMULATOR, { latitude: -7.25, longitude: 112.75 });
    expect(messages.at(-1)).toEqual({
      type: 'locations',
      locations: [expect.objectContaining({ latitude: -7.25 })],
    });

    expect(await service.clearLocation(EMULATOR)).toBe(true);
    expect(emulator.gpsSets.at(-1)).toEqual({ latitude: 37.422, longitude: -122.084 });
    expect(messages.at(-1)).toEqual({ type: 'locations', locations: [] });
    expect(await service.clearLocation(EMULATOR)).toBe(false);
  });

  it('uses the emulator console (longitude first) without gRPC', async () => {
    const { adb, service } = setup({ withGrpc: false });
    await service.setLocation(EMULATOR, { latitude: -6.2, longitude: 106.8 });
    expect(adb.execCalls).toContainEqual(['-s', EMULATOR, 'emu', 'geo', 'fix', '106.8000000', '-6.2000000']);
  });
});

describe('LocationService on physical devices', () => {
  afterEach(() => vi.useRealTimers());

  it('adds the test providers, refreshes them every second and restores the device on clear', async () => {
    vi.useFakeTimers();
    const { device, service } = setup();
    const location = await service.setLocation(PHONE, { latitude: -6.2088, longitude: 106.8456 });
    expect(location.method).toBe('mock_provider');
    expect([...device.providers]).toEqual(['gps', 'network', 'fused']);
    expect(device.appOp).toBe('allow');
    expect(parseMarker(device.marker ?? '')).toEqual({ pid: OUR_PID, host: HOST, mode: 'default' });
    expect(device.pushes).toContain('gps@-6.2088000,106.8456000');

    const pushes = device.pushes.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(device.pushes.length).toBe(pushes + 6);

    // A new point reuses the providers.
    await service.setLocation(PHONE, { latitude: 1, longitude: 2 });
    expect(device.commands.filter((command) => command.includes('add-test-provider gps'))).toHaveLength(1);
    expect(device.pushes.at(-1)).toBe('fused@1.0000000,2.0000000');

    expect(await service.clearLocation(PHONE)).toBe(true);
    expect(device.providers.size).toBe(0);
    expect(device.appOp).toBe('default');
    expect(device.marker).toBeNull();
    const after = device.pushes.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(device.pushes.length).toBe(after);
  });

  it('refuses devices below Android 12', async () => {
    const { device, service } = setup();
    device.sdk = 30;
    await expect(service.setLocation(PHONE, { latitude: 0, longitude: 0 })).rejects.toThrow(/Android 12/);
    expect(device.providers.size).toBe(0);
  });

  it('reports the device refusing mock locations and leaves it as it was', async () => {
    const { device, service } = setup();
    device.refuse.add('gps');
    await expect(service.setLocation(PHONE, { latitude: 0, longitude: 0 })).rejects.toThrow(
      /refused mock locations: java.lang.SecurityException/,
    );
    expect(device.providers.size).toBe(0);
    expect(device.appOp).toBe('default');
    expect(device.marker).toBeNull();
    expect(service.getLocations()).toEqual([]);
  });

  it('keeps going without the fused provider, and warns when location is off', async () => {
    const { device, service } = setup();
    device.refuse.add('fused');
    device.locationEnabled = false;
    const location = await service.setLocation(PHONE, { latitude: 0, longitude: 0 });
    expect(location.warning).toBe(LOCATION_OFF_WARNING);
    expect([...device.providers]).toEqual(['gps', 'network']);
    await service.close();
  });

  it('refuses a device another live Lionscope is moving', async () => {
    const { device, service } = setup({ alive: () => true });
    device.marker = marker(99, 'default');
    await expect(service.setLocation(PHONE, { latitude: 0, longitude: 0 })).rejects.toThrow(/pid 99/);
    expect(device.providers.size).toBe(0);
  });

  it('takes over a dead Lionscope’s marker, keeping the app op mode from before it', async () => {
    const { device, service } = setup();
    device.marker = marker(99, 'ignore');
    device.appOp = 'allow';
    await service.setLocation(PHONE, { latitude: 0, longitude: 0 });
    await service.clearLocation(PHONE);
    expect(device.appOp).toBe('ignore');
  });

  it('cleans up a leftover when a device appears, but not one of a live Lionscope', async () => {
    const dead = setup();
    dead.device.marker = marker(99, 'default');
    dead.device.appOp = 'allow';
    dead.device.providers.add('gps');
    dead.service.setDevices([ready(PHONE)]);
    await vi.waitFor(() => expect(dead.device.marker).toBeNull());
    expect(dead.device.providers.size).toBe(0);
    expect(dead.device.appOp).toBe('default');

    const live = setup({ alive: () => true });
    live.device.marker = marker(99, 'default');
    live.service.setDevices([ready(PHONE)]);
    await vi.waitFor(() => expect(live.device.commands.length).toBe(1));
    expect(live.device.marker).not.toBeNull();
  });

  it('forgets a device that went away and restores the others when it closes', async () => {
    const { device, messages, service } = setup();
    service.setDevices([ready(PHONE), ready(EMULATOR)]);
    await service.setLocation(PHONE, { latitude: 0, longitude: 0 });
    await service.setLocation(EMULATOR, { latitude: 0, longitude: 0 });
    service.setDevices([ready(PHONE)]);
    expect(messages.at(-1)).toEqual({
      type: 'locations',
      locations: [expect.objectContaining({ serial: PHONE })],
    });

    await service.close();
    expect(device.providers.size).toBe(0);
    expect(device.marker).toBeNull();
    await expect(service.setLocation(PHONE, { latitude: 0, longitude: 0 })).rejects.toThrow(/shutting down/);
  });
});

describe('LocationService keeps the device restorable', () => {
  afterEach(() => vi.useRealTimers());

  it('undoes the providers when the first push fails halfway, and Reset finds what a failed set left', async () => {
    const { device, messages, service } = setup();
    device.failOn = /set-test-provider-location/;
    await expect(service.setLocation(PHONE, { latitude: 1, longitude: 2 })).rejects.toThrow(/offline/);
    expect(device.providers.size).toBe(0);
    expect(device.appOp).toBe('default');
    expect(device.marker).toBeNull();

    // A set the server lost track of (e.g. the undo failed too): Reset still restores the phone.
    device.failOn = null;
    device.providers.add('gps');
    device.appOp = 'allow';
    device.marker = marker(OUR_PID, 'ignore');
    const before = messages.length;
    expect(await service.clearLocation(PHONE)).toBe(true);
    expect(device.providers.size).toBe(0);
    expect(device.appOp).toBe('ignore');
    expect(messages.length).toBe(before + 1);
    // Nothing to reset: still answered with a broadcast.
    expect(await service.clearLocation(PHONE)).toBe(false);
    expect(messages.length).toBe(before + 2);
  });

  it('does not touch the app op unless the marker was written', async () => {
    const { device, service } = setup();
    device.markerWritable = false;
    await expect(service.setLocation(PHONE, { latitude: 0, longitude: 0 })).rejects.toThrow(
      /could not write/,
    );
    expect(device.appOp).toBe('default');
    expect(device.providers.size).toBe(0);
  });

  it('keeps the location when Reset fails, so it can be tried again, and keeps refreshing meanwhile', async () => {
    vi.useFakeTimers();
    const { device, service } = setup();
    await service.setLocation(PHONE, { latitude: 1, longitude: 2 });
    device.failOn = /remove-test-provider/;
    await expect(service.clearLocation(PHONE)).rejects.toThrow(/offline/);
    expect(service.getLocation(PHONE)).not.toBeNull();
    const pushes = device.pushes.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.pushes.length).toBeGreaterThan(pushes);
    device.failOn = null;
    expect(await service.clearLocation(PHONE)).toBe(true);
    expect(device.providers.size).toBe(0);
  });

  it('restores a phone whose set was still in flight when the server stops', async () => {
    const { device, adb, service } = setup();
    const exec = adb.execHandler;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    adb.execHandler = async (args) => {
      if (String(args[3]).includes('set-test-provider-location')) await gate;
      return exec(args);
    };
    const set = service.setLocation(PHONE, { latitude: 1, longitude: 2 });
    await vi.waitFor(() => expect(device.providers.size).toBe(3));
    const closing = service.close();
    release();
    await set.catch(() => undefined);
    await closing;
    expect(device.providers.size).toBe(0);
    expect(device.marker).toBeNull();
  });

  it('takes a marker from another machine as ownerless, and sends the refresh after a newer point', async () => {
    vi.useFakeTimers();
    const { device, service } = setup({ alive: () => true });
    device.marker = marker(99, 'deny', 'ffffffffffff');
    await service.setLocation(PHONE, { latitude: 1, longitude: 2 });
    await service.setLocation(PHONE, { latitude: 3, longitude: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.pushes.at(-1)).toBe('fused@3.0000000,4.0000000');
    await service.clearLocation(PHONE);
    expect(device.appOp).toBe('deny');
  });

  it('does not send an emulator back to 0, 0 when it reported no fix', async () => {
    const { emulator, service } = setup();
    emulator.gps = { latitude: 0, longitude: 0 };
    await service.setLocation(EMULATOR, { latitude: 1, longitude: 2 });
    await service.clearLocation(EMULATOR);
    expect(emulator.gpsSets).toEqual([{ latitude: 1, longitude: 2 }]);
  });
});

describe('marker owners', () => {
  it.skipIf(process.platform === 'win32')(
    'counts only live processes that look like a Lionscope server',
    async () => {
      const lionscope = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'lionscope']);
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'something-else']);
      try {
        await vi.waitFor(() => expect(isLionscopeProcess(lionscope.pid ?? 0)).toBe(true));
        expect(isLionscopeProcess(other.pid ?? 0)).toBe(false);
      } finally {
        lionscope.kill();
        other.kill();
      }
      await vi.waitFor(() => expect(isLionscopeProcess(lionscope.pid ?? 0)).toBe(false));
    },
  );

  it('names the host with 12 hex characters', () => {
    expect(hostId('mac.local')).toMatch(/^[0-9a-f]{12}$/);
    expect(hostId('mac.local')).toBe(hostId('mac.local'));
    expect(hostId('other')).not.toBe(hostId('mac.local'));
  });
});

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { DeviceClient } from './helpers/deviceClient.ts';
import { FakeAdb } from './helpers/fakes.ts';
import { noEmulatorHost } from './helpers/emulators.ts';

const HELLO = {
  type: 'hello',
  protocolVersion: 1,
  sdkVersion: '0.1.0',
  packageName: 'com.example.app',
  processName: 'com.example.app',
  pid: 42,
  apiLevel: 35,
  deviceWallMs: 1792516375000,
  refreshRateHz: 60,
};

describe('Lionscope server SDK gateway', () => {
  let server: LionscopeServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  it('listens for the SDK on loopback next to HTTP, and closes it with the server', async () => {
    server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb: new FakeAdb(() => ''),
      emulatorHost: noEmulatorHost(),
    });
    const http = await server.listen();
    const device = server.deviceAddress;
    expect(device?.address).toBe('127.0.0.1');
    expect(device?.port).not.toBe(http.port);

    // No session yet: the SDK is told to come back later.
    const client = await DeviceClient.open(device?.port ?? 0);
    client.send(HELLO);
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'no_session' }]);

    await server.close();
    expect(server.deviceAddress).toBeNull();
    await expect(DeviceClient.open(device?.port ?? 0)).rejects.toThrow();
    server = null;
  });

  it('falls back to a free SDK port when the configured one is taken (adb reverse maps any port)', async () => {
    const warn = vi.spyOn(log, 'warn');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;
    server = createLionscopeServer({
      port: 0,
      devicePort: taken,
      adb: new FakeAdb(() => ''),
      emulatorHost: noEmulatorHost(),
    });
    expect((await server.listen()).port).toBeGreaterThan(0);
    expect(server.deviceAddress?.port).toBeGreaterThan(0);
    expect(server.deviceAddress?.port).not.toBe(taken);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('SDK gateway cannot listen'))).toBe(true);
    await new Promise((resolve) => blocker.close(resolve));
  });

  it('keeps serving the dashboard when the SDK gateway cannot listen at all', async () => {
    const warn = vi.spyOn(log, 'warn');
    server = createLionscopeServer({
      port: 0,
      devicePort: 70_000,
      adb: new FakeAdb(() => ''),
      emulatorHost: noEmulatorHost(),
    });
    expect((await server.listen()).port).toBeGreaterThan(0);
    expect(server.deviceAddress).toBeNull();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('SDK gateway cannot listen'))).toBe(true);
  });
});

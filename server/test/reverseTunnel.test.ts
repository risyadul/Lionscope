import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  DeviceReverseQueues,
  mappedHostPort,
  probeLoopbackPort,
  ReverseTunnel,
} from '../src/device/reverseTunnel.ts';
import { FakeAdb } from './helpers/fakes.ts';

describe('mappedHostPort', () => {
  it('reads the host side of the device port mapping', () => {
    const listing = 'UsbFfs tcp:9000 tcp:9001\nhost-12 tcp:8700 tcp:8711\n';
    expect(mappedHostPort(listing, 8700)).toBe(8711);
    expect(mappedHostPort(listing, 9000)).toBe(9001);
  });

  it('is undefined when the device port is not mapped, null for a non-TCP target', () => {
    expect(mappedHostPort('', 8700)).toBeUndefined();
    expect(mappedHostPort('UsbFfs tcp:9000 tcp:9000\n', 8700)).toBeUndefined();
    expect(mappedHostPort('UsbFfs tcp:8700 localabstract:lionscope\n', 8700)).toBeNull();
  });
});

describe('probeLoopbackPort', () => {
  it('is true while something listens on 127.0.0.1 and false once it stopped', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await probeLoopbackPort(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeLoopbackPort(port)).toBe(false);
  });
});

describe('ReverseTunnel on shared device queues', () => {
  it('lands its steps in call order among the other steps on the device', async () => {
    const adb = new FakeAdb(() => '');
    const devices = new DeviceReverseQueues();
    const tunnel = new ReverseTunnel({
      adb,
      devicePort: 8700,
      hostPort: () => 9123,
      onOpenFailed: () => undefined,
      devices,
    });
    const steps: string[] = [];
    let release: () => void = () => undefined;
    // An inspect-only step on the device is still running when the session maps it…
    const slow = devices.run('emulator-5554', () => new Promise<void>((resolve) => (release = resolve)));
    const opened = tunnel.open('emulator-5554');
    // …the user presses Stop (nothing wants the device)…
    const closed = tunnel.close();
    expect(tunnel.serial).toBeNull();
    // …then opens the Inspector: its mapping must land after the session's removal, not before it.
    const inspect = devices.run('emulator-5554', async () => {
      steps.push('inspect map');
    });
    adb.reverseHandler = (args) => {
      steps.push(args.includes('--remove') ? 'session remove' : 'session map');
    };
    await new Promise((resolve) => setTimeout(resolve, 0)); // the slow step started
    release();
    await Promise.all([slow, opened, closed, inspect]);
    expect(steps).toEqual(['session map', 'session remove', 'inspect map']);
  });

  it('removes the previous device and maps the next without one waiting on the other', async () => {
    const adb = new FakeAdb(() => '');
    const devices = new DeviceReverseQueues();
    const tunnel = new ReverseTunnel({
      adb,
      devicePort: 8700,
      hostPort: () => 9123,
      onOpenFailed: () => undefined,
      devices,
    });
    await tunnel.open('emulator-5554');
    // The old device hangs (unplugged): the new one is mapped all the same.
    void devices.run('emulator-5554', () => new Promise<void>(() => undefined));
    void tunnel.open('R58M123ABC');
    await devices.run('R58M123ABC', async () => undefined);
    expect(adb.reverseCalls).toEqual([
      ['-s', 'emulator-5554', 'reverse', 'tcp:8700', 'tcp:9123'],
      ['-s', 'R58M123ABC', 'reverse', 'tcp:8700', 'tcp:9123'],
    ]);
    expect(tunnel.serial).toBe('R58M123ABC');
  });
});

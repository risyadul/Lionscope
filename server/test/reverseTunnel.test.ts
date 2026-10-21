import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { mappedHostPort, probeLoopbackPort } from '../src/device/reverseTunnel.ts';

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

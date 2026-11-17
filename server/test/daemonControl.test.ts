import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAEMON_HEADER, DAEMON_PATH } from '../src/http/daemonControl.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { FakeAdb } from './helpers/fakes.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { rawRequest } from './helpers/net.ts';

describe('private daemon control', () => {
  const token = 'a'.repeat(64);
  const stop = vi.fn();
  let server: LionscopeServer;
  let port: number;
  const headers = { 'Content-Type': 'application/json', [DAEMON_HEADER]: token };

  beforeAll(async () => {
    server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb: new FakeAdb(() => ''),
      emulatorHost: noEmulatorHost(),
      daemon: { token, stop },
    });
    port = (await server.listen()).port;
  });
  afterAll(async () => {
    await server.close();
  });

  it('authenticates an owning CLI without exposing its key', async () => {
    const response = await rawRequest(port, `${DAEMON_PATH}status`, 'POST', headers);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ pid: process.pid, port });
    expect(response.body).not.toContain(token);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', headers],
    ['POST', { 'Content-Type': 'application/json' }],
    ['POST', { ...headers, [DAEMON_HEADER]: 'b'.repeat(64) }],
    ['POST', { ...headers, [DAEMON_HEADER]: 'é'.repeat(64) }],
    ['POST', { ...headers, Origin: 'http://localhost' }],
    ['POST', { ...headers, Origin: 'https://untrusted.example' }],
    ['POST', { ...headers, Host: 'localhost:12345' }],
    ['POST', { ...headers, Host: 'untrusted.example' }],
    ['POST', { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }],
  ])('refuses browser-shaped or unauthenticated control: %s %j', async (method, requestHeaders) => {
    expect((await rawRequest(port, `${DAEMON_PATH}stop`, method, requestHeaders)).status).toBe(403);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not accept arbitrary lifecycle commands', async () => {
    expect((await rawRequest(port, `${DAEMON_PATH}restart`, 'POST', headers)).status).toBe(404);
    expect(stop).not.toHaveBeenCalled();
  });

  it('acknowledges a verified stop before requesting graceful shutdown', async () => {
    expect((await rawRequest(port, `${DAEMON_PATH}stop`, 'POST', headers)).status).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
  });
});

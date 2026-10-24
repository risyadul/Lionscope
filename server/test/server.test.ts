import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SDK_OPTIONS, MAX_CLIENT_FRAME_BYTES, PROTOCOL_VERSION, WS_PATH } from '@lionscope/protocol';
import type { SessionState } from '@lionscope/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BUFFER_WINDOW_MS } from '../src/config.ts';
import { CONTENT_SECURITY_POLICY } from '../src/http/securityHeaders.ts';
import {
  createStaticHandler,
  missingDashboardMessage,
  resolveDashboardDir,
  resolveSafePath,
} from '../src/http/staticFiles.ts';
import {
  buildAllowedOrigins,
  CLIENT_CAP_RETRY_AFTER_S,
  isAllowedHost,
  isAllowedOrigin,
  MAX_CLIENTS,
  NO_SESSION_MESSAGE,
} from '../src/http/wsGateway.ts';
import { NO_EMULATOR_MESSAGE } from '../src/emulator/emulatorManager.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';
import { noEmulatorHost } from './helpers/emulators.ts';
import { Client, handshakeResponse, handshakeStatus, rawRequest } from './helpers/net.ts';

const PKG = 'com.google.android.apps.nexuslauncher';

describe('Lionscope server', () => {
  let tmp: string;
  let dist: string;
  let server: LionscopeServer;
  let port: number;
  let failPm = false;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'lionscope-'));
    dist = path.join(tmp, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Lionscope</title>');
    writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.info("hi")');
    writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
    mkdirSync(path.join(tmp, 'outside'));
    writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'TOP SECRET');
    symlinkSync(path.join(tmp, 'outside', 'secret.txt'), path.join(dist, 'leak.txt'));
    symlinkSync(path.join(tmp, 'outside'), path.join(dist, 'assets', 'linked'));

    const device = new FakeDevice();
    const adb = new FakeAdb(
      (args) => {
        if (args[0] === 'devices') return fixture('adb-devices.txt');
        if (args.at(-1) === 'pm list packages') {
          if (failPm) throw new Error('adb -s emulator-5554 shell pm list packages failed: /secret/path/adb');
          return 'package:com.example.app\npackage:' + PKG;
        }
        if (args.at(-1) === 'ps -A -o PID,NAME') return `  1105 ${PKG}\n`;
        return '';
      },
      (command) => device.handle(command),
    );
    server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb,
      emulatorHost: noEmulatorHost(),
      dashboardDir: dist,
      sessionIntervals: { cpuMs: 50, framesMs: 50, memoryMs: 50, logFlushMs: 20 },
    });
    port = (await server.listen()).port;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('listens on loopback only', () => {
    expect(server.address?.address).toBe('127.0.0.1');
  });

  describe('HTTP', () => {
    it('serves index.html with security headers', async () => {
      const res = await rawRequest(port, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<title>Lionscope</title>');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self';");
      expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
      expect(CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('rejects requests whose Host is not loopback (DNS rebinding)', async () => {
      for (const host of ['evil.example', `evil.example:${port}`, 'localhost.evil.example']) {
        const res = await rawRequest(port, '/', 'GET', { Host: host });
        expect(res.status).toBe(403);
        expect(res.body).not.toContain('Lionscope');
        expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      }
      expect((await rawRequest(port, '/', 'GET', { Host: `localhost:${port}` })).status).toBe(200);
      expect((await rawRequest(port, '/', 'GET', { Host: `[::1]:${port}` })).status).toBe(200);
    });

    it('serves assets with the right MIME type and caching', async () => {
      const js = await rawRequest(port, '/assets/app.js');
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(js.headers['cache-control']).toContain('immutable');
      const svg = await rawRequest(port, '/favicon.svg');
      expect(svg.headers['content-type']).toBe('image/svg+xml');
    });

    it('falls back to index.html for SPA routes but 404s for missing files', async () => {
      const spa = await rawRequest(port, '/session/live');
      expect(spa.status).toBe(200);
      expect(spa.body).toContain('Lionscope');
      expect((await rawRequest(port, '/assets/missing.js')).status).toBe(404);
    });

    it.each([
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/assets/..%2f..%2fpackage.json',
      '/%00',
    ])('does not serve traversal attempt %s', async (attempt) => {
      const res = await rawRequest(port, attempt);
      expect(res.body).not.toContain('"name"');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) expect(res.body).toContain('<title>Lionscope</title>');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('does not follow symlinks out of the dashboard directory', async () => {
      for (const target of ['/leak.txt', '/assets/linked/secret.txt']) {
        const res = await rawRequest(port, target);
        expect(res.status).toBe(404);
        expect(res.body).not.toContain('TOP SECRET');
      }
    });

    it('answers HEAD without a body and rejects other methods with 405', async () => {
      const head = await rawRequest(port, '/', 'HEAD');
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const res = await rawRequest(port, '/', method);
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('GET, HEAD');
        expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      }
    });

    it('serves Inspector screenshots under the dashboard Host rules, 404 when there is none', async () => {
      const path = '/inspector/0123456789abcdef.png';
      expect((await rawRequest(port, path)).status).toBe(404);
      expect((await rawRequest(port, path, 'GET', { Host: 'evil.example' })).status).toBe(403);
      expect((await rawRequest(port, path, 'GET', { Origin: 'http://evil.example' })).status).toBe(403);
      expect((await rawRequest(port, path, 'POST')).status).toBe(405);
      // Not the SPA fallback.
      expect((await rawRequest(port, '/inspector/x')).body).not.toContain('Lionscope');
    });

    it('asks plain HTTP requests to the WebSocket path to upgrade', async () => {
      expect((await rawRequest(port, WS_PATH)).status).toBe(426);
    });

    it('returns 503 with a build hint (and no filesystem path) when the dashboard is not built', async () => {
      const bare = createLionscopeServer({
        port: 0,
        devicePort: 0,
        adb: new FakeAdb(() => ''),
        emulatorHost: noEmulatorHost(),
        dashboardDir: path.join(dist, 'does-not-exist'),
      });
      const { port: barePort } = await bare.listen();
      const res = await rawRequest(barePort, '/');
      expect(res.status).toBe(503);
      expect(res.body).toBe(
        'The Lionscope dashboard is not built.\nRun `npm run build` (or start with `npm run lionscope`) and reload.\n',
      );
      expect(res.body).not.toContain(tmp);
      expect(res.body).not.toContain('/');
      await bare.close();
    });
  });

  describe('WebSocket security', () => {
    const good = () => ({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` });

    it('accepts exactly the dashboard origins on the bound port', async () => {
      expect(await handshakeStatus(port, good())).toBe(101);
      expect(
        await handshakeStatus(port, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }),
      ).toBe(101);
      expect(await handshakeStatus(port, { Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` })).toBe(
        101,
      );
    });

    it('rejects loopback origins on other ports or schemes when not in dev mode', async () => {
      for (const origin of [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        `http://localhost:${port + 1}`,
        `https://localhost:${port}`,
        'http://localhost',
      ]) {
        expect(await handshakeStatus(port, { ...good(), Origin: origin })).toBe(403);
      }
    });

    it('rejects a cross-site Origin', async () => {
      expect(await handshakeStatus(port, { ...good(), Origin: 'https://evil.example' })).toBe(403);
      expect(
        await handshakeStatus(port, { ...good(), Origin: `http://localhost.evil.example:${port}` }),
      ).toBe(403);
      expect(await handshakeStatus(port, { ...good(), Origin: 'null' })).toBe(403);
    });

    it('rejects a missing Origin', async () => {
      expect(await handshakeStatus(port, { Host: `localhost:${port}` })).toBe(403);
    });

    it('rejects a non-loopback Host (DNS rebinding)', async () => {
      expect(await handshakeStatus(port, { ...good(), Host: `evil.example:${port}` })).toBe(403);
      expect(await handshakeStatus(port, { ...good(), Host: '' })).toBe(403);
    });

    it('rejects upgrades on other paths', async () => {
      expect(await handshakeStatus(port, good(), '/other')).toBe(404);
    });

    it('accepts the Vite dev server origins in dev mode only', async () => {
      const dev = createLionscopeServer({
        port: 0,
        devicePort: 0,
        adb: new FakeAdb(() => ''),
        emulatorHost: noEmulatorHost(),
        dashboardDir: dist,
        dev: true,
      });
      const { port: devPort } = await dev.listen();
      const host = `localhost:${devPort}`;
      expect(await handshakeStatus(devPort, { Host: host, Origin: 'http://localhost:5173' })).toBe(101);
      expect(await handshakeStatus(devPort, { Host: host, Origin: 'http://127.0.0.1:5173' })).toBe(101);
      expect(await handshakeStatus(devPort, { Host: host, Origin: `http://localhost:${devPort}` })).toBe(101);
      expect(await handshakeStatus(devPort, { Host: host, Origin: 'http://localhost:5174' })).toBe(403);
      await dev.close();
    });

    it('builds and checks the allowlist by serialized origin', () => {
      const allowed = buildAllowedOrigins(8701, false);
      expect([...allowed]).toEqual(['http://localhost:8701', 'http://127.0.0.1:8701', 'http://[::1]:8701']);
      expect(isAllowedOrigin('http://LOCALHOST:8701', allowed)).toBe(true);
      expect(isAllowedOrigin('http://localhost:8701/path', allowed)).toBe(true);
      expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(false);
      expect(isAllowedOrigin('http://localhost:5173', buildAllowedOrigins(8701, true))).toBe(true);
      expect(isAllowedOrigin('not a url', allowed)).toBe(false);
      expect(isAllowedOrigin(undefined, allowed)).toBe(false);
      expect(isAllowedHost('localhost')).toBe(true);
      expect(isAllowedHost('127.0.0.1:1')).toBe(true);
      expect(isAllowedHost(undefined)).toBe(false);
      expect(isAllowedHost('a b')).toBe(false);
    });
  });

  describe('WebSocket protocol', () => {
    it('greets with hello, devices, emulators, session, snapshot in that order', async () => {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      expect(client.messages.slice(0, 5).map((message) => message.type)).toEqual([
        'hello',
        'devices',
        'emulators',
        'session',
        'snapshot',
      ]);
      expect(client.messages[0]).toEqual({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
        bufferWindowMs: BUFFER_WINDOW_MS,
      });
      client.close();
    });

    it('answers invalid messages with bad_request and keeps the connection open', async () => {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      client.send('{not json');
      client.send({ type: 'startSession', serial: 'emulator-5554', packageName: 'x; reboot' });
      client.send({ type: 'launchMissiles' });
      client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
      await client.waitFor('error', () => client.messages.filter((m) => m.type === 'error').length >= 4);
      const errors = client.messages.filter((message) => message.type === 'error');
      expect(errors.map((error) => error.code)).toEqual([
        'bad_request',
        'bad_request',
        'bad_request',
        'bad_request',
      ]);
      expect(errors[0]?.message).toBe('invalid JSON');
      expect(errors[1]?.message).toContain('invalid package name');

      const devices = client.next('devices');
      const emulators = client.next('emulators');
      client.send({ type: 'refreshDevices' });
      expect((await devices).devices[0]?.serial).toBe('emulator-5554');
      expect((await emulators).emulators).toEqual([]);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      client.close();
    });

    it('answers emulator requests it cannot carry out with an error', async () => {
      const client = await Client.open(port);
      client.send({ type: 'bootEmulator', avdName: 'Pixel_9a', mode: 'quick' });
      expect(await client.waitFor('error')).toEqual({
        type: 'error',
        code: 'bootEmulator_failed',
        message: NO_EMULATOR_MESSAGE,
      });
      client.send({ type: 'shutdownEmulator', avdName: 'Pixel_9a' });
      expect(await client.waitFor('error', (error) => error.code === 'shutdownEmulator_failed')).toEqual({
        type: 'error',
        code: 'shutdownEmulator_failed',
        message: 'Pixel_9a was not started by Lionscope: close it where it was started (e.g. Android Studio)',
      });
      client.close();
    });

    it('closes connections that exceed the max payload; refuses large frames of any type but setNetworkMock', async () => {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      client.send({ type: 'refreshDevices', padding: 'x'.repeat(10_000) });
      expect(await client.waitFor('error')).toMatchObject({
        code: 'bad_request',
        message: 'message too large',
      });
      const closed = client.closed();
      client.send('x'.repeat(MAX_CLIENT_FRAME_BYTES + 1));
      expect(await closed).toBe(1009);
    });

    it('closes clients that exceed the message rate limit with 1008', async () => {
      const client = await Client.open(port);
      await client.waitFor('snapshot');
      const closed = client.closed();
      for (let i = 0; i < 40; i += 1) client.send({ type: 'refreshDevices' });
      expect(await closed).toBe(1008);
    });

    it('lists apps for the requesting client', async () => {
      const client = await Client.open(port);
      client.send({ type: 'listApps', serial: 'emulator-5554' });
      const apps = await client.waitFor('apps');
      expect(apps.serial).toBe('emulator-5554');
      expect(apps.apps[0]).toEqual({ packageName: PKG, pid: 1105, thirdParty: false });
      client.close();
    });

    it('reports public failure reasons, and a fixed message for internal errors', async () => {
      const client = await Client.open(port);
      client.send({ type: 'startSession', serial: 'emulator-9999', packageName: PKG });
      expect(await client.waitFor('error')).toEqual({
        type: 'error',
        code: 'startSession_failed',
        message: 'Device emulator-9999 is not connected',
      });
      failPm = true;
      client.send({ type: 'listApps', serial: 'emulator-5554' });
      const internal = await client.waitFor('error', (error) => error.code === 'listApps_failed');
      failPm = false;
      expect(internal.message).toBe('Could not list apps on the device');
      expect(JSON.stringify(client.messages)).not.toContain('/secret');
      client.close();
    });

    it('runs a session end-to-end and broadcasts live data to every client', async () => {
      const a = await Client.open(port);
      const b = await Client.open(port);
      await Promise.all([a.waitFor('snapshot'), b.waitFor('snapshot')]);
      a.send({ type: 'setSdkOptions', strictMode: true });
      expect(await a.waitFor('error')).toEqual({
        type: 'error',
        code: 'no_session',
        message: NO_SESSION_MESSAGE,
      });
      a.send({ type: 'startSession', serial: 'emulator-5554', packageName: PKG });
      const running = await b.waitFor('session', (m) => m.session.status === 'running');
      expect(running.session.sdk?.options).toEqual(DEFAULT_SDK_OPTIONS);
      // Any client may change the options; every client gets the updated session.
      a.send({ type: 'setSdkOptions', stallThresholdMs: 500, strictMode: true });
      const updated = (m: { session: SessionState }) => m.session.sdk?.options?.strictMode === true;
      const [mine, theirs] = await Promise.all([a.next('session', updated), b.waitFor('session', updated)]);
      expect(mine.session.sdk?.options).toEqual({
        stallThresholdMs: 500,
        strictMode: true,
        inflateTracking: true,
        rxTracking: true,
      });
      expect(theirs.session).toEqual(mine.session);
      expect(running.session).toMatchObject({ serial: 'emulator-5554', packageName: PKG, pid: 1105 });
      const [cpu, memory, frames] = await Promise.all([
        b.waitFor('cpu'),
        b.waitFor('memory'),
        b.waitFor('frames'),
      ]);
      expect(cpu.sample.percent).toBeGreaterThan(0);
      expect(memory.sample.totalPssKb).toBe(102638);
      expect(frames.sample.frameCount).toBeGreaterThan(0);

      // A late joiner gets the buffered data in its snapshot.
      const late = await Client.open(port);
      const snapshot = await late.waitFor('snapshot');
      expect(snapshot.snapshot.cpu.length).toBeGreaterThan(0);
      expect((await late.waitFor('session')).session.status).toBe('running');

      // stopSession is answered to the requester even though it is also broadcast.
      const reply = a.next('session', (m) => m.session.status === 'idle');
      a.send({ type: 'stopSession' });
      expect((await reply).session).toMatchObject({ packageName: PKG, pid: null });
      const again = a.next('session');
      a.send({ type: 'stopSession' });
      expect((await again).session.status).toBe('idle');
      const refused = a.next('error');
      a.send({ type: 'setSdkOptions', strictMode: false });
      expect((await refused).code).toBe('no_session');
      for (const client of [a, b, late]) client.close();
    });

    it(`accepts at most ${MAX_CLIENTS} clients, refusing more before the upgrade with 503 + Retry-After`, async () => {
      const clients = await Promise.all(Array.from({ length: MAX_CLIENTS }, () => Client.open(port)));
      const refused = await handshakeResponse(port, {
        Host: `localhost:${port}`,
        Origin: `http://localhost:${port}`,
      });
      expect(refused.status).toBe(503);
      expect(refused.head).toMatch(new RegExp(`\\r\\nRetry-After: ${CLIENT_CAP_RETRY_AFTER_S}\\r\\n`));
      expect(refused.head).not.toMatch(/Upgrade: websocket/i);

      // A real browser-like client never sees `open`: it gets an unexpected-response instead.
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: `http://localhost:${port}` });
      let opened = false;
      ws.on('open', () => (opened = true));
      // terminate() while still CONNECTING emits "closed before the connection was established".
      ws.on('error', () => undefined);
      const response = await new Promise<{ status: number; retryAfter: string | undefined }>((resolve) => {
        ws.on('unexpected-response', (_req, res) => {
          resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] });
          res.resume();
          ws.terminate();
        });
      });
      expect(response).toEqual({ status: 503, retryAfter: String(CLIENT_CAP_RETRY_AFTER_S) });
      expect(opened).toBe(false);
      const first = clients[0];
      const closed = first?.closed();
      first?.close();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const replacement = await Client.open(port);
      for (const client of [...clients.slice(1), replacement]) client.close();
      await Promise.all([...clients.slice(1), replacement].map((client) => client.closed()));
    });
  });
});

describe('resolveSafePath', () => {
  const root = path.resolve('/srv/dist');

  it('keeps paths inside the root', () => {
    expect(resolveSafePath(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'));
    expect(resolveSafePath(root, '/')).toBe(root);
  });

  it('clamps decoded escapes inside the root and rejects NUL bytes or malformed encodings', () => {
    expect(resolveSafePath(root, '/..%2f..%2fetc%2fpasswd')).toBe(path.join(root, 'etc', 'passwd'));
    expect(resolveSafePath(root, '/%00')).toBeNull();
    expect(resolveSafePath(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('resolveDashboardDir', () => {
  const bases: string[] = [];
  /** A fresh `<base>/pkg/dist/lionscope.mjs` layout (the npm package), optionally with a built dashboard. */
  function layout(withIndex: boolean): { base: string; bundleUrl: string } {
    const base = mkdtempSync(path.join(tmpdir(), 'lionscope-dashboard-dir-'));
    bases.push(base);
    mkdirSync(path.join(base, 'pkg', 'dist'), { recursive: true });
    if (withIndex) {
      mkdirSync(path.join(base, 'pkg', 'dashboard'));
      writeFileSync(path.join(base, 'pkg', 'dashboard', 'index.html'), '<!doctype html>');
    }
    return { base, bundleUrl: pathToFileURL(path.join(base, 'pkg', 'dist', 'lionscope.mjs')).href };
  }
  afterAll(() => {
    for (const base of bases) rmSync(base, { recursive: true, force: true });
  });

  it('prefers an explicit directory (LIONSCOPE_DASHBOARD_DIR), resolved to an absolute path', () => {
    const { bundleUrl } = layout(true);
    expect(resolveDashboardDir('custom', bundleUrl, false)).toBe(path.resolve('custom'));
    expect(resolveDashboardDir('custom', bundleUrl, true)).toBe(path.resolve('custom'));
  });

  it('uses ../dashboard next to the running module when it holds an index.html', () => {
    const { base, bundleUrl } = layout(true);
    expect(resolveDashboardDir(undefined, bundleUrl, false)).toBe(path.join(base, 'pkg', 'dashboard'));
    expect(resolveDashboardDir('', bundleUrl, false)).toBe(path.join(base, 'pkg', 'dashboard'));
  });

  it("falls back to the repo's dashboard/dist without a packaged index.html (development)", () => {
    const { base } = layout(false);
    const source = pathToFileURL(path.join(base, 'repo', 'server', 'src', 'http', 'staticFiles.ts')).href;
    expect(resolveDashboardDir(undefined, source, false)).toBe(path.join(base, 'repo', 'dashboard', 'dist'));
    // The default module URL is this source file: server/src/http → <repo>/dashboard/dist.
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    expect(resolveDashboardDir()).toBe(path.join(repoRoot, 'dashboard', 'dist'));
  });

  it('never leaves the package in the bundled build, even without a packaged index.html', () => {
    const { base, bundleUrl } = layout(false);
    expect(resolveDashboardDir(undefined, bundleUrl, true)).toBe(path.join(base, 'pkg', 'dashboard'));
  });

  it('tells a bundled install to reinstall when its dashboard files are missing', async () => {
    const { base } = layout(false);
    const handler = createStaticHandler(path.join(base, 'pkg', 'dashboard'), true);
    const server = createServer((req, res) => void handler(req, res, '/'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await rawRequest((server.address() as AddressInfo).port, '/');
    server.close();
    expect(res.status).toBe(503);
    expect(res.body).toBe(missingDashboardMessage(true));
    expect(res.body).toContain('Reinstall lionscope (or run `npm run build` in a clone)');
    expect(res.body).not.toContain('/');
  });
});

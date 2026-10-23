import {
  DEFAULT_SDK_OPTIONS,
  DEVICE_PROTOCOL_V2,
  DEVICE_PROTOCOL_V4,
  DEVICE_PROTOCOL_V5,
  DEVICE_PROTOCOL_VERSION,
  MAX_DEVICE_LINE_BYTES,
} from '@lionscope/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceGateway, DEFAULT_DEVICE_LIMITS, MAX_HELD_LINES } from '../src/device/deviceGateway.ts';
import type { DeviceGateway, DeviceGatewayLimits } from '../src/device/deviceGateway.ts';
import type {
  ByeReason,
  SdkAttachResult,
  SdkHello,
  SdkLink,
  SdkLinkHandler,
  SdkLinkMessage,
  SdkLinkTarget,
} from '../src/device/sdkLink.ts';
import { log } from '../src/log.ts';
import { TokenBucket } from '../src/net/tokenBucket.ts';
import { DeviceClient } from './helpers/deviceClient.ts';

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 1,
  sdkVersion: '0.1.0',
  packageName: 'com.example.app',
  processName: 'com.example.app',
  pid: 4242,
  apiLevel: 35,
  deviceWallMs: 1792516375000,
  refreshRateHz: 120,
};
const HEARTBEAT = { type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 };
const STALL = {
  type: 'stall',
  ts: 1792516378000,
  durationMs: 342.5,
  frames: [{ className: 'com.example.app.Home', method: 'load', file: 'Home.kt', line: 87, inApp: true }],
  samples: 6,
  truncated: false,
  screen: 'home',
  debugger: false,
};
const STRICTMODE = {
  type: 'strictmode',
  ts: 1792516379000,
  policy: 'thread',
  violation: 'DiskReadViolation',
  message: null,
  frames: [],
  count: 1,
  screen: null,
};

class FakeTarget implements SdkLinkTarget {
  answer: 'ok' | ByeReason = 'ok';
  /** Make the link handler throw on every message (a bug downstream). */
  throwing = false;
  /** Ask for a `config` while attaching (before the welcome went out), like the session does. */
  configOnAttach = false;
  /** Close the link from inside attachSdk (e.g. the session stopped meanwhile). */
  closeOnAttach = false;
  readonly hellos: SdkHello[] = [];
  readonly links: SdkLink[] = [];
  readonly messages: SdkLinkMessage[] = [];
  closes = 0;
  invalidDiagnostics = 0;

  attachSdk(hello: SdkHello, link: SdkLink): SdkAttachResult {
    this.hellos.push(hello);
    this.links.push(link);
    if (this.configOnAttach) link.sendConfig(DEFAULT_SDK_OPTIONS);
    if (this.closeOnAttach) link.close('no_session');
    if (this.answer !== 'ok') return { ok: false, reason: this.answer };
    return {
      ok: true,
      handler: {
        onMessage: (message) => {
          if (this.throwing) throw new Error('boom');
          this.messages.push(message);
        },
        onInvalidDiagnostic: () => {
          this.invalidDiagnostics += 1;
        },
        onClose: () => {
          this.closes += 1;
        },
      },
    };
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('device gateway', () => {
  let gateway: DeviceGateway | null = null;
  let target: FakeTarget;
  /** Rate limiters run on this clock: it only moves when a test says so. */
  let clock = 1_000_000;
  const clients: DeviceClient[] = [];

  async function start(limits: Partial<DeviceGatewayLimits> = {}): Promise<number> {
    target = new FakeTarget();
    gateway = createDeviceGateway({ port: 0, target, limits, now: () => clock });
    return (await gateway.listen()).port;
  }

  async function open(port: number): Promise<DeviceClient> {
    const client = await DeviceClient.open(port);
    clients.push(client);
    return client;
  }

  async function linked(port: number): Promise<DeviceClient> {
    const client = await open(port);
    client.send(HELLO);
    await client.waitFor((message) => message.type === 'welcome');
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await gateway?.close();
    gateway = null;
    vi.restoreAllMocks();
  });

  it('uses a 1 s hello timeout and separate handshake / link pools by default', () => {
    expect(DEFAULT_DEVICE_LIMITS).toMatchObject({
      helloTimeoutMs: 1000,
      maxHandshakes: 4,
      maxLinks: 4,
      hellosPerSecond: 1,
      helloBurst: 5,
    });
  });

  it('listens on loopback only', async () => {
    await start();
    expect(gateway?.address?.address).toBe('127.0.0.1');
  });

  it('welcomes a valid hello and forwards later messages in order', async () => {
    const port = await start();
    const client = await linked(port);
    expect(client.received).toEqual([{ type: 'welcome', protocolVersion: 1 }]);
    expect(target.hellos).toEqual([HELLO]);

    // Several lines per chunk, a line split across chunks (inside a multi-byte character), and CRLF.
    const screen = {
      type: 'screen',
      ts: 1792516375100,
      screen: { name: 'Ünïcödé', className: 'com.example.Main', kind: 'activity' },
    };
    const bytes = Buffer.from(`${JSON.stringify(screen)}\r\n${JSON.stringify(HEARTBEAT)}\n`);
    const cut = bytes.indexOf(Buffer.from('Ü')) + 1;
    client.write(bytes.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write(bytes.subarray(cut));
    client.send({ type: 'frames', window: 'w', intervalMs: 16.6, frames: [] });
    await waitUntil(() => target.messages.length === 3);
    expect(target.messages.map((message) => message.type)).toEqual(['screen', 'heartbeat', 'frames']);
    expect(target.messages[0]).toEqual(screen);
    expect(client.isClosed).toBe(false);
  });

  it.each(['no_session', 'package_mismatch'] as const)(
    'says bye %s and closes when the target refuses the hello',
    async (reason) => {
      const port = await start();
      target.answer = reason;
      const client = await open(port);
      client.send(HELLO);
      await client.closed;
      expect(client.received).toEqual([{ type: 'bye', reason }]);
    },
  );

  it.each([
    ['a non-hello first message', JSON.stringify(HEARTBEAT)],
    ['an unknown first message', JSON.stringify({ type: 'future', ts: 1 })],
    ['invalid JSON', '{nope'],
    ['a protocol version below the minimum', JSON.stringify({ ...HELLO, protocolVersion: 0 })],
  ])('closes with bye protocol_error on %s', async (_name, line) => {
    const port = await start();
    const client = await open(port);
    client.send(line);
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'protocol_error' }]);
    expect(target.hellos).toEqual([]);
  });

  it('keeps the link up for a batch holding a frame over a minute (the server drops just that frame)', async () => {
    const port = await start();
    const client = await linked(port);
    const frame = {
      ts: 1792516375300,
      totalMs: 90_000,
      inputMs: 0,
      animationMs: 0,
      layoutMs: 0,
      drawMs: 0,
      syncMs: 0,
      commandMs: 0,
      swapMs: 0,
      delayMs: 90_000,
      gpuMs: null,
      deadlineMs: null,
      firstDraw: false,
    };
    client.send({ type: 'frames', window: 'w', intervalMs: 16.6, frames: [frame] });
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 2);
    expect(client.isClosed).toBe(false);
    expect(client.received).toEqual([{ type: 'welcome', protocolVersion: 1 }]);
  });

  it('negotiates down to its own protocol version with a newer SDK and keeps it on the link', async () => {
    const port = await start();
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_VERSION + 1 });
    await client.waitFor((message) => message.type === 'welcome');
    expect(client.received).toEqual([
      { type: 'welcome', protocolVersion: DEVICE_PROTOCOL_VERSION, mode: 'session' },
    ]);
    expect(target.hellos[0]?.protocolVersion).toBe(DEVICE_PROTOCOL_VERSION + 1);
    expect(target.links[0]?.protocolVersion).toBe(DEVICE_PROTOCOL_VERSION);
  });

  it('skips and counts messages of an unknown type (a newer SDK) without closing the link', async () => {
    const warn = vi.spyOn(log, 'warn');
    const port = await start();
    const client = await linked(port);
    client.send({ type: 'memory', ts: 1792516380000, heapBytes: 1 });
    client.send(HEARTBEAT);
    client.send({ type: 'memory', ts: 1792516380002, heapBytes: 2 });
    client.send({ type: 'screen', ts: 1792516380001, screen: null });
    await waitUntil(() => target.messages.length === 2);
    expect(target.messages.map((message) => message.type)).toEqual(['heartbeat', 'screen']);
    expect(client.isClosed).toBe(false);
    // One throttled log line, naming the first type and the count so far.
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('unknown type'));
    expect(lines).toEqual([
      'Device gateway: ignoring SDK messages of unknown type "memory" (a newer SDK?), 1 so far',
    ]);

    // A known type that is malformed still closes the link.
    client.send({ ...HEARTBEAT, ts: 'later' });
    await client.closed;
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
  });

  it('logs an unknown type as shortened printable ASCII', async () => {
    const warn = vi.spyOn(log, 'warn');
    const port = await start();
    const client = await linked(port);
    client.send({ type: `evil\u202e\u0000${'x'.repeat(200)}` });
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('unknown type'));
    expect(line).toContain(`"evil??${'x'.repeat(58)}"`);
  });

  it('logs an out-of-range hello protocol version as unsupported', async () => {
    const warn = vi.spyOn(log, 'warn');
    const port = await start();
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: 0 });
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'protocol_error' }]);
    expect(warn).toHaveBeenCalledWith('Device gateway: closed a connection (unsupported protocol version 0)');
  });

  it('sends flat gateway lines with type as the first key (the SDK scans them without a JSON parser)', async () => {
    const port = await start();
    const client = await linked(port);
    target.links[0]?.close('no_session');
    await client.closed;
    const refused = await open(port);
    refused.send(HEARTBEAT);
    await refused.closed;
    target.configOnAttach = true;
    const v2 = await open(port);
    v2.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await v2.waitFor((message) => message.type === 'config');
    // Key order of the options object must not leak into the line.
    target.links.at(-1)?.sendConfig({ strictMode: true, inflateTracking: false, stallThresholdMs: 1000 });
    await v2.waitFor((message) => message.type === 'config' && message.strictMode);
    const lines = [...client.rawLines, ...refused.rawLines, ...v2.rawLines];
    expect(lines).toEqual([
      '{"type":"welcome","protocolVersion":1}',
      '{"type":"bye","reason":"no_session"}',
      '{"type":"bye","reason":"protocol_error"}',
      '{"type":"welcome","protocolVersion":2}',
      '{"type":"config","stallThresholdMs":150,"strictMode":false,"inflateTracking":true}',
      '{"type":"config","stallThresholdMs":1000,"strictMode":true,"inflateTracking":false}',
    ]);
    for (const line of lines) {
      expect(line.startsWith('{"type":')).toBe(true);
      const values = Object.values(JSON.parse(line) as Record<string, unknown>);
      expect(values.every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('sends config right after the welcome on a v2 link, and again whenever asked', async () => {
    const port = await start();
    target.configOnAttach = true;
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await client.waitFor((message) => message.type === 'config');
    expect(client.received).toEqual([
      { type: 'welcome', protocolVersion: 2 },
      { type: 'config', stallThresholdMs: 150, strictMode: false, inflateTracking: true },
    ]);
    target.links[0]?.sendConfig({ stallThresholdMs: 500, strictMode: true, inflateTracking: true });
    await client.waitFor((message) => message.type === 'config' && message.strictMode);
    expect(client.received.at(-1)).toEqual({
      type: 'config',
      stallThresholdMs: 500,
      strictMode: true,
      inflateTracking: true,
    });

    target.links[0]?.close('no_session');
    target.links[0]?.sendConfig(DEFAULT_SDK_OPTIONS); // closing: nothing more is sent
    await client.closed;
    expect(client.received.map((message) => message.type)).toEqual(['welcome', 'config', 'config', 'bye']);
  });

  it('never sends config on a link negotiated at v1', async () => {
    const port = await start();
    target.configOnAttach = true;
    const client = await linked(port);
    target.links[0]?.sendConfig({ stallThresholdMs: 500, strictMode: true, inflateTracking: true });
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    expect(client.received).toEqual([{ type: 'welcome', protocolVersion: 1 }]);
  });

  it('does not send a config asked for by a target that refuses the hello', async () => {
    const port = await start();
    target.configOnAttach = true;
    target.answer = 'no_session';
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'no_session' }]);
  });

  it('skips and counts v2 messages on a v1 link, and forwards them on a v2 link', async () => {
    const warn = vi.spyOn(log, 'warn');
    const port = await start();
    const v1 = await linked(port);
    v1.send(STALL);
    v1.send(STRICTMODE);
    v1.send({ type: 'stall' }); // not even validated
    v1.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    expect(target.messages.map((message) => message.type)).toEqual(['heartbeat']);
    expect(v1.isClosed).toBe(false);
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"stall"'));
    expect(lines).toEqual(['Device gateway: ignoring "stall": SDK sent a v2 message on a v1 link, 1 so far']);

    const v2 = await open(port);
    v2.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await v2.waitFor((message) => message.type === 'welcome');
    v2.send(STALL);
    v2.send(STRICTMODE);
    await waitUntil(() => target.messages.length === 3);
    expect(target.messages.slice(1)).toEqual([STALL, STRICTMODE]);
  });

  it('drops an invalid diagnostic but keeps the link, and cleans up StrictMode text', async () => {
    const warn = vi.spyOn(log, 'warn');
    const port = await start();
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await client.waitFor((message) => message.type === 'welcome');
    const frame = STALL.frames[0];
    client.send({ ...STRICTMODE, message: 'a\nb' });
    client.send({ ...STRICTMODE, message: '' });
    client.send({ ...STRICTMODE, violation: '' });
    client.send({ ...STALL, frames: [{ ...frame, className: 'c'.repeat(257) }] }); // dropped
    client.send({ ...STRICTMODE, frames: [{ ...frame, line: '87' }] }); // dropped
    client.send({ ...STALL, durationMs: -1 }); // dropped
    client.send({ type: 'frames', window: 'w', intervalMs: 16.6, frames: [] });
    await waitUntil(() => target.messages.length === 4);
    expect(target.messages).toEqual([
      { ...STRICTMODE, message: 'a b' },
      { ...STRICTMODE, message: null },
      { ...STRICTMODE, violation: 'Violation' },
      { type: 'frames', window: 'w', intervalMs: 16.6, frames: [] },
    ]);
    expect(target.invalidDiagnostics).toBe(3);
    expect(client.isClosed).toBe(false);
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('invalid SDK'));
    expect(lines).toHaveLength(1); // throttled
    expect(lines[0]).toMatch(/^Device gateway: dropped an invalid SDK stall message \(.+\), 1 so far$/);

    // An invalid v1 message still closes the link.
    client.send({ ...HEARTBEAT, droppedMessages: -1 });
    await client.closed;
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
  });

  it('writes neither welcome nor config when the target closed the link while attaching it', async () => {
    const port = await start();
    target.configOnAttach = true;
    target.closeOnAttach = true;
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V2 });
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'no_session' }]);
  });

  it('welcomes a hello with unknown extra fields (a newer SDK)', async () => {
    const port = await start();
    const client = await open(port);
    client.send({ ...HELLO, futureField: true });
    await client.waitFor((message) => message.type === 'welcome');
    expect(target.hellos).toEqual([HELLO]);
  });

  it.each(['GET / HTTP/1.1', 'POST /x HTTP/1.1', 'OPTIONS * HTTP/1.1', 'CONNECT a:1 HTTP/1.1'])(
    'drops a connection whose first line looks like HTTP (%s) without answering',
    async (requestLine) => {
      const port = await start();
      const client = await open(port);
      client.write(`${requestLine}\r\nHost: localhost:8700\r\nOrigin: https://evil.example\r\n\r\n`);
      await client.closed;
      expect(client.received).toEqual([]);
      expect(target.hellos).toEqual([]);
    },
  );

  it('closes a connection that sends no hello in time', async () => {
    const port = await start({ helloTimeoutMs: 200 });
    const client = await open(port);
    client.write('{"type":"hel'); // incomplete line
    const started = Date.now();
    await client.closed;
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(client.received).toEqual([]);
  });

  it(`closes on a line over ${MAX_DEVICE_LINE_BYTES} bytes, even before its newline arrives`, async () => {
    const port = await start();
    const client = await linked(port);
    client.write(`{"type":"heartbeat","pad":"${'x'.repeat(MAX_DEVICE_LINE_BYTES)}`);
    await client.closed;
    expect(target.messages).toEqual([]);
    await waitUntil(() => target.closes === 1);
  });

  it('accepts a line of exactly the maximum size', async () => {
    const port = await start();
    const client = await linked(port);
    const prefix = '{"type":"frames","window":"w","intervalMs":16.6,"frames":[]';
    const line = `${prefix}${' '.repeat(MAX_DEVICE_LINE_BYTES - prefix.length - 1)}}`;
    expect(Buffer.byteLength(line)).toBe(MAX_DEVICE_LINE_BYTES);
    client.send(line);
    await waitUntil(() => target.messages.length === 1);
    expect(client.isClosed).toBe(false);
  });

  it('closes a client that exceeds the line rate limit', async () => {
    const port = await start({ lineBurst: 5, linesPerSecond: 1 });
    const client = await linked(port); // the hello is line 1
    for (let i = 0; i < 3; i += 1) client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 3);
    clock += 2000; // two more lines' worth of tokens
    for (let i = 0; i < 10; i += 1) client.send(HEARTBEAT);
    await client.closed;
    expect(target.messages).toHaveLength(6);
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
    await waitUntil(() => target.closes === 1);
  });

  it('drops diagnostic lines over the line budget instead of closing the link', async () => {
    const port = await start({ lineBurst: 200, linesPerSecond: 100 });
    const client = await open(port);
    client.send({ ...HELLO, protocolVersion: 3 });
    await client.waitFor((message) => message.type === 'welcome');
    const inflate = {
      type: 'inflate',
      ts: 1_792_516_375_260,
      layout: 'fragment_home',
      label: null,
      library: false,
      nested: false,
      screen: null,
      count: 1,
      totalMs: 1,
      maxMs: 1,
      views: 3,
    };
    for (let i = 0; i < 300; i += 1) client.send(inflate);
    // The hello took one token: 199 inflates fit, the other 101 are shed.
    await waitUntil(() => target.messages.length === 199);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(target.messages).toHaveLength(199);
    expect(client.isClosed).toBe(false);
    expect(client.received.map((message) => message.type)).toEqual(['welcome']);
  });

  it('still closes on a flood of non-diagnostic lines', async () => {
    const port = await start({ lineBurst: 20, linesPerSecond: 1 });
    const client = await linked(port);
    for (let i = 0; i < 300; i += 1) client.send(HEARTBEAT);
    await client.closed;
    expect(target.messages.length).toBeLessThanOrEqual(19);
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
  });

  it('limits hellos gateway-wide, so reconnecting does not reset the rate limit', async () => {
    const port = await start({ helloBurst: 2, hellosPerSecond: 1 });
    for (const client of [await linked(port), await linked(port)]) client.socket.destroy();
    const third = await open(port);
    third.send(HELLO);
    await third.closed;
    expect(third.received).toEqual([{ type: 'bye', reason: 'too_many_connections' }]);
    expect(target.hellos).toHaveLength(2);
    clock += 1000;
    expect((await linked(port)).isClosed).toBe(false);
  });

  it('closes the link with protocol_error when handling a message throws', async () => {
    const error = vi.spyOn(log, 'error');
    const port = await start();
    const client = await linked(port);
    target.throwing = true;
    client.send(HEARTBEAT);
    await client.closed;
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
    expect(error.mock.calls.some((call) => String(call[1]).includes('boom'))).toBe(true);
  });

  it('closes on an invalid message or a second hello after the handshake', async () => {
    const port = await start();
    const bad = await linked(port);
    bad.send({ ...HEARTBEAT, droppedMessages: -1 });
    await bad.closed;
    expect(bad.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });

    const again = await linked(port);
    again.send(HELLO);
    await again.closed;
    expect(again.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
    expect(target.hellos).toHaveLength(2);
    await waitUntil(() => target.closes === 2);
  });

  it('drops an idle connection, and heartbeats keep it alive', async () => {
    const port = await start({ idleTimeoutMs: 400 });
    const quiet = await linked(port);
    const chatty = await linked(port);
    const timer = setInterval(() => chatty.send(HEARTBEAT), 50);
    await quiet.closed;
    expect(chatty.isClosed).toBe(false);
    clearInterval(timer);
    await chatty.closed;
    await waitUntil(() => target.closes === 2);
  });

  it('evicts the oldest handshaking connection when the handshake pool is full', async () => {
    const port = await start({ maxHandshakes: 3 });
    const live = await linked(port); // past its hello: not in the handshake pool
    const waiting = [await open(port), await open(port), await open(port)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newcomer = await open(port);
    await waiting[0]?.closed;
    expect(waiting[0]?.received).toEqual([]);
    expect(waiting.slice(1).every((client) => !client.isClosed)).toBe(true);
    newcomer.send(HELLO);
    await newcomer.waitFor((message) => message.type === 'welcome');
    expect(live.isClosed).toBe(false);
  });

  it('caps the links: one more hello gets bye too_many_connections', async () => {
    const port = await start({ maxLinks: 2 });
    const links = [await linked(port), await linked(port)];
    const third = await open(port);
    third.send(HELLO);
    await third.closed;
    expect(third.received).toEqual([{ type: 'bye', reason: 'too_many_connections' }]);
    expect(target.hellos).toHaveLength(2);

    links[0]?.socket.destroy();
    await links[0]?.closed;
    await waitUntil(() => target.closes === 1);
    expect((await linked(port)).isClosed).toBe(false);
  });

  it('lets the target close a link with a reason', async () => {
    const port = await start();
    const client = await linked(port);
    target.links[0]?.close('no_session');
    target.links[0]?.close('no_session'); // idempotent
    await client.closed;
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'no_session' });
    await waitUntil(() => target.closes === 1);

    const silent = await linked(port);
    target.links[1]?.close();
    await silent.closed;
    expect(silent.received).toEqual([{ type: 'welcome', protocolVersion: 1 }]);
  });

  it('close() drops every connection and stops listening', async () => {
    const port = await start();
    const client = await linked(port);
    await gateway?.close();
    await client.closed;
    await waitUntil(() => target.closes === 1);
    await expect(DeviceClient.open(port)).rejects.toThrow();
    await gateway?.close(); // idempotent
  });

  it('rejects listen() when the port is taken', async () => {
    const port = await start();
    const second = createDeviceGateway({ port, target: new FakeTarget() });
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
    const fallback = await second.listen(0);
    expect(fallback.port).not.toBe(port);
    await second.close();
  });
});

describe('device gateway: checking a hello before the welcome', () => {
  const gateways: DeviceGateway[] = [];
  const clients: DeviceClient[] = [];
  const SCREEN = { type: 'screen', ts: 1792516376000, screen: null };

  /** A target that decides on each hello only when the test resolves it. */
  function deferredTarget() {
    const pending: { hello: SdkHello; link: SdkLink; resolve: (result: SdkAttachResult) => void }[] = [];
    const messages: SdkLinkMessage[] = [];
    let closes = 0;
    const handler: SdkLinkHandler = {
      onMessage: (message) => messages.push(message),
      onInvalidDiagnostic: () => undefined,
      onClose: () => {
        closes += 1;
      },
    };
    const target: SdkLinkTarget = {
      attachSdk: (hello, link) => new Promise((resolve) => pending.push({ hello, link, resolve })),
    };
    return { target, pending, messages, handler, closes: () => closes };
  }

  async function listen(target: SdkLinkTarget, sharedHellos?: TokenBucket): Promise<number> {
    const gateway = createDeviceGateway({ port: 0, target, ...(sharedHellos ? { sharedHellos } : {}) });
    gateways.push(gateway);
    return (await gateway.listen()).port;
  }

  async function open(port: number): Promise<DeviceClient> {
    const client = await DeviceClient.open(port);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    for (const gateway of gateways.splice(0)) await gateway.close();
  });

  it('sends nothing until the target decided, then welcomes and hands on the lines it held', async () => {
    const deferred = deferredTarget();
    const client = await open(await listen(deferred.target));
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V5 });
    client.send(SCREEN);
    client.send(HEARTBEAT);
    await waitUntil(() => deferred.pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.rawLines).toEqual([]);
    expect(deferred.messages).toEqual([]);
    deferred.pending[0]?.resolve({ ok: true, handler: deferred.handler, mode: 'inspect' });
    await client.waitFor((message) => message.type === 'welcome');
    await waitUntil(() => deferred.messages.length === 2);
    expect(deferred.messages.map((message) => message.type)).toEqual(['screen', 'heartbeat']);
    client.send(HEARTBEAT);
    await waitUntil(() => deferred.messages.length === 3);
  });

  it(`holds at most ${MAX_HELD_LINES} lines while checking`, async () => {
    const deferred = deferredTarget();
    const client = await open(await listen(deferred.target));
    client.send(HELLO);
    for (let index = 0; index < MAX_HELD_LINES + 5; index++) client.send(HEARTBEAT);
    await waitUntil(() => deferred.pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deferred.pending[0]?.resolve({ ok: true, handler: deferred.handler });
    await client.waitFor((message) => message.type === 'welcome');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deferred.messages).toHaveLength(MAX_HELD_LINES);
  });

  it('a refused hello hears nothing but bye no_session, however long the check took', async () => {
    const deferred = deferredTarget();
    const client = await open(await listen(deferred.target));
    client.send({ ...HELLO, protocolVersion: DEVICE_PROTOCOL_V5 });
    client.send(SCREEN);
    await waitUntil(() => deferred.pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deferred.pending[0]?.resolve({ ok: false, reason: 'no_session' });
    await client.closed;
    expect(client.rawLines).toEqual(['{"type":"bye","reason":"no_session"}']);
    expect(deferred.messages).toEqual([]);
  });

  it('sends welcome.mode on v5 links only, never inspect mode below v5, and no config to inspect links', async () => {
    const deferred = deferredTarget();
    const port = await listen(deferred.target);
    const welcome = async (protocolVersion: number, mode: 'session' | 'inspect' | undefined) => {
      const client = await open(port);
      client.send({ ...HELLO, protocolVersion });
      await waitUntil(() => deferred.pending.length > 0);
      const entry = deferred.pending.shift();
      // Options asked for while attaching go out right after a session welcome.
      entry?.link.sendConfig(DEFAULT_SDK_OPTIONS);
      entry?.resolve({ ok: true, handler: deferred.handler, ...(mode ? { mode } : {}) });
      await client.waitFor((message) => message.type === 'welcome' || message.type === 'bye');
      entry?.link.sendConfig(DEFAULT_SDK_OPTIONS);
      client.send(HEARTBEAT);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return client.rawLines;
    };
    const config = JSON.stringify({ type: 'config', ...DEFAULT_SDK_OPTIONS });
    expect(await welcome(DEVICE_PROTOCOL_V5, undefined)).toEqual([
      '{"type":"welcome","protocolVersion":5,"mode":"session"}',
      config,
      config,
    ]);
    expect(await welcome(DEVICE_PROTOCOL_V5 + 1, 'inspect')).toEqual([
      '{"type":"welcome","protocolVersion":5,"mode":"inspect"}',
    ]);
    expect(await welcome(DEVICE_PROTOCOL_V4, 'session')).toEqual([
      '{"type":"welcome","protocolVersion":4}',
      config,
      config,
    ]);
    expect(await welcome(DEVICE_PROTOCOL_V4, 'inspect')).toEqual(['{"type":"bye","reason":"no_session"}']);
  });

  it('tells the handler when the connection went away while the target checked it', async () => {
    const deferred = deferredTarget();
    const client = await open(await listen(deferred.target));
    client.send(HELLO);
    await waitUntil(() => deferred.pending.length === 1);
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    deferred.pending[0]?.resolve({ ok: true, handler: deferred.handler });
    await waitUntil(() => deferred.closes() === 1);
  });

  it('closes with protocol_error when the target fails', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const client = await open(await listen({ attachSdk: () => Promise.reject(new Error('boom')) }));
    client.send(HELLO);
    await client.closed;
    expect(client.received).toEqual([{ type: 'bye', reason: 'protocol_error' }]);
    vi.restoreAllMocks();
  });

  it('bounds hellos across listeners with a shared bucket, on top of each one’s own', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const shared = new TokenBucket(2, 0);
    const accept: SdkLinkTarget = {
      attachSdk: () => ({
        ok: true,
        handler: {
          onMessage: () => undefined,
          onInvalidDiagnostic: () => undefined,
          onClose: () => undefined,
        },
      }),
    };
    const ports = [await listen(accept, shared), await listen(accept, shared)];
    const answers: string[] = [];
    for (const port of [ports[0], ports[1], ports[1]]) {
      const client = await open(port ?? 0);
      client.send(HELLO);
      await client.waitFor((message) => message.type === 'welcome' || message.type === 'bye');
      answers.push(client.received[0]?.type === 'bye' ? client.received[0].reason : 'welcome');
    }
    expect(answers).toEqual(['welcome', 'welcome', 'too_many_connections']);
    vi.restoreAllMocks();
  });
});

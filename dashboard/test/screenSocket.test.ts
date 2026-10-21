import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREEN_TEXT_CHARS } from '@lionscope/protocol/wire';
import {
  createScreenConnection,
  parseScreenBinary,
  parseScreenMessage,
  screenUrl,
  type ScreenBinary,
  type ScreenConnectionState,
  type ScreenInfo,
} from '../src/lib/screenSocket.ts';
import { BACKOFF_CAP_MS } from '../src/lib/connection.ts';
import { binaryMessage, FakeScreenSocket, SCREEN_INFO } from './screenFakes.ts';

describe('screenUrl', () => {
  it('targets the screen path on the page origin with the serial and size', () => {
    expect(screenUrl({ protocol: 'http:', host: '127.0.0.1:8701' }, 'emulator-5554', 540)).toBe(
      'ws://127.0.0.1:8701/ws/screen?serial=emulator-5554&size=540',
    );
    expect(screenUrl({ protocol: 'https:', host: 'example.test' }, '192.168.1.5:5555', 360)).toBe(
      'wss://example.test/ws/screen?serial=192.168.1.5%3A5555&size=360',
    );
  });
});

describe('parseScreenBinary', () => {
  it('reads the kind byte and keeps the rest as a PNG blob', async () => {
    const frame = parseScreenBinary(binaryMessage('frame', [1, 2, 3]));
    expect(frame?.kind).toBe('frame');
    expect(frame?.png.type).toBe('image/png');
    expect([...new Uint8Array(await frame!.png.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(parseScreenBinary(binaryMessage('screenshot'))?.kind).toBe('screenshot');
  });

  it('drops unknown kinds and empty payloads', () => {
    expect(parseScreenBinary(new Uint8Array([9, 1, 2]).buffer)).toBeNull();
    expect(parseScreenBinary(new Uint8Array([1]).buffer)).toBeNull();
    expect(parseScreenBinary(new ArrayBuffer(0))).toBeNull();
  });
});

describe('parseScreenMessage', () => {
  it('accepts screenInfo and screenError only', () => {
    expect(parseScreenMessage(JSON.stringify(SCREEN_INFO))).toEqual(SCREEN_INFO);
    expect(parseScreenMessage('{"type":"screenError","code":"busy","message":"x"}')?.type).toBe(
      'screenError',
    );
    expect(parseScreenMessage('{"type":"hello"}')).toBeNull();
    expect(parseScreenMessage('not json')).toBeNull();
    expect(parseScreenMessage('null')).toBeNull();
    expect(parseScreenMessage(42)).toBeNull();
  });
});

describe('createScreenConnection', () => {
  let states: ScreenConnectionState[];
  let binaries: ScreenBinary[];
  let infos: ScreenInfo[];
  let size: number;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeScreenSocket.reset();
    states = [];
    binaries = [];
    infos = [];
    size = 540;
  });
  afterEach(() => vi.useRealTimers());

  const connect = () =>
    createScreenConnection({
      url: () => `ws://test/ws/screen?size=${size}`,
      onBinary: (msg) => binaries.push(msg),
      onInfo: (info) => infos.push(info),
      onState: (state) => states.push(state),
      createSocket: (url) => new FakeScreenSocket(url),
      random: () => 0.5,
    });
  const lastStatus = () => states[states.length - 1]?.status;

  it('asks for array buffers, goes live on the first frame and forwards frames, screenshots and info', () => {
    connect();
    const socket = FakeScreenSocket.latest();
    expect(socket.binaryType).toBe('arraybuffer');
    expect(lastStatus()).toBe('connecting');
    socket.open();
    socket.receiveJson(SCREEN_INFO);
    expect(infos).toEqual([SCREEN_INFO]);
    expect(lastStatus()).toBe('connecting');
    socket.receive(binaryMessage('frame'));
    socket.receive(binaryMessage('frame'));
    socket.receive(binaryMessage('screenshot'));
    expect(binaries.map((b) => b.kind)).toEqual(['frame', 'frame', 'screenshot']);
    expect(states.filter((s) => s.status === 'live')).toHaveLength(1);
  });

  it('reconnects with backoff after a drop, using the current size, and resets after a frame', () => {
    connect();
    FakeScreenSocket.latest().open();
    FakeScreenSocket.latest().drop();
    expect(lastStatus()).toBe('reconnecting');
    expect(states[states.length - 1]?.attempt).toBe(1);
    size = 720;
    vi.advanceTimersByTime(250);
    expect(FakeScreenSocket.instances).toHaveLength(2);
    expect(FakeScreenSocket.latest().url).toContain('size=720');

    FakeScreenSocket.latest().drop();
    vi.advanceTimersByTime(499);
    expect(FakeScreenSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeScreenSocket.instances).toHaveLength(3);

    FakeScreenSocket.latest().open();
    FakeScreenSocket.latest().receive(binaryMessage('frame'));
    expect(states[states.length - 1]).toEqual({ status: 'live', attempt: 0, error: null });
  });

  it('keeps a transient error (ended, busy) while it retries', () => {
    connect();
    const socket = FakeScreenSocket.latest();
    socket.open();
    socket.receiveJson({ type: 'screenError', code: 'ended', message: 'stream ended' });
    socket.drop();
    expect(states[states.length - 1]).toMatchObject({
      status: 'reconnecting',
      error: { code: 'ended', message: 'stream ended' },
    });
    vi.advanceTimersByTime(BACKOFF_CAP_MS);
    expect(FakeScreenSocket.instances.length).toBeGreaterThan(1);
  });

  it('stops for good on errors a retry can’t fix', () => {
    connect();
    const socket = FakeScreenSocket.latest();
    socket.open();
    socket.receiveJson({ type: 'screenError', code: 'not_emulator', message: 'physical device' });
    expect(socket.readyState).toBe(3);
    expect(states[states.length - 1]).toMatchObject({ status: 'failed', error: { code: 'not_emulator' } });
    vi.advanceTimersByTime(60_000);
    expect(FakeScreenSocket.instances).toHaveLength(1);
  });

  it('sends JSON only while open, refuses oversized messages, and close() stops retrying', () => {
    const connection = connect();
    const socket = FakeScreenSocket.latest();
    expect(connection.send({ type: 'nav', button: 'home' })).toBe(false);
    socket.open();
    expect(connection.send({ type: 'nav', button: 'home' })).toBe(true);
    expect(socket.messages()).toEqual([{ type: 'nav', button: 'home' }]);
    expect(connection.send({ type: 'text', text: 'x'.repeat(MAX_SCREEN_TEXT_CHARS) })).toBe(true);
    expect(connection.send({ type: 'text', text: '\u0001'.repeat(400) })).toBe(false);

    connection.close();
    expect(socket.readyState).toBe(3);
    vi.advanceTimersByTime(60_000);
    expect(FakeScreenSocket.instances).toHaveLength(1);
    expect(connection.send({ type: 'nav', button: 'home' })).toBe(false);
  });

  it('holds a size picked while connecting and sends it on open; a reconnect takes it from the URL', () => {
    const connection = connect();
    const first = FakeScreenSocket.latest();
    expect(connection.send({ type: 'setSize', size: 360 })).toBe(true);
    expect(connection.send({ type: 'setSize', size: 720 })).toBe(true);
    expect(first.sent).toEqual([]);
    first.open();
    expect(first.messages()).toEqual([{ type: 'setSize', size: 720 }]);

    first.drop();
    connection.send({ type: 'setSize', size: 360 });
    size = 360;
    vi.advanceTimersByTime(BACKOFF_CAP_MS);
    const second = FakeScreenSocket.latest();
    second.open();
    expect(second.url).toContain('size=360');
    expect(second.sent).toEqual([]);
  });

  it('ignores messages from a socket it already replaced', () => {
    connect();
    const first = FakeScreenSocket.latest();
    first.open();
    first.drop();
    vi.advanceTimersByTime(BACKOFF_CAP_MS);
    first.receive(binaryMessage('frame'));
    expect(binaries).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  closeReasonFor,
  createConnection,
  POLICY_BACKOFF_MS,
  STABLE_AFTER_MS,
  parseServerMessage,
  wsUrl,
  type SocketLike,
} from '../src/lib/connection.ts';
import type { ServerMessageType } from '@lionscope/protocol/wire';
import type { ConnectionState } from '../src/lib/store.ts';

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.onerror?.(new Event('error'));
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

describe('wsUrl', () => {
  it('derives ws/wss from the page protocol', () => {
    expect(wsUrl({ protocol: 'http:', host: 'localhost:8701' })).toBe('ws://localhost:8701/ws');
    expect(wsUrl({ protocol: 'https:', host: 'example.test' })).toBe('wss://example.test/ws');
  });
});

describe('backoffDelay', () => {
  it('doubles from 250 ms with ±20% jitter and caps at 5 s', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(250);
    expect(backoffDelay(1, mid)).toBe(500);
    expect(backoffDelay(3, mid)).toBe(2000);
    expect(backoffDelay(10, mid)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelay(0, () => 0)).toBe(200);
    expect(backoffDelay(0, () => 1)).toBe(300);
    expect(backoffDelay(10, () => 1)).toBe(BACKOFF_CAP_MS);
  });
});

describe('parseServerMessage', () => {
  it('accepts known message types', () => {
    expect(parseServerMessage('{"type":"devices","devices":[]}')).toEqual({ type: 'devices', devices: [] });
  });

  it('accepts every server message type, including the SDK screen, breakdown, stall, StrictMode, inflate and view tree streams', () => {
    // A Record forces this list to grow with the protocol: a new type fails to compile here.
    const types: Record<ServerMessageType, true> = {
      hello: true,
      devices: true,
      emulators: true,
      apps: true,
      session: true,
      snapshot: true,
      cpu: true,
      memory: true,
      frames: true,
      logs: true,
      event: true,
      screen: true,
      breakdown: true,
      stall: true,
      strictmode: true,
      inflate: true,
      viewtree: true,
      error: true,
    };
    for (const type of Object.keys(types)) {
      expect(parseServerMessage(JSON.stringify({ type }))?.type).toBe(type);
    }
  });

  it('rejects malformed input', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('{"type":"nope"}')).toBeNull();
    expect(parseServerMessage('{"devices":[]}')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('closeReasonFor', () => {
  it('maps policy close codes', () => {
    expect(closeReasonFor(1008)).toBe('rate-limited');
    // Over-capacity is an HTTP 503 before the upgrade: the browser only sees 1006.
    expect(closeReasonFor(1013)).toBeNull();
    expect(closeReasonFor(1006)).toBeNull();
    expect(closeReasonFor(undefined)).toBeNull();
  });
});

describe('createConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const statuses: ConnectionState[] = [];
    const messages: unknown[] = [];
    const connection = createConnection({
      url: 'ws://localhost:8701/ws',
      onMessage: (msg) => messages.push(msg),
      onStatus: (state) => statuses.push(state),
      createSocket: (url) => new FakeSocket(url),
      random: () => 0.5,
      now: () => 1000,
    });
    const socket = (i: number) => {
      const s = FakeSocket.instances[i];
      if (!s) throw new Error(`no socket ${i}`);
      return s;
    };
    return { connection, statuses, messages, socket };
  }

  it('connects without sending anything and forwards parsed messages', () => {
    const { connection, statuses, messages, socket } = setup();
    expect(socket(0).url).toBe('ws://localhost:8701/ws');
    expect(statuses.at(-1)).toEqual({ status: 'connecting', attempt: 0, retryAt: null, closeReason: null });
    expect(connection.send({ type: 'stopSession' })).toBe(false);

    socket(0).open();
    expect(statuses.at(-1)?.status).toBe('open');
    // The server pushes hello / devices / session / snapshot on its own.
    expect(socket(0).sent).toEqual([]);

    socket(0).receive('{"type":"error","message":"boom"}');
    socket(0).receive('garbage');
    expect(messages).toEqual([{ type: 'error', message: 'boom' }]);

    expect(connection.send({ type: 'listApps', serial: 'emulator-5554' })).toBe(true);
    expect(socket(0).sent.at(-1)).toBe('{"type":"listApps","serial":"emulator-5554"}');
  });

  it('keeps backing off when sockets open and drop immediately', () => {
    const { statuses, socket } = setup();
    socket(0).drop();
    expect(statuses.at(-1)).toEqual({ status: 'reconnecting', attempt: 1, retryAt: 1250, closeReason: null });

    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // Opens, then drops before it is stable: the backoff must keep growing.
    socket(1).open();
    socket(1).drop();
    expect(statuses.at(-1)).toMatchObject({ attempt: 2, retryAt: 1500 });
    vi.advanceTimersByTime(500);
    socket(2).open();
    socket(2).drop();
    expect(statuses.at(-1)).toMatchObject({ attempt: 3, retryAt: 2000 });
  });

  it('resets backoff once hello arrives', () => {
    const { statuses, socket } = setup();
    socket(0).drop();
    vi.advanceTimersByTime(250);
    socket(1).open();
    socket(1).receive('{"type":"hello","protocolVersion":1,"serverVersion":"x","bufferWindowMs":1}');
    socket(1).drop();
    expect(statuses.at(-1)).toMatchObject({ attempt: 1, retryAt: 1250 });
  });

  it('resets backoff after the connection has been stable for 5 s', () => {
    const { statuses, socket } = setup();
    socket(0).drop();
    vi.advanceTimersByTime(250);
    socket(1).open();
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    socket(1).drop();
    expect(statuses.at(-1)).toMatchObject({ attempt: 1, retryAt: 1250 });
  });

  it('waits at least 30 s after a rate-limit close and says why', () => {
    const { statuses, socket } = setup();
    socket(0).open();
    socket(0).drop(1008);
    expect(statuses.at(-1)).toEqual({
      status: 'reconnecting',
      attempt: 1,
      retryAt: 1000 + POLICY_BACKOFF_MS,
      closeReason: 'rate-limited',
    });
    vi.advanceTimersByTime(POLICY_BACKOFF_MS - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'reconnecting', closeReason: 'rate-limited' });
    // A refused upgrade (e.g. too many dashboards → HTTP 503) surfaces as 1006: normal backoff.
    socket(1).drop(1006);
    expect(statuses.at(-1)).toMatchObject({ closeReason: null, attempt: 2, retryAt: 1500 });
  });

  it('close() reports closed and stops reconnecting; reconnect() starts over', () => {
    const { connection, statuses, socket } = setup();
    socket(0).open();
    connection.close();
    expect(statuses.at(-1)?.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(connection.send({ type: 'stopSession' })).toBe(false);

    connection.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ status: 'connecting', attempt: 0, retryAt: null, closeReason: null });
    connection.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('close() during a pending retry cancels it', () => {
    const { connection, socket } = setup();
    socket(0).drop();
    connection.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

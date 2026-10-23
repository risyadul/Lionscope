import type { NetworkMocksState, ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { droppedHttpMessage } from '../src/device/sdkBridge.ts';
import type { SdkLinkHandler } from '../src/device/sdkLink.ts';
import { EMPTY_MOCKS, NO_SESSION_MOCKS_MESSAGE } from '../src/session/mockRules.ts';
import { SessionManager } from '../src/session/sessionManager.ts';
import { LOST_LINK_MESSAGE } from '../src/store/networkStore.ts';
import type { SdkHttpRequest, SdkHttpResponse } from '../src/store/networkStore.ts';
import { FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';
import { mockInput } from './helpers/networkFixtures.ts';
import { deviceNow, FakeLink, HELLO, HOME, setupSdkSession as setup, START } from './helpers/sdkSession.ts';

const V7_HELLO = { ...HELLO, protocolVersion: 7, sdkVersion: '0.7.0' };

function request(id: number, ts: number, overrides: Partial<SdkHttpRequest> = {}): SdkHttpRequest {
  return {
    type: 'httpRequest',
    id,
    ts,
    method: 'GET',
    url: `https://api.example.com/v1/items/${id}`,
    headers: [],
    body: null,
    mockId: null,
    dropped: 0,
    ...overrides,
  };
}

function response(id: number): SdkHttpResponse {
  return {
    type: 'httpResponse',
    id,
    ts: deviceNow(),
    status: 200,
    protocol: 'h2',
    headers: [],
    body: null,
    headersMs: 40,
    durationMs: 50,
    error: null,
  };
}

const mockStates = (messages: ServerMessage[]) =>
  messages.flatMap((message): NetworkMocksState[] =>
    message.type === 'networkMocks' ? [message.mocks] : [],
  );

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfilingSession network capture', () => {
  it('records the live link’s exchanges on the laptop clock, clamped into the session', async () => {
    const { session, connect } = await setup();
    await vi.advanceTimersByTimeAsync(5000);
    const { handler } = await connect(V7_HELLO);
    handler.onMessage({ type: 'screen', ts: deviceNow() - 1000, screen: HOME });
    handler.onMessage(request(1, deviceNow() - 200));
    handler.onMessage(request(2, deviceNow() - 3_600_000)); // before the session started
    handler.onMessage(request(3, deviceNow() + 60_000)); // ahead of the laptop
    handler.onMessage(response(1));
    const http = session.snapshot().http ?? [];
    expect(http.map((exchange) => exchange.ts)).toEqual([Date.now() - 200, session.startedAt, Date.now()]);
    expect(http[0]).toMatchObject({ state: 'complete', endTs: Date.now() - 150, screen: 'home' });
    expect(session.httpExchange(http[0]?.id ?? -1)).toMatchObject({ protocol: 'h2', status: 200 });
    session.stop();
  });

  it('sums the calls the SDK did not record into one throttled notice', async () => {
    const { connect, ofType } = await setup();
    const { handler } = await connect(V7_HELLO);
    handler.onMessage(request(1, deviceNow(), { dropped: 3 }));
    handler.onMessage(request(2, deviceNow(), { dropped: 4 }));
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: droppedHttpMessage(3) },
    ]);
    expect(droppedHttpMessage(7)).toBe(
      'SDK skipped 7 HTTP calls (over 20 per second); the Network list is incomplete',
    );
  });

  it('fails pending exchanges as lost when their link closes, is replaced, or the session stops', async () => {
    const { session, connect } = await setup();
    const states = () =>
      (session.snapshot().http ?? []).map((exchange) => exchange.error?.kind ?? exchange.state);
    const first = await connect(V7_HELLO);
    first.handler.onMessage(request(1, deviceNow()));
    first.handler.onClose();
    expect(session.snapshot().http?.[0]?.error).toEqual({ kind: 'lost', message: LOST_LINK_MESSAGE });

    const second = await connect(V7_HELLO);
    second.handler.onMessage(request(1, deviceNow()));
    const third = await connect(V7_HELLO);
    expect(second.link.closedWith).toBe('none');
    third.handler.onMessage(request(1, deviceNow()));
    third.handler.onMessage(request(2, deviceNow()));
    third.handler.onMessage(response(2));
    expect(states()).toEqual(['lost', 'lost', 'pending', 'complete']);
    session.stop();
    expect(states()).toEqual(['lost', 'lost', 'lost', 'complete']);
  });

  it('pushes its mock rules to a v7 link once verified and tracks what the SDK applied', async () => {
    const { session, connect, messages } = await setup();
    expect(session.networkMocks).toEqual(EMPTY_MOCKS);
    const rule = session.setNetworkMock(mockInput(), 'user');
    expect(mockStates(messages).at(-1)).toEqual({ rules: [rule], rev: 1, appliedRev: null });

    const pendingLink = new FakeLink(7);
    const handler: SdkLinkHandler = session.attachSdk(V7_HELLO, pendingLink);
    expect(pendingLink.mockSets).toEqual([]); // not before its PID checked out
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingLink.mockSets).toEqual([{ rev: 1, rules: [rule] }]);
    handler.onMessage({ type: 'mocksApplied', rev: 1, count: 1 });
    expect(mockStates(messages).at(-1)).toEqual({ rules: [rule], rev: 1, appliedRev: 1 });

    expect(session.clearNetworkMocks('m7')).toBe(false);
    expect(session.clearNetworkMocks()).toBe(true);
    expect(pendingLink.mockSets.at(-1)).toEqual({ rev: 2, rules: [] });
    handler.onClose();
    expect(session.networkMocks.appliedRev).toBeNull();

    // A link below v7 gets nothing.
    session.setNetworkMock(mockInput(), 'agent');
    const old = await connect({ ...HELLO, protocolVersion: 5 });
    expect(old.link.mockSets).toEqual([]);
    expect(session.networkMocks.appliedRev).toBeNull();

    session.stop();
    expect(mockStates(messages).at(-1)).toEqual({ rules: [], rev: 4, appliedRev: null });
    expect(() => session.setNetworkMock(mockInput(), 'user')).toThrow(NO_SESSION_MOCKS_MESSAGE);
  });
});

describe('SessionManager mock rules', () => {
  function managerSetup() {
    const device = new FakeDevice();
    const adb = new FakeAdb(
      (args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : ''),
      (command) => device.handle(command),
    );
    const messages: ServerMessage[] = [];
    const manager = new SessionManager({ adb, broadcast: (message) => messages.push(message) });
    return { manager, messages };
  }

  it('refuses rules without a session, clears them on stop and starts every session without any', async () => {
    const { manager, messages } = managerSetup();
    expect(() => manager.setNetworkMock(mockInput(), 'user')).toThrow(NO_SESSION_MOCKS_MESSAGE);
    expect(manager.clearNetworkMocks()).toBe(false);
    expect(manager.getNetworkMocks()).toEqual(EMPTY_MOCKS);
    expect(manager.getHttpExchange(1)).toBeNull();

    await manager.startSession('emulator-5554', HELLO.packageName);
    expect(mockStates(messages)).toEqual([EMPTY_MOCKS]);
    manager.setNetworkMock(mockInput(), 'user');
    expect(manager.getNetworkMocks().rules).toHaveLength(1);

    await manager.startSession('emulator-5554', HELLO.packageName);
    // The old session's rules went with it (an empty set announced), and the new one starts without any.
    expect(mockStates(messages).slice(-2)).toEqual([{ rules: [], rev: 2, appliedRev: null }, EMPTY_MOCKS]);
    manager.setNetworkMock(mockInput(), 'user');
    await manager.stopSession();
    expect(manager.getNetworkMocks().rules).toEqual([]);
    expect(() => manager.setNetworkMock(mockInput(), 'user')).toThrow(NO_SESSION_MOCKS_MESSAGE);
    await manager.close();
  });
});

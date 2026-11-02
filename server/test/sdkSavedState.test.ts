import { DEVICE_PROTOCOL_V10, LARGE_SAVED_STATE_BYTES } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkLinkMessage } from '../src/device/sdkLink.ts';
import { deviceNow, FakeLink, HELLO, setupSdkSession as setup, START } from './helpers/sdkSession.ts';

const HELLO_V10 = { ...HELLO, protocolVersion: DEVICE_PROTOCOL_V10, sdkVersion: '0.12.0' };
type SavedState = Extract<SdkLinkMessage, { type: 'savedState' }>;

function savedState(agoMs: number, totalBytes: number): SavedState {
  return {
    type: 'savedState',
    ts: deviceNow() - agoMs,
    activity: 'com.example.shop.ui.orders.OrdersActivity',
    screen: 'orders',
    hook: 'post_save',
    totalBytes,
    measureMs: 0.4,
    breakdownMs: totalBytes >= LARGE_SAVED_STATE_BYTES ? 3.1 : null,
    entries:
      totalBytes >= LARGE_SAVED_STATE_BYTES
        ? [
            {
              path: [
                'androidx.lifecycle.BundlableSavedStateRegistry.key',
                'android:support:fragments',
                'fragment_a1',
              ],
              bytes: totalBytes - 1000,
              kind: 'fragment',
              fragment: 'com.example.shop.ui.orders.OrderListFragment',
              valueClass: 'android.os.Bundle',
            },
          ]
        : [],
    truncated: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProfilingSession SDK saved states', () => {
  it('stores each report on the laptop clock and marks the large ones on the timeline', async () => {
    const { session, connect, ofType } = await setup();
    const { handler } = await connect(HELLO_V10);
    await vi.advanceTimersByTimeAsync(1000);
    handler.onMessage(savedState(100, 12_000));
    handler.onMessage(savedState(50, 440_060));
    const snapshot = session.snapshot();
    expect((snapshot.savedStates ?? []).map((sample) => sample.totalBytes)).toEqual([12_000, 440_060]);
    expect(snapshot.savedStates?.[1]).toMatchObject({
      ts: Date.now() - 50,
      activity: 'com.example.shop.ui.orders.OrdersActivity',
      hook: 'post_save',
      entries: [
        expect.objectContaining({
          kind: 'fragment',
          fragment: 'com.example.shop.ui.orders.OrderListFragment',
        }),
      ],
    });
    expect(ofType('savedState')).toHaveLength(2);
    expect(snapshot.events).toEqual([
      {
        ts: Date.now() - 50,
        kind: 'saved_state',
        pid: HELLO.pid,
        source: 'sdk',
        detail: 'orders 440060 bytes',
      },
    ]);
  });

  it('redacts credential-looking keys before storing or sending them, and keeps plain key names', async () => {
    const { session, connect, ofType } = await setup();
    const { handler } = await connect(HELLO_V10);
    await vi.advanceTimersByTimeAsync(1000);
    const report = savedState(50, 440_060);
    const path = [
      'https://api.example.test/v1/items?page=2&token=synthetic-secret-1',
      'cache auth_token=synthetic-secret-2',
      'token',
      'password',
      'fragment_a1',
    ];
    handler.onMessage({ ...report, entries: [{ ...report.entries[0]!, path }] });
    const expected = [
      'https://api.example.test/v1/items?page=2&token=‹redacted›',
      'cache auth_token=‹redacted›',
      'token',
      'password',
      'fragment_a1',
    ];
    expect(session.snapshot().savedStates?.[0]?.entries[0]?.path).toEqual(expected);
    expect(JSON.stringify(ofType('savedState'))).not.toContain('synthetic-secret');
    expect(JSON.stringify(session.snapshot())).not.toContain('synthetic-secret');
  });

  it('drops a report from a clock far off, like other SDK events', async () => {
    const { session, connect } = await setup();
    const { handler } = await connect(HELLO_V10);
    await vi.advanceTimersByTimeAsync(1000);
    handler.onMessage(savedState(10 * 60_000, 440_060));
    expect(session.snapshot().savedStates).toEqual([]);
  });

  it('joins a report with a TransactionTooLarge failure of the same process', async () => {
    const { session, connect } = await setup();
    const { handler } = await connect(HELLO_V10);
    await vi.advanceTimersByTimeAsync(1000);
    handler.onMessage(savedState(5, 583_420));
    session['store'].transactions.addLogs([
      {
        ts: Date.now(),
        pid: HELLO.pid,
        tid: HELLO.pid,
        level: 'E',
        tag: 'JavaBinder',
        message: '!!! FAILED BINDER TRANSACTION !!!  (parcel size = 583524)',
      },
    ]);
    expect(session.transactionFailures()).toEqual([
      expect.objectContaining({
        pid: HELLO.pid,
        parcelBytes: 583_524,
        savedState: {
          ts: Date.now() - 5,
          activity: 'com.example.shop.ui.orders.OrdersActivity',
          totalBytes: 583_420,
          instanceId: null,
        },
      }),
    ]);
    expect(session.snapshot().events.map((event) => event.kind)).toEqual([
      'saved_state',
      'transaction_too_large',
    ]);
  });

  describe('instances (liveActivities)', () => {
    type Live = Extract<SdkLinkMessage, { type: 'liveActivities' }>;
    const list = (ids: number[], agoMs = 0, truncated = false): Live => ({
      type: 'liveActivities',
      ts: deviceNow() - agoMs,
      activities: ids.map((id) => ({
        id,
        activity: 'com.example.shop.ui.orders.OrdersActivity',
        prevId: null,
      })),
      truncated,
    });
    const states = (session: {
      snapshot: () => { savedStateInstances?: { pid: number; id: number; state: string }[] };
    }) =>
      (session.snapshot().savedStateInstances ?? []).map((instance) => [
        `${instance.pid}:${instance.id}`,
        instance.state,
      ]);

    it('ties each report to its process and instance, and makes an unknown instance live', async () => {
      const { session, connect } = await setup();
      const { handler } = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(1000);
      handler.onMessage({ ...savedState(5, 12_000), instanceId: 3 });
      handler.onMessage(savedState(4, 12_000)); // a pre-release SDK: no instanceId
      expect(session.snapshot().savedStates?.map((sample) => [sample.pid, sample.instanceId])).toEqual([
        [HELLO.pid, 3],
        [HELLO.pid, null],
      ]);
      expect(states(session)).toEqual([[`${HELLO.pid}:3`, 'live']]);
    });

    it('keeps the newest list a pending link sent, whatever else it held, and applies it once verified (E-12)', async () => {
      const { session, device } = await setup();
      const original = device.handle.bind(device);
      device.handle = (command) =>
        command.startsWith('pidof') ? { output: `${HELLO.pid}\n`, delayMs: 1000 } : original(command);
      const link = new FakeLink(DEVICE_PROTOCOL_V10);
      const handler = session.attachSdk(HELLO_V10, link); // its PID check takes a second
      handler.onMessage(list([1, 2], 30));
      for (let i = 0; i < 20; i += 1)
        handler.onMessage({ type: 'heartbeat', ts: deviceNow(), droppedMessages: 0 });
      handler.onMessage(list([2], 10));
      expect(states(session)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.state.sdk?.connected).toBe(true);
      expect(states(session)).toEqual([[`${HELLO.pid}:2`, 'live']]);
    });

    it('closes what a list after a reconnect leaves out (E-04)', async () => {
      const { session, connect } = await setup();
      const first = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(1000);
      first.handler.onMessage(list([1, 2]));
      first.handler.onClose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(states(session)).toEqual([
        [`${HELLO.pid}:1`, 'live'],
        [`${HELLO.pid}:2`, 'live'],
      ]);
      const second = await connect(HELLO_V10);
      second.handler.onMessage(list([1]));
      expect(states(session)).toEqual([
        [`${HELLO.pid}:1`, 'live'],
        [`${HELLO.pid}:2`, 'closed'],
      ]);
      expect(session.snapshot().savedStateInstances?.[1]?.closedAt).toBe(Date.now());
    });

    it('ends the old process instances when a link of a new process goes live (E-03a)', async () => {
      const { session, connect, device } = await setup();
      const first = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(1000);
      first.handler.onMessage(list([1]));
      device.pid = 2000;
      await connect({ ...HELLO_V10, pid: 2000 });
      expect(states(session)).toContainEqual([`${HELLO.pid}:1`, 'process_ended']);
    });

    it.each([
      ['died', (device: { pid: number | null; startTime: number }) => void (device.pid = null)],
      ['reused', (device: { pid: number | null; startTime: number }) => void (device.startTime = 99_999)],
    ])('ends the instances of a process that %s (E-03b)', async (_, change) => {
      const { session, connect, device, ofType } = await setup();
      const { handler } = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(2000);
      handler.onMessage(list([1, 2]));
      change(device);
      await vi.advanceTimersByTimeAsync(2000);
      expect(states(session)).toEqual([
        [`${HELLO.pid}:1`, 'process_ended'],
        [`${HELLO.pid}:2`, 'process_ended'],
      ]);
      // Announced once each, however many triggers.
      await vi.advanceTimersByTimeAsync(2000);
      const ended = ofType('savedStateInstance').filter(
        (message) => message.instance.state === 'process_ended',
      );
      expect(ended).toHaveLength(2);
    });

    it('keeps a failure report after the savedStates window let it go (E-11)', async () => {
      const { session, connect } = await setup();
      const { handler } = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(1000);
      handler.onMessage({ ...savedState(5, 583_420), instanceId: 1 });
      session['store'].transactions.addLogs([
        {
          ts: Date.now(),
          pid: HELLO.pid,
          tid: HELLO.pid,
          level: 'E',
          tag: 'JavaBinder',
          message: '!!! FAILED BINDER TRANSACTION !!!  (parcel size = 583524)',
        },
      ]);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(session.snapshot().savedStates).toEqual([]);
      const [failure] = session.transactionFailures();
      expect(failure?.savedState).toMatchObject({ totalBytes: 583_420, instanceId: 1 });
      expect(failure?.report).toMatchObject({ totalBytes: 583_420, instanceId: 1, pid: HELLO.pid });
      expect(failure?.report?.entries[0]?.fragment).toBe('com.example.shop.ui.orders.OrderListFragment');
    });

    it('keeps the instances as the stop left them, closed and ended ones included, past the window (V8)', async () => {
      const { session, connect, device } = await setup();
      const { handler } = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(2000);
      handler.onMessage(list([1, 2, 3]));
      handler.onMessage(list([1, 3]));
      device.pid = null;
      await vi.advanceTimersByTimeAsync(2000);
      expect(states(session)).toEqual([
        [`${HELLO.pid}:1`, 'process_ended'],
        [`${HELLO.pid}:2`, 'closed'],
        [`${HELLO.pid}:3`, 'process_ended'],
      ]);
      session.stop();
      const stopped = session.snapshot().savedStateInstances;
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(session.state.status).toBe('idle');
      expect(session.snapshot().savedStateInstances).toEqual(stopped);
    });

    it('still lets closed instances go after the window while the session runs, never live ones', async () => {
      const { session, connect } = await setup();
      const { handler } = await connect(HELLO_V10);
      await vi.advanceTimersByTimeAsync(1000);
      handler.onMessage(list([1, 2]));
      handler.onMessage(list([1]));
      expect(states(session)).toEqual([
        [`${HELLO.pid}:1`, 'live'],
        [`${HELLO.pid}:2`, 'closed'],
      ]);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(session.state.status).toBe('running');
      expect(states(session)).toEqual([[`${HELLO.pid}:1`, 'live']]);
      session.stop();
    });
  });
});

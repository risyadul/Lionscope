import { DEFAULT_SDK_OPTIONS, DEVICE_PROTOCOL_V10 } from '@lionscope/protocol';
import type { SavedStateSample, TransactionFailure } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { callTool } from '../src/agent/registry.ts';
import type { ToolOutcome } from '../src/agent/registry.ts';
import { DISCONNECTED_SDK } from '../src/device/sdkBridge.ts';
import type { AppCrash } from '../src/store/crashLog.ts';
import { fakeAgent, PKG, RUNNING, T0 } from './helpers/agentFixtures.ts';
import type { FakeAgent, Json } from './helpers/agentFixtures.ts';

async function run(agent: FakeAgent, name: string, args: unknown = {}) {
  const outcome: ToolOutcome = await callTool(agent.ctx, name, args, false);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.result as Json;
}

const ROOT = 'androidx.lifecycle.BundlableSavedStateRegistry.key';

function report(ts: number, totalBytes: number): SavedStateSample {
  return {
    ts,
    activity: `${PKG}.ui.orders.OrdersActivity`,
    pid: 4321,
    instanceId: null,
    screen: 'orders',
    hook: 'post_save',
    totalBytes,
    measureMs: 0.42,
    breakdownMs: 3.14,
    entries: [
      {
        path: [ROOT],
        bytes: totalBytes - 120_000,
        kind: 'bundle',
        fragment: null,
        valueClass: 'android.os.Bundle',
      },
      {
        path: [ROOT, 'android:support:fragments', 'fragment_a1'],
        bytes: totalBytes - 130_000,
        kind: 'fragment',
        fragment: `${PKG}.ui.orders.OrdersPagerFragment`,
        valueClass: 'android.os.Bundle',
      },
      {
        path: [ROOT, 'android:support:fragments', 'fragment_a1', 'childFragmentManager', 'fragment_b2'],
        bytes: totalBytes - 240_000,
        kind: 'fragment',
        fragment: `${PKG}.ui.orders.OrderListFragment`,
        valueClass: 'android.os.Bundle',
      },
      { path: ['late_payload'], bytes: 122_900, kind: 'value', fragment: null, valueClass: 'byte[]' },
    ],
    truncated: false,
  };
}

const FAILURE: TransactionFailure = {
  id: 1,
  ts: T0 + 20_000,
  pid: 4321,
  parcelBytes: 583_524,
  binderLine: true,
  crashed: true,
  transaction: 'IActivityManager.activityStopped',
  screen: null,
  savedState: {
    ts: T0 + 19_990,
    activity: `${PKG}.ui.orders.OrdersActivity`,
    totalBytes: 583_420,
    instanceId: null,
  },
  report: null,
};

const SDK_V10 = {
  ...RUNNING,
  sdk: {
    ...DISCONNECTED_SDK,
    connected: true,
    protocolVersion: DEVICE_PROTOCOL_V10,
    options: DEFAULT_SDK_OPTIONS,
  },
};

describe('get_saved_state', () => {
  it('lists failures and the largest reports with their nested fragments and keys', async () => {
    const agent = fakeAgent(
      { savedStates: [report(T0 + 1000, 90_000), report(T0 + 19_990, 583_420)] },
      {
        session: SDK_V10,
      },
    );
    agent.transactionFailures = [FAILURE];
    const result = await run(agent, 'get_saved_state', { limit: 1, entries: 3 });
    expect(result.sdk).toEqual({ connected: true, measuring: true, savedStateTracking: true });
    expect(result.note).toBeUndefined();
    expect(result.transactionFailures).toEqual([
      {
        time: new Date(T0 + 20_000).toISOString(),
        pid: 4321,
        parcelBytes: 583_524,
        transaction: 'IActivityManager.activityStopped',
        crashed: true,
        binderLine: true,
        screen: null,
        savedState: {
          time: new Date(T0 + 19_990).toISOString(),
          activity: `${PKG}.ui.orders.OrdersActivity`,
          totalBytes: 583_420,
          sdkInstanceId: null,
        },
        report: null,
      },
    ]);
    expect(result.savedStateReports).toBe(2);
    expect(result.largestBytes).toBe(583_420);
    const [largest] = result.savedStates;
    expect(largest).toMatchObject({
      totalBytes: 583_420,
      hook: 'post_save',
      measureMs: 0.42,
      breakdownMs: 3.14,
    });
    expect(largest.fragments).toEqual([
      {
        fragment: `${PKG}.ui.orders.OrdersPagerFragment`,
        instances: 1,
        bytes: 453_420,
        largestBytes: 453_420,
        depth: 3,
      },
      {
        fragment: `${PKG}.ui.orders.OrderListFragment`,
        instances: 1,
        bytes: 343_420,
        largestBytes: 343_420,
        depth: 5,
      },
    ]);
    expect(largest.top).toHaveLength(3);
    expect(largest.top[2]).toMatchObject({
      path: `${ROOT} › android:support:fragments › fragment_a1 › childFragmentManager › fragment_b2`,
      kind: 'fragment',
    });
    expect(largest.truncated).toBe(true);
  });

  it('counts a nested fragment of its parent fragment class as another instance', async () => {
    const recursive = `${PKG}.ui.RecursiveFragment`;
    const sample: SavedStateSample = {
      ...report(T0 + 1000, 300_000),
      entries: [
        {
          path: ['android:support:fragments', 'fragment_p'],
          bytes: 200_000,
          kind: 'fragment',
          fragment: recursive,
          valueClass: 'android.os.Bundle',
        },
        {
          path: ['android:support:fragments', 'fragment_p', 'childFragmentManager', 'fragment_c'],
          bytes: 150_000,
          kind: 'fragment',
          fragment: recursive,
          valueClass: 'android.os.Bundle',
        },
        {
          path: ['android:support:fragments', 'fragment_p', 'childFragmentManager', 'fragment_c', 'state'],
          bytes: 2_000,
          kind: 'bundle',
          fragment: recursive,
          valueClass: 'androidx.fragment.app.FragmentState',
        },
      ],
    };
    const agent = fakeAgent({ savedStates: [sample] }, { session: SDK_V10 });
    const [largest] = (await run(agent, 'get_saved_state')).savedStates;
    expect(largest.fragments).toEqual([
      { fragment: recursive, instances: 2, bytes: 350_000, largestBytes: 200_000, depth: 2 },
    ]);
  });

  it('still reports failures from logcat without the SDK, and says what is not measured', async () => {
    const agent = fakeAgent();
    agent.transactionFailures = [{ ...FAILURE, savedState: null }];
    const result = await run(agent, 'get_saved_state');
    expect(result.sdk).toMatchObject({ connected: false, measuring: false });
    expect(result.note).toContain('transactionFailures (from logcat) still are');
    expect(result.transactionFailures).toHaveLength(1);
    expect(result.savedStates).toEqual([]);
  });

  it('measures only with a v10 SDK whose saved-state tracking is on', async () => {
    const reports = { savedStates: [report(T0 + 1000, 90_000)] };
    const off = fakeAgent(reports, {
      session: {
        ...SDK_V10,
        sdk: { ...SDK_V10.sdk, options: { ...DEFAULT_SDK_OPTIONS, savedStateTracking: false } },
      },
    });
    off.transactionFailures = [FAILURE];
    const offResult = await run(off, 'get_saved_state');
    expect(offResult.sdk).toEqual({ connected: true, measuring: false, savedStateTracking: false });
    expect(offResult.note).toContain('Saved-state tracking is off');
    // Reports measured before it was turned off, and failures from logcat, are still listed.
    expect(offResult.savedStateReports).toBe(1);
    expect(offResult.transactionFailures).toHaveLength(1);

    const on = fakeAgent(reports, {
      session: {
        ...SDK_V10,
        sdk: { ...SDK_V10.sdk, options: { ...DEFAULT_SDK_OPTIONS, savedStateTracking: true } },
      },
    });
    const onResult = await run(on, 'get_saved_state');
    expect(onResult.sdk).toEqual({ connected: true, measuring: true, savedStateTracking: true });
    expect(onResult.note).toBeUndefined();

    // An SDK older than 0.12.0 (v9) cannot measure, whatever the option says.
    const old = fakeAgent(
      {},
      { session: { ...SDK_V10, sdk: { ...SDK_V10.sdk, protocolVersion: DEVICE_PROTOCOL_V10 - 1 } } },
    );
    const oldResult = await run(old, 'get_saved_state');
    expect(oldResult.sdk).toEqual({ connected: true, measuring: false, savedStateTracking: true });
    expect(oldResult.note).toContain('No in-app SDK (0.12.0+) is connected');

    const gone = fakeAgent({}, { session: { ...SDK_V10, sdk: { ...SDK_V10.sdk, connected: false } } });
    const goneResult = await run(gone, 'get_saved_state');
    expect(goneResult.sdk).toEqual({ connected: false, measuring: false, savedStateTracking: true });
    expect(goneResult.note).toContain('No in-app SDK (0.12.0+) is connected');
  });

  it('filters by time and size', async () => {
    const agent = fakeAgent(
      { savedStates: [report(T0 + 1000, 90_000), report(T0 + 19_990, 583_420)] },
      {
        session: SDK_V10,
      },
    );
    agent.transactionFailures = [FAILURE];
    const later = await run(agent, 'get_saved_state', { since: new Date(T0 + 30_000).toISOString() });
    expect(later).toMatchObject({ savedStateReports: 0, transactionFailures: [] });
    const big = await run(agent, 'get_saved_state', { minBytes: 100_000 });
    expect(big.savedStateReports).toBe(1);
  });
});

describe('get_crashes on a TransactionTooLargeException', () => {
  it('names the parcel size and the failed call', async () => {
    const agent = fakeAgent();
    const crash: AppCrash = {
      ts: T0 + 20_000,
      pid: 4321,
      tid: 4321,
      kind: 'java',
      thread: 'main',
      process: PKG,
      exception: 'java.lang.RuntimeException',
      message: 'android.os.TransactionTooLargeException: data parcel size 583524 bytes',
      stack: [
        '\tat android.app.servertransaction.PendingTransactionActions$StopInfo.run(PendingTransactionActions.java:160)',
        'Caused by: android.os.TransactionTooLargeException: data parcel size 583524 bytes',
        '\tat android.app.IActivityManager$Stub$Proxy.activityStopped(IActivityManager.java:4027)',
      ],
      droppedLines: 0,
    };
    agent.crashes = [crash, { ...crash, ts: T0 + 30_000, message: 'boom', stack: [] }];
    const result = await run(agent, 'get_crashes');
    expect(result.crashes[0].transactionTooLarge).toEqual({
      parcelBytes: 583_524,
      transaction: 'IActivityManager.activityStopped',
    });
    expect(result.crashes[1]).not.toHaveProperty('transactionTooLarge');
  });
});

describe('get_saved_state: instances and failure reports', () => {
  it('keeps the pairing report of a failure, with the instance and process', async () => {
    const paired = { ...report(T0 + 19_990, 583_420), instanceId: 2 };
    const agent = fakeAgent({ savedStates: [] }, { session: SDK_V10 });
    agent.transactionFailures = [
      {
        ...FAILURE,
        savedState: { ...FAILURE.savedState!, instanceId: 2 },
        report: paired,
      },
    ];
    const result = await run(agent, 'get_saved_state', { entries: 2 });
    const [failure] = result.transactionFailures;
    expect(failure.savedState.sdkInstanceId).toBe(2);
    expect(failure.report).toMatchObject({ pid: 4321, sdkInstanceId: 2, totalBytes: 583_420 });
    expect(failure.report.top).toHaveLength(2);
    expect(result.savedStates).toEqual([]);
  });

  it('lists instances: live first, then by their last save, a rotated one as one chain (E-01, E-07)', async () => {
    const at = (ms: number) => T0 + ms;
    const instance = (
      id: number,
      state: 'live' | 'closed',
      prevId: number | null = null,
      closedAt: number | null = null,
    ) => ({
      pid: 4321,
      id,
      activity: `${PKG}.ui.orders.OrdersActivity`,
      prevId,
      firstSeen: at(id),
      state,
      closedAt,
    });
    const saved = (ts: number, instanceId: number, totalBytes: number) => ({
      ...report(ts, totalBytes),
      instanceId,
    });
    const agent = fakeAgent(
      {
        savedStates: [saved(at(1000), 1, 125_000), saved(at(2000), 2, 163_000), saved(at(3000), 4, 900_000)],
        savedStateInstances: [
          instance(1, 'closed', null, at(1500)),
          instance(2, 'live', 1),
          instance(3, 'live'),
          instance(4, 'closed', null, at(3500)),
        ],
      },
      { session: SDK_V10 },
    );
    const result = await run(agent, 'get_saved_state', {});
    expect(result.instances).toEqual([
      {
        activity: `${PKG}.ui.orders.OrdersActivity`,
        screen: 'orders',
        pid: 4321,
        sdkInstanceIds: [2, 1],
        state: 'live',
        saves: 2,
        firstBytes: 125_000,
        lastBytes: 163_000,
        maxBytes: 163_000,
        lastTime: new Date(at(2000)).toISOString(),
      },
      expect.objectContaining({
        sdkInstanceIds: [3],
        state: 'live',
        saves: 0,
        lastBytes: null,
        lastTime: null,
      }),
      expect.objectContaining({ sdkInstanceIds: [4], state: 'closed', saves: 1, lastBytes: 900_000 }),
    ]);
    expect(result.savedStates[0]).toMatchObject({ pid: 4321, sdkInstanceId: 4 });
  });

  it('has no instances and null ids from a pre-release SDK (E-13)', async () => {
    const agent = fakeAgent({ savedStates: [report(T0 + 1000, 90_000)] }, { session: SDK_V10 });
    const result = await run(agent, 'get_saved_state', {});
    expect(result.instances).toEqual([]);
    expect(result.savedStates[0]).toMatchObject({ pid: 4321, sdkInstanceId: null });
  });
});

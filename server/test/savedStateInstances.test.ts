import { MAX_SAVED_STATE_INSTANCES } from '@lionscope/protocol';
import type { SavedStateInstance, ServerMessage } from '@lionscope/protocol';
import { chainTrend, instanceChains } from '@lionscope/protocol/insights';
import { describe, expect, it } from 'vitest';
import { SavedStateInstances } from '../src/store/savedStateInstances.ts';

const T0 = 1_800_000_000_000;
const WINDOW_MS = 10 * 60_000;
const MAIN = 'com.example.MainActivity';
const ORDERS = 'com.example.OrdersActivity';

function setup() {
  let now = T0;
  const messages: ServerMessage[] = [];
  const instances = new SavedStateInstances({
    windowMs: WINDOW_MS,
    emit: (message) => messages.push(message),
    now: () => now,
  });
  const emitted = () =>
    messages.flatMap((message) => (message.type === 'savedStateInstance' ? [message.instance] : []));
  const states = () => instances.list().map((instance) => [`${instance.pid}:${instance.id}`, instance.state]);
  return {
    instances,
    emitted,
    states,
    clock: {
      set: (ms: number) => {
        now = ms;
      },
    },
  };
}

const entry = (id: number, activity = MAIN, prevId: number | null = null) => ({ id, activity, prevId });

describe('SavedStateInstances', () => {
  it('chains a configuration change: the old instance closes, the new one is live with prevId (E-01)', () => {
    const { instances, emitted } = setup();
    instances.reconcile(100, T0, [entry(1, ORDERS)], false);
    instances.reconcile(100, T0 + 500, [entry(2, ORDERS, 1)], false);
    expect(instances.list()).toEqual([
      { pid: 100, id: 1, activity: ORDERS, prevId: null, firstSeen: T0, state: 'closed', closedAt: T0 + 500 },
      { pid: 100, id: 2, activity: ORDERS, prevId: 1, firstSeen: T0 + 500, state: 'live', closedAt: null },
    ]);
    expect(emitted()).toHaveLength(3);
    // One chain whose trend joins both instances' saves.
    const [chain, ...others] = instanceChains(instances.list());
    expect(others).toEqual([]);
    expect(chain?.instances.map((instance) => instance.id)).toEqual([2, 1]);
    const report = (ts: number, instanceId: number, totalBytes: number) => ({
      ts,
      activity: ORDERS,
      pid: 100,
      instanceId,
      screen: null,
      hook: 'post_save' as const,
      totalBytes,
      measureMs: 0.1,
      breakdownMs: null,
      entries: [],
      truncated: false,
    });
    const reports = [report(T0 + 100, 1, 125_000), report(T0 + 900, 2, 163_000), report(T0 + 950, 9, 1)];
    expect(chainTrend(chain!, reports, T0, T0 + 1000)).toEqual({
      saves: 2,
      firstBytes: 125_000,
      lastBytes: 163_000,
      maxBytes: 163_000,
      lastTs: T0 + 900,
    });
  });

  it('closes a finished instance at the list time and keeps the rest of the process live (E-02)', () => {
    const { instances, states } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2, ORDERS)], false);
    instances.reconcile(100, T0 + 700, [entry(1)], false);
    expect(states()).toEqual([
      ['100:1', 'live'],
      ['100:2', 'closed'],
    ]);
    expect(instances.list()[1]?.closedAt).toBe(T0 + 700);
  });

  it('reconciles per process: another process list closes nothing here (E-05)', () => {
    const { instances, states } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2)], false);
    instances.reconcile(200, T0 + 10, [entry(1)], false);
    expect(states()).toEqual([
      ['100:1', 'live'],
      ['100:2', 'live'],
      ['200:1', 'live'],
    ]);
    instances.reconcile(100, T0 + 20, [entry(2)], false);
    expect(states()).toEqual([
      ['100:1', 'closed'],
      ['100:2', 'live'],
      ['200:1', 'live'],
    ]);
  });

  it('ends a process once, and never reopens what ended (E-03)', () => {
    const { instances, emitted, states } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2)], false);
    instances.reconcile(100, T0 + 5, [entry(2)], false);
    const before = emitted().length;
    instances.endProcess(100, T0 + 10);
    instances.endProcess(100, T0 + 20);
    instances.endOtherProcesses(200, T0 + 30);
    expect(emitted().length).toBe(before + 1);
    expect(states()).toEqual([
      ['100:1', 'closed'],
      ['100:2', 'process_ended'],
    ]);
    // A list naming the same ids: of pid 100 it reopens nothing, of a new pid it is a new key.
    instances.reconcile(100, T0 + 40, [entry(1), entry(2)], false);
    expect(states()).toEqual([
      ['100:1', 'live'],
      ['100:2', 'process_ended'],
    ]);
    instances.reconcile(300, T0 + 50, [entry(2)], false);
    expect(states()).toContainEqual(['300:2', 'live']);
    instances.endOtherProcesses(300, T0 + 60);
    expect(states()).toEqual([
      ['100:1', 'process_ended'],
      ['100:2', 'process_ended'],
      ['300:2', 'live'],
    ]);
  });

  it('announces nothing for a list it already knows (E-09)', () => {
    const { instances, emitted } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2, ORDERS, 1)], false);
    const count = emitted().length;
    instances.reconcile(100, T0 + 250, [entry(1), entry(2, ORDERS, 1)], false);
    expect(emitted()).toHaveLength(count);
  });

  it('closes nothing on a truncated list (E-10)', () => {
    const { instances, states } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2)], false);
    instances.reconcile(100, T0 + 10, [entry(2), entry(3)], true);
    expect(states()).toEqual([
      ['100:1', 'live'],
      ['100:2', 'live'],
      ['100:3', 'live'],
    ]);
  });

  it('takes a report of an unknown instance as live, and leaves a closed one closed (E-15)', () => {
    const { instances, emitted, states } = setup();
    instances.noteReport(100, 4, ORDERS, T0);
    expect(instances.list()).toEqual([
      { pid: 100, id: 4, activity: ORDERS, prevId: null, firstSeen: T0, state: 'live', closedAt: null },
    ]);
    instances.reconcile(100, T0 + 10, [], false);
    const count = emitted().length;
    instances.noteReport(100, 4, ORDERS, T0 + 20);
    expect(states()).toEqual([['100:4', 'closed']]);
    expect(emitted()).toHaveLength(count);
    // The list corrects what a report assumed, and sets prevId once (never back to null).
    instances.reconcile(100, T0 + 30, [entry(4, MAIN, 2)], false);
    instances.reconcile(100, T0 + 40, [entry(4, MAIN, null)], false);
    expect(instances.list()[0]).toMatchObject({ activity: MAIN, prevId: 2, state: 'live', closedAt: null });
  });

  it('drops closed instances after the window and the longest closed beyond the cap, never live ones (V7)', () => {
    const { instances, clock } = setup();
    instances.reconcile(100, T0, [entry(1), entry(2)], false);
    instances.reconcile(100, T0 + 1000, [entry(1)], false);
    clock.set(T0 + 1000 + WINDOW_MS + 1);
    expect(instances.list().map((instance) => instance.id)).toEqual([1]);

    const live = Array.from({ length: 10 }, (_, i) => entry(i + 1));
    const closing = Array.from({ length: MAX_SAVED_STATE_INSTANCES }, (_, i) => entry(i + 1000));
    const at = T0 + WINDOW_MS + 2000;
    instances.reconcile(200, at, [...live, ...closing], false);
    // Closed one by one: the earliest closed go first.
    for (const [index] of closing.entries()) {
      instances.reconcile(200, at + index + 1, [...live, ...closing.slice(index + 1)], false);
    }
    const kept: SavedStateInstance[] = instances.list();
    expect(kept).toHaveLength(MAX_SAVED_STATE_INSTANCES);
    expect(kept.filter((instance) => instance.state === 'live')).toHaveLength(11);
    expect(kept.some((instance) => instance.id === 1000)).toBe(false);
    expect(kept.some((instance) => instance.id === 1000 + MAX_SAVED_STATE_INSTANCES - 1)).toBe(true);
  });
});

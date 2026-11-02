import { describe, expect, it } from 'vitest';
import { instanceChains, savedStateChainRows, sortChainRows } from '../src/insights/index.ts';
import type { SavedStateInstance, SavedStateSample } from '../src/wire.ts';

const T0 = 1_800_000_000_000;

const instance = (
  pid: number,
  id: number,
  prevId: number | null = null,
  state: SavedStateInstance['state'] = 'live',
  closedAt: number | null = null,
): SavedStateInstance => ({
  pid,
  id,
  activity: 'com.example.MainActivity',
  prevId,
  firstSeen: T0 + id,
  state,
  closedAt,
});

const report = (
  pid: number,
  instanceId: number | null,
  ts: number,
  totalBytes: number,
): SavedStateSample => ({
  ts,
  activity: 'com.example.MainActivity',
  pid,
  instanceId,
  screen: `screen-${instanceId}`,
  hook: 'post_save',
  totalBytes,
  measureMs: 0.1,
  breakdownMs: null,
  entries: [],
  truncated: false,
});

describe('saved-state chains', () => {
  it('joins instances by prevId within a process only, newest first, and survives a loop', () => {
    const chains = instanceChains([
      instance(1, 1),
      instance(1, 2, 1),
      instance(1, 3, 2),
      instance(2, 4, 3), // another process: its prevId 3 is not process 1's #3
      instance(1, 7, 8),
      instance(1, 8, 7), // a loop (never sent by the SDK) neither hangs nor repeats
    ]);
    expect(chains.map((chain) => [chain.pid, chain.instances.map((known) => known.id)])).toEqual([
      [1, [3, 2, 1]],
      [2, [4]],
    ]);
  });

  it('lists live chains and the closed ones that closed or saved in the range', () => {
    const instances = [
      instance(1, 1, null, 'closed', T0 + 100),
      instance(1, 2),
      instance(1, 3, null, 'closed', T0 - 5000),
      instance(1, 4, null, 'process_ended', T0 - 5000),
    ];
    const reports = [report(1, 4, T0 + 10, 50), report(1, 2, T0 + 20, 70), report(1, null, T0 + 30, 999)];
    const rows = savedStateChainRows(instances, reports, T0, T0 + 1000);
    expect(rows.map((row) => [row.chain.head.id, row.saves, row.screen])).toEqual([
      [1, 0, null],
      [2, 1, 'screen-2'],
      [4, 1, 'screen-4'],
    ]);
  });

  it('orders by the last save (largest or latest), rows without a save last', () => {
    const instances = [instance(1, 1), instance(1, 2), instance(1, 3)];
    const reports = [report(1, 1, T0 + 10, 900), report(1, 3, T0 + 20, 100)];
    const rows = savedStateChainRows(instances, reports, T0, T0 + 1000);
    const ids = (order: 'largest' | 'latest') => sortChainRows(rows, order).map((row) => row.chain.head.id);
    expect(ids('largest')).toEqual([1, 3, 2]);
    expect(ids('latest')).toEqual([3, 1, 2]);
  });
});

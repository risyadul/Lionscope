/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SavedStateEntry,
  SavedStateSample,
  ServerMessage,
  Snapshot,
  TransactionFailure,
} from '@lionscope/protocol/wire';
import { SavedStatePanel } from '../src/components/savedState/SavedStatePanel.tsx';
import { eventLabel } from '../src/components/timeline/marks.ts';
import { entryRows, formatBytes, reportsInWindow } from '../src/lib/savedState.ts';
import { applyServerMessageAt, createInitialState, type DashboardState } from '../src/lib/store.ts';
import { T0 } from './fixtures.ts';

// Read from disk: Vitest turns CSS imports, `?raw` included, into empty modules.
const savedStateCss = readFileSync(
  resolve(import.meta.dirname, '../src/components/savedState/savedState.css'),
  'utf8',
);

afterEach(() => cleanup());

const NOW = T0 + 10 * 60_000;
const apply = (state: DashboardState, msg: ServerMessage) => applyServerMessageAt(state, msg, NOW);
const ROOT = 'androidx.lifecycle.BundlableSavedStateRegistry.key';

/**
 * A NavHost holding three Fragments (two of one class), each with a viewState, flat and largest first like the SDK
 * sends them (`SavedStateBreakdown`): the viewStates come after all three Fragments, a top-level key between them.
 */
function threeFragments(): SavedStateSample {
  const manager = [ROOT, 'android:support:fragments', 'fragment_host', 'childFragmentManager'];
  const step = 'com.example.shop.ui.CheckoutStepFragment';
  const fragment = (who: string, bytes: number, cls: string): SavedStateEntry => ({
    path: [...manager, `fragment_${who}`],
    bytes,
    kind: 'fragment',
    fragment: cls,
    valueClass: 'android.os.Bundle',
  });
  const viewState = (who: string, bytes: number, cls: string): SavedStateEntry => ({
    path: [...manager, `fragment_${who}`, 'viewState'],
    bytes,
    kind: 'value',
    fragment: cls,
    valueClass: 'android.util.SparseArray',
  });
  const nav = 'androidx.navigation.fragment.NavHostFragment';
  const first = 'aaaa1111-0000-4000-8000-000000000001';
  const second = 'aaaa1111-0000-4000-8000-000000000002';
  const third = 'bbbb2222-0000-4000-8000-000000000003';
  return {
    ts: T0 + 1000,
    activity: 'com.example.shop.ui.CheckoutActivity',
    pid: 4321,
    instanceId: null,
    screen: 'checkout',
    hook: 'post_save',
    totalBytes: 166_000,
    measureMs: 0.5,
    breakdownMs: 9.8,
    entries: [
      { path: [ROOT], bytes: 160_000, kind: 'bundle', fragment: null, valueClass: 'android.os.Bundle' },
      {
        path: manager.slice(0, 2),
        bytes: 150_000,
        kind: 'bundle',
        fragment: null,
        valueClass: 'android.os.Bundle',
      },
      {
        path: manager.slice(0, 3),
        bytes: 148_000,
        kind: 'fragment',
        fragment: nav,
        valueClass: 'android.os.Bundle',
      },
      { path: manager, bytes: 140_000, kind: 'bundle', fragment: nav, valueClass: 'android.os.Bundle' },
      fragment(first, 18_400, step),
      fragment(second, 18_200, step),
      fragment(third, 16_500, 'com.example.shop.ui.SummaryFragment'),
      viewState(first, 16_300, step),
      viewState(second, 16_100, step),
      { path: ['late_payload'], bytes: 15_000, kind: 'value', fragment: null, valueClass: 'byte[]' },
      viewState(third, 14_000, 'com.example.shop.ui.SummaryFragment'),
    ],
    truncated: false,
  };
}

/** Renders one report and opens it. */
function openTree(sample: SavedStateSample) {
  render(
    <SavedStatePanel
      savedStates={[sample]}
      failures={[]}
      fromTs={T0}
      toTs={T0 + 10_000}
      isMeasuring
      tracking={null}
    />,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

/** The key rows as rendered, top to bottom: path (from the tooltip), kind, indent in px, text. */
function keyRows() {
  return [...document.querySelectorAll<HTMLTableRowElement>('.state-entries tbody tr')].map((tr) => {
    const td = tr.querySelector<HTMLTableCellElement>('td')!;
    const at = td.title.indexOf(ROOT);
    return {
      path: (at < 0 ? td.title : td.title.slice(at)).split(' › '),
      kind: tr.dataset.kind,
      indent: Number.parseInt(td.style.paddingLeft, 10),
      text: td.textContent ?? '',
    };
  });
}

/** Declarations of every block in savedState.css whose selector list ends with [selector]. */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...savedStateCss.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1])
    .join('\n');
}

function report(ts: number, totalBytes: number): SavedStateSample {
  return {
    ts,
    activity: 'com.example.shop.ui.orders.OrdersActivity',
    pid: 4321,
    instanceId: null,
    screen: 'orders',
    hook: 'post_save',
    totalBytes,
    measureMs: 0.4,
    breakdownMs: 3.1,
    entries: [
      {
        path: [ROOT, 'android:support:fragments', 'fragment_a1', 'childFragmentManager', 'fragment_b2'],
        bytes: 307_300,
        kind: 'fragment',
        fragment: 'com.example.shop.ui.orders.OrderListFragment',
        valueClass: 'android.os.Bundle',
      },
      { path: ['late_payload'], bytes: 122_900, kind: 'value', fragment: null, valueClass: 'byte[]' },
    ],
    truncated: false,
  };
}

const FAILURE: TransactionFailure = {
  id: 1,
  ts: T0 + 60_000,
  pid: 4321,
  parcelBytes: 583_524,
  binderLine: true,
  crashed: false,
  transaction: null,
  screen: 'orders',
  savedState: null,
  report: null,
};

describe('saved-state store', () => {
  it('takes both streams from a snapshot and keeps them up to date', () => {
    const snapshot: Snapshot = {
      cpu: [],
      memory: [],
      frames: [],
      logs: [],
      events: [],
      savedStates: [report(T0 + 2000, 90_000), report(T0 + 1000, 440_060)],
      transactionFailures: [FAILURE],
    };
    let state = apply(createInitialState(), { type: 'snapshot', snapshot });
    expect(state.savedStates.map((sample) => sample.ts)).toEqual([T0 + 1000, T0 + 2000]);
    expect(state.transactionFailures).toEqual([FAILURE]);

    state = apply(state, { type: 'savedState', sample: report(T0 + 3000, 12_000) });
    expect(state.savedStates).toHaveLength(3);
    // The crash joined the failure: same id, replaced.
    state = apply(state, {
      type: 'transactionFailure',
      failure: { ...FAILURE, crashed: true, transaction: 'IActivityManager.activityStopped' },
    });
    expect(state.transactionFailures).toEqual([
      { ...FAILURE, crashed: true, transaction: 'IActivityManager.activityStopped' },
    ]);
    // Older servers send neither.
    state = apply(state, {
      type: 'snapshot',
      snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [] },
    });
    expect(state.savedStates).toEqual([]);
    expect(state.transactionFailures).toEqual([]);
  });
});

describe('saved-state helpers and timeline labels', () => {
  it('formats sizes and ranks reports by size in the window', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(583_524)).toBe('570 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(null)).toBe('—');
    const reports = [report(T0, 10), report(T0 + 1, 500), report(T0 + 99_000, 900)];
    expect(reportsInWindow(reports, T0, T0 + 1000).map((r) => r.totalBytes)).toEqual([500, 10]);
  });

  it('labels the 0.12.0 events by size', () => {
    expect(
      eventLabel({ ts: T0, kind: 'transaction_too_large', pid: 4321, detail: 'parcel size 583524 bytes' }),
    ).toBe('TOO LARGE 570 KB');
    expect(
      eventLabel({ ts: T0, kind: 'saved_state', pid: 4321, source: 'sdk', detail: 'orders 440060 bytes' }),
    ).toBe('STATE 430 KB');
    expect(eventLabel({ ts: T0, kind: 'transaction_too_large', pid: 4321 })).toBe('TOO LARGE 4321');
    expect(eventLabel({ ts: T0, kind: 'process_start', pid: 7 })).toBe('START 7');
  });
});

describe('SavedStatePanel', () => {
  it('lists failures, then reports largest first, with the keys of an opened report', () => {
    render(
      <SavedStatePanel
        savedStates={[report(T0 + 1000, 90_000), report(T0 + 2000, 440_060)]}
        failures={[FAILURE]}
        fromTs={T0}
        toTs={T0 + 10_000}
        isMeasuring
        tracking={null}
      />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('570 KB')).toBeTruthy();
    const heads = screen.getAllByRole('button', { expanded: false });
    expect(heads.map((head) => head.querySelector('.state-report-size')?.textContent)).toEqual([
      '430 KB',
      '88 KB',
    ]);
    fireEvent.click(heads[0]!);
    expect(screen.getByText('OrderListFragment')).toBeTruthy();
    expect(screen.getByText('fragment_b2')).toBeTruthy();
    expect(screen.getByText('late_payload')).toBeTruthy();
  });

  it('nests each key under its parent, siblings largest first, from the flat largest-first list', () => {
    openTree(threeFragments());
    const rows = keyRows();
    expect(rows.map((row) => row.path.at(-1))).toEqual([
      ROOT,
      'android:support:fragments',
      'fragment_host',
      'childFragmentManager',
      'fragment_aaaa1111-0000-4000-8000-000000000001',
      'viewState',
      'fragment_aaaa1111-0000-4000-8000-000000000002',
      'viewState',
      'fragment_bbbb2222-0000-4000-8000-000000000003',
      'viewState',
      'late_payload',
    ]);
    // Every viewState right under its own Fragment, one level deeper.
    rows.forEach((row, i) => {
      if (row.path.at(-1) !== 'viewState') return;
      const parent = rows[i - 1]!;
      expect(parent.kind).toBe('fragment');
      expect(row.path.slice(0, -1)).toEqual(parent.path);
      expect(row.indent).toBe(parent.indent + 12);
    });
  });

  it('keeps a key whose parent is not listed under a stand-in for that parent, never another key', () => {
    const fragments = `${ROOT} › android:support:fragments › fragment_host › childFragmentManager`;
    const entries = [
      ...threeFragments().entries.filter((entry) => entry.path.at(-1) !== 'late_payload'),
      // Its Fragment fell below the listed keys; the SDK sends it last, right after the third Fragment's viewState.
      {
        path: [...fragments.split(' › '), 'fragment_cccc', 'viewState'],
        bytes: 9_000,
        kind: 'value' as const,
        fragment: 'com.example.shop.ui.OrphanFragment',
        valueClass: 'android.util.SparseArray',
      },
    ];
    openTree({ ...threeFragments(), entries });
    const rows = keyRows();
    const orphan = rows.findIndex((row) => row.path.at(-2) === 'fragment_cccc');
    const standIn = rows[orphan - 1]!;
    expect(standIn.kind).toBe('unlisted');
    expect(standIn.path).toEqual([...fragments.split(' › '), 'fragment_cccc']);
    expect(standIn.text).toContain('fragment_cccc');
    expect(rows[orphan]!.indent).toBe(standIn.indent + 12);
    // The stand-in sits beside the listed Fragments, under their manager.
    const manager = rows.find((row) => row.path.at(-1) === 'childFragmentManager')!;
    expect(standIn.indent).toBe(manager.indent + 12);
    expect(entryRows(entries).filter((row) => row.entry === null)).toHaveLength(1);
  });

  it('marks a stand-in that skips unlisted levels', () => {
    const rows = entryRows([
      { path: [ROOT], bytes: 90_000, kind: 'bundle', fragment: null, valueClass: 'android.os.Bundle' },
      { path: [ROOT, 'a', 'b', 'c'], bytes: 40_000, kind: 'value', fragment: null, valueClass: 'byte[]' },
      { path: ['x', 'y'], bytes: 20_000, kind: 'value', fragment: null, valueClass: 'byte[]' },
    ]);
    expect(rows.map((row) => [row.path.join('/'), row.depth, row.skipped, row.entry === null])).toEqual([
      [ROOT, 0, 0, false],
      [`${ROOT}/a/b`, 1, 1, true],
      [`${ROOT}/a/b/c`, 2, 0, false],
      ['x', 0, 0, true],
      ['x/y', 1, 0, false],
    ]);
  });

  it('numbers sibling Fragments of one class in a part of the label that never gives way', () => {
    openTree(threeFragments());
    const fragments = document.querySelectorAll('tr[data-kind="fragment"]');
    const labels = [...fragments].map((row) => ({
      name: row.querySelector('.state-entry-name')?.textContent,
      instance: row.querySelector('.state-entry-instance')?.textContent ?? null,
    }));
    expect(labels).toEqual([
      { name: 'NavHostFragment', instance: null },
      { name: 'CheckoutStepFragment', instance: '#1' },
      { name: 'CheckoutStepFragment', instance: '#2' },
      { name: 'SummaryFragment', instance: null },
    ]);
    // The number is its own non-shrinking flex item; the who key is the part that shrinks first.
    expect(cssRule('.state-entry-instance')).toMatch(/flex:\s*none/);
    expect(cssRule('.state-entry-detail')).toMatch(/flex:\s*1 1 0/);
    expect(cssRule('.state-entry-label')).toMatch(/display:\s*flex/);
    // The full class and key stay one hover away.
    expect((fragments[2] as HTMLElement).querySelector('td')?.title).toContain(
      'com.example.shop.ui.CheckoutStepFragment · ',
    );
  });

  it('wraps a long Activity class inside the card and keeps it whole in the tooltip', () => {
    const activity = 'com.example.shop.feature.checkout.presentation.revamp.screens.CheckoutFlowHostActivity';
    openTree({ ...threeFragments(), activity });
    const line = screen.getByText(new RegExp(activity.replace(/\./g, '\\.')));
    expect(line.classList.contains('state-report-activity')).toBe(true);
    expect(line.title).toBe(activity);
    expect(cssRule('.state-report-activity')).toMatch(/overflow-wrap:\s*anywhere/);
    // The head row's name carries the full class too.
    expect(document.querySelector<HTMLElement>('.state-report-name')?.title).toBe(activity);
  });

  it('says what is missing without the SDK', () => {
    render(
      <SavedStatePanel
        savedStates={[]}
        failures={[]}
        fromTs={T0}
        toTs={T0 + 10_000}
        isMeasuring={false}
        tracking={null}
      />,
    );
    expect(screen.getByText(/Needs the in-app SDK 0.12.0\+/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('turns tracking off and back on with one switch', () => {
    const change = vi.fn();
    const panel = (tracking: boolean, onTrackingChange?: (on: boolean) => void) => (
      <SavedStatePanel
        savedStates={[]}
        failures={[]}
        fromTs={T0}
        toTs={T0 + 10_000}
        isMeasuring={tracking}
        tracking={tracking}
        onTrackingChange={onTrackingChange}
      />
    );
    const { rerender } = render(panel(true, change));
    const toggle = screen.getByRole('switch', { name: 'Saved-state tracking' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(change).toHaveBeenLastCalledWith(false);
    rerender(panel(false, change));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Saved-state tracking is off/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(change).toHaveBeenLastCalledWith(true);
    rerender(panel(false));
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

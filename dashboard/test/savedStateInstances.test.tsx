/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SAVED_STATE_INSTANCES } from '@lionscope/protocol/wire';
import type {
  SavedStateInstance,
  SavedStateSample,
  ServerMessage,
  TransactionFailure,
} from '@lionscope/protocol/wire';
import { SavedStatePanel } from '../src/components/savedState/SavedStatePanel.tsx';
import { formatDelta, formatTrend } from '../src/lib/savedState.ts';
import { applyServerMessageAt, createInitialState, type DashboardState } from '../src/lib/store.ts';
import { T0 } from './fixtures.ts';

// Read from disk: Vitest turns CSS imports, `?raw` included, into empty modules.
const css = readFileSync(resolve(import.meta.dirname, '../src/components/savedState/savedState.css'), 'utf8');
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1])
    .join('\n');
}

afterEach(() => cleanup());

const PID = 4321;
const ORDERS = 'com.example.shop.ui.orders.OrdersActivity';
const KB = 1024;

function instance(
  id: number,
  state: SavedStateInstance['state'] = 'live',
  extra: Partial<SavedStateInstance> = {},
): SavedStateInstance {
  return {
    pid: PID,
    id,
    activity: ORDERS,
    prevId: null,
    firstSeen: T0 + id,
    state,
    closedAt: state === 'live' ? null : T0 + 5000,
    ...extra,
  };
}

function save(
  ts: number,
  instanceId: number | null,
  totalBytes: number,
  screenName = 'orders',
): SavedStateSample {
  return {
    ts,
    activity: ORDERS,
    pid: PID,
    instanceId,
    screen: screenName,
    hook: 'post_save',
    totalBytes,
    measureMs: 0.4,
    breakdownMs: null,
    entries: [],
    truncated: false,
  };
}

function panel(
  savedStates: SavedStateSample[],
  instances: SavedStateInstance[],
  options: { failures?: TransactionFailure[]; isMeasuring?: boolean } = {},
) {
  return render(
    <SavedStatePanel
      savedStates={savedStates}
      failures={options.failures ?? []}
      instances={instances}
      fromTs={T0}
      toTs={T0 + 60_000}
      isMeasuring={options.isMeasuring ?? true}
      tracking={null}
    />,
  );
}

/** The chain rows of a list, top to bottom: size, name, `#id`, meta. */
function chainRows(list: Element | null = document.querySelector('.state-reports')) {
  return [...(list?.querySelectorAll(':scope > .state-chain') ?? [])].map((row) => ({
    size: row.querySelector('.state-report-size')?.textContent,
    name: row.querySelector('.state-chain-label')?.textContent,
    id: row.querySelector('.state-chain-id')?.textContent,
    meta: row.querySelector('.state-report-meta')?.textContent,
  }));
}

describe('saved-state instances in the store', () => {
  const NOW = T0 + 1000;
  const apply = (state: DashboardState, message: ServerMessage) => applyServerMessageAt(state, message, NOW);

  it('takes them from a snapshot, upserts them by process and number, and reads [] from an older server', () => {
    let state = apply(createInitialState(), {
      type: 'snapshot',
      snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [], savedStateInstances: [instance(1)] },
    });
    expect(state.savedStateInstances).toEqual([instance(1)]);
    state = apply(state, { type: 'savedStateInstance', instance: instance(2, 'live', { prevId: 1 }) });
    state = apply(state, { type: 'savedStateInstance', instance: instance(1, 'closed') });
    state = apply(state, { type: 'savedStateInstance', instance: { ...instance(1), pid: 99 } });
    expect(state.savedStateInstances.map((known) => [known.pid, known.id, known.state])).toEqual([
      [PID, 1, 'closed'],
      [PID, 2, 'live'],
      [99, 1, 'live'],
    ]);
    state = apply(state, {
      type: 'snapshot',
      snapshot: { cpu: [], memory: [], frames: [], logs: [], events: [] },
    });
    expect(state.savedStateInstances).toEqual([]);
  });

  it('prunes like the server: closed ones past the window, then the longest closed past the cap', () => {
    const closedLong = instance(1, 'closed', { closedAt: T0 - 11 * 60_000 });
    const many = Array.from({ length: MAX_SAVED_STATE_INSTANCES + 1 }, (_, i) =>
      instance(i + 10, 'closed', { closedAt: T0 + i }),
    );
    const state = apply(createInitialState(), {
      type: 'snapshot',
      snapshot: {
        cpu: [{ ts: T0 + 1000, cpuPercent: 1, threadCount: 1 }] as never,
        memory: [],
        frames: [],
        logs: [],
        events: [],
        savedStateInstances: [closedLong, instance(2), ...many],
      },
    });
    const ids = state.savedStateInstances.map((known) => known.id);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(10);
    expect(ids).toHaveLength(MAX_SAVED_STATE_INSTANCES);
  });
});

describe('trend copy', () => {
  it('reads a chain of saves', () => {
    expect(formatTrend({ saves: 3, firstBytes: 125 * KB, lastBytes: 163 * KB })).toBe(
      '125 → 163 KB · 3 saves',
    );
    // One save: the row already shows its size, so the summary only counts it.
    expect(formatTrend({ saves: 1, firstBytes: 163 * KB, lastBytes: 163 * KB })).toBe('1 save');
    expect(formatTrend({ saves: 0, firstBytes: null, lastBytes: null })).toBe('no save');
    expect(formatTrend({ saves: 2, firstBytes: 980 * KB, lastBytes: 1.2 * 1024 * KB })).toBe(
      '980 KB → 1.2 MB · 2 saves',
    );
    expect(formatDelta(163 * KB, 125 * KB)).toBe('+38 KB');
    expect(formatDelta(100, 300)).toBe('−200 B');
    expect(formatDelta(1, undefined)).toBeNull();
  });
});

describe('SavedStatePanel: live and trend per Activity', () => {
  it('shows a rotated Activity as one live row whose old instance is not listed as closed (E-01)', () => {
    panel(
      [save(T0 + 1000, 1, 125 * KB), save(T0 + 2000, 2, 140 * KB), save(T0 + 3000, 2, 163 * KB)],
      [instance(1, 'closed'), instance(2, 'live', { prevId: 1 })],
    );
    expect(chainRows()).toEqual([
      { size: '163 KB', name: 'orders', id: '#2', meta: expect.stringContaining('125 → 163 KB · 3 saves') },
    ]);
    expect(screen.queryByRole('button', { name: /Closed/ })).toBeNull();
    // Its history: newest first, the change from the save before, which instance.
    fireEvent.click(screen.getByRole('button', { name: /orders/ }));
    const saves = [...document.querySelectorAll('.state-save')].map((row) => [
      row.querySelector('.state-report-size')?.textContent,
      row.querySelector('.state-chain-label')?.textContent,
      row.querySelector('.state-chain-id')?.textContent,
    ]);
    expect(saves).toEqual([
      ['163 KB', '+23 KB', '#2'],
      ['140 KB', '+15 KB', '#2'],
      ['125 KB', 'first', '#1'],
    ]);
    expect(screen.getByText(/#2 ← #1/)).toBeTruthy();
  });

  it('keeps two instances of one class apart, each with its number in sight (E-06)', () => {
    panel(
      [save(T0 + 1000, 1, 200 * KB), save(T0 + 1000, 2, 20 * KB), save(T0 + 2000, 2, 30 * KB)],
      [instance(1), instance(2)],
    );
    expect(chainRows()).toEqual([
      {
        size: '200 KB',
        name: 'orders',
        id: '#1',
        meta: expect.stringMatching(/^1 save · saved \d\d:\d\d:\d\d$/),
      },
      { size: '30 KB', name: 'orders', id: '#2', meta: expect.stringContaining('20 → 30 KB · 2 saves') },
    ]);
    expect(cssRule('.state-chain-id')).toMatch(/flex:\s*none/);
    expect(cssRule('.state-chain-label')).toMatch(/flex:\s*0 1 auto/);
  });

  it('lists a live Activity that never saved at the bottom in both orders (E-07)', () => {
    panel([save(T0 + 1000, 1, 10 * KB), save(T0 + 2000, 3, 5 * KB)], [instance(1), instance(2), instance(3)]);
    const order = () => chainRows().map((row) => row.id);
    expect(order()).toEqual(['#1', '#3', '#2']); // Largest
    expect(chainRows()[2]).toMatchObject({ size: '', meta: expect.stringMatching(/^no save · seen /) });
    fireEvent.click(screen.getByRole('button', { name: 'Latest' }));
    expect(order()).toEqual(['#3', '#1', '#2']);
    expect(screen.getByRole('button', { name: 'Latest' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('folds closed and ended Activities away, with why they closed', () => {
    panel(
      [save(T0 + 1000, 1, 10 * KB), save(T0 + 1000, 3, 10 * KB)],
      [instance(1, 'closed'), instance(2), instance(3, 'process_ended')],
    );
    const toggle = screen.getByRole('button', { name: 'Closed (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.state-chain')).toHaveLength(1);
    fireEvent.click(toggle);
    const closed = chainRows(document.querySelectorAll('.state-reports')[1] ?? null);
    expect(closed.map((row) => row.meta)).toEqual([
      expect.stringContaining('closed'),
      expect.stringContaining('process ended'),
    ]);
  });

  it('says the live list is the last known one while nothing is measured', () => {
    panel([], [instance(1)], { isMeasuring: false });
    expect(screen.getByText(/Last known state/)).toBeTruthy();
  });

  it('opens two saves of one millisecond separately (E-06 keys)', () => {
    panel(
      [save(T0 + 1000, 1, 10 * KB), save(T0 + 1000, 2, 12 * KB)],
      [instance(1, 'closed'), instance(2, 'live', { prevId: 1 })],
    );
    fireEvent.click(screen.getByRole('button', { name: /orders/ }));
    const heads = [...document.querySelectorAll<HTMLButtonElement>('.state-save .state-report-head')];
    expect(heads).toHaveLength(2);
    fireEvent.click(heads[1]!);
    expect(heads.map((head) => head.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });

  it('lists reports without an instance apart from the Activities (E-13)', () => {
    panel([save(T0 + 1000, 1, 10 * KB), save(T0 + 2000, null, 77 * KB, 'legacy')], [instance(1)]);
    expect(screen.getByText('Unattributed (older SDK)')).toBeTruthy();
    const flat = [...document.querySelectorAll('.state-report:not(.state-chain) .state-report-name')];
    expect(flat.map((name) => name.textContent)).toEqual(['legacy']);
  });

  it('gives a disclosure triangle only to rows that open; a row without a save is plain text (UX)', () => {
    panel([save(T0 + 1000, 1, 10 * KB)], [instance(1), instance(2)]);
    const rows = [...document.querySelectorAll('.state-chain')];
    expect(rows.map((row) => row.getAttribute('data-saved'))).toEqual(['true', 'false']);
    const [saved, unsaved] = rows;
    expect(saved?.querySelector('button.state-report-head svg')).not.toBeNull();
    expect(unsaved?.querySelector('button')).toBeNull();
    expect(unsaved?.querySelector('.state-twist svg')).toBeNull();
    expect(unsaved?.querySelector('.state-report-head')?.getAttribute('title')).toBe(
      `${ORDERS} · pid ${PID}`,
    );
    expect(unsaved?.textContent).not.toContain('\u2014');
  });

  it('says when a closed Activity closed, without a size it never had', () => {
    panel([], [instance(1, 'closed', { closedAt: T0 + 2000 })]);
    fireEvent.click(screen.getByRole('button', { name: 'Closed (1)' }));
    const closed = chainRows(document.querySelectorAll('.state-reports')[0] ?? null);
    expect(closed).toEqual([
      {
        size: '',
        name: 'OrdersActivity',
        id: '#1',
        meta: expect.stringMatching(/^no save · closed \d\d:\d\d:\d\d$/),
      },
    ]);
  });

  it('shows an older SDK as before: no groups, no order switch (E-13)', () => {
    panel([save(T0 + 1000, null, 10 * KB)], []);
    expect(screen.queryByText(/Live/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Order' })).toBeNull();
    expect(document.querySelectorAll('.state-report')).toHaveLength(1);
  });
});

describe('SavedStatePanel: failures keep their report (UI5)', () => {
  const failure: TransactionFailure = {
    id: 1,
    ts: T0 + 5000,
    pid: PID,
    parcelBytes: 583_524,
    binderLine: true,
    crashed: true,
    transaction: 'IActivityManager.activityStopped',
    screen: 'orders',
    savedState: { ts: T0 + 4990, activity: ORDERS, totalBytes: 583_420, instanceId: 1 },
    report: {
      ...save(T0 + 4990, 1, 583_420),
      entries: [
        { path: ['late_payload'], bytes: 500_000, kind: 'value', fragment: null, valueClass: 'byte[]' },
      ],
    },
  };

  it('opens a failure into its report tree', () => {
    panel([], [], { failures: [failure] });
    fireEvent.click(screen.getByRole('button', { name: /TransactionTooLargeException/ }));
    expect(screen.getByText('late_payload')).toBeTruthy();
  });

  it('says when the keys are no longer kept, and keeps the summary', () => {
    panel([], [], { failures: [{ ...failure, report: null }] });
    expect(screen.queryByRole('button', { name: /TransactionTooLargeException/ })).toBeNull();
    expect(document.querySelector('.state-failure')?.textContent).toContain(
      'measured at 570 KB (its keys are no longer kept)',
    );
  });
});

describe('SavedStatePanel: a stand-in keeps saying "not listed" (WARN-001)', () => {
  it('puts the note in a part that never shrinks, so the key gives way first', () => {
    const report: SavedStateSample = {
      ...save(T0 + 1000, null, 200 * KB),
      entries: [
        {
          path: ['root', 'fragment_8f3a9c2e-41b7-4c55-9d1e-0123456789ab', 'viewState'],
          bytes: 100 * KB,
          kind: 'value',
          fragment: null,
          valueClass: 'android.util.SparseArray',
        },
      ],
    };
    panel([report], []);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const note = screen.getAllByText('not listed')[0]!;
    expect(note.classList.contains('state-entry-note')).toBe(true);
    expect(note.classList.contains('state-entry-detail')).toBe(false);
    expect(cssRule('.state-entry-note')).toMatch(/flex:\s*none/);
    expect(cssRule('.state-entry-name')).toMatch(/flex:\s*0 1 auto/);
  });
});

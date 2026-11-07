/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ServerMessage,
  StorageConsent,
  StoragePrefsEntry,
  StorageResponse,
  StorageTarget,
  StorageWriteOutcome,
} from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { ServicesContext, useDashboardState, type DashboardServices } from '../src/app/services.ts';
import { StoragePanel } from '../src/components/storage/StoragePanel.tsx';
import { createSignal } from '../src/lib/signal.ts';
import { bitsOf, cellReadOnly, outcomeText, parseValue, storageSessionKey } from '../src/lib/storage.ts';
import {
  applyServerMessage,
  createInitialState,
  createStore,
  type ConnectionState,
} from '../src/lib/store.ts';
import { session } from './fixtures.ts';

afterEach(() => cleanup());

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const hello = (storageConsent?: StorageConsent): ServerMessage => ({
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.13.0',
  bufferWindowMs: 600_000,
  ...(storageConsent ? { storageConsent } : {}),
});
const LONG_MAX = '9223372036854775807';

describe('storage values in the dashboard', () => {
  it('keeps integers as decimal strings checked with BigInt, never through Number', () => {
    expect(parseValue(LONG_MAX, { t: 'long', v: '1' })).toEqual({ value: { t: 'long', v: LONG_MAX } });
    expect(parseValue('9223372036854775806', { t: 'integer', v: LONG_MAX })).toEqual({
      value: { t: 'integer', v: '9223372036854775806' },
    });
    expect(parseValue('9223372036854775808', { t: 'long', v: '1' })).toHaveProperty('error');
    expect(parseValue('2147483648', { t: 'int', v: '1' })).toHaveProperty('error');
    expect(parseValue('1.5', { t: 'int', v: '1' })).toHaveProperty('error');
    const source = readFileSync(resolve(import.meta.dirname, '../src/lib/storage.ts'), 'utf8');
    const integerPath = source.slice(source.indexOf("case 'int':\n    case 'long':\n    case 'integer': {"));
    expect(integerPath.slice(0, integerPath.indexOf("case 'float'"))).not.toMatch(
      /Number\(|parseInt|parseFloat/,
    );
  });

  it('turns typed floats into their raw bits, -0.0 and NaN included', () => {
    expect(bitsOf('-0.0', 'real')).toBe('0x8000000000000000');
    expect(bitsOf('0', 'real')).toBe('0x0000000000000000');
    expect(bitsOf('0.1', 'float')).toBe('0x3dcccccd');
    expect(bitsOf('NaN', 'float')).toBe('0x7fc00000');
    expect(bitsOf('-Infinity', 'real')).toBe('0xfff0000000000000');
    expect(bitsOf('1e3x', 'real')).toBeNull();
    expect(parseValue('0.5', { t: 'float', v: '1.0', bits: '0x3f800000' })).toEqual({
      value: { t: 'float', v: '0.5', bits: '0x3f000000' },
    });
    // A NULL cell takes the column's affinity.
    expect(parseValue('7', { t: 'null' }, 'integer')).toEqual({ value: { t: 'integer', v: '7' } });
  });

  it('says why a cell is read-only and what a write did, without claiming the UI changed', () => {
    const page = {
      table: 't',
      columns: ['id', 'v'],
      pk: ['id'],
      readOnly: null,
      rows: [],
      nextCursor: null,
      truncated: false,
    };
    expect(cellReadOnly(page, 'id', { t: 'integer', v: '1' })).toMatch(/primary key/);
    expect(cellReadOnly(page, 'v', { t: 'redacted', orig: 'string' })).toMatch(/credential/);
    expect(cellReadOnly(page, 'v', { t: 'string', v: 'x', complete: false, length: 20000 })).toMatch(
      /too long/,
    );
    expect(cellReadOnly({ ...page, readOnly: 'no_explicit_pk' }, 'v', { t: 'string', v: 'x' })).toMatch(
      /rowid/,
    );
    const prefs = outcomeText({
      opId: 'x',
      code: 'ok',
      late: false,
      phase: 'final',
      persisted: false,
      observers: 'posted_unverified',
    });
    expect(prefs).toMatch(/memory only/);
    expect(prefs).not.toMatch(/UI (was )?updated/);
    // Never "Saved" unless saved, and never "the listeners were notified".
    expect(prefs).not.toMatch(/Saved/);
    expect(prefs).not.toMatch(/listeners were notified/);
    expect(prefs).toMatch(/whether they ran is not known/);
    const provisional = outcomeText({
      opId: 'x',
      code: 'ok',
      late: false,
      phase: 'provisional',
      persisted: 'timeout',
    });
    expect(provisional).toMatch(/^Changed in the app’s memory/);
    expect(provisional).toMatch(/still running/);
    expect(
      outcomeText({ opId: 'x', code: 'ok', late: false, phase: 'final', persisted: true, memory: 'applied' }),
    ).toMatch(/^Saved/);
    const db = outcomeText({
      opId: 'x',
      code: 'ok',
      late: false,
      changes: 1,
      totalChangesDelta: 2,
      observers: 'room_invalidation',
    });
    expect(db).toMatch(/side effects/);
    expect(db).toMatch(/reload/);
    expect(outcomeText({ opId: 'x', code: 'ok', late: true, phase: 'final' })).toMatch(
      /after the request had timed out/,
    );
  });

  it('keeps the consent of the hello (off from older servers) and the storage answers', () => {
    let state = applyServerMessage(createInitialState(), hello());
    expect(state.storageConsent).toBe('off');
    state = applyServerMessage(state, hello('read'));
    expect(state.storageConsent).toBe('read');
    const response: StorageResponse = { ok: false, code: 'busy', message: 'busy' };
    state = applyServerMessage(state, { type: 'storage', requestId: 4, response });
    expect(state.storageAnswers).toEqual([{ requestId: 4, response }]);
    state = applyServerMessage(state, {
      type: 'storageOutcome',
      serial: 'emulator-5640',
      outcome: { opId: 'o', code: 'ok', late: true },
    });
    expect(state.storageOutcomes).toHaveLength(1);
  });
});

const TARGET: StorageTarget = { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 };
const TOKEN = 'c1.0123456789abcdef0123456789abcdef';

function setup(consent: StorageConsent) {
  const store = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const sent: ClientMessage[] = [];
  const services: DashboardServices = {
    store,
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    probeTs: createSignal<number | null>(null),
    cursorX: createSignal<number | null>(null),
  };
  store.dispatch({ kind: 'connection', connection: OPEN });
  store.dispatch({ kind: 'server', msg: hello(consent) });
  store.dispatch({ kind: 'server', msg: { type: 'session', session: session() } });
  store.flush();
  const Panel = () => {
    const state = useDashboardState();
    return (
      <StoragePanel
        consent={state.storageConsent}
        answers={state.storageAnswers}
        outcomes={state.storageOutcomes}
        isRunning={state.session.status === 'running'}
        sessionKey={storageSessionKey(state.session)}
      />
    );
  };
  render(
    <ServicesContext.Provider value={services}>
      <Panel />
    </ServicesContext.Provider>,
  );
  /** Answers request [requestId] (any order). */
  const answerTo = async (requestId: number, response: StorageResponse) => {
    await act(async () => {
      store.dispatch({ kind: 'server', msg: { type: 'storage', requestId, response } });
      store.flush();
      await Promise.resolve();
    });
  };
  /** Answers the last request sent. */
  const answer = async (response: StorageResponse) => {
    const last = sent.at(-1) as Extract<ClientMessage, { requestId: number }>;
    await answerTo(last.requestId, response);
  };
  const lastId = () => (sent.at(-1) as Extract<ClientMessage, { requestId: number }>).requestId;
  const setSession = async (next: Parameters<typeof session>[0]) => {
    await act(async () => {
      store.dispatch({ kind: 'server', msg: { type: 'session', session: session(next) } });
      store.flush();
      await Promise.resolve();
    });
  };
  const writes = () => sent.filter((msg) => msg.type === 'storageWrite');
  /** A final outcome after its answer, as the server broadcasts it. */
  const late = async (outcome: StorageWriteOutcome) => {
    await act(async () => {
      store.dispatch({ kind: 'server', msg: { type: 'storageOutcome', serial: TARGET.serial, outcome } });
      store.flush();
      await Promise.resolve();
    });
  };
  return { sent, answer, answerTo, lastId, setSession, writes, late };
}

const listOf = (prefs: string[], databases: string[] = []): StorageResponse => ({
  ok: true,
  kind: 'list',
  target: TARGET,
  prefs: prefs.map((name) => ({ name, backupOnly: false })),
  prefsTruncated: false,
  databases: databases.map((name) => ({ name, status: 'ok' as const })),
});

const prefsOf = (
  name: string,
  entries: StoragePrefsEntry[],
  more: { nextCursor?: string | null; truncated?: boolean; target?: StorageTarget } = {},
): StorageResponse => ({
  ok: true,
  kind: 'prefs',
  target: more.target ?? TARGET,
  name,
  entries,
  nextCursor: more.nextCursor ?? null,
  truncated: more.truncated ?? false,
});

const schemaOf = (name: string, tables: string[]): StorageResponse => ({
  ok: true,
  kind: 'schema',
  target: TARGET,
  name,
  tables: tables.map((table) => ({
    name: table,
    kind: 'table' as const,
    withoutRowid: false,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: false, pk: 1 },
      { name: 'v', type: 'TEXT', notNull: false, pk: 0 },
    ],
    pk: ['id'],
    readOnly: null,
  })),
  tablesTruncated: false,
});

const pageOf = (name: string, table: string, value: string): StorageResponse => ({
  ok: true,
  kind: 'pages',
  target: TARGET,
  name,
  txMs: 1,
  pages: [
    {
      table,
      columns: ['id', 'v'],
      pk: ['id'],
      readOnly: null,
      rows: [
        {
          cells: [
            { t: 'integer', v: '1' },
            { t: 'string', v: value },
          ],
          digest: 'a'.repeat(64),
        },
      ],
      nextCursor: null,
      truncated: false,
    },
  ],
});

const BUSY: StorageResponse = { ok: false, code: 'busy', message: 'busy' };

describe('Storage tab', () => {
  it('shows that storage is off and sends nothing', () => {
    const { sent } = setup('off');
    expect(screen.getByTestId('storage-consent-off').textContent).toContain('--allow-storage-read');
    expect(sent).toEqual([]);
  });

  it('lists, reads a prefs file and edits a Long exactly, offering undo only from the answer', async () => {
    const { sent, answer } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    expect(sent.at(-1)).toMatchObject({ type: 'storageList' });
    await answer({
      ok: true,
      kind: 'list',
      target: TARGET,
      prefs: [{ name: 'app_settings', backupOnly: false }],
      prefsTruncated: false,
      databases: [
        { name: 'app.db', status: 'ok' },
        { name: 'old.db', status: 'unsupported:closed' },
      ],
    });
    expect((screen.getByRole('button', { name: /old\.db/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'app_settings' }));
    expect(sent.at(-1)).toMatchObject({
      type: 'storageRead',
      read: { store: 'prefs', name: 'app_settings' },
    });
    await answer(
      prefsOf('app_settings', [
        { key: 'big', value: { t: 'long', v: LONG_MAX } },
        { key: 'session_token', value: { t: 'redacted', orig: 'string' } },
      ]),
    );
    expect(screen.getByText(LONG_MAX)).toBeTruthy();
    expect(screen.getByText(/read-only: looks like a credential/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of big' }), {
      target: { value: '9223372036854775806' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const write = sent.at(-1) as Extract<ClientMessage, { type: 'storageWrite' }>;
    // The write names the link its values were read from.
    expect(write.write).toEqual({
      store: 'prefs',
      name: 'app_settings',
      op: 'update',
      key: 'big',
      expected: { t: 'long', v: LONG_MAX },
      value: { t: 'long', v: '9223372036854775806' },
      target: TARGET,
    });
    await answer({
      ok: true,
      kind: 'write',
      target: TARGET,
      outcome: {
        opId: 'o1',
        code: 'ok',
        phase: 'final',
        late: false,
        persisted: false,
        memory: 'applied',
        observers: 'posted_unverified',
      },
    });
    expect(screen.getByRole('status').textContent).toMatch(/memory only/);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('keeps a cut key read-only next to the key its prefix names (keyLength)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { sent, answer } = setup('read_write');
      fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
      await answer(listOf(['p']));
      fireEvent.click(screen.getByRole('button', { name: 'p' }));
      const prefix = 'k'.repeat(1024);
      // What the server answers (it keeps keyLength: storageService.test.ts, agentStorage.test.ts).
      await answer(
        prefsOf('p', [
          { key: prefix, value: { t: 'int', v: '3' } },
          { key: prefix, keyLength: 1030, value: { t: 'int', v: '3' } },
        ]),
      );
      expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
      expect(screen.getByText(/read-only: the key is too long to send whole/)).toBeTruthy();
      expect(screen.getByText(/\(1030 chars\)/)).toBeTruthy();
      // No two rows share a React key (the cut one would otherwise collide with the other).
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
      // The one Edit is the key itself, written as itself.
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const write = sent.at(-1) as Extract<ClientMessage, { type: 'storageWrite' }>;
      expect(write.write).toMatchObject({ key: prefix, expected: { t: 'int', v: '3' } });
    } finally {
      errors.mockRestore();
    }
  });

  it('hides edit controls with read consent only', async () => {
    const { answer } = setup('read');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    expect(screen.getByText(/Read only \(--allow-storage-write is off\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('drops an answer for a target that is no longer shown: a slow read of A never edits B', async () => {
    const { answer, answerTo, lastId, writes } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['prefs_a', 'prefs_b']));
    fireEvent.click(screen.getByRole('button', { name: 'prefs_a' }));
    const readA = lastId();
    fireEvent.click(screen.getByRole('button', { name: 'prefs_b' }));
    await answer(BUSY);
    // A's answer comes last: it is not shown under B, so nothing of it can be edited.
    await answerTo(readA, prefsOf('prefs_a', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    expect(screen.queryByTestId('storage-prefs')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(writes()).toHaveLength(0);
    // B read for real: its own values, written to B.
    fireEvent.click(screen.getByRole('button', { name: 'prefs_b' }));
    await answer(prefsOf('prefs_b', [{ key: 'count', value: { t: 'int', v: '5' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(writes().at(-1)).toMatchObject({
      write: { name: 'prefs_b', key: 'count', expected: { t: 'int', v: '5' }, value: { t: 'int', v: '6' } },
    });
  });

  it('drops a late schema and a late page of another database or table', async () => {
    const { answer, answerTo, lastId } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf([], ['x.db', 'y.db']));
    fireEvent.click(screen.getByRole('button', { name: 'x.db' }));
    const schemaX = lastId();
    fireEvent.click(screen.getByRole('button', { name: 'y.db' }));
    await answer(schemaOf('y.db', ['y_table']));
    await answerTo(schemaX, schemaOf('x.db', ['x_table']));
    expect(screen.getByRole('button', { name: 'y_table' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'x_table' })).toBeNull();
    // Two tables: the first one's page arrives after the second's.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'y_table' }));
    });
    const pageFirst = lastId();
    await answer(BUSY);
    await answerTo(pageFirst, pageOf('y.db', 'y_table', 'stale'));
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('sends one write for a double submit', async () => {
    const { answer, writes } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox', { name: 'New value of count' });
    fireEvent.change(input, { target: { value: '4' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(writes()).toHaveLength(1);
  });

  it('forgets what was read, and any edit or undo, when the session or its app changes', async () => {
    const { answer, setSession, writes } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await answer({
      ok: true,
      kind: 'write',
      target: TARGET,
      outcome: {
        opId: '6f1c2b8e-0d5a-4f43-9b0e-3a7c2d1e4f50',
        code: 'ok',
        phase: 'final',
        late: false,
        undo: {
          store: 'prefs',
          name: 'p',
          op: 'update',
          key: 'count',
          expected: { t: 'int', v: '4' },
          value: { t: 'int', v: '3' },
          undoOf: '6f1c2b8e-0d5a-4f43-9b0e-3a7c2d1e4f50',
          target: TARGET,
        },
      },
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    // Stopped, then running again: nothing of before is offered.
    await setSession({ status: 'idle' });
    await setSession({});
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'p' })).toBeNull();
    // Another app (or the same one restarted: another pid) on the same device: the same.
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    await setSession({ packageName: 'com.example.other' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    await setSession({ packageName: 'com.example.other', pid: 4321 });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('does not offer edits of values read from another link than the listing', async () => {
    const { answer } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(
      prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }], { target: { ...TARGET, link: 2 } }),
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByText(/SDK link changed/)).toBeTruthy();
  });

  it('pages prefs keys with Next / Previous and says when a page was cut', async () => {
    const { answer, sent } = setup('read');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(
      prefsOf('p', [{ key: 'a', value: { t: 'int', v: '1' } }], { nextCursor: TOKEN, truncated: true }),
    );
    expect(screen.getByText(/Keys cut to stay under the answer size/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(sent.at(-1)).toMatchObject({
      type: 'storageRead',
      read: { store: 'prefs', name: 'p', cursor: TOKEN },
    });
    await answer(prefsOf('p', [{ key: 'b', value: { t: 'int', v: '2' } }]));
    expect(screen.getByText('b')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(sent.at(-1)).toMatchObject({ type: 'storageRead', read: { store: 'prefs', name: 'p' } });
    expect((sent.at(-1) as Extract<ClientMessage, { type: 'storageRead' }>).read).not.toHaveProperty(
      'cursor',
    );
  });

  it('marks a cut key read-only', async () => {
    const { answer } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'kkk', keyLength: 5000, value: { t: 'int', v: '1' } }]));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByText(/key is too long/)).toBeTruthy();
  });

  it('reads the write audit (no values) on request', async () => {
    const { answer, sent } = setup('read');
    fireEvent.click(screen.getByRole('button', { name: 'Write audit' }));
    expect(sent.at(-1)).toMatchObject({ type: 'storageAudit' });
    await answer({
      ok: true,
      kind: 'audit',
      entries: [
        {
          ts: 0,
          opId: 'o1',
          serial: 'emulator-5554',
          packageName: 'com.example.shop',
          store: 'db',
          name: 'app.db',
          table: 'user',
          field: '[redacted-name]',
          pkDigest: 'abcdef0123456789'.repeat(4),
          op: 'update',
          code: 'conflict',
          phase: 'final',
          late: false,
          persisted: null,
          changes: null,
          totalChangesDelta: null,
        },
      ],
    });
    const audit = screen.getByTestId('storage-audit').textContent ?? '';
    expect(audit).toMatch(/update · db · app\.db · user · \[redacted-name\] · conflict · final/);
    expect(audit).toMatch(/key #abcdef01/);
  });

  it('shows a provisional write, then its final outcome in place when it comes', async () => {
    const { answer, late } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'name', value: { t: 'string', v: 'Ana' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of name' }), { target: { value: 'Bo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const base = {
      opId: 'op-slow',
      code: 'ok' as const,
      late: false,
      memory: 'applied' as const,
      observers: 'posted_unverified' as const,
    };
    await answer({
      ok: true,
      kind: 'write',
      target: TARGET,
      outcome: { ...base, phase: 'provisional', persisted: 'timeout' },
    });
    expect(screen.getByRole('status').textContent).toMatch(/still running/);
    await late({ ...base, phase: 'final', persisted: true });
    expect(screen.getByRole('status').textContent).not.toMatch(/still running/);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

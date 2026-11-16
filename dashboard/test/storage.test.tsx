/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ServerMessage,
  StorageConsent,
  StoragePrefsEntry,
  StorageResponse,
  StorageTarget,
  StorageValue,
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
    expect(cellReadOnly(page, 'id', { t: 'integer', v: '1' })).toBeNull();
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

  it('edits BLOB base64 and JSON string sets without accepting incomplete or malformed input', () => {
    expect(parseValue('AP8=', { t: 'blob', b64: '', size: 0, complete: true })).toEqual({
      value: { t: 'blob', b64: 'AP8=', size: 2, complete: true },
    });
    expect(parseValue('not base64', { t: 'blob', b64: '', size: 0, complete: true })).toHaveProperty('error');
    expect(parseValue('["alpha","beta","alpha"]', { t: 'stringSet', v: [] })).toEqual({
      value: { t: 'stringSet', v: ['alpha', 'beta'] },
    });
    expect(parseValue('[1]', { t: 'stringSet', v: [] })).toHaveProperty('error');
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

/** The row of a prefs key (its name as shown: a cut key ends with its length). */
const keyRow = (shown: string) => {
  const row = screen
    .getAllByRole('button')
    .find((button) => button.querySelector('.storage-row-name')?.textContent === shown);
  if (!row) throw new Error(`no row ${shown}`);
  return row;
};
/** Opens a key's (or a page row's) sheet, then its value's editor. */
const openKey = (shown: string) => fireEvent.click(keyRow(shown));
const editKey = (key: string) => {
  openKey(key);
  fireEvent.click(screen.getByRole('button', { name: `Edit ${key}` }));
};
const editButtons = () => screen.queryAllByRole('button', { name: /^Edit / });

/** A page of [table] with these (id, v) rows, v of type [type] ('string' by default). */
const rowsOf = (table: string, rows: [string, StorageValue][]): StorageResponse => {
  const page = pageOf('shop.db', table, '') as Extract<StorageResponse, { kind: 'pages' }>;
  page.pages[0]!.rows = rows.map(([id, v], index) => ({
    cells: [{ t: 'integer', v: id }, v],
    digest: String(index).repeat(64).slice(0, 64),
  }));
  return page;
};
const str = (v: string): StorageValue => ({ t: 'string', v });
const SHOP_ROWS: [string, StorageValue][] = [
  ['1', str('Bread')],
  ['2', str('Milk')],
];

/** Lists, opens shop.db's item table with [rows] (a REAL column v when [real]). */
async function openItem(h: ReturnType<typeof setup>, rows = SHOP_ROWS, real = false) {
  fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
  await h.answer(listOf([], ['shop.db']));
  fireEvent.click(screen.getByRole('button', { name: 'shop.db' }));
  const schema = schemaOf('shop.db', ['item']) as Extract<StorageResponse, { kind: 'schema' }>;
  if (real) schema.tables[0]!.columns[1]!.type = 'REAL';
  await h.answer(schema);
  fireEvent.click(screen.getByRole('button', { name: 'item' }));
  await h.answer(rowsOf('item', rows));
}
const rowOf = (text: string) => screen.getByText(text, { selector: 'td' }).closest('tr')!;
const sheet = () => screen.queryByRole('dialog', { name: 'Row' });
const OK = (opId: string, more: Partial<StorageWriteOutcome> = {}): StorageResponse => ({
  ok: true,
  kind: 'write',
  target: TARGET,
  outcome: { opId, code: 'ok', phase: 'final', late: false, changes: 1, ...more },
});

describe('Storage tab', () => {
  it('keeps Query beside Tables, blocks navigation while running and refreshes after SQL mutations', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Bread'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New Query' }));
    const editor = screen.getByRole('textbox', { name: /SQL editor/ });
    expect((editor as HTMLTextAreaElement).value).toBe('SELECT * FROM "item";');
    fireEvent.change(editor, { target: { value: "UPDATE item SET v='SQL' WHERE id=1" } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(h.sent.at(-1)).toMatchObject({ type: 'storageQuery', query: { name: 'shop.db', target: TARGET } });
    expect(screen.getByRole('button', { name: 'Tables' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true);
    await h.answer({
      ok: true,
      kind: 'query',
      target: TARGET,
      outcome: { opId: 'sql1', code: 'ok', phase: 'final', late: false, changes: 1 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(h.sent.at(-1)).toMatchObject({ type: 'storageRead', read: { pages: [{ table: 'item' }] } });
    await h.answer(rowsOf('item', [['1', str('SQL')]]));
    expect(screen.queryByRole('textbox', { name: 'New value of v' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'SQL' })).toBeTruthy();
  });

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
    // A database that can't be read is not a way in: it says why instead.
    expect(screen.getByRole('button', { name: 'Open database old.db' }).hasAttribute('disabled')).toBe(true);
    expect(
      screen
        .getAllByText('old.db')
        .find((element) => element.closest('[aria-disabled="true"]'))
        ?.closest('[aria-disabled="true"]'),
    ).toBeTruthy();
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
    openKey('session_token');
    expect(screen.getByText(/read-only: credential hidden by the linked SDK/)).toBeTruthy();
    expect(editButtons()).toHaveLength(0);
    editKey('big');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of big' }), {
      target: { value: '9223372036854775806' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
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
    // Changed in the app's memory only is not saved: no saved mark on the key, no tick.
    expect(keyRow('big').hasAttribute('data-saved')).toBe(false);
    expect(screen.getByRole('status').querySelector('.storage-tick')).toBeNull();
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
      // No two rows share a React key (the cut one would otherwise collide with the other).
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
      openKey(`${prefix}… (1030 chars)`);
      expect(editButtons()).toHaveLength(0);
      expect(screen.getByText(/read-only: the key is too long to send whole/)).toBeTruthy();
      // The editable one is the key itself, written as itself.
      openKey(prefix);
      expect(editButtons()).toHaveLength(1);
      fireEvent.click(editButtons()[0]!);
      fireEvent.change(screen.getAllByRole('textbox').at(-1)!, { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
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
    expect(screen.getByText('Read only')).toBeTruthy();
    openKey('count');
    expect(editButtons()).toHaveLength(0);
  });

  it('drops an answer for a target that is no longer shown: a slow read of A never edits B', async () => {
    const { answer, answerTo, lastId, writes } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['prefs_a', 'prefs_b']));
    fireEvent.click(screen.getByRole('button', { name: 'prefs_a' }));
    const readA = lastId();
    // Back to the stores, then B: A's read is of an older generation.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'prefs_b' }));
    await answer(BUSY);
    // A's answer comes last: it is not shown under B, so nothing of it can be edited.
    await answerTo(readA, prefsOf('prefs_a', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    expect(screen.queryByTestId('storage-prefs')).toBeNull();
    expect(editButtons()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    // B read for real: its own values, written to B.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'prefs_b' }));
    await answer(prefsOf('prefs_b', [{ key: 'count', value: { t: 'int', v: '5' } }]));
    editKey('count');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
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
    editKey('count');
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
    editKey('count');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
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
    expect(editButtons()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'p' })).toBeNull();
    // Another app (or the same one restarted: another pid) on the same device: the same.
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    openKey('count');
    expect(screen.getByRole('button', { name: 'Edit count' })).toBeTruthy();
    await setSession({ packageName: 'com.example.other' });
    expect(editButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '3' } }]));
    openKey('count');
    await setSession({ packageName: 'com.example.other', pid: 4321 });
    expect(editButtons()).toHaveLength(0);
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
    openKey('count');
    expect(editButtons()).toHaveLength(0);
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
    openKey('kkk… (5000 chars)');
    expect(editButtons()).toHaveLength(0);
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
    editKey('name');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of name' }), { target: { value: 'Bo' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
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
    // Provisional: not saved yet, no mark.
    expect(screen.getByRole('status').querySelector('.storage-tick')).toBeNull();
    await late({ ...base, phase: 'final', persisted: true });
    expect(screen.getByRole('status').textContent).not.toMatch(/still running/);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('opens a grid and stages a row edit with transaction readback', async () => {
    const { answer, writes } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf([], ['shop.db']));
    fireEvent.click(screen.getByRole('button', { name: 'shop.db' }));
    await answer(schemaOf('shop.db', ['item']));
    fireEvent.click(screen.getByRole('button', { name: 'item' }));
    await answer(pageOf('shop.db', 'item', 'Bread'));
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.click(screen.getByText('Bread').closest('tr')!);
    // Keys are editable; fields are staged until Apply.
    expect(screen.getByRole('button', { name: 'Edit id' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    expect(screen.getByRole('textbox', { name: 'New value of v' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Rye' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    expect(writes().at(-1)).toMatchObject({
      write: {
        store: 'db',
        name: 'shop.db',
        op: 'updateRow',
        table: 'item',
        pk: [{ t: 'integer', v: '1' }],
        edits: [{ column: 'v', expected: { t: 'string', v: 'Bread' }, value: { t: 'string', v: 'Rye' } }],
      },
    });
    await answer({
      ok: true,
      kind: 'write',
      target: TARGET,
      outcome: {
        opId: 'o2',
        pk: [{ t: 'integer', v: '1' }],
        storedFields: [{ column: 'v', value: str('Rye') }],
        code: 'ok',
        phase: 'final',
        late: false,
        changes: 1,
        observers: 'room_invalidation',
      },
    });
    // The committed readback updates the grid without racing another page read.
    const row = screen.getByText('Rye', { selector: 'td' }).closest('tr')!;
    expect(row.hasAttribute('data-saved')).toBe(true);
    expect(row.querySelector('td[data-changed]')?.textContent).toBe('Rye');
    expect(screen.getByRole('status').querySelector('.storage-tick')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Room was told the table changed/);
  });

  it('marks nothing saved for a late final outcome of a timed-out write', async () => {
    const { answer } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf([], ['shop.db']));
    fireEvent.click(screen.getByRole('button', { name: 'shop.db' }));
    await answer(schemaOf('shop.db', ['item']));
    fireEvent.click(screen.getByRole('button', { name: 'item' }));
    await answer(pageOf('shop.db', 'item', 'Bread'));
    fireEvent.click(screen.getByText('Bread').closest('tr')!);
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Rye' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    await answer({
      ok: true,
      kind: 'write',
      target: TARGET,
      outcome: { opId: 'o3', code: 'ok', phase: 'final', late: true, changes: 1 },
    });
    await answer(pageOf('shop.db', 'item', 'Rye'));
    expect(screen.getByText('Rye', { selector: 'td' }).closest('tr')!.hasAttribute('data-saved')).toBe(false);
    expect(screen.getByRole('status').textContent).toMatch(/after the request had timed out/);
  });

  it('groups read-only tables, collapsed, with a short reason and the whole one on hover', async () => {
    const { answer } = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await answer(listOf([], ['shop.db']));
    fireEvent.click(screen.getByRole('button', { name: 'shop.db' }));
    const schema = schemaOf('shop.db', ['item', 'item_names']) as Extract<
      StorageResponse,
      { kind: 'schema' }
    >;
    schema.tables[1]!.readOnly = 'view';
    await answer(schema);
    expect(screen.getByRole('button', { name: 'item' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^item_names/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show/ }));
    const view = screen.getByRole('button', { name: /^item_names/ });
    expect(view.textContent).toContain('view');
    expect(view.getAttribute('title')).toMatch(/read-only: a view/);
    // A filter shows matching tables of both groups.
    fireEvent.click(screen.getByRole('button', { name: /Hide/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'names' } });
    expect(screen.queryByRole('button', { name: 'item' })).toBeNull();
    expect(screen.getByRole('button', { name: /^item_names/ })).toBeTruthy();
  });
  it('keeps a draft on its row (by key) and the value it was read as across a Refresh', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Milk'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Cream' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    // The app changed the rows since: id 1 is gone, id 2 now at the top and changed, id 3 where id 2 was.
    await h.answer(
      rowsOf('item', [
        ['2', str('Oat milk')],
        ['3', str('Other')],
      ]),
    );
    expect(sheet()!.textContent).toContain('id = 2');
    expect(screen.getByText(/Apply compares with that|Save compares with that/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    expect(h.writes().at(-1)).toMatchObject({
      write: {
        pk: [{ t: 'integer', v: '2' }],
        edits: [{ column: 'v', expected: str('Milk'), value: str('Cream') }],
      },
    });
  });

  it.each<{ label: string; pk: string[]; columns: string[]; keys: StorageValue[] }>([
    { label: 'nullable', pk: ['id'], columns: ['id', 'v'], keys: [{ t: 'null' }] },
    {
      label: 'composite nullable',
      pk: ['id', 'part'],
      columns: ['id', 'part', 'v'],
      keys: [str('same'), { t: 'null' }],
    },
    { label: 'nonunique', pk: ['id'], columns: ['id', 'v'], keys: [str('same')] },
    { label: 'redacted', pk: ['id'], columns: ['id', 'v'], keys: [{ t: 'redacted', orig: 'string' }] },
    {
      label: 'cut string',
      pk: ['id'],
      columns: ['id', 'v'],
      keys: [{ t: 'string', v: 'prefix', complete: false, length: 10000 }],
    },
    {
      label: 'cut blob',
      pk: ['id'],
      columns: ['id', 'v'],
      keys: [{ t: 'blob', b64: 'YQ==', size: 10000, complete: false }],
    },
    { label: 'missing column', pk: ['id'], columns: ['v'], keys: [] },
    { label: 'missing cell', pk: ['id'], columns: ['v', 'id'], keys: [] },
    { label: 'no explicit key', pk: [], columns: ['v'], keys: [] },
  ])(
    'inspects exact rows with $label primary keys without offering unsafe writes',
    async ({ pk, columns, keys }) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const h = setup('read_write');
        await openItem(h);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        const response = rowsOf('item', []) as Extract<StorageResponse, { kind: 'pages' }>;
        Object.assign(response.pages[0]!, {
          pk,
          columns,
          rows: ['First unsafe row', 'Second unsafe row'].map((value) => ({
            cells: [...keys, str(value)],
            digest: 'a'.repeat(64),
          })),
        });
        await h.answer(response);
        for (const value of ['Second unsafe row', 'First unsafe row']) {
          fireEvent.click(rowOf(value));
          expect(within(sheet()!).getByText(value)).toBeTruthy();
          expect(editButtons()).toHaveLength(0);
          expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
        }
        expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
        expect(h.writes()).toHaveLength(0);
      } finally {
        errors.mockRestore();
      }
    },
  );

  it.each<{ pk: StorageValue[] }>([
    { pk: [str('group'), { t: 'integer', v: '7' }] },
    { pk: [{ t: 'blob', b64: 'YQ==', size: 1, complete: true }] },
  ])('keeps complete unique primary keys writable ($pk)', async ({ pk }) => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const response = pageOf('shop.db', 'item', '') as Extract<StorageResponse, { kind: 'pages' }>;
    const keyColumns = pk.map((_, index) => `key${index}`);
    Object.assign(response.pages[0]!, {
      pk: keyColumns,
      columns: [...keyColumns, 'v'],
      rows: [{ cells: [...pk, str('Before')], digest: 'a'.repeat(64) }],
    });
    await h.answer(response);
    fireEvent.click(rowOf('Before'));
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'After' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    expect(h.writes().at(-1)).toMatchObject({
      write: { pk, edits: [{ column: 'v', expected: str('Before'), value: str('After') }] },
    });
  });

  it('preserves every draft field after a conflicting Apply and shows the refreshed app value', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Milk'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Cream' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await h.answer(OK('w1', { code: 'conflict', currentFields: [{ column: 'v', value: str('Oat milk') }] }));
    await h.answer(
      rowsOf('item', [
        ['1', str('Bread')],
        ['2', str('Oat milk')],
      ]),
    );
    expect((screen.getByRole('textbox', { name: 'New value of v' }) as HTMLInputElement).value).toBe('Cream');
    expect(sheet()!.textContent).toContain('Oat milk');
    expect(sheet()!.textContent).toContain('Milk');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revert row edit' })).toBeNull();
  });

  it('drops drafts on an SDK replacement even when connected stays true', async () => {
    const h = setup('read_write');
    await h.setSession({
      sdk: {
        sdkVersion: '0.13.0',
        processName: 'com.example.shop',
        apiLevel: 28,
        connected: true,
        framesActive: false,
        linkGeneration: 1,
      },
    });
    await openItem(h);
    fireEvent.click(rowOf('Milk'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    await h.setSession({
      sdk: {
        sdkVersion: '0.13.0',
        processName: 'com.example.shop',
        apiLevel: 28,
        connected: true,
        framesActive: false,
        linkGeneration: 2,
      },
    });
    expect(screen.queryByRole('textbox', { name: 'New value of v' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Load storage' })).toBeTruthy();
  });

  it('does not carry a fallback row identity into a refreshed page or another cursor', async () => {
    const h = setup('read_write');
    await openItem(h);
    const nullablePage = (value: string, nextCursor: string | null = null) => {
      const response = pageOf('shop.db', 'item', value) as Extract<StorageResponse, { kind: 'pages' }>;
      response.pages[0]!.rows[0]!.cells[0] = { t: 'null' };
      response.pages[0]!.nextCursor = nextCursor;
      return response;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(nullablePage('First page', TOKEN));
    fireEvent.click(rowOf('First page'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(BUSY);
    expect(within(sheet()!).getByText('First page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(nullablePage('Replacement page', TOKEN));
    expect(sheet()).toBeNull();
    fireEvent.click(rowOf('Replacement page'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await h.answer(nullablePage('Next page'));
    expect(sheet()).toBeNull();
    fireEvent.click(rowOf('Next page'));
    expect(within(sheet()!).getByText('Next page')).toBeTruthy();
    expect(editButtons()).toHaveLength(0);
    expect(h.writes()).toHaveLength(0);
  });

  it('closes the sheet of a row a Refresh no longer shows', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Milk'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(rowsOf('item', [['1', str('Bread')]]));
    expect(sheet()).toBeNull();
  });

  it.each(['draft', 'delete'] as const)(
    'forgets a missing DB row and its $0 state when the same PK reappears',
    async (state) => {
      const h = setup('read_write');
      await openItem(h);
      fireEvent.click(rowOf('Milk'));
      if (state === 'draft') {
        fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), {
          target: { value: 'Cream' },
        });
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await h.answer(rowsOf('item', [['1', str('Bread')]]));
      expect(sheet()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await h.answer(rowsOf('item', SHOP_ROWS));
      expect(sheet()).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /^(Save|Apply)$/ })).toBeNull();
      expect(h.writes()).toHaveLength(0);
      fireEvent.click(rowOf('Milk'));
      expect((screen.getByRole('button', { name: 'Edit v' }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole('button', { name: 'Delete row' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Delete id =/ })).toBeNull();
    },
  );

  it('forgets a missing prefs key and its draft when the same key reappears', async () => {
    const h = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await h.answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    const entries: StoragePrefsEntry[] = [{ key: 'count', value: { t: 'int', v: '3' } }];
    await h.answer(prefsOf('p', entries));
    editKey('count');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(prefsOf('p', []));
    expect(screen.queryByRole('dialog', { name: 'Key' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(prefsOf('p', entries));
    expect(screen.queryByRole('dialog', { name: 'Key' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(h.writes()).toHaveLength(0);
    openKey('count');
    expect((screen.getByRole('button', { name: 'Edit count' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('preserves a DB draft across failed reads without rebasing its expected snapshot', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Milk'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Cream' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(BUSY);
    expect((screen.getByRole('textbox', { name: 'New value of v' }) as HTMLInputElement).value).toBe('Cream');
    expect(sheet()!.textContent).toContain('id = 2');
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    expect(h.writes().at(-1)).toMatchObject({
      write: {
        pk: [{ t: 'integer', v: '2' }],
        edits: [{ column: 'v', expected: str('Milk'), value: str('Cream') }],
        target: TARGET,
      },
    });
  });

  it('preserves a prefs draft across filtering and failed reads with its original expected snapshot', async () => {
    const h = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await h.answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    const entries: StoragePrefsEntry[] = [{ key: 'count', value: { t: 'int', v: '3' } }];
    await h.answer(prefsOf('p', entries));
    editKey('count');
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of count' }), { target: { value: '4' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not present' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(prefsOf('p', entries));
    expect((screen.getByRole('textbox', { name: 'New value of count' }) as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(BUSY);
    expect((screen.getByRole('textbox', { name: 'New value of count' }) as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(prefsOf('p', [{ key: 'count', value: { t: 'int', v: '9' } }]));
    expect(screen.getByText(/Apply compares with that|Save compares with that/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^(Save|Apply)$/ }));
    expect(h.writes().at(-1)).toMatchObject({
      write: { key: 'count', expected: { t: 'int', v: '3' }, value: { t: 'int', v: '4' }, target: TARGET },
    });
  });

  it('reconciles the latest sheet when the user switches rows while Refresh is pending', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Bread'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(rowOf('Milk'));
    await h.answer(rowsOf('item', [['1', str('Bread')]]));
    expect(sheet()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(rowsOf('item', SHOP_ROWS));
    expect(sheet()).toBeNull();
  });

  it('ends a draft and an armed Delete when another row or key opens, or the sheet closes', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Bread'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.click(rowOf('Milk'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Edit v' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(screen.getByRole('button', { name: 'Delete id = 2?' })).toBeTruthy();
    fireEvent.click(rowOf('Bread'));
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeTruthy();
    expect(h.writes()).toHaveLength(0);
  });

  it('ends a prefs draft when its sheet closes: the next key can be edited', async () => {
    const h = setup('read_write');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await h.answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    await h.answer(
      prefsOf('p', [
        { key: 'a', value: { t: 'int', v: '1' } },
        { key: 'b', value: { t: 'int', v: '2' } },
      ]),
    );
    editKey('a');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openKey('b');
    expect((screen.getByRole('button', { name: 'Edit b' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a row outcome and revert on the row it edited, with its confirmed new key', async () => {
    const h = setup('read_write');
    await openItem(h);
    fireEvent.click(rowOf('Bread'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit id' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of id' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: 'Rye' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const pk = [{ t: 'integer' as const, v: '7' }];
    await h.answer(
      OK('w1', {
        pk,
        storedFields: [
          { column: 'id', value: pk[0]! },
          { column: 'v', value: str('Rye') },
        ],
        undo: {
          store: 'db',
          name: 'shop.db',
          op: 'updateRow',
          table: 'item',
          pk,
          edits: [
            { column: 'id', expected: pk[0]!, value: { t: 'integer', v: '1' } },
            { column: 'v', expected: str('Rye'), value: str('Bread') },
          ],
          undoOf: 'w1',
          target: TARGET,
        },
      }),
    );
    expect(sheet()!.textContent).toContain('id = 7');
    expect(sheet()!.querySelector('.storage-field-outcome .storage-tick')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revert row edit' })).toBeTruthy();
    expect(h.writes().at(-1)?.write).toMatchObject({
      op: 'updateRow',
      pk: [{ t: 'integer', v: '1' }],
      edits: [
        { column: 'id', expected: { t: 'integer', v: '1' }, value: pk[0] },
        { column: 'v', expected: str('Bread'), value: str('Rye') },
      ],
    });
    fireEvent.click(rowOf('Milk'));
    expect(within(sheet()!).queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revert row edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('status').textContent).toMatch(/^item · 1 · row edit: /);
    expect(screen.getByRole('button', { name: 'Revert row edit' })).toBeTruthy();
  });

  it('uses transaction readback and removes saved marks when a later read sees another value', async () => {
    const h = setup('read_write');
    const real = (v: string): StorageValue => ({
      t: 'real',
      v,
      bits: v === '0.0' ? '0x0000000000000000' : '0x3ff0000000000000',
    });
    await openItem(h, [['1', real('1.0')]], true);
    fireEvent.click(rowOf('1.0'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit v' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value of v' }), { target: { value: '-0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await h.answer(
      OK('w1', {
        normalized: true,
        pk: [{ t: 'integer', v: '1' }],
        storedFields: [{ column: 'v', value: real('0.0') }],
      }),
    );
    expect(within(sheet()!).getByRole('status').textContent).toMatch(/Stored v: 0\.0/);
    expect(rowOf('0.0').hasAttribute('data-saved')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await h.answer(rowsOf('item', [['1', { t: 'real', v: '5.0', bits: '0x4014000000000000' }]]));
    expect(rowOf('5.0').hasAttribute('data-saved')).toBe(false);
    expect(within(sheet()!).getByRole('status').textContent).toMatch(/Stored v: 0\.0/);
  });

  it('does not stay busy after leaving a view whose read was still running', async () => {
    const h = setup('read');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await h.answer(listOf(['p']));
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    const read = h.lastId();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    await h.answerTo(read, prefsOf('p', [{ key: 'a', value: { t: 'int', v: '1' } }]));
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    // A newer read keeps its own busy state until its own answer.
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the tables again on Refresh at the tables level', async () => {
    const h = setup('read');
    fireEvent.click(screen.getByRole('button', { name: 'Load storage' }));
    await h.answer(listOf([], ['shop.db']));
    fireEvent.click(screen.getByRole('button', { name: 'shop.db' }));
    await h.answer(schemaOf('shop.db', ['item']));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(h.sent.at(-1)).toMatchObject({ type: 'storageRead', read: { store: 'db', name: 'shop.db' } });
    expect((h.sent.at(-1) as Extract<ClientMessage, { type: 'storageRead' }>).read).not.toHaveProperty(
      'pages',
    );
    await h.answer(schemaOf('shop.db', ['item', 'order_line']));
    expect(screen.getByRole('button', { name: 'order_line' })).toBeTruthy();
  });
});

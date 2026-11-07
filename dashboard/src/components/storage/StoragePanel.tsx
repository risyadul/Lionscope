import { memo, useCallback, useRef, useState } from 'react';
import type {
  StorageAuditEntry,
  StorageConsent,
  StorageDatabase,
  StoragePage,
  StoragePrefsEntry,
  StoragePrefsFile,
  StorageResponse,
  StorageTable,
  StorageTarget,
  StorageValue,
  StorageWriteInput,
  StorageWriteOutcome,
} from '@lionscope/protocol/wire';
import { useServices } from '../../app/services.ts';
import { useStorage } from '../../hooks/useStorage.ts';
import {
  affinityOf,
  auditText,
  cellReadOnly,
  displayValue,
  editText,
  isEditable,
  outcomeText,
  parseValue,
  readOnlyText,
  sameTarget,
} from '../../lib/storage.ts';
import type { StorageAnswer, StorageOutcomeNotice } from '../../lib/store.ts';
import './storage.css';

type Selected = { store: 'prefs'; name: string } | { store: 'db'; name: string };

interface Listing {
  target: StorageTarget;
  prefs: StoragePrefsFile[];
  prefsTruncated: boolean;
  databases: StorageDatabase[];
}

/** A prefs page, with the app link it was read from (a write names it: the server refuses it on another link). */
interface PrefsView {
  name: string;
  target: StorageTarget;
  entries: StoragePrefsEntry[];
  /** Cursors of the pages read so far, the shown one last (null: the first page). */
  cursors: (string | null)[];
  nextCursor: string | null;
  truncated: boolean;
}

interface DbView {
  name: string;
  target: StorageTarget;
  tables: StorageTable[];
  tablesTruncated: boolean;
  table: string | null;
  page: { page: StoragePage; target: StorageTarget } | null;
  cursors: (string | null)[];
}

interface Editing {
  /** prefs key, or `row:column` of a page cell. */
  id: string;
  text: string;
  error: string | null;
}

interface LastWrite {
  outcome: StorageWriteOutcome;
}

const PAGE_ROWS = 50;

/** The type a value is shown with. */
function typeLabel(value: StorageValue): string {
  return value.t === 'redacted' ? `${value.orig} · redacted` : value.t;
}

function ValueText({ value }: { value: StorageValue }) {
  return (
    <span className="storage-value mono" data-type={value.t}>
      {displayValue(value)}
    </span>
  );
}

type Props = {
  consent: StorageConsent;
  /** This client's storage answers (DashboardState.storageAnswers). */
  answers: readonly StorageAnswer[];
  /** Final outcomes that came after their answer (DashboardState.storageOutcomes). */
  outcomes: readonly StorageOutcomeNotice[];
  /** A profiling session is running (storage goes through its SDK link). */
  isRunning: boolean;
  /**
   * Which session (device, app, process, start) is running; everything read or offered (edit, delete, undo) is
   * dropped when it changes, and when the session stops.
   */
  sessionKey: string;
};

/**
 * Storage tab (0.13.0): the session app's prefs and registered Room databases, read and edited live. Memoized: it
 * re-renders on its own props, not on every live-session flush.
 *
 * Answers are only taken for what is shown now: each navigation (another file, table, page, a new session) starts a
 * new generation and an answer of an older one is dropped, so a slow read of one target never fills the view of
 * another. Every edit names the app link its values were read from (`target`): the server refuses it on another.
 */
export const StoragePanel = memo(function StoragePanel(props: Props) {
  // A new session (or none) mounts a fresh tab: nothing read, offered or pending of the old one survives it.
  return <StorageTab key={props.sessionKey} {...props} />;
});

function StorageTab({ consent, answers, outcomes, isRunning }: Props) {
  const { send } = useServices();
  const storage = useStorage(send, answers);
  const canWrite = consent === 'read_write';

  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [prefsView, setPrefsView] = useState<PrefsView | null>(null);
  const [dbView, setDbView] = useState<DbView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [lastWrite, setLastWrite] = useState<LastWrite | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [audit, setAudit] = useState<StorageAuditEntry[] | null>(null);

  /** The view's generation: an answer to a request of an older one is dropped. */
  const generation = useRef(0);
  /** A write is on its way: another Save / Delete / Undo is ignored until it is answered. */
  const writing = useRef(false);

  /** Starts a new generation: nothing on screen may be edited from an answer of before. */
  const begin = useCallback(() => {
    generation.current += 1;
    setEditing(null);
    setConfirmDelete(null);
    return generation.current;
  }, []);

  /**
   * Runs one request for generation [gen]: its answer (or its error) only lands while that generation is current.
   * null when it failed or is stale.
   */
  const run = useCallback(
    async (gen: number, call: () => Promise<StorageResponse>): Promise<StorageResponse | null> => {
      setBusy(true);
      setError(null);
      const response = await call();
      if (gen !== generation.current) return null;
      setBusy(false);
      if (!response.ok) {
        setError(`${response.code}: ${response.message}`);
        return null;
      }
      return response;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const gen = begin();
    setSelected(null);
    setPrefsView(null);
    setDbView(null);
    setLastWrite(null);
    const response = await run(gen, storage.list);
    if (response?.ok && response.kind === 'list') {
      setListing({
        target: response.target,
        prefs: response.prefs,
        prefsTruncated: response.prefsTruncated,
        databases: response.databases,
      });
    }
  }, [begin, run, storage.list]);

  const loadPrefs = useCallback(
    async (gen: number, name: string, cursors: (string | null)[]) => {
      const cursor = cursors.at(-1) ?? null;
      const response = await run(gen, () =>
        storage.read({ store: 'prefs', name, ...(cursor ? { cursor } : {}) }),
      );
      if (response?.ok && response.kind === 'prefs') {
        setPrefsView({
          name,
          target: response.target,
          entries: response.entries,
          cursors,
          nextCursor: response.nextCursor,
          truncated: response.truncated,
        });
      }
    },
    [run, storage],
  );

  const loadPage = useCallback(
    async (gen: number, view: DbView, table: string, cursors: (string | null)[]) => {
      const cursor = cursors.at(-1) ?? null;
      const response = await run(gen, () =>
        storage.read({ store: 'db', name: view.name, pages: [{ table, cursor, limit: PAGE_ROWS }] }),
      );
      if (response?.ok && response.kind === 'pages') {
        const page = response.pages[0];
        setDbView({ ...view, table, cursors, page: page ? { page, target: response.target } : null });
      }
    },
    [run, storage],
  );

  const open = useCallback(
    async (next: Selected) => {
      const gen = begin();
      setSelected(next);
      setPrefsView(null);
      setDbView(null);
      setLastWrite(null);
      if (next.store === 'prefs') return loadPrefs(gen, next.name, [null]);
      const response = await run(gen, () => storage.read({ store: 'db', name: next.name }));
      if (response?.ok && response.kind === 'schema') {
        setDbView({
          name: next.name,
          target: response.target,
          tables: response.tables,
          tablesTruncated: response.tablesTruncated,
          table: null,
          page: null,
          cursors: [null],
        });
      }
    },
    [begin, loadPrefs, run, storage],
  );

  const openTable = useCallback(
    async (name: string) => {
      if (!dbView) return;
      const gen = begin();
      const view = { ...dbView, table: name, page: null, cursors: [null] };
      setDbView(view);
      await loadPage(gen, view, name, [null]);
    },
    [begin, dbView, loadPage],
  );

  /** Reads the shown page again (after a write), in the generation that is current. */
  const reload = useCallback(async () => {
    const gen = generation.current;
    if (prefsView) return loadPrefs(gen, prefsView.name, prefsView.cursors);
    if (dbView?.table) return loadPage(gen, dbView, dbView.table, dbView.cursors);
  }, [dbView, loadPage, loadPrefs, prefsView]);

  const loadAudit = useCallback(async () => {
    const gen = generation.current;
    const response = await run(gen, storage.audit);
    if (response?.ok && response.kind === 'audit') setAudit(response.entries);
  }, [run, storage]);

  const submit = useCallback(
    async (write: StorageWriteInput) => {
      if (writing.current) return;
      writing.current = true;
      const gen = generation.current;
      setEditing(null);
      setConfirmDelete(null);
      // A new write ends the offer of the last one's undo (it would revert under the new value).
      setLastWrite(null);
      try {
        const response = await run(gen, () => storage.write(write));
        if (gen !== generation.current) return;
        if (response?.ok && response.kind === 'write') setLastWrite({ outcome: response.outcome });
      } finally {
        writing.current = false;
      }
      await reload();
      if (audit !== null) await loadAudit();
    },
    [audit, loadAudit, reload, run, storage],
  );

  const savePrefs = (view: PrefsView, entry: StoragePrefsEntry) => {
    // A cut key is only a prefix: written as a key it would name another one.
    if (!editing || entry.keyLength !== undefined) return;
    const parsed = parseValue(editing.text, entry.value);
    if ('error' in parsed) return setEditing({ ...editing, error: parsed.error });
    void submit({
      store: 'prefs',
      name: view.name,
      op: 'update',
      key: entry.key,
      expected: entry.value,
      value: parsed.value,
      target: view.target,
    });
  };

  const saveCell = (view: DbView, shown: StoragePage, target: StorageTarget, row: number, column: string) => {
    if (!editing) return;
    const cells = shown.rows[row]?.cells ?? [];
    const current = cells[shown.columns.indexOf(column)];
    if (!current) return;
    const schema = view.tables.find((candidate) => candidate.name === shown.table);
    const parsed =
      editing.text === '' && current.t !== 'string'
        ? { value: { t: 'null' } as StorageValue }
        : parseValue(editing.text, current, affinityOf(schema, column));
    if ('error' in parsed) return setEditing({ ...editing, error: parsed.error });
    void submit({
      store: 'db',
      name: view.name,
      op: 'update',
      table: shown.table,
      column,
      pk: shown.pk.map((key) => cells[shown.columns.indexOf(key)]!),
      expected: current,
      value: parsed.value,
      target,
    });
  };

  const deleteRow = (view: DbView, shown: StoragePage, target: StorageTarget, row: number) => {
    const cells = shown.rows[row]?.cells ?? [];
    const digest = shown.rows[row]?.digest;
    if (!digest) return;
    void submit({
      store: 'db',
      name: view.name,
      op: 'delete',
      table: shown.table,
      pk: shown.pk.map((key) => cells[shown.columns.indexOf(key)]!),
      rowDigest: digest,
      target,
    });
  };

  if (consent === 'off') {
    return (
      <section className="storage" aria-label="Storage">
        <p className="storage-note" data-testid="storage-consent-off">
          Storage is off. Start Lionscope with <code>--allow-storage-read</code> to read the app’s
          SharedPreferences and the Room databases it registers (<code>Lionscope.trackDatabase</code>), and{' '}
          <code>--allow-storage-write</code> as well to edit them.
        </p>
      </section>
    );
  }

  // A provisional answer shows its final outcome once that came (it carries no undo).
  const final =
    lastWrite?.outcome.phase === 'provisional'
      ? outcomes.find((notice) => notice.outcome.opId === lastWrite.outcome.opId)?.outcome
      : undefined;
  const written = lastWrite && (final ? { outcome: final } : lastWrite);
  const shown = dbView?.page ?? null;
  const page = shown?.page ?? null;
  const pkMissing = page !== null && page.pk.some((key) => !page.columns.includes(key));
  // Only what the latest list answer's link shows may be edited (a reconnect makes another link).
  const stale = (target: StorageTarget) => listing !== null && !sameTarget(listing.target, target);

  return (
    <section className="storage" aria-label="Storage">
      <div className="storage-head">
        <button type="button" className="btn" onClick={() => void refresh()} disabled={busy || !isRunning}>
          {listing ? 'Refresh' : 'Load storage'}
        </button>
        <button type="button" className="btn" onClick={() => void loadAudit()} disabled={busy || !isRunning}>
          {audit ? 'Refresh audit' : 'Write audit'}
        </button>
        <span className="storage-meta">
          {canWrite ? 'Read and edit' : 'Read only (--allow-storage-write is off)'}
          {busy ? ' · working…' : ''}
        </span>
      </div>
      {!isRunning && (
        <p className="storage-note">
          Start a profiling session of an app with the Lionscope SDK 0.13.0 or newer.
        </p>
      )}
      {error && (
        <p className="storage-error" role="alert">
          {error}
        </p>
      )}
      {written && (
        <div className="storage-outcome" role="status" data-code={written.outcome.code}>
          <span>{outcomeText(written.outcome)}</span>
          {written.outcome.current && (
            <span>
              {' '}
              Current value: <ValueText value={written.outcome.current} />
            </span>
          )}
          {written.outcome.undo && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                const undo = written.outcome.undo!;
                setLastWrite(null);
                void submit(undo);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {listing && ((prefsView && stale(prefsView.target)) || (shown && stale(shown.target))) && (
        <p className="storage-note" role="alert">
          The app’s SDK link changed since the list was read (a reconnect or a restart): Refresh to edit
          again.
        </p>
      )}
      {listing && (
        <div className="storage-targets">
          <h3 className="overline">SharedPreferences</h3>
          {listing.prefs.length === 0 && <p className="storage-note">No prefs files.</p>}
          <ul>
            {listing.prefs.map((file) => (
              <li key={`p:${file.name}`}>
                <button
                  type="button"
                  className="storage-target"
                  aria-pressed={selected?.store === 'prefs' && selected.name === file.name}
                  onClick={() => void open({ store: 'prefs', name: file.name })}
                >
                  {file.name}
                  {file.backupOnly ? ' (backup only)' : ''}
                </button>
              </li>
            ))}
          </ul>
          {listing.prefsTruncated && <p className="storage-note">More files than listed.</p>}
          <h3 className="overline">Databases</h3>
          {listing.databases.length === 0 && (
            <p className="storage-note">
              None registered. The app registers them with Lionscope.trackDatabase.
            </p>
          )}
          <ul>
            {listing.databases.map((db) => (
              <li key={`d:${db.name}`}>
                <button
                  type="button"
                  className="storage-target"
                  disabled={db.status !== 'ok'}
                  title={db.status === 'ok' ? undefined : readOnlyText(db.status)}
                  aria-pressed={selected?.store === 'db' && selected.name === db.name}
                  onClick={() => void open({ store: 'db', name: db.name })}
                >
                  {db.name}
                  {db.status !== 'ok' ? ` (${readOnlyText(db.status)})` : ''}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {prefsView && (
        <div className="storage-body" data-testid="storage-prefs">
          <p className="storage-note">
            Values as the app holds them in memory (its own SharedPreferences instance, main process only),
            not necessarily what is on disk.
          </p>
          <table className="storage-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Type</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {prefsView.entries.map((entry) => {
                // A cut key shows the same text as the key its prefix names: keyLength keeps the two apart.
                const keyCut = entry.keyLength !== undefined;
                const id = keyCut ? `k:${entry.key}:${entry.keyLength}` : `k:${entry.key}`;
                const editable = canWrite && !keyCut && !stale(prefsView.target) && isEditable(entry.value);
                return (
                  <tr key={id}>
                    <td className="mono">
                      {entry.key}
                      {keyCut ? `… (${entry.keyLength} chars)` : ''}
                    </td>
                    <td className="storage-type">{typeLabel(entry.value)}</td>
                    <td>
                      {editing?.id === id ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            savePrefs(prefsView, entry);
                          }}
                        >
                          <input
                            aria-label={`New value of ${entry.key}`}
                            className="mono"
                            value={editing.text}
                            onChange={(event) =>
                              setEditing({ ...editing, text: event.target.value, error: null })
                            }
                            autoFocus
                          />
                          <button type="submit" className="btn" disabled={busy}>
                            Save
                          </button>
                          <button type="button" className="btn" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          {editing.error && <span className="storage-error">{editing.error}</span>}
                        </form>
                      ) : (
                        <>
                          <ValueText value={entry.value} />
                          {editable ? (
                            <button
                              type="button"
                              className="btn storage-edit"
                              disabled={busy}
                              onClick={() => setEditing({ id, text: editText(entry.value), error: null })}
                            >
                              Edit
                            </button>
                          ) : keyCut ? (
                            <span className="storage-reason">
                              read-only: the key is too long to send whole
                            </span>
                          ) : entry.value.t === 'redacted' ? (
                            <span className="storage-reason">read-only: {readOnlyText('redacted')}</span>
                          ) : (
                            !isEditable(entry.value) &&
                            canWrite && (
                              <span className="storage-reason">
                                read-only:{' '}
                                {entry.value.t === 'stringSet' && entry.value.complete === false
                                  ? readOnlyText('truncated')
                                  : entry.value.t === 'string'
                                    ? readOnlyText('truncated')
                                    : 'sets are edited from an agent (write_storage)'}
                              </span>
                            )
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="storage-paging">
            <button
              type="button"
              className="btn"
              disabled={busy || prefsView.cursors.length < 2}
              onClick={() => {
                const gen = begin();
                void loadPrefs(gen, prefsView.name, prefsView.cursors.slice(0, -1));
              }}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || prefsView.nextCursor === null}
              onClick={() => {
                const gen = begin();
                void loadPrefs(gen, prefsView.name, [...prefsView.cursors, prefsView.nextCursor]);
              }}
            >
              Next
            </button>
            {prefsView.truncated && (
              <span className="storage-note">Keys cut to stay under the answer size: Next continues.</span>
            )}
            {prefsView.nextCursor !== null && !prefsView.truncated && (
              <span className="storage-note">More keys: Next continues.</span>
            )}
          </div>
        </div>
      )}
      {dbView && (
        <div className="storage-body">
          <ul className="storage-tables">
            {dbView.tables.map((candidate) => (
              <li key={candidate.name}>
                <button
                  type="button"
                  className="storage-target"
                  aria-pressed={dbView.table === candidate.name}
                  onClick={() => void openTable(candidate.name)}
                >
                  {candidate.name}
                </button>
                {candidate.readOnly && (
                  <span className="storage-reason">read-only: {readOnlyText(candidate.readOnly)}</span>
                )}
              </li>
            ))}
          </ul>
          {dbView.tablesTruncated && <p className="storage-note">More tables than listed.</p>}
          {shown && page && (
            <>
              <p className="storage-note">
                Read in one transaction: consistent within this read only. Reading holds the app’s database
                writers while it runs (a budget of 250 ms, checked between statements: a slow statement can
                run past it).
                {page.readOnly ? ` Read-only: ${readOnlyText(page.readOnly)}.` : ''}
              </p>
              <table className="storage-table">
                <thead>
                  <tr>
                    {page.columns.map((column) => (
                      <th key={column} className="mono">
                        {column}
                        {page.pk.includes(column) ? ' (key)' : ''}
                      </th>
                    ))}
                    {canWrite && !page.readOnly && <th aria-label="Row actions" />}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.cells.map((cell, columnIndex) => {
                        const column = page.columns[columnIndex] ?? '';
                        const id = `${rowIndex}:${column}`;
                        const reason = cellReadOnly(page, column, cell);
                        return (
                          <td key={id} title={reason ? `read-only: ${reason}` : typeLabel(cell)}>
                            {editing?.id === id ? (
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  saveCell(dbView, page, shown.target, rowIndex, column);
                                }}
                              >
                                <input
                                  aria-label={`New value of ${column}`}
                                  className="mono"
                                  value={editing.text}
                                  onChange={(event) =>
                                    setEditing({ ...editing, text: event.target.value, error: null })
                                  }
                                  autoFocus
                                />
                                <button type="submit" className="btn" disabled={busy}>
                                  Save
                                </button>
                                <button type="button" className="btn" onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                                {editing.error && <span className="storage-error">{editing.error}</span>}
                              </form>
                            ) : canWrite && reason === null && !pkMissing && !stale(shown.target) ? (
                              <button
                                type="button"
                                className="storage-cell"
                                disabled={busy}
                                onClick={() => setEditing({ id, text: editText(cell), error: null })}
                              >
                                <ValueText value={cell} />
                              </button>
                            ) : (
                              <ValueText value={cell} />
                            )}
                          </td>
                        );
                      })}
                      {canWrite && !page.readOnly && (
                        <td>
                          {row.digest && !pkMissing && !stale(shown.target) && (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() =>
                                confirmDelete === rowIndex
                                  ? deleteRow(dbView, page, shown.target, rowIndex)
                                  : setConfirmDelete(rowIndex)
                              }
                            >
                              {confirmDelete === rowIndex ? 'Confirm delete' : 'Delete'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="storage-paging">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || dbView.cursors.length < 2}
                  onClick={() => {
                    const gen = begin();
                    void loadPage(gen, dbView, page.table, dbView.cursors.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || page.nextCursor === null}
                  onClick={() => {
                    const gen = begin();
                    void loadPage(gen, dbView, page.table, [...dbView.cursors, page.nextCursor]);
                  }}
                >
                  Next
                </button>
                {page.truncated && (
                  <span className="storage-note">
                    Rows or values cut to stay under the answer size: Next continues.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {audit && (
        <div className="storage-audit" data-testid="storage-audit">
          <h3 className="overline">Write audit (this server run, no values)</h3>
          {audit.length === 0 ? (
            <p className="storage-note">No writes yet.</p>
          ) : (
            <ul>
              {audit
                .slice()
                .reverse()
                .map((entry) => (
                  <li key={`${entry.opId}:${entry.ts}:${entry.phase ?? ''}`} className="mono">
                    {auditText(entry)}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      {outcomes.length > 0 && (
        <div className="storage-late">
          <h3 className="overline">Final outcomes after the answer</h3>
          <ul>
            {outcomes
              .slice()
              .reverse()
              .map(({ serial, outcome }) => (
                <li key={`${serial}:${outcome.opId}`} className="mono">
                  {outcome.opId.slice(0, 8)} · {outcomeText(outcome)}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

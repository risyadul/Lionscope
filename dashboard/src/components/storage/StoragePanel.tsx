import { memo, useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
  readOnlyChip,
  readOnlyText,
  sameTarget,
  showsSaved,
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
  page: { page: StoragePage; target: StorageTarget; scope: number } | null;
  cursors: (string | null)[];
}

type PrefsUpdate = Extract<StorageWriteInput, { store: 'prefs'; op: 'update' }>;
type DbUpdate = Extract<StorageWriteInput, { store: 'db'; op: 'update' }>;

/**
 * A draft of one field. What it writes (the key, or the row by its key and the column, the value it was read as,
 * the link) is taken when Edit is pressed: a refresh, a late page or another row never changes it.
 */
interface Editing {
  /** The field: the same id as [fieldId] of its write. */
  id: string;
  text: string;
  error: string | null;
  base: Omit<PrefsUpdate, 'value'> | Omit<DbUpdate, 'value'>;
  /** A database column's declared affinity (how the text is read). */
  affinity?: 'string' | 'integer' | 'real';
}

interface LastWrite {
  outcome: StorageWriteOutcome;
  /** What was sent: the row or key it names gets the saved mark when the outcome allows it. */
  write: StorageWriteInput;
  /** Counts writes, so the mark plays again for a second edit of the same row. */
  seq: number;
}

/**
 * The open row: a prefs entry or a table row by its usable primary key. Read-only rows without a unique usable
 * key have an identity valid only for that page read. Confirmed absence ends the sheet and its draft.
 */
type Sheet = { store: 'prefs'; id: string } | { store: 'db'; table: string; row: string };

function prefsIdentity(entry: StoragePrefsEntry): string {
  return entry.keyLength === undefined ? `k:${entry.key}` : `k:${entry.key}:${entry.keyLength}`;
}

/** Which field a write names: a prefs key, or a table's row (by its key) and column (none for a delete). */
function fieldId(write: StorageWriteInput): string {
  if (write.store === 'prefs') return `p\u0000${write.name}\u0000${write.key}`;
  const column = write.op === 'update' ? write.column : '';
  return `d\u0000${write.name}\u0000${write.table}\u0000${JSON.stringify(write.pk)}\u0000${column}`;
}

/** What a write names, for an outcome shown away from its field. */
function writeLabel(write: StorageWriteInput): string {
  if (write.store === 'prefs') return `${write.name} · ${write.key}`;
  const key = write.pk.map(displayValue).join(', ');
  return write.op === 'update'
    ? `${write.table} · ${key} · ${write.column}`
    : `${write.table} · ${key} · delete`;
}

/** Only complete, non-NULL SQLite keys can address a write; rowid is never a substitute. */
function rowIdentities(page: StoragePage, scope: number) {
  const keys = page.rows.map(({ cells }) => {
    const pk = page.pk.map((key) => cells[page.columns.indexOf(key)]);
    return pk.length > 0 &&
      pk.every(
        (value) =>
          value !== undefined &&
          (value.t === 'integer' ||
            value.t === 'real' ||
            (value.t === 'string' && value.complete !== false) ||
            (value.t === 'blob' && value.complete)),
      )
      ? (pk as StorageValue[])
      : null;
  });
  const counts = new Map<string, number>();
  for (const pk of keys) {
    if (pk === null) continue;
    const key = JSON.stringify(pk);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return keys.map((pk, index) => {
    const key = JSON.stringify(pk);
    return pk !== null && counts.get(key) === 1 ? { key, pk } : { key: `#${scope}:${index}`, pk: null };
  });
}

const sameValue = (a: StorageValue | undefined, b: StorageValue | undefined) =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [audit, setAudit] = useState<StorageAuditEntry[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // Reads reconcile the sheet open when they finish, not the one open when they started.
  const currentSheet = useRef<Sheet | null>(null);
  const [filter, setFilter] = useState('');
  const [readOnlyOpen, setReadOnlyOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  /** Which way the last navigation went: the new level slides in from that side. */
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const writes = useRef(0);
  const pages = useRef(0);

  /** The view's generation: an answer to a request of an older one is dropped. */
  const generation = useRef(0);
  /** A write is on its way: another Save / Delete / Undo is ignored until it is answered. */
  const writing = useRef(false);
  /** The request that owns the busy state: only its own completion ends it (a newer one takes it over). */
  const request = useRef(0);

  /** Starts a new generation: nothing on screen may be edited from an answer of before. */
  const begin = useCallback(() => {
    generation.current += 1;
    // What the view left was waiting for is not this view's: it no longer holds it busy.
    request.current += 1;
    setBusy(false);
    setEditing(null);
    setConfirmDelete(false);
    currentSheet.current = null;
    setSheet(null);
    return generation.current;
  }, []);

  /** Opens another row or key (or none): a draft or an armed Delete of the one before ends with it. */
  const openSheet = useCallback((next: Sheet | null) => {
    setEditing(null);
    setConfirmDelete(false);
    currentSheet.current = next;
    setSheet(next);
  }, []);

  /**
   * Runs one request for generation [gen]: its answer (or its error) only lands while that generation is current.
   * null when it failed or is stale.
   */
  const run = useCallback(
    async (gen: number, call: () => Promise<StorageResponse>): Promise<StorageResponse | null> => {
      const own = ++request.current;
      setBusy(true);
      setError(null);
      const response = await call();
      if (own === request.current) setBusy(false);
      if (gen !== generation.current) return null;
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
    setAuditOpen(false);
    setFilter('');
    setDirection('out');
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
        const open = currentSheet.current;
        if (open?.store === 'prefs' && !response.entries.some((entry) => prefsIdentity(entry) === open.id)) {
          openSheet(null);
        }
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
    [openSheet, run, storage],
  );

  const loadPage = useCallback(
    async (gen: number, view: DbView, table: string, cursors: (string | null)[]) => {
      const cursor = cursors.at(-1) ?? null;
      const response = await run(gen, () =>
        storage.read({ store: 'db', name: view.name, pages: [{ table, cursor, limit: PAGE_ROWS }] }),
      );
      if (response?.ok && response.kind === 'pages') {
        const page = response.pages[0];
        const scope = ++pages.current;
        const open = currentSheet.current;
        if (
          open?.store === 'db' &&
          (open.table !== table ||
            !page ||
            !rowIdentities(page, scope).some((identity) => identity.key === open.row))
        ) {
          openSheet(null);
        }
        setDbView({ ...view, table, cursors, page: page ? { page, target: response.target, scope } : null });
      }
    },
    [openSheet, run, storage],
  );

  const open = useCallback(
    async (next: Selected) => {
      const gen = begin();
      setSelected(next);
      setPrefsView(null);
      setDbView(null);
      setLastWrite(null);
      setFilter('');
      setReadOnlyOpen(false);
      setDirection('in');
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
      setDirection('in');
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

  /** Reads the shown database's tables again. */
  const reloadSchema = useCallback(async () => {
    if (!dbView) return;
    const gen = generation.current;
    const name = dbView.name;
    const response = await run(gen, () => storage.read({ store: 'db', name }));
    if (response?.ok && response.kind === 'schema') {
      setDbView((view) =>
        view && view.name === name && view.table === null
          ? {
              ...view,
              target: response.target,
              tables: response.tables,
              tablesTruncated: response.tablesTruncated,
            }
          : view,
      );
    }
  }, [dbView, run, storage]);

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
      setConfirmDelete(false);
      // A new write ends the offer of the last one's undo (it would revert under the new value).
      setLastWrite(null);
      try {
        const response = await run(gen, () => storage.write(write));
        if (gen !== generation.current) return;
        if (response?.ok && response.kind === 'write') {
          writes.current += 1;
          setLastWrite({ outcome: response.outcome, write, seq: writes.current });
        }
      } finally {
        writing.current = false;
      }
      await reload();
      if (audit !== null) await loadAudit();
    },
    [audit, loadAudit, reload, run, storage],
  );

  /** Saves the draft: the write it was started as, with the new value (one field, one write). */
  const save = () => {
    if (!editing) return;
    const { base, affinity } = editing;
    const parsed =
      base.store === 'db' && editing.text === '' && base.expected.t !== 'string'
        ? { value: { t: 'null' } as StorageValue }
        : parseValue(editing.text, base.expected, affinity);
    if ('error' in parsed) return setEditing({ ...editing, error: parsed.error });
    void submit({ ...base, value: parsed.value } as StorageWriteInput);
  };

  const deleteRow = (view: DbView, shown: StoragePage, target: StorageTarget, row: number) => {
    const pk = rowIdentities(shown, 0)[row]?.pk;
    const digest = shown.rows[row]?.digest;
    if (!digest || !pk) return;
    openSheet(null);
    void submit({
      store: 'db',
      name: view.name,
      op: 'delete',
      table: shown.table,
      pk,
      rowDigest: digest,
      target,
    });
  };

  // A provisional answer shows its final outcome once that came (it carries no undo).
  const final =
    lastWrite?.outcome.phase === 'provisional'
      ? outcomes.find((notice) => notice.outcome.opId === lastWrite.outcome.opId)?.outcome
      : undefined;
  const written: LastWrite | null = lastWrite && (final ? { ...lastWrite, outcome: final } : lastWrite);
  const shown = dbView?.page ?? null;
  const page = shown?.page ?? null;
  const identities = page && shown ? rowIdentities(page, shown.scope) : [];
  const pkMissing = page !== null && page.pk.some((key) => !page.columns.includes(key));
  // Only what the latest list answer's link shows may be edited (a reconnect makes another link).
  const stale = (target: StorageTarget) => listing !== null && !sameTarget(listing.target, target);

  /** The level shown: the stores, one prefs file or database (its keys or tables), a table's rows, the audit. */
  const level: 'stores' | 'audit' | 'prefs' | 'tables' | 'rows' = auditOpen
    ? 'audit'
    : selected?.store === 'prefs'
      ? 'prefs'
      : selected?.store === 'db'
        ? dbView?.table
          ? 'rows'
          : 'tables'
        : 'stores';

  /** Back to the stores: what was read of a file or database is dropped (the listing stays). */
  const toStores = () => {
    setDirection('out');
    setInfoOpen(false);
    setAuditOpen(false);
    if (!selected) return;
    begin();
    setSelected(null);
    setPrefsView(null);
    setDbView(null);
    setFilter('');
  };

  const back = () => {
    if (level === 'rows' && dbView) {
      setDirection('out');
      setInfoOpen(false);
      begin();
      setFilter('');
      return setDbView({ ...dbView, table: null, page: null, cursors: [null] });
    }
    toStores();
  };

  const openAudit = () => {
    setDirection('in');
    setAuditOpen(true);
    void loadAudit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    if (editing) return setEditing(null);
    if (infoOpen) return setInfoOpen(false);
    if (sheet) return openSheet(null);
  };

  const writtenId = written ? fieldId(written.write) : null;
  /**
   * The saved mark: an outcome that allows it, on the field its write named, while that field shows what the write
   * stored (a later read that failed, or that saw the app change it since, shows no mark).
   */
  const marks = (id: string, value: StorageValue | undefined) =>
    written !== null &&
    writtenId === id &&
    showsSaved(written.outcome) &&
    (written.outcome.stored === undefined || sameValue(written.outcome.stored, value));
  const prefsField = (entry: StoragePrefsEntry) =>
    prefsView && entry.keyLength === undefined ? `p\u0000${prefsView.name}\u0000${entry.key}` : null;
  const cellField = (row: number, column: string) =>
    dbView && page && identities[row]?.pk
      ? `d\u0000${dbView.name}\u0000${page.table}\u0000${JSON.stringify(identities[row]!.pk)}\u0000${column}`
      : null;
  const savedRow = (row: number, cells: StorageValue[]) =>
    page?.columns.find((column, index) => {
      const id = cellField(row, column);
      return id !== null && marks(id, cells[index]);
    }) ?? null;

  if (consent === 'off') {
    return (
      <section className="storage" aria-label="Storage">
        <div className="storage-empty" data-testid="storage-consent-off">
          <p className="storage-empty-title">Storage is off</p>
          <p>
            Start Lionscope with <code>--allow-storage-read</code> to read the app’s SharedPreferences and the
            Room databases it registers (<code>Lionscope.trackDatabase</code>), and add{' '}
            <code>--allow-storage-write</code> to edit them.
          </p>
          <pre className="storage-snippet mono">npx lionscope --allow-storage-read --allow-storage-write</pre>
        </div>
      </section>
    );
  }

  /** The last write's outcome, in the server's words; [away]: shown away from its field, so it names it. */
  const outcomeBlock = (away: boolean) =>
    written && (
      <div className="storage-outcome" role="status" data-code={written.outcome.code}>
        <span className="storage-outcome-text">
          {away && <span className="storage-outcome-target mono">{writeLabel(written.write)}: </span>}
          {showsSaved(written.outcome) && <TickIcon />}
          {outcomeText(written.outcome)}
          {written.outcome.normalized && written.outcome.stored && (
            <>
              {' '}
              Stored: <ValueText value={written.outcome.stored} />
            </>
          )}
          {written.outcome.current && (
            <>
              {' '}
              Current value: <ValueText value={written.outcome.current} />
            </>
          )}
        </span>
        {written.outcome.undo && (
          <button
            type="button"
            className="storage-link"
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
    );

  /** Where each crumb leads: the stores, the database's tables, or nowhere (the level shown). */
  const crumbs: { label: string; mono?: boolean; to: 'stores' | 'tables' | null }[] = [
    { label: 'Storage', to: level === 'stores' ? null : 'stores' },
  ];
  if (level === 'audit') crumbs.push({ label: 'Write audit', to: null });
  if (selected) crumbs.push({ label: selected.name, mono: true, to: level === 'rows' ? 'tables' : null });
  if (level === 'rows' && dbView?.table) crumbs.push({ label: dbView.table, mono: true, to: null });

  const query = filter.trim().toLowerCase();

  let body: ReactNode;
  if (level === 'audit') {
    body = (
      <div className="storage-group" data-testid="storage-audit">
        <h3 className="storage-group-head">Writes of this server run, newest first (no values)</h3>
        {audit === null ? (
          <p className="storage-group-note">Reading…</p>
        ) : audit.length === 0 ? (
          <p className="storage-group-note">No writes yet.</p>
        ) : (
          <ul className="storage-audit">
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
    );
  } else if (!listing) {
    body = (
      <div className="storage-empty">
        <p className="storage-empty-title">Read the app’s storage</p>
        <p>
          Its SharedPreferences files and the Room databases it registers, read through its own SDK link.
          {canWrite ? ' Values can be edited.' : ''}
        </p>
        {!isRunning && (
          <p className="storage-empty-note">
            Start a profiling session of an app with the Lionscope SDK 0.13.0 or newer.
          </p>
        )}
        <div className="storage-empty-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void refresh()}
            disabled={busy || !isRunning}
          >
            Load storage
          </button>
          <button type="button" className="btn" onClick={openAudit} disabled={busy}>
            Write audit
          </button>
        </div>
      </div>
    );
  } else if (level === 'stores') {
    body = (
      <>
        <div className="storage-group">
          <h3 className="storage-group-head">
            SharedPreferences <span className="mono">{listing.prefs.length}</span>
          </h3>
          {listing.prefs.length === 0 && <p className="storage-group-note">No prefs files.</p>}
          {listing.prefs.map((file) => (
            <button
              key={`p:${file.name}`}
              type="button"
              className="storage-row"
              onClick={() => void open({ store: 'prefs', name: file.name })}
            >
              <PrefsIcon />
              <span className="storage-row-name">{file.name}</span>
              {file.backupOnly && <span className="storage-chip">backup only</span>}
              <ChevronIcon />
            </button>
          ))}
          {listing.prefsTruncated && <p className="storage-group-note">More files than listed.</p>}
        </div>
        <div className="storage-group">
          <h3 className="storage-group-head">
            Databases <span className="mono">{listing.databases.length}</span>
          </h3>
          {listing.databases.length === 0 && (
            <p className="storage-group-note">
              None registered. The app registers them with <code>Lionscope.trackDatabase</code>.
            </p>
          )}
          {listing.databases.map((db) =>
            db.status === 'ok' ? (
              <button
                key={`d:${db.name}`}
                type="button"
                className="storage-row"
                onClick={() => void open({ store: 'db', name: db.name })}
              >
                <DatabaseIcon />
                <span className="storage-row-name">{db.name}</span>
                <ChevronIcon />
              </button>
            ) : (
              <div
                key={`d:${db.name}`}
                className="storage-row"
                aria-disabled="true"
                title={readOnlyText(db.status)}
              >
                <DatabaseIcon />
                <span className="storage-row-name">{db.name}</span>
                <span className="storage-chip" data-tone="warn">
                  {readOnlyText(db.status)}
                </span>
              </div>
            ),
          )}
        </div>
        <div className="storage-group">
          <h3 className="storage-group-head">This server run</h3>
          <button type="button" className="storage-row" onClick={openAudit} disabled={!isRunning}>
            <AuditIcon />
            <span>Write audit</span>
            <ChevronIcon />
          </button>
          {outcomes.length > 0 && (
            <div className="storage-late">
              <p className="storage-group-note">Final outcomes after the answer</p>
              <ul>
                {outcomes
                  .slice()
                  .reverse()
                  .map(({ serial, outcome: late }) => (
                    <li key={`${serial}:${late.opId}`} className="mono">
                      {late.opId.slice(0, 8)} · {outcomeText(late)}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </>
    );
  } else if (level === 'prefs') {
    const entries = (prefsView?.entries ?? []).filter((entry) => entry.key.toLowerCase().includes(query));
    body = prefsView && (
      <div className="storage-group" data-testid="storage-prefs">
        <h3 className="storage-group-head">
          Keys <span className="mono">{prefsView.entries.length}</span>
          <span className="storage-group-aside">as the app holds them in memory</span>
        </h3>
        {entries.map((entry) => {
          const keyCut = entry.keyLength !== undefined;
          const id = prefsIdentity(entry);
          const open = sheet?.store === 'prefs' && sheet.id === id;
          const field = prefsField(entry);
          const saved = field !== null && marks(field, entry.value);
          return (
            <button
              key={`${id}:${saved ? written?.seq : 0}`}
              type="button"
              className="storage-row storage-row--entry"
              aria-pressed={open}
              data-saved={saved || undefined}
              onClick={() => openSheet({ store: 'prefs', id })}
            >
              <span className="storage-row-name">
                {entry.key}
                {keyCut ? `… (${entry.keyLength} chars)` : ''}
              </span>
              <span className="storage-row-value mono" data-type={entry.value.t}>
                {displayValue(entry.value)}
              </span>
            </button>
          );
        })}
        {entries.length === 0 && <p className="storage-group-note">No key matches.</p>}
      </div>
    );
  } else if (level === 'tables') {
    const tables = (dbView?.tables ?? []).filter((table) => table.name.toLowerCase().includes(query));
    const editable = tables.filter((table) => !table.readOnly);
    const readOnly = tables.filter((table) => table.readOnly);
    const showReadOnly = readOnlyOpen || query !== '';
    body = dbView && (
      <>
        <div className="storage-group">
          <h3 className="storage-group-head">
            {canWrite ? 'Editable' : 'Tables'} <span className="mono">{editable.length}</span>
          </h3>
          {editable.map((table) => (
            <button
              key={table.name}
              type="button"
              className="storage-row"
              onClick={() => void openTable(table.name)}
            >
              <TableIcon />
              <span className="storage-row-name">{table.name}</span>
              <ChevronIcon />
            </button>
          ))}
          {editable.length === 0 && <p className="storage-group-note">None.</p>}
        </div>
        {readOnly.length > 0 && (
          <div className="storage-group" data-collapsed={showReadOnly ? undefined : ''}>
            <h3 className="storage-group-head">
              Read-only <span className="mono">{readOnly.length}</span>
              <button
                type="button"
                className="storage-group-toggle"
                aria-expanded={showReadOnly}
                onClick={() => setReadOnlyOpen(!readOnlyOpen)}
                disabled={query !== ''}
              >
                <DisclosureIcon />
                {showReadOnly ? 'Hide' : 'Show'}
              </button>
            </h3>
            {showReadOnly &&
              readOnly.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  className="storage-row"
                  title={`read-only: ${readOnlyText(table.readOnly!)}`}
                  onClick={() => void openTable(table.name)}
                >
                  <TableIcon />
                  <span className="storage-row-name">{table.name}</span>
                  <span className="storage-chip">
                    <LockIcon />
                    {readOnlyChip(table.readOnly!)}
                  </span>
                  <ChevronIcon />
                </button>
              ))}
          </div>
        )}
        {dbView.tablesTruncated && <p className="storage-group-note">More tables than listed.</p>}
      </>
    );
  } else {
    body = shown && page && dbView && (
      <>
        {page.readOnly && (
          <p className="storage-banner">
            <span className="storage-chip">
              <LockIcon />
              {readOnlyChip(page.readOnly)}
            </span>
            Read-only: {readOnlyText(page.readOnly)}.
          </p>
        )}
        <div className="storage-grid-wrap">
          <table className="storage-grid">
            <thead>
              <tr>
                {page.columns.map((column) => {
                  const type = dbView.tables
                    .find((table) => table.name === page.table)
                    ?.columns.find((candidate) => candidate.name === column)?.type;
                  return (
                    <th key={column} scope="col">
                      <span className={page.pk.includes(column) ? 'storage-key' : undefined}>
                        {page.pk.includes(column) && <KeyIcon />}
                        {column}
                        {page.pk.includes(column) && <span className="sr-only"> (key)</span>}
                      </span>
                      {type && <small>{type}</small>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, rowIndex) => {
                const savedColumn = savedRow(rowIndex, row.cells);
                const key = identities[rowIndex]!.key;
                const next: Sheet = { store: 'db', table: page.table, row: key };
                return (
                  <tr
                    key={`${key}:${savedColumn !== null ? written?.seq : 0}`}
                    tabIndex={0}
                    aria-selected={sheet?.store === 'db' && sheet.table === page.table && sheet.row === key}
                    data-saved={savedColumn !== null || undefined}
                    onClick={() => openSheet(next)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openSheet(next);
                      }
                    }}
                  >
                    {row.cells.map((cell, columnIndex) => {
                      const column = page.columns[columnIndex] ?? '';
                      return (
                        <td
                          key={column}
                          data-type={cell.t}
                          data-changed={savedColumn === column || undefined}
                        >
                          {displayValue(cell)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page.rows.length === 0 && <p className="storage-group-note">No rows.</p>}
        </div>
      </>
    );
  }

  const pager =
    level === 'rows' && dbView && page ? (
      <Pager
        label={`${page.rows.length} ${page.rows.length === 1 ? 'row' : 'rows'}`}
        note={page.truncated ? 'Rows or values cut to stay under the answer size: Next continues.' : null}
        canPrevious={!busy && dbView.cursors.length > 1}
        canNext={!busy && page.nextCursor !== null}
        onPrevious={() => void loadPage(begin(), dbView, page.table, dbView.cursors.slice(0, -1))}
        onNext={() => void loadPage(begin(), dbView, page.table, [...dbView.cursors, page.nextCursor])}
      />
    ) : level === 'prefs' && prefsView ? (
      <Pager
        label={`${prefsView.entries.length} ${prefsView.entries.length === 1 ? 'key' : 'keys'}`}
        note={
          prefsView.truncated
            ? 'Keys cut to stay under the answer size: Next continues.'
            : prefsView.nextCursor !== null
              ? 'More keys: Next continues.'
              : null
        }
        canPrevious={!busy && prefsView.cursors.length > 1}
        canNext={!busy && prefsView.nextCursor !== null}
        onPrevious={() => void loadPrefs(begin(), prefsView.name, prefsView.cursors.slice(0, -1))}
        onNext={() => void loadPrefs(begin(), prefsView.name, [...prefsView.cursors, prefsView.nextCursor])}
      />
    ) : null;

  // The open row's sheet: every field, one edited at a time, the last write's outcome under the field it named.
  let sheetBody: ReactNode = null;
  /** The fields of the open sheet: the last write's outcome goes under its own one, else in the foot. */
  let sheetFields: (string | null)[] = [];
  const fieldOutcome = (id: string | null) =>
    id !== null && id === writtenId ? (
      <div className="storage-field-outcome">{outcomeBlock(false)}</div>
    ) : null;
  if (sheet?.store === 'prefs' && prefsView) {
    const entry = prefsView.entries.find((candidate) => prefsIdentity(candidate) === sheet.id);
    if (entry) {
      const keyCut = entry.keyLength !== undefined;
      const field = prefsField(entry);
      sheetFields = [field];
      const editable = canWrite && !keyCut && !stale(prefsView.target) && isEditable(entry.value);
      const reason = keyCut
        ? 'the key is too long to send whole'
        : entry.value.t === 'redacted'
          ? readOnlyText('redacted')
          : !isEditable(entry.value)
            ? entry.value.t === 'stringSet' && entry.value.complete !== false
              ? 'sets are edited from an agent (write_storage)'
              : readOnlyText('truncated')
            : null;
      sheetBody = (
        <>
          <SheetHead
            title="Key"
            detail={keyCut ? `${entry.key}… (${entry.keyLength} chars)` : entry.key}
            onClose={() => openSheet(null)}
          />
          <div className="storage-fields">
            <Field label="value" type={typeLabel(entry.value)}>
              {editing !== null && editing.id === field ? (
                <ValueEditor
                  label={entry.key}
                  editing={editing}
                  shown={entry.value}
                  busy={busy}
                  onChange={setEditing}
                  onSave={save}
                />
              ) : (
                <FieldValue
                  value={entry.value}
                  editLabel={editable ? `Edit ${entry.key}` : null}
                  disabled={busy || editing !== null}
                  onEdit={() =>
                    field !== null &&
                    setEditing({
                      id: field,
                      text: editText(entry.value),
                      error: null,
                      base: {
                        store: 'prefs',
                        name: prefsView.name,
                        op: 'update',
                        key: entry.key,
                        expected: entry.value,
                        target: prefsView.target,
                      },
                    })
                  }
                  reason={canWrite || keyCut || entry.value.t === 'redacted' ? reason : null}
                />
              )}
              {fieldOutcome(field)}
            </Field>
          </div>
        </>
      );
    }
  } else if (sheet?.store === 'db' && page && shown && dbView && sheet.table === page.table) {
    const rowIndex = identities.findIndex((identity) => identity.key === sheet.row);
    const row = page.rows[rowIndex];
    if (row) {
      const pk = identities[rowIndex]!.pk;
      const keyText = page.pk
        .map((key) => `${key} = ${displayValue(row.cells[page.columns.indexOf(key)] ?? { t: 'null' })}`)
        .join(', ');
      const canDelete = canWrite && !page.readOnly && row.digest && pk !== null && !stale(shown.target);
      const schema = dbView.tables.find((table) => table.name === page.table);
      sheetFields = page.columns.map((column) => cellField(rowIndex, column));
      sheetBody = (
        <>
          <SheetHead title="Row" detail={keyText || `#${rowIndex + 1}`} onClose={() => openSheet(null)} />
          <div className="storage-fields">
            {row.cells.map((cell, columnIndex) => {
              const column = page.columns[columnIndex] ?? '';
              const field = cellField(rowIndex, column);
              const reason = cellReadOnly(page, column, cell);
              const editable =
                canWrite && reason === null && !pkMissing && field !== null && !stale(shown.target);
              const type = schema?.columns.find((candidate) => candidate.name === column)?.type;
              return (
                <Field
                  key={column}
                  label={column}
                  type={page.pk.includes(column) ? `key · ${type ?? cell.t}` : (type ?? cell.t)}
                >
                  {editing !== null && editing.id === field ? (
                    <ValueEditor
                      label={column}
                      editing={editing}
                      shown={cell}
                      busy={busy}
                      onChange={setEditing}
                      onSave={save}
                    />
                  ) : (
                    <FieldValue
                      value={cell}
                      editLabel={editable ? `Edit ${column}` : null}
                      disabled={busy || editing !== null}
                      onEdit={() =>
                        field !== null &&
                        setEditing({
                          id: field,
                          text: editText(cell),
                          error: null,
                          base: {
                            store: 'db',
                            name: dbView.name,
                            op: 'update',
                            table: page.table,
                            column,
                            pk: pk!,
                            expected: cell,
                            target: shown.target,
                          },
                          affinity: affinityOf(schema, column),
                        })
                      }
                      reason={canWrite && !page.pk.includes(column) && !page.readOnly ? reason : null}
                    />
                  )}
                  {fieldOutcome(field)}
                </Field>
              );
            })}
            {canWrite && pkMissing && (
              <p className="storage-group-note">
                Read-only here: the primary key columns are not on this page.
              </p>
            )}
            {canWrite && !pkMissing && pk === null && (
              <p className="storage-group-note">
                Read-only here: this row has no complete, non-NULL, unique primary key.
              </p>
            )}
          </div>
          {canDelete && (
            <div className="storage-sheet-foot">
              <button
                type="button"
                className="btn storage-delete"
                data-armed={confirmDelete || undefined}
                disabled={busy || editing !== null}
                onClick={() =>
                  confirmDelete ? deleteRow(dbView, page, shown.target, rowIndex) : setConfirmDelete(true)
                }
              >
                {confirmDelete ? `Delete ${keyText}?` : 'Delete row'}
              </button>
            </div>
          )}
        </>
      );
    }
  }
  const footOutcome = writtenId !== null && sheetFields.includes(writtenId) ? null : outcomeBlock(true);

  /**
   * Refresh reads the level shown again. An armed Delete ends with it; a draft stays, still writing what it was
   * started as (its row by key, the value it was read as): the app's change since makes it a conflict, not a rebase.
   */
  const refreshShown = () => {
    setConfirmDelete(false);
    if (level === 'audit') return void loadAudit();
    if (level === 'stores') return void refresh();
    if (level === 'tables') return void reloadSchema();
    void reload();
  };

  const levelKey = `${level}:${selected?.name ?? ''}:${dbView?.table ?? ''}`;

  return (
    <section className="storage" aria-label="Storage" onKeyDown={onKeyDown}>
      <header className="storage-head">
        <button
          type="button"
          className="storage-icon-btn"
          aria-label="Back"
          disabled={level === 'stores'}
          onClick={back}
        >
          <BackIcon />
        </button>
        <nav className="storage-crumbs" aria-label="Location">
          {crumbs.map((crumb, index) => (
            <span key={`${index}:${crumb.label}`} className="storage-crumb-item">
              {index > 0 && <span className="storage-crumb-sep">/</span>}
              <button
                type="button"
                className={`storage-crumb${crumb.mono ? ' mono' : ''}`}
                aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                disabled={crumb.to === null}
                onClick={() => (crumb.to === 'stores' ? toStores() : back())}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <span
          className="storage-mode"
          data-mode={canWrite ? 'edit' : 'read'}
          title={
            canWrite
              ? 'Values can be edited'
              : 'Started without --allow-storage-write: values can’t be edited'
          }
        >
          <i aria-hidden="true" />
          {canWrite ? 'Edit' : 'Read only'}
        </span>
        <button
          type="button"
          className="storage-icon-btn"
          aria-label="How reads and edits reach the app"
          aria-expanded={infoOpen}
          onClick={() => setInfoOpen(!infoOpen)}
        >
          <InfoIcon />
        </button>
        <button
          type="button"
          className="storage-icon-btn"
          aria-label="Refresh"
          data-busy={busy || undefined}
          disabled={busy || !isRunning || !listing}
          onClick={refreshShown}
        >
          <RefreshIcon />
        </button>
      </header>
      {infoOpen && (
        <div className="storage-pop" role="dialog" aria-label="How reads and edits reach the app">
          <p>
            <b>Reads</b> run in the app’s own transaction, one request at a time: consistent within that read
            only, and the app’s database writers wait while it runs (a budget of 250 ms, checked between
            statements: a slow statement can run past it). Prefs are the app’s own instance in memory, main
            process only, not necessarily what is on disk.
          </p>
          <p>
            <b>Edits</b> are compare-and-set: refused with the current value when the app changed it since it
            was read. One value per edit; Undo is offered from the answer, on the same link only.
          </p>
        </div>
      )}
      {level === 'tables' || level === 'prefs' ? (
        <div className="storage-toolbar">
          <label className="storage-search">
            <span className="sr-only">{level === 'tables' ? 'Filter tables' : 'Filter keys'}</span>
            <SearchIcon />
            <input
              type="search"
              value={filter}
              placeholder={level === 'tables' ? 'Filter tables' : 'Filter keys on this page'}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter !== '') {
                  event.stopPropagation();
                  setFilter('');
                }
              }}
            />
          </label>
        </div>
      ) : null}
      {listing && !isRunning && (
        <p className="storage-banner">
          Start a profiling session of an app with the Lionscope SDK 0.13.0 or newer.
        </p>
      )}
      {error && (
        <p className="storage-banner" data-tone="critical" role="alert">
          {error}
        </p>
      )}
      {listing && ((prefsView && stale(prefsView.target)) || (shown && stale(shown.target))) && (
        <p className="storage-banner" role="alert">
          The app’s SDK link changed since the list was read (a reconnect or a restart): Refresh to edit
          again.
        </p>
      )}
      <div className="storage-body" key={levelKey} data-direction={direction} aria-busy={busy || undefined}>
        {body}
      </div>
      {pager}
      {footOutcome && !sheetBody && <div className="storage-foot">{footOutcome}</div>}
      {sheetBody && (
        <div className="storage-sheet" role="dialog" aria-label={sheet?.store === 'db' ? 'Row' : 'Key'}>
          {sheetBody}
        </div>
      )}
    </section>
  );
}

function ValueEditor({
  label,
  editing,
  shown,
  busy,
  onChange,
  onSave,
}: {
  label: string;
  editing: Editing;
  /** The value the field shows now (read again since Edit was pressed, it may differ from what Save compares). */
  shown: StorageValue;
  busy: boolean;
  onChange: (editing: Editing | null) => void;
  onSave: () => void;
}) {
  return (
    <form
      className="storage-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <input
        aria-label={`New value of ${label}`}
        className="mono"
        value={editing.text}
        spellCheck={false}
        onChange={(event) => onChange({ ...editing, text: event.target.value, error: null })}
        autoFocus
      />
      <button type="submit" className="btn btn--primary" disabled={busy}>
        Save
      </button>
      <button type="button" className="btn" onClick={() => onChange(null)}>
        Cancel
      </button>
      {editing.error && (
        <span className="storage-error" role="alert">
          {editing.error}
        </span>
      )}
      {!sameValue(shown, editing.base.expected) && (
        <span className="storage-reason storage-editor-note">
          Read as <ValueText value={editing.base.expected} /> when the edit began: Save compares with that, so
          it is refused if the app changed it.
        </span>
      )}
    </form>
  );
}

function SheetHead({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) {
  return (
    <div className="storage-sheet-head">
      <span className="storage-sheet-title">
        {title} <span className="mono">{detail}</span>
      </span>
      <button type="button" className="storage-icon-btn" aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}

function Field({ label, type, children }: { label: string; type: string; children: ReactNode }) {
  return (
    <div className="storage-field">
      <span className="storage-field-label">
        <span className="mono">{label}</span>
        <small>{type}</small>
      </span>
      <div className="storage-field-body">{children}</div>
    </div>
  );
}

function FieldValue({
  value,
  editLabel,
  disabled,
  onEdit,
  reason,
}: {
  value: StorageValue;
  editLabel: string | null;
  disabled: boolean;
  onEdit: () => void;
  reason: string | null;
}) {
  return (
    <>
      <ValueText value={value} />
      {editLabel ? (
        <button
          type="button"
          className="storage-edit"
          aria-label={editLabel}
          disabled={disabled}
          onClick={onEdit}
        >
          <PencilIcon />
          Edit
        </button>
      ) : (
        reason && <span className="storage-reason">read-only: {reason}</span>
      )}
    </>
  );
}

function Pager({
  label,
  note,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
}: {
  label: string;
  note: string | null;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="storage-pager">
      <span className="mono">{label}</span>
      {note && <span className="storage-pager-note">{note}</span>}
      <span className="storage-pager-gap" />
      <button
        type="button"
        className="storage-icon-btn"
        aria-label="Previous"
        disabled={!canPrevious}
        onClick={onPrevious}
      >
        <BackIcon />
      </button>
      <button
        type="button"
        className="storage-icon-btn"
        aria-label="Next"
        disabled={!canNext}
        onClick={onNext}
      >
        <ChevronIcon />
      </button>
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" {...stroke} strokeWidth="1.6" />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg className="storage-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" {...stroke} strokeWidth="1.6" />
    </svg>
  );
}
function DisclosureIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" {...stroke} strokeWidth="1.5" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" {...stroke} strokeWidth="1.4" />
      <path d="M8 7.2v3.6M8 5.1v.1" {...stroke} strokeWidth="1.6" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.6h-2.6" {...stroke} strokeWidth="1.5" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="4.25" {...stroke} strokeWidth="1.5" />
      <path d="m8.6 8.6 3.4 3.4" {...stroke} strokeWidth="1.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" {...stroke} strokeWidth="1.6" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 3 13 5.5 6 12.5H3.5V10z" {...stroke} strokeWidth="1.4" />
    </svg>
  );
}
function TickIcon() {
  return (
    <svg className="storage-tick" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="m3 7.5 2.6 2.5L11 4.5" {...stroke} strokeWidth="1.8" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="4" cy="6" r="2.4" {...stroke} strokeWidth="1.3" />
      <path d="M6.4 6H11M9 6v1.8" {...stroke} strokeWidth="1.3" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" {...stroke} strokeWidth="1.3" />
    </svg>
  );
}
function PrefsIcon() {
  return (
    <svg className="storage-row-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5h5.5L12 5v8.5H4z" {...stroke} strokeWidth="1.3" />
      <path d="M6 8h4M6 10.5h4" {...stroke} strokeWidth="1.3" />
    </svg>
  );
}
function DatabaseIcon() {
  return (
    <svg className="storage-row-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <ellipse cx="8" cy="4" rx="4.75" ry="1.75" {...stroke} strokeWidth="1.3" />
      <path
        d="M3.25 4v8c0 1 2.1 1.75 4.75 1.75s4.75-.75 4.75-1.75V4M3.25 8c0 1 2.1 1.75 4.75 1.75S12.75 9 12.75 8"
        {...stroke}
        strokeWidth="1.3"
      />
    </svg>
  );
}
function TableIcon() {
  return (
    <svg className="storage-row-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} strokeWidth="1.3" />
      <path d="M2.5 6.5h11M6.5 6.5V13" {...stroke} strokeWidth="1.3" />
    </svg>
  );
}
function AuditIcon() {
  return (
    <svg className="storage-row-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3.5h10M3 8h10M3 12.5h6" {...stroke} strokeWidth="1.3" />
    </svg>
  );
}

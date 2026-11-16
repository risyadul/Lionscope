import { useRef, useState } from 'react';
import type { StorageDatabase, StorageTarget, StorageWriteOutcome } from '@lionscope/protocol/wire';
import { MAX_STORAGE_QUERY_OFFSET, planStorageSql } from '@lionscope/protocol/storage-sql';
import type { StorageRequests } from '../../hooks/useStorage.ts';
import { displayValue, outcomeText } from '../../lib/storage.ts';
import type { StorageOutcomeNotice } from '../../lib/store.ts';
import { Select } from '../ui/Select.tsx';

interface Props {
  storage: StorageRequests;
  databases: StorageDatabase[];
  target: StorageTarget;
  initialDatabase: string;
  initialTable: string | null;
  canWrite: boolean;
  isRunning: boolean;
  outcomes: readonly StorageOutcomeNotice[];
  onMutation: () => void;
  onBusyChange?: (busy: boolean) => void;
}

interface Execution {
  name: string;
  sql: string;
  offsets: number[];
  outcome: StorageWriteOutcome;
}

function resultSummary(busy: boolean, outcome: StorageWriteOutcome | undefined): string {
  if (busy) return 'Waiting for the app…';
  if (!outcome) return 'Run a query to see its results.';
  if (outcome.code !== 'ok') return outcomeText(outcome);
  if (outcome.query?.readOnly) return `${outcome.query.rows.length} rows · ${outcome.txMs ?? 0} ms`;
  return `${outcome.changes ?? 0} rows changed · ${outcome.txMs ?? 0} ms`;
}

/** Drafts, SQL history and results live only in this mounted session, never in browser storage. */
export function StorageQuery({
  storage,
  databases,
  target,
  initialDatabase,
  initialTable,
  canWrite,
  isRunning,
  outcomes,
  onMutation,
  onBusyChange,
}: Props) {
  const [name, setName] = useState(initialDatabase);
  const [sql, setSql] = useState(
    initialTable ? `SELECT * FROM "${initialTable.replaceAll('"', '""')}";` : 'SELECT 1;',
  );
  const [execution, setExecution] = useState<Execution | null>(null);
  const [history, setHistory] = useState<{ name: string; sql: string }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const running = useRef(false);
  const generation = useRef(0);
  const plan = planStorageSql(sql);
  const needsWrite = typeof plan !== 'string' && !plan.readOnly;
  const late =
    execution &&
    outcomes.findLast(
      (notice) => notice.serial === target.serial && notice.outcome.opId === execution.outcome.opId,
    );
  const outcome = late ? late.outcome : execution?.outcome;
  const result = outcome?.query;
  const changedDraft = execution !== null && (execution.sql !== sql.trim() || execution.name !== name);

  async function run(text: string, offsets = [0]) {
    if (running.current || !isRunning) return;
    const parsed = planStorageSql(text);
    if (typeof parsed === 'string') {
      setError(parsed);
      return;
    }
    if (!parsed.readOnly && !canWrite) {
      setError('Restart Lionscope with --allow-storage-write to run this statement.');
      return;
    }
    if (!name) {
      setError('Choose a database.');
      return;
    }
    const gen = ++generation.current;
    running.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setExecution(null);
    setHistoryOpen(false);
    if (!parsed.readOnly) onMutation();
    setHistory((entries) =>
      [
        { name, sql: text.trim() },
        ...entries.filter((entry) => entry.name !== name || entry.sql !== text.trim()),
      ].slice(0, 20),
    );
    const response = await storage.query({ name, sql: text, target, limit: 50, offset: offsets.at(-1) ?? 0 });
    running.current = false;
    setBusy(false);
    onBusyChange?.(false);
    if (gen !== generation.current) return;
    if (!response.ok) setError(response.message);
    else if (response.kind === 'query')
      setExecution({ name, sql: text.trim(), offsets, outcome: response.outcome });
  }

  function runEditor() {
    const input = editor.current;
    const selection =
      input && input.selectionStart !== input.selectionEnd
        ? sql.slice(input.selectionStart, input.selectionEnd)
        : sql;
    void run(selection);
  }

  return (
    <section className="storage-query" aria-label="SQL query">
      <label className="storage-query-label" htmlFor="storage-sql">
        SQL editor <span>One statement per run · Ctrl / ⌘ Enter to run selection or editor</span>
      </label>
      <textarea
        id="storage-sql"
        ref={editor}
        className="storage-query-editor mono"
        value={sql}
        spellCheck={false}
        autoComplete="off"
        maxLength={16384}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            runEditor();
          }
        }}
      />
      <div className="storage-query-toolbar">
        <label>
          Database{' '}
          <Select
            aria-label="Query database"
            title={name}
            value={name}
            disabled={busy}
            onChange={(event) => {
              generation.current++;
              setName(event.target.value);
              setExecution(null);
              setError(null);
            }}
          >
            {databases
              .filter((database) => database.status === 'ok')
              .map((database) => (
                <option key={database.name} value={database.name}>
                  {database.name}
                </option>
              ))}
          </Select>
        </label>
        <button
          type="button"
          className="btn"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(!historyOpen)}
          disabled={busy}
        >
          History <span className="mono">{history.length}</span>
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={runEditor}
          disabled={busy || !isRunning || !name || !sql.trim()}
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {historyOpen && (
        <div className="storage-query-history" aria-label="Query history">
          <div className="storage-query-history-head">
            <span>Recent queries · this session only</span>
            <button type="button" className="btn" disabled={!history.length} onClick={() => setHistory([])}>
              Clear history
            </button>
          </div>
          {!history.length && <p>No queries yet.</p>}
          {history.map((entry, index) => (
            <button
              type="button"
              key={`${index}:${entry.name}`}
              aria-label={`Load query from ${entry.name}: ${entry.sql}`}
              onClick={() => {
                generation.current++;
                setName(entry.name);
                setSql(entry.sql);
                setExecution(null);
                setError(null);
                setHistoryOpen(false);
                editor.current?.focus();
              }}
            >
              <span>{entry.name}</span>
              <code>{entry.sql}</code>
            </button>
          ))}
        </div>
      )}
      {needsWrite && (
        <p className="storage-query-note">
          Changes matching rows directly. SQL writes do not use compare-and-set and cannot be undone here.
          {!canWrite && ' Write access is off.'}
        </p>
      )}
      {error && (
        <p className="storage-banner" data-tone="critical" role="alert">
          {error}
        </p>
      )}
      <div className="storage-query-results" aria-busy={busy}>
        <div className="storage-query-result-head" role="status">
          <strong>Results</strong>
          <span>{resultSummary(busy, outcome)}</span>
        </div>
        {changedDraft && (
          <p className="storage-query-note">Showing the previous execution. Run to update the results.</p>
        )}
        {late && (
          <p className="storage-query-note">
            Final outcome received after the original answer. This statement was not retried.
          </p>
        )}
        {outcome?.queryError && (
          <pre className="storage-query-error" role="alert">
            {outcome.queryError}
          </pre>
        )}
        {outcome?.code === 'timeout' && (
          <p className="storage-query-note">
            The statement may still be running. A write may have committed. Check the data before running it
            again.
          </p>
        )}
        {result?.readOnly && (
          <>
            <div className="storage-query-grid" tabIndex={0} role="region" aria-label="Query results table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    {result.columns.map((column, index) => (
                      <th scope="col" key={index}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      <th scope="row">{result.offset + index + 1}</th>
                      {row.map((cell, column) => (
                        <td key={column} className="mono" title={displayValue(cell)}>
                          {displayValue(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.rows.length && <p className="storage-query-note">The query returned no rows.</p>}
            {result.truncated && (
              <p className="storage-query-note">
                Some values or columns were shortened to fit the result limit.
              </p>
            )}
            <div className="storage-query-pagination">
              <span>Each page is a new read. Use ORDER BY for stable ordering.</span>
              <button
                type="button"
                className="btn"
                disabled={busy || !isRunning || !execution || result.offset === 0}
                onClick={() => execution && void run(execution.sql, execution.offsets.slice(0, -1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={
                  busy ||
                  !isRunning ||
                  !execution ||
                  !result.hasMore ||
                  !result.rows.length ||
                  result.offset + result.rows.length > MAX_STORAGE_QUERY_OFFSET
                }
                onClick={() =>
                  execution &&
                  void run(execution.sql, [...execution.offsets, result.offset + result.rows.length])
                }
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

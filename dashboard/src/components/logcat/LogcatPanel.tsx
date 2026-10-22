import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { LogLevel } from '@lionscope/protocol/wire';
import { useDrawerSlot } from '../layout/drawerSlot.ts';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { writeDesktopClipboard } from '../../lib/clipboard.ts';
import { formatInteger } from '../../lib/format.ts';
import { filterLogs } from '../../lib/logFilter.ts';
import { formatLogLines } from '../../lib/logText.ts';
import type { Signal } from '../../lib/signal.ts';
import type { LogRecord } from '../../lib/store.ts';
import { LevelFilter } from './LevelFilter.tsx';
import { LogRow } from './LogRow.tsx';
import { useLogSelection } from './useLogSelection.ts';
import './logcat.css';

/** Rows rendered at once; older matches stay in the buffer and in the count. */
export const MAX_VISIBLE_ROWS = 1000;
const SEARCH_DEBOUNCE_MS = 150;
/** Within this many px of the bottom counts as "following". */
const FOLLOW_SLACK_PX = 24;
/** How long the "Copied" confirmation stays (a refusal stays twice as long). */
const COPY_CONFIRM_MS = 1600;

type CopyStatus = { kind: 'copied' | 'failed'; count: number; id: number };

const lineCount = (count: number) => `${formatInteger(count)} ${count === 1 ? 'line' : 'lines'}`;

type Props = {
  logs: readonly LogRecord[];
  pid: number | null;
  probeTs: Signal<number | null>;
};

export function LogcatPanel({ logs, pid, probeTs }: Props) {
  const [minLevel, setMinLevel] = useState<LogLevel>('D');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [isFollowing, setIsFollowing] = useState(true);
  /** Rows pinned while the user reads back, so new lines don't shift the view. */
  const [frozenRows, setFrozenRows] = useState<readonly LogRecord[] | null>(null);
  /**
   * Lines at or before this timestamp are hidden. By ts, not seq: a reconnect re-sends the
   * snapshot with fresh sequence numbers, and cleared lines must stay cleared.
   */
  const [clearedTs, setClearedTs] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const slot = useDrawerSlot();
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);

  const visibleLogs = useMemo(
    () => (clearedTs === null ? logs : logs.filter((record) => record.ts > clearedTs)),
    [logs, clearedTs],
  );
  const { rows: liveRows, matched } = useMemo(
    () => filterLogs(visibleLogs, { minLevel, query: debouncedQuery }, MAX_VISIBLE_ROWS),
    [visibleLogs, minLevel, debouncedQuery],
  );
  const rows = !isFollowing && frozenRows ? frozenRows : liveRows;
  const seenSeq = rows[rows.length - 1]?.seq ?? -1;
  const unseen = isFollowing ? 0 : liveRows.filter((r) => r.seq > seenSeq).length;

  const { selected, select, selectAll, clear: clearSelection } = useLogSelection(rows);
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.seq)), [rows, selected]);

  useEffect(() => {
    if (copyStatus === null) return;
    const timer = setTimeout(
      () => setCopyStatus(null),
      copyStatus.kind === 'copied' ? COPY_CONFIRM_MS : COPY_CONFIRM_MS * 2,
    );
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const copyRows = useCallback((records: readonly LogRecord[]) => {
    if (records.length === 0) return;
    // Called inside the click / key handler, so the browser still counts it as a user gesture.
    void writeDesktopClipboard(formatLogLines(records)).then((ok) =>
      setCopyStatus((prev) => ({
        kind: ok ? 'copied' : 'failed',
        count: records.length,
        id: (prev?.id ?? 0) + 1,
      })),
    );
  }, []);
  const copyOne = useCallback((record: LogRecord) => copyRows([record]), [copyRows]);

  const handleListKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const isMod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' && selected.size > 0) {
      clearSelection();
      event.preventDefault();
    } else if (isMod && event.key.toLowerCase() === 'a') {
      selectAll();
      event.preventDefault();
    } else if (isMod && event.key.toLowerCase() === 'c' && selectedRows.length > 0) {
      copyRows(selectedRows);
      event.preventDefault();
    }
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && isFollowing) list.scrollTop = list.scrollHeight;
  }, [rows, isFollowing]);

  const follow = () => {
    setIsFollowing(true);
    setFrozenRows(null);
  };

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
    if (atBottom === isFollowing) return;
    if (atBottom) {
      follow();
    } else {
      setIsFollowing(false);
      setFrozenRows(liveRows);
    }
  };

  const jumpToLatest = () => {
    follow();
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  };

  const changeLevel = (level: LogLevel) => {
    setMinLevel(level);
    follow();
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    follow();
  };

  const handleHover = useCallback((ts: number) => probeTs.set(ts), [probeTs]);
  const clearProbe = () => probeTs.set(null);

  const isEmptyBuffer = visibleLogs.length === 0;
  const buffered = visibleLogs.length;
  const countText =
    matched === buffered
      ? formatInteger(buffered)
      : `${formatInteger(matched)} of ${formatInteger(buffered)}`;
  const countTitle =
    matched === buffered
      ? `${lineCount(buffered)} in the buffer`
      : `${lineCount(matched)} match the filter, of ${lineCount(buffered)} in the buffer`;
  const capNote = matched > rows.length ? `; the newest ${formatInteger(rows.length)} are listed` : '';

  const toolbar = (
    <>
      <h2 id="logcat-title" className="logcat-title">
        Logcat
      </h2>
      {pid !== null && <span className="logcat-pid mono">pid {pid}</span>}
      <span className="logcat-count mono" title={countTitle + capNote}>
        {countText}
      </span>
      <LevelFilter minLevel={minLevel} onChange={changeLevel} />
      <label className="logcat-search">
        <span className="sr-only">Filter by tag or message</span>
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
          <circle cx="5.5" cy="5.5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m8.6 8.6 3.4 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder="Tag or message"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') changeQuery('');
          }}
        />
      </label>
      <button
        type="button"
        className="btn logcat-clear"
        onClick={() => {
          setClearedTs(logs.reduce((max, r) => (r.ts > max ? r.ts : max), clearedTs ?? -Infinity));
          clearSelection();
          follow();
        }}
        disabled={isEmptyBuffer}
        title="Hide the lines received so far (the buffer is kept)"
      >
        Clear
      </button>
    </>
  );

  return (
    <section className="logcat" aria-labelledby="logcat-title">
      {/* In the drawer the toolbar lives in its bar; `null` is the moment before the bar has mounted. */}
      {slot === undefined ? (
        <header className="logcat-bar">{toolbar}</header>
      ) : (
        slot && createPortal(toolbar, slot)
      )}

      <div className="logcat-body">
        {rows.length === 0 ? (
          <div className="logcat-empty">
            {isEmptyBuffer ? (
              <>
                <p className="logcat-empty-title">No log lines yet</p>
                <p>Lines from the app process stream in here while a session is running.</p>
              </>
            ) : (
              <>
                <p className="logcat-empty-title">No lines match</p>
                <p>Lower the level or clear the search.</p>
              </>
            )}
          </div>
        ) : (
          <ol
            ref={listRef}
            className="logcat-list"
            tabIndex={0}
            onScroll={handleScroll}
            onMouseLeave={clearProbe}
            onKeyDown={handleListKeyDown}
            aria-label="Log lines, newest last"
          >
            {rows.map((record) => (
              <LogRow
                key={record.seq}
                record={record}
                query={debouncedQuery}
                isSelected={selected.has(record.seq)}
                onHover={handleHover}
                onSelect={select}
                onCopy={copyOne}
              />
            ))}
          </ol>
        )}
        {selectedRows.length > 0 && (
          <div className="logcat-selection">
            <span className="mono">{formatInteger(selectedRows.length)} selected</span>
            <button
              type="button"
              className="logcat-selection-copy"
              onClick={() => copyRows(selectedRows)}
              title="Copy the selected lines (Cmd/Ctrl+C); Esc clears the selection"
            >
              Copy
            </button>
          </div>
        )}
        {!isFollowing && rows.length > 0 && (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1v7M1.5 5 5 8.5 8.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Jump to latest
            {unseen > 0 && <span className="jump-count mono">+{formatInteger(unseen)}</span>}
          </button>
        )}
        <div className="logcat-toast-region" role="status">
          {copyStatus !== null && (
            <div className="logcat-toast" data-kind={copyStatus.kind} key={copyStatus.id}>
              {copyStatus.kind === 'copied'
                ? `Copied ${lineCount(copyStatus.count)}`
                : 'Copying isn’t allowed here'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

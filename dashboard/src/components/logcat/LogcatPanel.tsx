import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogLevel } from '@lionscope/protocol/wire';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { formatInteger } from '../../lib/format.ts';
import { filterLogs } from '../../lib/logFilter.ts';
import type { Signal } from '../../lib/signal.ts';
import type { LogRecord } from '../../lib/store.ts';
import { LevelFilter } from './LevelFilter.tsx';
import { LogRow } from './LogRow.tsx';
import './logcat.css';

/** Rows rendered at once; older matches stay in the buffer and in the count. */
export const MAX_VISIBLE_ROWS = 1000;
const SEARCH_DEBOUNCE_MS = 150;
/** Within this many px of the bottom counts as "following". */
const FOLLOW_SLACK_PX = 24;

type Props = {
  logs: readonly LogRecord[];
  pid: number | null;
  probeTs: Signal<number | null>;
  /** The panel sits under a tab that already names it; keep the heading for screen readers only. */
  isTitleHidden?: boolean;
};

export function LogcatPanel({ logs, pid, probeTs, isTitleHidden = false }: Props) {
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

  return (
    <section className="logcat" aria-labelledby="logcat-title">
      <header className="logcat-head">
        <div className="logcat-title-row">
          <h2 id="logcat-title" className={isTitleHidden ? 'sr-only' : 'logcat-title'}>
            Logcat
          </h2>
          {pid !== null && <span className="logcat-pid mono">pid {pid}</span>}
          <span className="logcat-count mono" aria-live="off">
            {matched > rows.length
              ? `${formatInteger(rows.length)} of ${formatInteger(matched)}`
              : formatInteger(matched)}{' '}
            <span className="logcat-count-unit">lines</span>
          </span>
          <button
            type="button"
            className="btn logcat-clear"
            onClick={() => {
              setClearedTs(logs.reduce((max, r) => (r.ts > max ? r.ts : max), clearedTs ?? -Infinity));
              follow();
            }}
            disabled={isEmptyBuffer}
            title="Hide the lines received so far (the buffer is kept)"
          >
            Clear
          </button>
        </div>
        <div className="logcat-filters">
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
        </div>
      </header>

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
            onScroll={handleScroll}
            onMouseLeave={clearProbe}
            aria-label="Log lines, newest last"
          >
            {rows.map((record) => (
              <LogRow key={record.seq} record={record} query={debouncedQuery} onHover={handleHover} />
            ))}
          </ol>
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
      </div>
    </section>
  );
}

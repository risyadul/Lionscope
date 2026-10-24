import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { HttpExchange } from '@lionscope/protocol/wire';
import { statusClassOf, urlParts } from '@lionscope/protocol/insights';
import { useElementSize } from '../../hooks/useElementSize.ts';
import { formatBlockMs, formatInteger } from '../../lib/format.ts';
import { formatBytes } from '../../lib/network.ts';

/** Every row has this height, so only the rows in view (and a few around them) are rendered. */
export const ROW_PX = 40;
const OVERSCAN_ROWS = 6;
/** Until the list is measured (and in tests), it is assumed this tall. */
const FALLBACK_VIEWPORT_PX = 480;
/** Within this many px of the bottom counts as "following". */
const FOLLOW_SLACK_PX = 24;

type Props = {
  rows: readonly HttpExchange[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  isFollowing: boolean;
  /** The user scrolled away from the bottom (false) or back to it (true). */
  onFollowChange: (isFollowing: boolean) => void;
  /** Rows that arrived since following stopped. */
  unseen: number;
};

/** `200`, `…` while pending, the failure kind when it failed before a response. */
function statusText(exchange: HttpExchange): string {
  if (exchange.state === 'pending') return '…';
  if (exchange.status !== null) return String(exchange.status);
  return exchange.error?.kind === 'timeout' ? 'timeout' : 'failed';
}

function rowLabel(exchange: HttpExchange): string {
  const { host, path } = urlParts(exchange.url);
  const state =
    exchange.state === 'pending'
      ? 'pending'
      : exchange.status !== null
        ? `status ${exchange.status}`
        : `failed${exchange.error ? `: ${exchange.error.kind}` : ''}`;
  return [
    `${exchange.method} ${host}${path}`,
    state,
    exchange.durationMs === null ? null : formatBlockMs(exchange.durationMs),
    exchange.responseSize === null ? null : formatBytes(exchange.responseSize),
    exchange.mockId === null ? null : 'mocked',
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

const Row = memo(function Row({
  exchange,
  index,
  total,
  isSelected,
  isTabStop,
  onSelect,
}: {
  exchange: HttpExchange;
  index: number;
  total: number;
  isSelected: boolean;
  isTabStop: boolean;
  onSelect: (id: number) => void;
}) {
  const { host, path, query } = urlParts(exchange.url);
  return (
    <div
      role="option"
      className="net-row"
      data-id={exchange.id}
      data-state={exchange.state}
      data-class={statusClassOf(exchange)}
      aria-selected={isSelected}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-label={rowLabel(exchange)}
      tabIndex={isTabStop ? 0 : -1}
      style={{ transform: `translateY(${index * ROW_PX}px)` }}
      onClick={() => onSelect(exchange.id)}
    >
      <span className="net-method mono">{exchange.method}</span>
      <span className="net-url">
        <span className="net-path-line">
          <span className="net-path mono" title={exchange.url}>
            {path}
            {query && <span className="net-query">?{query}</span>}
          </span>
          {exchange.mockId !== null && (
            <span className="net-badge" data-kind="mock" title={`Answered by mock rule ${exchange.mockId}`}>
              Mocked
            </span>
          )}
        </span>
        <span className="net-host">{host}</span>
      </span>
      <span className="net-status mono" data-class={statusClassOf(exchange)}>
        {statusText(exchange)}
      </span>
      <span className="net-time mono">
        {exchange.durationMs === null ? '—' : formatBlockMs(exchange.durationMs)}
      </span>
      <span className="net-size mono">{formatBytes(exchange.responseSize)}</span>
    </div>
  );
});

/**
 * The request list, oldest at the top: it follows the newest call unless the user scrolled up. Rows are options of
 * a listbox (one tab stop; ↑/↓, Home/End, Page Up/Down move the selection). Only the rows in view are rendered.
 */
export function RequestList({ rows, selectedId, onSelect, isFollowing, onFollowChange, unseen }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(listRef);
  const [scrollTop, setScrollTop] = useState(0);
  // The row to focus once a keyboard move has rendered it.
  const focusId = useRef<number | null>(null);

  const viewport = height > 0 ? height : FALLBACK_VIEWPORT_PX;
  const total = rows.length;
  const maxTop = Math.max(0, total * ROW_PX - viewport);
  const top = isFollowing ? maxTop : Math.min(scrollTop, maxTop);
  const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((top + viewport) / ROW_PX) + OVERSCAN_ROWS);
  const shown = rows.slice(first, last);
  const selectedIndex = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  const tabStopId =
    selectedIndex >= first && selectedIndex < last ? selectedId : (shown[shown.length - 1]?.id ?? null);

  // Also when the list gets shorter (the detail opens under it): the rows rendered follow the newest, so the
  // scroll position must too, or the top of the list shows blank space above them.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && isFollowing) list.scrollTop = list.scrollHeight;
  }, [total, isFollowing, height]);

  useLayoutEffect(() => {
    const id = focusId.current;
    if (id === null) return;
    focusId.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  });

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    setScrollTop(list.scrollTop);
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
    if (atBottom !== isFollowing) onFollowChange(atBottom);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (total === 0) return;
    const page = Math.max(1, Math.floor(viewport / ROW_PX) - 1);
    const at = selectedIndex;
    let next: number;
    if (event.key === 'ArrowDown') next = at === -1 ? 0 : at + 1;
    else if (event.key === 'ArrowUp') next = at === -1 ? total - 1 : at - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = total - 1;
    else if (event.key === 'PageDown') next = at + page;
    else if (event.key === 'PageUp') next = at === -1 ? total - 1 - page : at - page;
    else return;
    event.preventDefault();
    next = Math.min(total - 1, Math.max(0, next));
    const row = rows[next];
    if (!row) return;
    focusId.current = row.id;
    onSelect(row.id);
    // Keep the row in view; the newest row means following again.
    if (next === total - 1) {
      onFollowChange(true);
      return;
    }
    const rowTop = next * ROW_PX;
    const nextTop =
      rowTop < top ? rowTop : rowTop + ROW_PX > top + viewport ? rowTop + ROW_PX - viewport : top;
    if (nextTop === top) return;
    if (isFollowing) onFollowChange(false);
    setScrollTop(nextTop);
    if (listRef.current) listRef.current.scrollTop = nextTop;
  };

  return (
    <div className="net-list-host">
      <div
        ref={listRef}
        className="net-list"
        role="listbox"
        aria-label="Requests, newest last"
        tabIndex={-1}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        <div className="net-list-inner" style={{ height: `${total * ROW_PX}px` }}>
          {shown.map((exchange, i) => (
            <Row
              key={exchange.id}
              exchange={exchange}
              index={first + i}
              total={total}
              isSelected={exchange.id === selectedId}
              isTabStop={exchange.id === tabStopId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      {!isFollowing && total > 0 && (
        <button
          type="button"
          className="net-jump"
          onClick={() => {
            onFollowChange(true);
            const list = listRef.current;
            if (list) list.scrollTop = list.scrollHeight;
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M5 1v7M1.5 5 5 8.5 8.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Jump to latest
          {unseen > 0 && <span className="net-jump-count mono">+{formatInteger(unseen)}</span>}
        </button>
      )}
    </div>
  );
}

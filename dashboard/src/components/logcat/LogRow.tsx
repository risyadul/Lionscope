import { memo, type MouseEvent } from 'react';
import { formatClock } from '../../lib/format.ts';
import { splitMatch } from '../../lib/logFilter.ts';
import type { LogRecord } from '../../lib/store.ts';

function Highlight({ text, query }: { text: string; query: string }) {
  const parts = splitMatch(text, query);
  if (!parts) return <>{text}</>;
  const [before, match, after] = parts;
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

type Props = {
  record: LogRecord;
  query: string;
  isSelected: boolean;
  onHover: (ts: number) => void;
  /** Click, shift-click or Cmd/Ctrl-click: the panel decides what that selects. */
  onSelect: (record: LogRecord, event: MouseEvent<HTMLElement>) => void;
  onCopy: (record: LogRecord) => void;
};

export const LogRow = memo(function LogRow({ record, query, isSelected, onHover, onSelect, onCopy }: Props) {
  return (
    <li
      className="log-row"
      data-level={record.level}
      data-selected={isSelected || undefined}
      onMouseEnter={() => onHover(record.ts)}
      // Shift-click extends a range; without this the browser would also extend a text selection.
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => onSelect(record, event)}
    >
      {Number.isFinite(record.ts) ? (
        <time className="log-time" dateTime={new Date(record.ts).toISOString()}>
          {formatClock(record.ts)}
        </time>
      ) : (
        <span className="log-time">--:--:--.---</span>
      )}
      <span className="log-level" aria-label={`level ${record.level}`}>
        {record.level}
      </span>
      <span className="log-tag" title={record.tag}>
        <Highlight text={record.tag} query={query} />
      </span>
      <span className="log-msg">
        <Highlight text={record.message} query={query} />
      </span>
      {/* Out of the tab order (a thousand stops): the keyboard path is select + Cmd/Ctrl+C on the list. */}
      <button
        type="button"
        className="log-copy"
        tabIndex={-1}
        aria-label="Copy line"
        title="Copy line"
        onClick={(event) => {
          event.stopPropagation();
          onCopy(record);
        }}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <rect
            x="3.5"
            y="3.5"
            width="6"
            height="6.5"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M7.5 2V1.5a.5.5 0 0 0-.5-.5H2a1 1 0 0 0-1 1v5a.5.5 0 0 0 .5.5H2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      </button>
    </li>
  );
});

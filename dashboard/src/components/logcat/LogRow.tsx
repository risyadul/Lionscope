import { memo } from 'react';
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
  onHover: (ts: number) => void;
};

export const LogRow = memo(function LogRow({ record, query, onHover }: Props) {
  return (
    <li className="log-row" data-level={record.level} onMouseEnter={() => onHover(record.ts)}>
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
    </li>
  );
});

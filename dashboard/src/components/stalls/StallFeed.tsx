import { formatBlockMs, formatClockShort, formatInteger } from '../../lib/format.ts';
import {
  culpritLabel,
  frameLocation,
  frameMethod,
  NO_STACK_LABEL,
  ORIGIN_KIND_LABELS,
  originText,
  stallColor,
  stallOrigin,
  type FeedFilter,
  type FeedItem,
  type StallOrigin,
} from '../../lib/stalls.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';

/** Rows rendered at once; the count still reports every match. */
export const MAX_FEED_ROWS = 500;

const FILTER_OPTIONS: readonly SegmentedOption<FeedFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'stalls', label: 'Stalls' },
  { value: 'strictmode', label: 'StrictMode' },
];

type Props = {
  items: readonly FeedItem[];
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
  /** Label of the culprit line the list is narrowed to. */
  culprit: string | null;
  onClearCulprit: () => void;
  /** Origin the list is narrowed to (stalls only). */
  origin: StallOrigin | null;
  onClearOrigin: () => void;
  onSelect: (key: string) => void;
};

function FeedRow({ item, onSelect }: { item: FeedItem; onSelect: (key: string) => void }) {
  const culprit = item.culprit;
  // Only stalls have an origin; an unknown one (no stack, cut stack) gets no tag.
  const origin = item.kind === 'stall' ? stallOrigin(item.sample) : null;
  const kind = origin === null || origin.kind === 'unknown' ? null : origin.kind;
  const what =
    item.kind === 'stall'
      ? formatBlockMs(item.sample.durationMs)
      : `${item.sample.violation.replace(/Violation$/, '')}${item.sample.count > 1 ? ` ×${formatInteger(item.sample.count)}` : ''}`;
  const summary = [
    formatClockShort(item.ts),
    item.kind === 'stall' ? `blocked ${what}` : `StrictMode ${item.sample.violation}`,
    item.sample.screen ?? 'no screen',
    culprit ? `${frameMethod(culprit)} ${frameLocation(culprit)}` : NO_STACK_LABEL,
    ...(kind === null ? [] : [`${ORIGIN_KIND_LABELS[kind]} origin`]),
  ].join(', ');
  return (
    <li>
      <button
        type="button"
        className="feed-row"
        data-kind={item.kind}
        data-key={item.key}
        aria-label={summary}
        onClick={() => onSelect(item.key)}
      >
        <span className="feed-time mono">{formatClockShort(item.ts)}</span>
        <span className="feed-what">
          {item.kind === 'stall' ? (
            <span
              className="stall-glyph"
              data-kind="stall"
              data-color={stallColor(item.sample)}
              aria-hidden="true"
            />
          ) : (
            <span className="stall-glyph" data-kind="strictmode" aria-hidden="true" />
          )}
          <span className="feed-value mono">{what}</span>
        </span>
        <span className="feed-culprit">
          <span className="feed-line mono" data-none={culprit === null || undefined}>
            {culpritLabel(culprit)}
          </span>
          {(culprit || kind) && (
            <span className="feed-method mono">
              {kind && (
                <span className="origin-tag" data-kind={kind} aria-hidden="true">
                  {ORIGIN_KIND_LABELS[kind]}
                </span>
              )}
              {culprit && frameMethod(culprit)}
            </span>
          )}
        </span>
        <span className="feed-screen">{item.sample.screen ?? '—'}</span>
      </button>
    </li>
  );
}

/** Stalls and StrictMode violations interleaved, newest first. */
export function StallFeed({
  items,
  filter,
  onFilterChange,
  culprit,
  onClearCulprit,
  origin,
  onClearOrigin,
  onSelect,
}: Props) {
  const rows = items.slice(0, MAX_FEED_ROWS);
  return (
    <section className="feed" aria-labelledby="feed-title">
      <div className="stalls-section-head">
        <h3 id="feed-title" className="overline">
          Events
        </h3>
        <span className="stalls-section-meta mono">
          {items.length > rows.length
            ? `${formatInteger(rows.length)} of ${formatInteger(items.length)}`
            : formatInteger(items.length)}
        </span>
        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={onFilterChange}
          label="Show"
          className="feed-filter"
        />
      </div>
      {culprit && (
        <button
          type="button"
          className="btn feed-culprit-filter"
          onClick={onClearCulprit}
          aria-label={`Clear line filter: ${culprit}`}
        >
          <span className="feed-culprit-filter-name mono">{culprit}</span>
          <span className="feed-culprit-filter-hint">Clear</span>
        </button>
      )}
      {origin && (
        <button
          type="button"
          className="btn feed-culprit-filter"
          onClick={onClearOrigin}
          aria-label={`Clear origin filter: ${originText(origin)}`}
        >
          <span className="origin-tag" data-kind={origin.kind}>
            {ORIGIN_KIND_LABELS[origin.kind]}
          </span>
          <span className="feed-culprit-filter-name">
            {origin.label}
            {origin.detail && <span className="mono"> · {origin.detail}</span>}
          </span>
          <span className="feed-culprit-filter-hint">Clear</span>
        </button>
      )}
      {rows.length === 0 ? (
        <p className="stalls-note">
          Nothing matches — pick All or clear the {origin ? 'origin' : 'line'} filter.
        </p>
      ) : (
        <ol className="feed-list" aria-label="Events, newest first" tabIndex={-1}>
          {rows.map((item) => (
            <FeedRow key={item.key} item={item} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </section>
  );
}

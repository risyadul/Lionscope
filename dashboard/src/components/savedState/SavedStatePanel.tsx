import { useState, type ReactNode } from 'react';
import type { SavedStateInstance, SavedStateSample, TransactionFailure } from '@lionscope/protocol/wire';
import { LARGE_SAVED_STATE_BYTES, MAX_SAVED_STATE_DEPTH } from '@lionscope/protocol/wire';
import {
  savedStateChainRows,
  sortChainRows,
  type SavedStateChainRow,
  type SavedStateOrder,
} from '@lionscope/protocol/insights';
import { formatClock, formatClockShort, formatFixed } from '../../lib/format.ts';
import {
  entryRows,
  formatBytes,
  formatDelta,
  formatTrend,
  reportsInWindow,
  share,
  simpleName,
  type EntryRow,
} from '../../lib/savedState.ts';
import './savedState.css';

/** Reports listed before "Show all". */
export const SAVED_STATE_PREVIEW = 20;

type Props = {
  /** The window's reports and the session's failures. */
  savedStates: readonly SavedStateSample[];
  failures: readonly TransactionFailure[];
  /** The SDK's Activity instances (none from a pre-release SDK: the reports are then listed as they come). */
  instances?: readonly SavedStateInstance[];
  fromTs: number;
  toTs: number;
  /** A v10 SDK is linked and measuring. */
  isMeasuring: boolean;
  /** Saved-state tracking in the SDK options; null without a v10 SDK in a running session (no switch then). */
  tracking: boolean | null;
  /** Turns tracking on or off; undefined while the options can't be changed (the switch is disabled). */
  onTrackingChange?: (on: boolean) => void;
};

const saveKey = (report: SavedStateSample) => `${report.pid}:${report.instanceId}:${report.ts}`;

/** The disclosure triangle of a row that opens; it turns when the row is open. */
function Twist() {
  return (
    <span className="state-twist" aria-hidden="true">
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M2 1l4 3-4 3z" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Holds the triangle's column in a row that does not open, so every row lines up. */
const NO_TWIST = <span className="state-twist" aria-hidden="true" />;

function FailureRow({ failure }: { failure: TransactionFailure }) {
  const [open, setOpen] = useState(false);
  const parts = [
    failure.crashed ? 'crashed' : 'logged',
    failure.transaction,
    failure.screen === null ? null : `on ${failure.screen}`,
  ].filter((part) => part !== null);
  const content = (twist: ReactNode) => (
    <>
      {twist}
      <span className="state-failure-size mono">{formatBytes(failure.parcelBytes)}</span>
      <span className="state-failure-what">
        TransactionTooLargeException <span className="state-muted">{parts.join(' · ')}</span>
        {failure.savedState !== null && (
          <span className="state-muted">
            {' '}
            · saved state of {simpleName(failure.savedState.activity)} measured at{' '}
            {formatBytes(failure.savedState.totalBytes)}
            {failure.report === null && ' (its keys are no longer kept)'}
          </span>
        )}
      </span>
      <time className="state-failure-time state-muted mono">{formatClock(failure.ts)}</time>
    </>
  );
  if (failure.report === null) return <li className="state-failure">{content(NO_TWIST)}</li>;
  const { report } = failure;
  return (
    <li className="state-failure-entry">
      <button
        type="button"
        className="state-failure state-failure-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {content(<Twist />)}
      </button>
      {open && (
        <div className="state-report-body">
          <ReportBody report={report} />
        </div>
      )}
    </li>
  );
}

/**
 * A key, indented by its depth in the tree. A Fragment shows its class, then `#n` when siblings share the class, then
 * its `fragment_<who>` key; the key gives way first, so the number stays visible however narrow the panel. A stand-in
 * says "not listed" in a part that never gives way either.
 */
function EntryRowView({ row, totalBytes }: { row: EntryRow; totalBytes: number }) {
  const { entry } = row;
  const key = row.path[row.path.length - 1] ?? '?';
  const path = row.path.join(' › ');
  const indent = { paddingLeft: `${row.depth * 12 + 8}px` };
  if (entry === null) {
    return (
      <tr data-kind="unlisted">
        <td
          className="state-entry-key"
          style={indent}
          title={`Not listed (smaller than the keys shown): ${path}`}
        >
          <span className="state-entry-label">
            <span className="state-entry-name state-entry-unlisted">
              {row.skipped > 0 ? `… › ${key}` : key}
            </span>
            <span className="state-entry-note state-muted">not listed</span>
          </span>
        </td>
        <td />
        <td />
      </tr>
    );
  }
  const fragment = entry.kind === 'fragment' && entry.fragment !== null;
  const detail = fragment ? key : entry.kind === 'value' ? entry.valueClass : null;
  return (
    <tr data-kind={entry.kind}>
      <td className="state-entry-key" style={indent} title={fragment ? `${entry.fragment} · ${path}` : path}>
        <span className="state-entry-label">
          <span className="state-entry-name">{fragment ? simpleName(entry.fragment) : key}</span>
          {row.instance !== null && <span className="state-entry-instance mono">#{row.instance}</span>}
          {detail !== null && <span className="state-entry-detail state-muted">{detail}</span>}
        </span>
      </td>
      <td className="mono">{formatBytes(entry.bytes)}</td>
      <td className="mono">{formatFixed(share(entry, totalBytes), 0)}%</td>
    </tr>
  );
}

/** An opened report: its Activity, then its keys as a tree. */
function ReportBody({ report }: { report: SavedStateSample }) {
  return (
    <>
      <p className="state-muted state-report-activity" title={report.activity}>
        {report.activity} ·{' '}
        {report.hook === 'post_save' ? 'onActivityPostSaveInstanceState' : 'posted after save'}
      </p>
      {report.entries.length === 0 ? (
        <p className="state-muted">
          Below {formatBytes(LARGE_SAVED_STATE_BYTES)}: only the total is measured.
        </p>
      ) : (
        <table className="state-entries">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Size</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {entryRows(report.entries).map((row) => (
              <EntryRowView key={row.path.join('\u0000')} row={row} totalBytes={report.totalBytes} />
            ))}
          </tbody>
        </table>
      )}
      {report.truncated && (
        <p className="state-muted">
          More keys than listed (largest first, up to {MAX_SAVED_STATE_DEPTH} levels).
        </p>
      )}
    </>
  );
}

function Report({
  report,
  open,
  onToggle,
}: {
  report: SavedStateSample;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="state-report">
      <button type="button" className="state-report-head" aria-expanded={open} onClick={onToggle}>
        <Twist />
        <span className="state-report-size mono">{formatBytes(report.totalBytes)}</span>
        <span className="state-report-name" title={report.activity}>
          {report.screen ?? simpleName(report.activity)}
        </span>
        <span className="state-report-meta state-muted mono">
          {formatFixed(report.measureMs + (report.breakdownMs ?? 0), 1)} ms · {formatClock(report.ts)}
        </span>
      </button>
      {open && (
        <div className="state-report-body">
          <ReportBody report={report} />
        </div>
      )}
    </li>
  );
}

/** One save of a chain: its size, the change from the save before, which instance (when the chain has several). */
function SaveRow({
  report,
  previous,
  showId,
  open,
  onToggle,
}: {
  report: SavedStateSample;
  previous: SavedStateSample | undefined;
  showId: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const delta = formatDelta(report.totalBytes, previous?.totalBytes);
  return (
    <li className="state-save">
      <button type="button" className="state-report-head" aria-expanded={open} onClick={onToggle}>
        <Twist />
        <span className="state-report-size mono">{formatBytes(report.totalBytes)}</span>
        <span className="state-report-name state-chain-name">
          <span className="state-chain-label state-muted mono">{delta ?? 'first'}</span>
          {showId && <span className="state-chain-id mono">#{report.instanceId}</span>}
        </span>
        <span className="state-report-meta state-muted mono">
          {formatFixed(report.measureMs + (report.breakdownMs ?? 0), 1)} ms · {formatClock(report.ts)}
        </span>
      </button>
      {open && (
        <div className="state-report-body">
          <ReportBody report={report} />
        </div>
      )}
    </li>
  );
}

/** When the row's Activity was last heard of: its newest save, when it closed, or when it was first seen. */
function lastHeard(row: SavedStateChainRow): string {
  const { head } = row.chain;
  if (head.state === 'closed')
    return `closed ${formatClockShort(head.closedAt ?? row.lastTs ?? head.firstSeen)}`;
  if (head.state === 'process_ended') {
    return `process ended ${formatClockShort(head.closedAt ?? row.lastTs ?? head.firstSeen)}`;
  }
  return row.lastTs === null
    ? `seen ${formatClockShort(head.firstSeen)}`
    : `saved ${formatClockShort(row.lastTs)}`;
}

/**
 * One Activity across its configuration changes: the size of its last save, its name and number (`#id`, never cut),
 * how its saves grew, and when it was last heard of. Opened: every save, newest first. An Activity that has not saved
 * in the window has nothing to open, so its row is plain text without a size.
 */
function ChainRow({
  row,
  open,
  onToggle,
  openSave,
  onToggleSave,
}: {
  row: SavedStateChainRow;
  open: boolean;
  onToggle: () => void;
  openSave: string | null;
  onToggleSave: (key: string) => void;
}) {
  const { head } = row.chain;
  const saved = row.reports.length > 0;
  const name = (
    <span className="state-report-name state-chain-name">
      <span className="state-chain-label">{row.screen ?? simpleName(head.activity)}</span>
      <span className="state-chain-id mono">#{head.id}</span>
    </span>
  );
  const meta = (
    <span className="state-report-meta state-muted">{`${formatTrend(row)} · ${lastHeard(row)}`}</span>
  );
  const title = `${head.activity} · pid ${head.pid}`;
  if (!saved) {
    return (
      <li className="state-report state-chain" data-state={head.state} data-saved="false">
        <div className="state-report-head" title={title}>
          {NO_TWIST}
          <span className="state-report-size mono" />
          {name}
          {meta}
        </div>
      </li>
    );
  }
  return (
    <li className="state-report state-chain" data-state={head.state} data-saved="true">
      <button
        type="button"
        className="state-report-head"
        aria-expanded={open}
        onClick={onToggle}
        title={title}
      >
        <Twist />
        <span className="state-report-size mono">{formatBytes(row.lastBytes)}</span>
        {name}
        {meta}
      </button>
      {open && (
        <div className="state-report-body">
          <p className="state-muted state-report-activity">
            {head.activity} · pid {head.pid}
            {row.chain.instances.length > 1 &&
              ` · ${row.chain.instances.map((instance) => `#${instance.id}`).join(' ← ')}`}
          </p>
          <ul className="state-saves">
            {row.reports.map((report, index) => (
              <SaveRow
                key={saveKey(report)}
                report={report}
                previous={row.reports[index + 1]}
                showId={row.chain.instances.length > 1}
                open={openSave === saveKey(report)}
                onToggle={() => onToggleSave(saveKey(report))}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The State tab: TransactionTooLarge failures (logcat, any app) and the SDK's saved-state attribution. */
export function SavedStatePanel({
  savedStates,
  failures,
  instances = [],
  fromTs,
  toTs,
  isMeasuring,
  tracking,
  onTrackingChange,
}: Props) {
  const [openKey, setOpenKey] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [order, setOrder] = useState<SavedStateOrder>('largest');
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [openSave, setOpenSave] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const reports = reportsInWindow(savedStates, fromTs, toTs);
  const rows = savedStateChainRows(instances, savedStates, fromTs, toTs);
  // Reports of no listed instance (a pre-release SDK sends no instanceId): listed as they come.
  const attributed = new Set(rows.flatMap((row) => row.reports));
  const flat = rows.length === 0 ? reports : reports.filter((report) => !attributed.has(report));
  const shown = showAll ? flat : flat.slice(0, SAVED_STATE_PREVIEW);
  const live = sortChainRows(
    rows.filter((row) => row.chain.head.state === 'live'),
    order,
  );
  const closed = sortChainRows(
    rows.filter((row) => row.chain.head.state !== 'live'),
    order,
  );
  const chainKey = (row: SavedStateChainRow) => `${row.chain.pid}:${row.chain.head.id}`;
  const chainRow = (row: SavedStateChainRow) => (
    <ChainRow
      key={chainKey(row)}
      row={row}
      open={openChain === chainKey(row)}
      onToggle={() => setOpenChain(openChain === chainKey(row) ? null : chainKey(row))}
      openSave={openSave}
      onToggleSave={(key) => setOpenSave(openSave === key ? null : key)}
    />
  );
  const reportList = (
    <>
      <ul className="state-reports">
        {shown.map((report) => (
          <Report
            key={report.ts}
            report={report}
            open={openKey === report.ts}
            onToggle={() => setOpenKey(openKey === report.ts ? null : report.ts)}
          />
        ))}
      </ul>
      {flat.length > shown.length && (
        <button type="button" className="btn state-more" onClick={() => setShowAll(true)}>
          Show all {flat.length}
        </button>
      )}
    </>
  );
  return (
    <section className="state" aria-label="Saved state">
      <div className="state-head">
        <p className="state-muted">
          Each row is one Activity and the size of its last saved state, measured when the save completes: the
          app goes to the background, or another Activity opens on top. Open a row for its saves and the keys
          inside. TransactionTooLarge failures are read from logcat.
        </p>
        {tracking !== null && (
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={tracking}
            disabled={onTrackingChange === undefined}
            title="Measure each Activity's saved state in the app (main-thread cost per save; see the README)"
            onClick={() => onTrackingChange?.(!tracking)}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            Saved-state tracking
          </button>
        )}
      </div>
      <div className="state-body">
        {failures.length > 0 && (
          <>
            <h3 className="overline state-section">TransactionTooLarge</h3>
            <ul className="state-failures">
              {[...failures].reverse().map((failure) => (
                <FailureRow key={failure.id} failure={failure} />
              ))}
            </ul>
          </>
        )}
        <h3 className="overline state-section">Saved states</h3>
        {rows.length > 0 ? (
          <>
            <div className="state-groups-head">
              <h4 className="state-group">Live ({live.length})</h4>
              <div className="segmented state-order" role="group" aria-label="Order">
                {(['largest', 'latest'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={order === value}
                    onClick={() => setOrder(value)}
                  >
                    {value === 'largest' ? 'Largest' : 'Latest'}
                  </button>
                ))}
              </div>
            </div>
            {!isMeasuring && live.length > 0 && (
              <p className="state-muted state-stale">
                Last known state: the SDK is disconnected or saved-state tracking is off.
              </p>
            )}
            {live.length === 0 ? (
              <p className="state-muted state-empty">No live Activity listed.</p>
            ) : (
              <ul className="state-reports">{live.map(chainRow)}</ul>
            )}
            {closed.length > 0 && (
              <>
                <button
                  type="button"
                  className="state-group state-group-toggle"
                  aria-expanded={showClosed}
                  onClick={() => setShowClosed(!showClosed)}
                >
                  <Twist />
                  Closed ({closed.length})
                </button>
                {showClosed && <ul className="state-reports">{closed.map(chainRow)}</ul>}
              </>
            )}
            {flat.length > 0 && (
              <>
                <h4 className="state-group">Unattributed (older SDK)</h4>
                {reportList}
              </>
            )}
          </>
        ) : reports.length === 0 ? (
          <p className="state-muted state-empty">
            {isMeasuring
              ? 'No Activity saved its state in this window yet: send the app to the background.'
              : tracking === false
                ? 'Saved-state tracking is off. TransactionTooLarge failures above are still read from logcat.'
                : 'Needs the in-app SDK 0.12.0+ in a profiling session. TransactionTooLarge failures above work without it.'}
          </p>
        ) : (
          reportList
        )}
      </div>
    </section>
  );
}

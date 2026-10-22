import { useMemo, useState } from 'react';
import type { InflateSample } from '@lionscope/protocol/wire';
import { SLOW_INFLATE_MS } from '@lionscope/protocol/wire';
import { formatInflateMs, formatInteger } from '../../lib/format.ts';
import {
  aggregateLayouts,
  inflatesInWindow,
  sortLayoutRows,
  type LayoutRow,
  type LayoutSortKey,
} from '../../lib/layouts.ts';
import type { SortDirection } from '../../lib/screenStats.ts';
import type { LayoutsEmpty } from '../../lib/viewState.ts';
import { SDK_GRADLE_SNIPPET } from '../topbar/SdkStatus.tsx';
import './layouts.css';
import './layoutsNarrow.css';

/** Rows shown before "Show all". */
export const LAYOUTS_PREVIEW = 40;

type Props = {
  inflates: readonly InflateSample[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Set when there is nothing in the window. */
  empty: LayoutsEmpty | null;
  /** Inflation tracking is off in the SDK options: new rows stop arriving. */
  isTrackingOff: boolean;
  /** Turns tracking back on; undefined while the options can't be changed. */
  onEnableTracking?: () => void;
};

interface Column {
  key: LayoutSortKey;
  label: string;
  title: string;
  firstDirection: SortDirection;
}

const COLUMNS: readonly Column[] = [
  { key: 'name', label: 'Layout', title: 'Layout resource name', firstDirection: 'asc' },
  { key: 'count', label: 'Count', title: 'Inflations in the window', firstDirection: 'desc' },
  {
    key: 'totalMs',
    label: 'Total',
    title:
      'Main-thread time spent inflating this layout (ms). A lower bound: parser setup is not included. A nested layout (an <include>) is also part of the layout that includes it, so its row is not extra time.',
    firstDirection: 'desc',
  },
  { key: 'meanMs', label: 'Mean', title: 'Total / count (ms)', firstDirection: 'desc' },
  {
    key: 'maxMs',
    label: 'Max',
    title: `Slowest single inflation (ms). ${SLOW_INFLATE_MS} ms or more is marked on the Main thread lane.`,
    firstDirection: 'desc',
  },
  { key: 'views', label: 'Views', title: 'Views created by the slowest inflation', firstDirection: 'desc' },
  { key: 'screenCount', label: 'Screens', title: 'Screens it was inflated on', firstDirection: 'desc' },
];

const LABEL_TITLE =
  'The SDK could not resolve this layout’s name. It shows the first view’s class and the XML line instead.';

function EmptyPanel({ empty, onEnableTracking }: { empty: LayoutsEmpty; onEnableTracking?: () => void }) {
  switch (empty.kind) {
    case 'waiting':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">No layouts inflated yet</p>
          <p>Every XML layout the app inflates on the main thread gets a row: screens, dialogs, list rows.</p>
          <p className="layouts-empty-note">
            Layouts are timed as they are created, so open a screen that was not already on top.
          </p>
          <p className="layouts-empty-note">
            Nothing appears if the app opted out in its manifest, sets its own LayoutInflater factory, or its
            screens are not AppCompatActivity (plain Activity and ComponentActivity screens are not timed).
          </p>
        </div>
      );
    case 'window':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">Nothing in this window</p>
          <p>Widen the time window, or go back to Live if the timeline is paused.</p>
        </div>
      );
    case 'off':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">Inflation tracking is off</p>
          <p>
            Layouts are not being timed. Turn it on and open a screen: the app only measures layouts it
            inflates from then on.
          </p>
          {onEnableTracking && (
            <button type="button" className="btn layouts-empty-action" onClick={onEnableTracking}>
              Turn on inflation tracking
            </button>
          )}
        </div>
      );
    case 'api-level':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">Layout inflation needs Android 10+</p>
          <p>
            This device runs Android API {empty.apiLevel}, which has no hook for timing inflation. View trees
            still work: the Screens tab shows each screen’s view count and depth.
          </p>
        </div>
      );
    case 'old-sdk':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">This SDK can’t time layouts</p>
          <p>
            The app runs Lionscope SDK{empty.sdkVersion ? ` v${empty.sdkVersion}` : ''}. Update the app’s
            Lionscope SDK to 0.4.0 for layout inflation timing and view trees, then rebuild and reinstall the
            debug app.
          </p>
        </div>
      );
    case 'old-server':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">This server can’t record layouts</p>
          <p>Update Lionscope to 0.4.0: layout timing needs a matching server and SDK.</p>
        </div>
      );
    case 'link-failed':
      return (
        <div className="layouts-empty" data-tone="critical">
          <p className="layouts-empty-title">SDK link failed</p>
          <p>
            The server couldn’t map the SDK port on the device (<code>adb reverse</code>), so the app can’t
            report here. It retries when the device reconnects.
          </p>
          <p className="layouts-empty-detail mono">{empty.message}</p>
        </div>
      );
    case 'disconnected':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">SDK disconnected</p>
          <p>SDK v{empty.sdkVersion} dropped off. It reconnects by itself while the app is running.</p>
        </div>
      );
    case 'no-session':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">No layouts recorded</p>
          <p>
            Start a session on an app with the Lionscope SDK: layouts show up here as the app inflates them.
          </p>
        </div>
      );
    case 'no-sdk':
      return (
        <div className="layouts-empty">
          <p className="layouts-empty-title">Layout timing needs the SDK</p>
          <p>
            The SDK times every XML layout the app inflates, with no app changes. Add the Lionscope SDK (0.4.0
            or newer), rebuild and reinstall the debug app; it connects to this session on launch.
          </p>
          <pre className="layouts-snippet mono">{SDK_GRADLE_SNIPPET}</pre>
        </div>
      );
  }
}

function LayoutCell({ row }: { row: LayoutRow }) {
  const shownScreens = row.screens.slice(0, 2).join(', ');
  const more = row.screens.length - 2;
  return (
    <th scope="row" data-col="name">
      <span className="layout-name-line">
        <span
          className="layout-name mono"
          data-label={row.isLabel || undefined}
          title={row.isLabel ? LABEL_TITLE : row.name}
        >
          {row.name}
        </span>
        {row.library && (
          <span className="layout-badge" title="From a library or the Android framework">
            lib
          </span>
        )}
        {row.nestedCount > 0 && (
          <span
            className="layout-badge"
            title={
              row.nestedCount === row.count
                ? 'Always inflated inside another layout (an <include> or a compound view). Its time is already part of that layout’s, so this row is not extra time.'
                : `${formatInteger(row.nestedCount)} of ${formatInteger(row.count)} inflations ran inside another layout. Those are already part of the enclosing layout’s time.`
            }
          >
            {row.nestedCount === row.count ? 'nested' : 'some nested'}
          </span>
        )}
      </span>
      {row.screens.length > 0 && (
        <span className="layout-screens" title={row.screens.join(', ')}>
          {shownScreens}
          {more > 0 && ` +${more}`}
        </span>
      )}
    </th>
  );
}

/** The Layouts tab: one row per layout the app inflated, heaviest first. */
export function LayoutsPanel({ inflates, fromTs, toTs, empty, isTrackingOff, onEnableTracking }: Props) {
  const [sortKey, setSortKey] = useState<LayoutSortKey>('totalMs');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [showLibrary, setShowLibrary] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const rows = useMemo(
    () => aggregateLayouts(inflates, fromTs, toTs, showLibrary),
    [inflates, fromTs, toTs, showLibrary],
  );
  const hiddenLibrary = useMemo(
    () =>
      showLibrary
        ? 0
        : new Set(
            inflatesInWindow(inflates, fromTs, toTs)
              .filter((s) => s.library)
              .map((s) => s.layout ?? s.label),
          ).size,
    [inflates, fromTs, toTs, showLibrary],
  );
  const sorted = sortLayoutRows(rows, sortKey, direction);
  const shown = isExpanded ? sorted : sorted.slice(0, LAYOUTS_PREVIEW);
  const worstTotal = Math.max(0, ...rows.map((row) => row.totalMs));

  const sortBy = (column: Column) => {
    if (column.key === sortKey) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(column.key);
      setDirection(column.firstDirection);
    }
  };

  return (
    <section className="layouts" aria-labelledby="layouts-title">
      <header className="layouts-head">
        <h2 id="layouts-title" className="sr-only">
          Layouts
        </h2>
        <p className="layouts-scope">
          <span className="overline">Visible window</span>
          <span className="mono">
            {formatInteger(rows.length)} {rows.length === 1 ? 'layout' : 'layouts'}
          </span>
        </p>
        {(empty === null || empty.kind === 'window') && (
          <button
            type="button"
            role="switch"
            className="switch layouts-library"
            aria-checked={showLibrary}
            title="Layouts from the Android framework and libraries (AppCompat, Material, AndroidX). Hidden by default: they are rarely yours to fix."
            onClick={() => setShowLibrary((v) => !v)}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            Show library layouts
            {hiddenLibrary > 0 && (
              <span className="layouts-hidden mono">+{formatInteger(hiddenLibrary)}</span>
            )}
          </button>
        )}
        {isTrackingOff && empty === null && (
          <p className="layouts-off-note">
            Inflation tracking is off: no new layouts are recorded.
            {onEnableTracking && (
              <button type="button" className="layouts-link" onClick={onEnableTracking}>
                Turn on
              </button>
            )}
          </p>
        )}
      </header>

      <div className="layouts-body">
        {empty !== null ? (
          <EmptyPanel empty={empty} onEnableTracking={onEnableTracking} />
        ) : rows.length === 0 ? (
          <div className="layouts-empty">
            <p className="layouts-empty-title">Only library layouts in this window</p>
            <p>
              The app inflated {formatInteger(hiddenLibrary)} library or framework{' '}
              {hiddenLibrary === 1 ? 'layout' : 'layouts'} and none of its own.
            </p>
            <button type="button" className="btn layouts-empty-action" onClick={() => setShowLibrary(true)}>
              Show library layouts
            </button>
          </div>
        ) : (
          <>
            <table className="layouts-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      data-col={column.key}
                      aria-sort={
                        sortKey === column.key
                          ? direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        className="sort-btn"
                        onClick={() => sortBy(column)}
                        title={column.title}
                      >
                        {column.label}
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                          <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const share = worstTotal > 0 ? row.totalMs / worstTotal : 0;
                  return (
                    <tr key={row.key}>
                      <LayoutCell row={row} />
                      <td data-col="count" className="mono">
                        {formatInteger(row.count)}
                      </td>
                      <td data-col="totalMs" className="mono">
                        {formatInflateMs(row.totalMs)}
                        <span className="layout-meter" aria-hidden="true">
                          <span style={{ transform: `scaleX(${share})` }} />
                        </span>
                      </td>
                      <td data-col="meanMs" className="mono">
                        {formatInflateMs(row.meanMs)}
                      </td>
                      <td data-col="maxMs" className="mono">
                        <span className="inflate-max" data-slow={row.maxMs >= SLOW_INFLATE_MS || undefined}>
                          {formatInflateMs(row.maxMs)}
                        </span>
                      </td>
                      <td data-col="views" className="mono">
                        {formatInteger(row.views)}
                      </td>
                      <td data-col="screenCount" className="mono">
                        {formatInteger(row.screens.length)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="layouts-foot">
              <span>
                Times are ms of main-thread work; a lower bound. Nested layouts are part of the layout around
                them.
              </span>
              {sorted.length > LAYOUTS_PREVIEW && (
                <button type="button" className="layouts-link" onClick={() => setIsExpanded((v) => !v)}>
                  {isExpanded ? `Show top ${LAYOUTS_PREVIEW}` : `Show all ${formatInteger(sorted.length)}`}
                </button>
              )}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

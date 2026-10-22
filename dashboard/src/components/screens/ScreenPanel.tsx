import { useState } from 'react';
import type { FrameStage } from '@lionscope/protocol/wire';
import { SLOW_INFLATE_MS } from '@lionscope/protocol/wire';
import { formatBlockMs, formatFixed, formatInflateMs, formatInteger } from '../../lib/format.ts';
import { pathLabel } from '../../lib/layouts.ts';
import { screenColor } from '../../lib/screens.ts';
import {
  sortScreenRows,
  type ScreenRow,
  type ScreenSortKey,
  type SortDirection,
} from '../../lib/screenStats.ts';
import { STACK_ORDER, STAGE_COLORS, STAGE_LABELS, STAGE_SHORT_LABELS } from '../../lib/stages.ts';
import { JANK_FLAG_PERCENT } from '../../lib/stats.ts';
import type { ScreensEmpty } from '../../lib/viewState.ts';
import { SDK_GRADLE_SNIPPET, SDK_SETTINGS_NOTE } from '../topbar/SdkStatus.tsx';
import './screens.css';
import './screensNarrow.css';

const NO_SCREEN_LABEL = 'no screen';

/** Why there are no rows to show. */
export type ScreenPanelEmpty = ScreensEmpty;

type Props = {
  rows: readonly ScreenRow[];
  /** Set when `rows` is empty. */
  empty: ScreenPanelEmpty | null;
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Show the Stalls column (a v2 SDK is linked or stalls were recorded). */
  showStalls?: boolean;
  /** Show the Inflate and Views columns (a v3 SDK is linked or layout data was recorded). */
  showLayouts?: boolean;
};

interface Column {
  key: ScreenSortKey;
  label: string;
  title?: string;
  /** Sort direction on the first click. */
  firstDirection: SortDirection;
}

const COLUMNS: readonly Column[] = [
  { key: 'name', label: 'Screen', firstDirection: 'asc' },
  { key: 'frames', label: 'Frames', firstDirection: 'desc' },
  { key: 'jankPercent', label: 'Jank', title: 'Janky frames / frames', firstDirection: 'desc' },
  { key: 'slowPercent', label: 'Slow', title: 'Frames over one vsync / frames', firstDirection: 'desc' },
  {
    key: 'typicalP90Ms',
    label: 'p90 typ',
    title:
      'Typical p90 frame time (ms): the frame-weighted median of the 0.5 s bucket p90s, ignoring buckets under 3 frames. The worst bucket is shown under it.',
    firstDirection: 'desc',
  },
];

const STALLS_COLUMN: Column = {
  key: 'stallCount',
  label: 'Stalls',
  title:
    'Main-thread stalls on this screen in the window and the time they blocked it (debugger stalls excluded)',
  firstDirection: 'desc',
};

const INFLATE_COLUMN: Column = {
  key: 'inflateMs',
  label: 'Inflate',
  title:
    'Main-thread time spent inflating XML layouts on this screen in the window, and how many inflations. A lower bound; the slowest layout is in the cell’s tooltip.',
  firstDirection: 'desc',
};

const VIEWS_COLUMN: Column = {
  key: 'views',
  label: 'Views',
  title: 'Views in the screen’s latest view tree, and its depth. The deepest path is in the cell’s tooltip.',
  firstDirection: 'desc',
};

function inflateTitle(row: ScreenRow): string | undefined {
  if (row.slowestInflate === null) return undefined;
  const { name, ms } = row.slowestInflate;
  return `Slowest: ${name}, ${formatInflateMs(ms)} ms\n${formatInteger(row.inflateCount)} ${row.inflateCount === 1 ? 'inflation' : 'inflations'}, each counted once, layouts inside another layout included in it (a lower bound)`;
}

function viewsTitle(row: ScreenRow): string | undefined {
  const tree = row.viewTree;
  if (tree === null) return undefined;
  const lines = [
    `${tree.window}: ${formatInteger(tree.views)} views, ${formatInteger(tree.viewGroups)} view groups, depth ${tree.maxDepth}`,
    `Deepest: ${pathLabel(tree)}`,
  ];
  if (tree.topClasses.length > 0) {
    lines.push(
      `Most common: ${tree.topClasses
        .slice(0, 3)
        .map((c) => `${c.className} ×${formatInteger(c.count)}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

function EmptyPanel({ empty }: { empty: ScreenPanelEmpty }) {
  if (empty.kind === 'link-failed') {
    return (
      <div className="screens-empty" data-tone="critical">
        <p className="screens-empty-title">SDK link failed</p>
        <p>
          The server couldn’t map the SDK port on the device (<code>adb reverse</code>), so the app’s SDK
          can’t reach this session. It retries when the device reconnects; replugging the device or restarting
          the session usually clears it.
        </p>
        <p className="screens-empty-detail mono">{empty.message}</p>
      </div>
    );
  }
  if (empty.kind === 'disconnected') {
    return (
      <div className="screens-empty">
        <p className="screens-empty-title">SDK disconnected</p>
        <p>
          SDK v{empty.sdkVersion} was linked to this session but dropped before any frames arrived. It
          reconnects by itself while the app is running.
        </p>
      </div>
    );
  }
  if (empty.kind === 'window') {
    return (
      <div className="screens-empty">
        <p className="screens-empty-title">No SDK frames in this window</p>
        <p>Widen the time window, or go back to Live if the timeline is paused.</p>
      </div>
    );
  }
  if (empty.kind === 'waiting') {
    return (
      <div className="screens-empty">
        <p className="screens-empty-title">SDK connected — waiting for frames</p>
        <p>Use the app: each screen gets a row once it draws frames.</p>
      </div>
    );
  }
  return (
    <div className="screens-empty">
      <p className="screens-empty-title">No screen data yet</p>
      <p>
        Frames, jank and stage timing per screen come from the in-app Lionscope SDK. Add it for local
        profiling, rebuild and reinstall the debug app; it connects to this session on launch.
      </p>
      <pre className="screens-snippet mono">{SDK_GRADLE_SNIPPET}</pre>
      <p className="screens-empty-note">{SDK_SETTINGS_NOTE}</p>
    </div>
  );
}

/** Where a selected screen's frame time goes, as one 100% bar plus the leading stages. */
function StageProfile({ row }: { row: ScreenRow }) {
  const total = STACK_ORDER.reduce((sum, stage) => sum + row.stageMs[stage], 0);
  if (total <= 0) return null;
  const leading = [...STACK_ORDER]
    .filter((stage) => row.stageMs[stage] > 0)
    .sort((a, b) => row.stageMs[b] - row.stageMs[a])
    .slice(0, 4);
  return (
    <figure className="stage-profile">
      <figcaption className="overline">Stage profile · mean ms / frame</figcaption>
      <div className="stage-bar" role="img" aria-label={stageSummary(row, leading)}>
        {STACK_ORDER.map((stage) =>
          row.stageMs[stage] > 0 ? (
            <span
              key={stage}
              className="stage-seg"
              data-color={STAGE_COLORS[stage]}
              style={{ flexGrow: row.stageMs[stage] }}
              title={`${STAGE_LABELS[stage]} ${formatFixed(row.stageMs[stage], 2)} ms`}
            />
          ) : null,
        )}
      </div>
      <ul className="stage-list">
        {leading.map((stage) => (
          <li key={stage}>
            <span
              className="legend-key"
              data-key="area"
              data-color={STAGE_COLORS[stage]}
              aria-hidden="true"
            />
            <span className="stage-name">{STAGE_LABELS[stage]}</span>
            <span className="mono">{formatFixed(row.stageMs[stage], 2)} ms</span>
            <span className="stage-share mono">{formatFixed((row.stageMs[stage] / total) * 100, 0)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function stageSummary(row: ScreenRow, stages: readonly FrameStage[]): string {
  return stages.map((stage) => `${STAGE_LABELS[stage]} ${formatFixed(row.stageMs[stage], 2)} ms`).join(', ');
}

export function ScreenPanel({
  rows,
  empty,
  selected,
  onSelect,
  showStalls = false,
  showLayouts = false,
}: Props) {
  const [sortKey, setSortKey] = useState<ScreenSortKey>('jankPercent');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const columns = [
    ...COLUMNS,
    ...(showStalls ? [STALLS_COLUMN] : []),
    ...(showLayouts ? [INFLATE_COLUMN, VIEWS_COLUMN] : []),
  ];

  const sorted = sortScreenRows(rows, sortKey, direction);
  const shown = selected === null ? sorted : sorted.filter((row) => row.name === selected);
  const maxJank = Math.max(0, ...rows.map((row) => row.jankPercent));
  const selectedRow = shown[0];

  const sortBy = (column: Column) => {
    if (column.key === sortKey) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(column.key);
      setDirection(column.firstDirection);
    }
  };

  return (
    <section className="screens" aria-labelledby="screens-title">
      <header className="screens-head">
        <h2 id="screens-title" className="sr-only">
          Screens
        </h2>
        <p className="screens-scope">
          <span className="overline">Visible window</span>
          <span className="mono">
            {formatInteger(rows.length)} {rows.length === 1 ? 'screen' : 'screens'}
          </span>
        </p>
        {selected !== null && (
          <button type="button" className="btn screens-filter" onClick={() => onSelect(null)}>
            <span className="screen-swatch" data-color={screenColor(selected)} aria-hidden="true" />
            <span className="screens-filter-name">{selected}</span>
            <span className="screens-filter-hint">Clear · Esc</span>
          </button>
        )}
      </header>

      <div className="screens-body">
        {empty !== null ? (
          <EmptyPanel empty={empty} />
        ) : (
          <>
            <table className="screens-table" data-layouts={showLayouts || undefined}>
              <thead>
                <tr>
                  {columns.map((column) => (
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
                  {/* Explicit roles: narrow panels position this column out of the table layout. */}
                  <th scope="col" data-col="dominant" role="columnheader">
                    <span title="Stage with the largest share of frame time (frame-weighted mean ms)">
                      Dominant
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const isSelected = row.name !== null && row.name === selected;
                  const jankShare = maxJank > 0 ? row.jankPercent / maxJank : 0;
                  return (
                    <tr
                      key={row.name ?? '\u0000'}
                      data-selected={isSelected || undefined}
                      onClick={row.name === null ? undefined : () => onSelect(isSelected ? null : row.name)}
                    >
                      <th scope="row" data-col="name">
                        {row.name === null ? (
                          <span className="screen-cell" data-none>
                            <span className="screen-swatch" data-bg aria-hidden="true" />
                            {NO_SCREEN_LABEL}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="screen-cell"
                            aria-pressed={isSelected}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect(isSelected ? null : row.name);
                            }}
                          >
                            <span
                              className="screen-swatch"
                              data-color={screenColor(row.name)}
                              aria-hidden="true"
                            />
                            <span className="screen-cell-name">{row.name}</span>
                          </button>
                        )}
                      </th>
                      <td data-col="frames" className="mono">
                        {formatInteger(row.frames)}
                      </td>
                      <td data-col="jankPercent" className="mono">
                        <span
                          className="jank-value"
                          data-flag={row.jankPercent >= JANK_FLAG_PERCENT || undefined}
                        >
                          {formatFixed(row.jankPercent, 1)}%
                        </span>
                        <span className="jank-meter" aria-hidden="true">
                          <span style={{ transform: `scaleX(${jankShare})` }} />
                        </span>
                      </td>
                      <td data-col="slowPercent" className="mono">
                        {formatFixed(row.slowPercent, 1)}%
                      </td>
                      <td data-col="typicalP90Ms" className="mono">
                        {formatFixed(row.typicalP90Ms, 1)}
                        <span className="p90-worst">worst {formatFixed(row.worstP90Ms, 1)}</span>
                      </td>
                      {showStalls && (
                        <td
                          data-col="stallCount"
                          className="mono"
                          title={row.stallCount > 0 ? `${formatBlockMs(row.stallMs)} blocked` : undefined}
                        >
                          <span className="stall-count" data-flag={row.stallCount > 0 || undefined}>
                            {formatInteger(row.stallCount)}
                          </span>
                          {row.stallCount > 0 && (
                            <span className="stall-blocked">
                              <span className="sr-only">, </span>
                              {formatBlockMs(row.stallMs)}
                              <span className="sr-only"> blocked</span>
                            </span>
                          )}
                        </td>
                      )}
                      {showLayouts && (
                        <>
                          <td data-col="inflateMs" className="mono" title={inflateTitle(row)}>
                            {row.inflateCount > 0 ? (
                              <>
                                <span
                                  className="inflate-total"
                                  data-flag={(row.slowestInflate?.ms ?? 0) >= SLOW_INFLATE_MS || undefined}
                                >
                                  {formatInflateMs(row.inflateMs)}
                                </span>
                                <span className="stall-blocked">
                                  <span className="sr-only">, </span>×{formatInteger(row.inflateCount)}
                                </span>
                              </>
                            ) : (
                              <span className="stall-count">—</span>
                            )}
                          </td>
                          <td data-col="views" className="mono" title={viewsTitle(row)}>
                            {row.viewTree !== null ? (
                              <>
                                {formatInteger(row.viewTree.views)}
                                <span className="stall-blocked">
                                  <span className="sr-only">, </span>depth {row.viewTree.maxDepth}
                                </span>
                              </>
                            ) : (
                              <span className="stall-count">—</span>
                            )}
                          </td>
                        </>
                      )}
                      <td data-col="dominant" role="cell">
                        {row.dominant ? (
                          <span className="dominant" title={STAGE_LABELS[row.dominant.stage]}>
                            <span
                              className="legend-key"
                              data-key="area"
                              data-color={STAGE_COLORS[row.dominant.stage]}
                              aria-hidden="true"
                            />
                            <span className="dominant-name">{STAGE_SHORT_LABELS[row.dominant.stage]}</span>
                            <span className="mono">{formatFixed(row.dominant.ms, 1)}</span>
                          </span>
                        ) : (
                          '—'
                        )}
                        {showLayouts && row.viewTree !== null && (
                          // Narrow panels fold the Views column into this second line (screensNarrow.css).
                          <span className="dominant-views mono" title={viewsTitle(row)}>
                            {formatInteger(row.viewTree.views)} views
                            <span className="dominant-depth"> · depth {row.viewTree.maxDepth}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {selected !== null && selectedRow === undefined && (
              <p className="screens-note">
                <strong>{selected}</strong> drew no frames in this window.
              </p>
            )}
            {selected !== null && selectedRow !== undefined && <StageProfile row={selectedRow} />}
          </>
        )}
      </div>
    </section>
  );
}

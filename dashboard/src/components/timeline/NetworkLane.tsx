import { useMemo, useRef, useState } from 'react';
import type { HttpExchange } from '@lionscope/protocol/wire';
import { statusClassOf, urlParts, type HttpStatusClass } from '@lionscope/protocol/insights';
import { useElementWidth } from '../../hooks/useElementWidth.ts';
import { formatBlockMs, formatClockShort, formatInteger } from '../../lib/format.ts';
import { formatBytes, layoutLaneBars, type LaneBar } from '../../lib/network.ts';
import type { Signal } from '../../lib/signal.ts';
import { TRACK_INSETS, TrackMarkers } from './ScreensLane.tsx';
import './networkLane.css';

/** Overlapping calls stack in this many rows; the rest collapse into the overflow strip. */
export const NETWORK_LANE_ROWS = 4;
/** Laid out at this width until the track is measured (and in tests). */
const FALLBACK_WIDTH_PX = 1000;
const TOOLTIP_HALF_WIDTH = 130;

/** The lane's colors: 1xx reads as a redirect-like hop, failures as server errors. */
type BarClass = '2xx' | '3xx' | '4xx' | '5xx' | 'pending';
const BAR_CLASS: Record<HttpStatusClass, BarClass> = {
  '1xx': '3xx',
  '2xx': '2xx',
  '3xx': '3xx',
  '4xx': '4xx',
  '5xx': '5xx',
  failed: '5xx',
  pending: 'pending',
};

const LEGEND: readonly { key: BarClass; label: string }[] = [
  { key: '2xx', label: '2xx' },
  { key: '3xx', label: '3xx' },
  { key: '4xx', label: '4xx' },
  { key: '5xx', label: '5xx · failed' },
  { key: 'pending', label: 'pending' },
];

const LANE_HINT =
  'One bar per HTTP call the app made through Lionscope.okHttpInterceptor(), from its start to the end of its body (pending calls grow until they end), colored by status. Overlapping calls stack in rows; when more overlap than fit, a hatched strip at the bottom stands for them. Mocked calls have a dashed outline. Click a bar for the call in the Network tab.';

type Props = {
  exchanges: readonly HttpExchange[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Where pending calls end (now while live). */
  openEnd: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Reveals the Network tab; offered while it is not on screen. */
  onViewList?: () => void;
  cursorX: Signal<number | null>;
  probeTs: Signal<number | null>;
};

function statusLabel(exchange: HttpExchange): string {
  if (exchange.state === 'pending') return 'pending';
  if (exchange.status !== null) return String(exchange.status);
  return exchange.error === null ? 'failed' : `failed · ${exchange.error.kind}`;
}

function BarTip({ exchange, center }: { exchange: HttpExchange; center: number }) {
  const { host, path } = urlParts(exchange.url);
  return (
    <div className="net-tip" style={{ left: `${Math.round(center)}px` }} aria-hidden="true">
      <p className="net-tip-title">
        <span className="net-tip-method mono">{exchange.method}</span>
        <span className="net-tip-status mono" data-class={BAR_CLASS[statusClassOf(exchange)]}>
          {statusLabel(exchange)}
        </span>
        {exchange.mockId !== null && <span className="net-tip-mock">mocked</span>}
      </p>
      <p className="net-tip-path mono">{path}</p>
      <p className="net-tip-host">{host}</p>
      <p className="net-tip-time mono">
        {exchange.durationMs === null ? 'still running' : formatBlockMs(exchange.durationMs)}
        <span>
          {formatClockShort(exchange.ts)}
          {exchange.responseSize !== null && ` · ${formatBytes(exchange.responseSize)}`}
        </span>
      </p>
      <p className="net-tip-hint">Click to open it in the Network tab</p>
    </div>
  );
}

/**
 * The Network lane: one bar per HTTP call on the shared x axis (aligned with the chart plot areas, the synced
 * cursor drawn through it), stacked in a few rows. Hover shows the call; click selects it in the Network tab. Bars
 * are not focusable: the Network tab's list is the keyboard path to every call.
 */
export function NetworkLane({
  exchanges,
  fromTs,
  toTs,
  openEnd,
  selectedId,
  onSelect,
  onViewList,
  cursorX,
  probeTs,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(trackRef);
  const width = measured > 0 ? measured : FALLBACK_WIDTH_PX;
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const layout = useMemo(
    () => layoutLaneBars(exchanges, fromTs, toTs, openEnd, width, NETWORK_LANE_ROWS),
    [exchanges, fromTs, toTs, openEnd, width],
  );
  // A hovered bar that left the window (or the buffer) drops its tooltip.
  const hovered: LaneBar | null = layout.bars.find((bar) => bar.exchange.id === hoveredId) ?? null;
  const tipCenter =
    hovered === null
      ? 0
      : width < TOOLTIP_HALF_WIDTH * 2
        ? width / 2
        : Math.min(
            Math.max((hovered.left + hovered.width / 2) * width, TOOLTIP_HALF_WIDTH),
            width - TOOLTIP_HALF_WIDTH,
          );
  const hiddenCount = layout.overflow.reduce((sum, o) => sum + o.count, 0);

  return (
    <figure className="lane lane--network" aria-labelledby="lane-network-title">
      <figcaption className="lane-head">
        <div className="lane-name">
          <h2 id="lane-network-title" className="lane-title">
            Network
          </h2>
          <span className="lane-unit">HTTP calls · OkHttp</span>
          <span className="lane-hint" tabIndex={0} role="note" aria-label={LANE_HINT} title={LANE_HINT}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6 5.3v3.2M6 3.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          {onViewList && layout.total > 0 && (
            <button type="button" className="screen-view-link" onClick={onViewList}>
              View in Network
              <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                <path
                  d="M2 4.5h5M4.8 2.2 7 4.5 4.8 6.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </button>
          )}
        </div>
        <ul className="lane-legend" aria-label="Network in this window">
          <li className="legend-item net-ramp" title="Bar color by status class">
            {LEGEND.map((item) => (
              <span key={item.key} className="net-ramp-step">
                <span className="net-key-bar" data-class={item.key} aria-hidden="true" />
                <span className="legend-label">{item.label}</span>
              </span>
            ))}
            <span className="net-ramp-step">
              <span className="net-key-bar" data-mocked aria-hidden="true" />
              <span className="legend-label">mocked</span>
            </span>
          </li>
          <li className="legend-item">
            <span className="legend-label">Calls</span>
            <span className="legend-value mono">{formatInteger(layout.total)}</span>
          </li>
          <li className="legend-item">
            <span className="legend-label">Failed · 5xx</span>
            <span className="legend-value mono">{formatInteger(layout.failed)}</span>
          </li>
        </ul>
      </figcaption>
      <div className="net-track-host">
        <div
          ref={trackRef}
          className="net-track"
          style={TRACK_INSETS}
          role="group"
          aria-label={`${formatInteger(layout.total)} HTTP calls in this window; the Network tab lists them`}
          data-has-selection={selectedId !== null || undefined}
          onMouseLeave={() => setHoveredId(null)}
        >
          {layout.total === 0 && <span className="net-track-empty">No HTTP calls in this window</span>}
          {layout.bars.map((bar) => (
            <span
              key={bar.exchange.id}
              className="net-bar"
              data-id={bar.exchange.id}
              data-row={bar.row}
              data-class={BAR_CLASS[statusClassOf(bar.exchange)]}
              data-mocked={bar.exchange.mockId !== null || undefined}
              data-open={bar.exchange.endTs === null || undefined}
              data-selected={bar.exchange.id === selectedId || undefined}
              style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
              aria-hidden="true"
              onMouseEnter={() => setHoveredId(bar.exchange.id)}
              onClick={() => onSelect(bar.exchange.id)}
            />
          ))}
          {layout.overflow.map((strip) => (
            <span
              key={strip.left}
              className="net-overflow"
              style={{ left: `${strip.left * 100}%`, width: `${strip.width * 100}%` }}
              title={`${formatInteger(strip.count)} more overlapping ${strip.count === 1 ? 'call' : 'calls'}: pick a shorter window, or see them in the Network tab`}
              aria-hidden="true"
            />
          ))}
          {hiddenCount > 0 && (
            <span className="sr-only">
              {formatInteger(hiddenCount)} overlapping calls are not drawn apart.
            </span>
          )}
          <TrackMarkers cursorX={cursorX} probeTs={probeTs} fromTs={fromTs} toTs={toTs} width={measured} />
          {hovered && <BarTip exchange={hovered.exchange} center={tipCenter} />}
        </div>
      </div>
    </figure>
  );
}

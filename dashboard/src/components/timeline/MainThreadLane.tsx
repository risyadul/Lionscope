import { useCallback, useMemo, useState } from 'react';
import type { InflateSample, StallSample, StrictModeSample, TimelineEvent } from '@lionscope/protocol/wire';
import { SLOW_INFLATE_MS } from '@lionscope/protocol/wire';
import { formatBlockMs, formatClockShort, formatInflateMs, formatInteger } from '../../lib/format.ts';
import { hitTestInflates, inflateKey, layoutName, slowInflates } from '../../lib/layouts.ts';
import type { Signal } from '../../lib/signal.ts';
import {
  buildFeed,
  buildStallScaleData,
  culpritLabel,
  frameMethod,
  hitTestMarks,
  originText,
  SEVERITY_COLORS,
  stallColor,
  stallOrigin,
  stallSeverity,
  summarizeWindow,
  type FeedItem,
  type StallSeverity,
} from '../../lib/stalls.ts';
import type { ChartTheme } from '../../lib/theme.ts';
import { INFLATE_ROW_PX, STALL_RAIL_PX, STALL_SPEC, type Threshold } from './chartSpec.ts';
import { createStallLayer, type StallItem, type ViolationItem } from './stallLayer.ts';
import { TimelineChart, type PlotPointer } from './TimelineChart.tsx';
import { Y_AXIS_WIDTH, type Backdrop } from './uplotOptions.ts';
import '../stalls/stallMarks.css';
import './mainThreadLane.css';

const TIP_HALF_WIDTH = 140;
const SEVERITIES: readonly StallSeverity[] = [1, 2, 3];
const SEVERITY_KEYS: Record<StallSeverity, string> = { 1: '<500', 2: '500+', 3: '1 s+' };

const LANE_HINT =
  'Bars: main-thread blocks caught by the SDK watchdog, drawn at their start; height and color show how long the thread was blocked (the scale stops at 2 s, longer bars get a caret). Hatched gray: a debugger was attached, so it is probably a breakpoint. Teal diamonds on the rail under the baseline: StrictMode violations. Gold bars on the rail above them: layout inflations of 16 ms or more, drawn over their duration. A stall’s tooltip names its origin: the RxJava chain, coroutine, Handler post, frame, input or lifecycle callback the main thread was running. Click a stall for its stack, a layout for the Layouts tab.';

type Props = {
  stalls: readonly StallSample[];
  strictMode: readonly StrictModeSample[];
  inflates: readonly InflateSample[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Current watchdog threshold (the dashed line). */
  thresholdMs: number;
  isStrictModeOn: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Reveals the Stalls tab; offered while it is not on screen. */
  onViewList?: () => void;
  /** Opens the Layouts tab; a click on an inflation marker asks for it. */
  onViewLayouts?: () => void;
  /** Inflation tracking is on for the live session (keeps the legend entry while no slow one was seen). */
  isInflateTrackingOn: boolean;
  theme: ChartTheme;
  xMin: number;
  xMax: number;
  backdrop: Backdrop | null;
  events: readonly TimelineEvent[];
  showTimeAxis: boolean;
  probeTs: Signal<number | null>;
  cursorX: Signal<number | null>;
  weight: number;
};

interface Hover {
  /** The mark's key: the item itself is looked up in the current data, so it never shows stale values. */
  key: string;
  /** Plot width (CSS px) when the pointer found the mark, to re-anchor it as the window moves. */
  plotWidth: number;
}

function InflateTip({ item }: { item: InflateSample }) {
  const where = [item.screen ?? 'no screen', formatClockShort(item.ts)].join(' · ');
  return (
    <>
      <p className="stall-tip-title">
        <span className="stall-glyph" data-kind="inflate" aria-hidden="true" />
        <span className="stall-tip-name mono">{formatInflateMs(item.maxMs)} ms</span>
        <span className="stall-tip-kind">layout inflated</span>
      </p>
      <p className="stall-tip-line mono">{layoutName(item)}</p>
      <p className="stall-tip-method mono">
        {formatInteger(item.views)} views
        {item.count > 1 &&
          ` · slowest of ${formatInteger(item.count)} (${formatInflateMs(item.totalMs)} ms total)`}
      </p>
      <p className="stall-tip-meta mono">{where}</p>
    </>
  );
}

function StallTip({ item }: { item: FeedItem }) {
  const culprit = item.culprit;
  const where = [item.sample.screen ?? 'no screen', formatClockShort(item.ts)].join(' · ');
  if (item.kind === 'strictmode') {
    const { violation, count, policy } = item.sample;
    return (
      <>
        <p className="stall-tip-title">
          <span className="stall-glyph" data-kind="strictmode" aria-hidden="true" />
          <span className="stall-tip-name">{violation}</span>
          {count > 1 && <span className="stall-tip-count mono">×{formatInteger(count)}</span>}
          <span className="stall-tip-kind">{policy === 'thread' ? 'Thread policy' : 'VM policy'}</span>
        </p>
        {culprit && <p className="stall-tip-method mono">{frameMethod(culprit)}</p>}
        <p className="stall-tip-line mono" data-none={culprit === null || undefined}>
          {culpritLabel(culprit)}
        </p>
        <p className="stall-tip-meta mono">{where}</p>
      </>
    );
  }
  const { durationMs, debugger: isDebugger } = item.sample;
  return (
    <>
      <p className="stall-tip-title">
        <span
          className="stall-glyph"
          data-kind="stall"
          data-color={stallColor(item.sample)}
          aria-hidden="true"
        />
        <span className="stall-tip-name mono">{formatBlockMs(durationMs)}</span>
        <span className="stall-tip-kind">main thread blocked</span>
        {isDebugger && <span className="stall-badge">debugger</span>}
      </p>
      {culprit && <p className="stall-tip-method mono">{frameMethod(culprit)}</p>}
      <p className="stall-tip-line mono" data-none={culprit === null || undefined}>
        {culpritLabel(culprit)}
      </p>
      {item.sample.frames.length > 0 && (
        <p className="stall-tip-origin">{originText(stallOrigin(item.sample))}</p>
      )}
      <p className="stall-tip-meta mono">{where}</p>
    </>
  );
}

/**
 * The Main thread lane: watchdog stalls as bars on the shared x axis (same cursor sync, backdrop
 * and event lines as every chart lane), StrictMode violations as diamonds on a rail below the
 * baseline. Hover shows the culprit line; click selects the mark in the Stalls panel. The canvas
 * is not focusable: the Stalls tab is the keyboard path to every mark.
 */
export function MainThreadLane({
  stalls,
  strictMode,
  inflates,
  fromTs,
  toTs,
  thresholdMs,
  isStrictModeOn,
  selectedKey,
  onSelect,
  onViewList,
  onViewLayouts,
  isInflateTrackingOn,
  theme,
  xMin,
  xMax,
  backdrop,
  events,
  showTimeAxis,
  probeTs,
  cursorX,
  weight,
}: Props) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [inflateHover, setInflateHover] = useState<Hover | null>(null);

  const feed = useMemo(
    () => buildFeed(stalls, strictMode, { fromTs, toTs, filter: 'all', culprit: null, origin: null }),
    [stalls, strictMode, fromTs, toTs],
  );
  const { stallItems, violationItems } = useMemo(() => {
    const ascending = [...feed].reverse();
    return {
      stallItems: ascending.filter((item): item is StallItem => item.kind === 'stall'),
      violationItems: ascending.filter((item): item is ViolationItem => item.kind === 'strictmode'),
    };
  }, [feed]);
  const slow = useMemo(() => slowInflates(inflates, fromTs, toTs), [inflates, fromTs, toTs]);
  const worstInflateMs = useMemo(() => Math.max(0, ...slow.map((s) => s.maxMs)), [slow]);
  const summary = useMemo(
    () => summarizeWindow(stalls, strictMode, fromTs, toTs),
    [stalls, strictMode, fromTs, toTs],
  );
  const data = useMemo(() => buildStallScaleData(stalls), [stalls]);
  const thresholds = useMemo<readonly Threshold[]>(
    () => [{ value: thresholdMs, label: `watchdog ${formatBlockMs(thresholdMs)}` }],
    [thresholdMs],
  );
  // A hovered mark that was pruned or replaced by a resync drops its tooltip.
  const hovered = hover === null ? null : (feed.find((item) => item.key === hover.key) ?? null);
  const hoveredKey = hovered?.key ?? null;
  const hoveredInflate =
    inflateHover === null ? null : (slow.find((item) => inflateKey(item) === inflateHover.key) ?? null);
  const hoveredInflateKey = hoveredInflate === null ? null : inflateKey(hoveredInflate);
  const marks = useMemo(
    () =>
      createStallLayer({
        stalls: stallItems,
        violations: violationItems,
        selectedKey,
        hoveredKey,
        inflates: slow,
        hoveredInflateKey,
      }),
    [stallItems, violationItems, selectedKey, hoveredKey, slow, hoveredInflateKey],
  );

  const handleCursor = useCallback((_idx: number | null, x: number | null) => cursorX.set(x), [cursorX]);
  const handlePointer = useCallback(
    (pointer: PlotPointer | null) => {
      if (pointer === null) {
        setHover(null);
        setInflateHover(null);
        return;
      }
      const railTop = pointer.plotHeight - STALL_RAIL_PX;
      const isOverRail = pointer.top >= railTop - 2;
      // The rail's upper row belongs to layout inflations; the lower one to StrictMode.
      const isOverInflateRow = pointer.top >= railTop - 2 && pointer.top < railTop + INFLATE_ROW_PX;
      const inflateHit = isOverInflateRow
        ? hitTestInflates(slow, { ts: pointer.ts, pxPerMs: pointer.pxPerMs })
        : null;
      const hit = inflateHit
        ? null
        : hitTestMarks(feed, { ts: pointer.ts, pxPerMs: pointer.pxPerMs, isOverRail });
      if (pointer.kind === 'click') {
        if (inflateHit) onViewLayouts?.();
        else if (hit) onSelect(hit.key);
        return;
      }
      const plotWidth = pointer.pxPerMs * (xMax - xMin) * 1000;
      setHover((current) =>
        hit === null ? null : current?.key === hit.key ? current : { key: hit.key, plotWidth },
      );
      const inflateKeyHit = inflateHit === null ? null : inflateKey(inflateHit);
      setInflateHover((current) =>
        inflateKeyHit === null
          ? null
          : current?.key === inflateKeyHit
            ? current
            : { key: inflateKeyHit, plotWidth },
      );
    },
    [feed, slow, onSelect, onViewLayouts, xMin, xMax],
  );

  // Anchored to the mark's start, kept inside the plot.
  const tipLeft =
    hover === null || hovered === null
      ? 0
      : Math.min(
          Math.max(((hovered.ts / 1000 - xMin) / (xMax - xMin)) * hover.plotWidth, TIP_HALF_WIDTH),
          Math.max(TIP_HALF_WIDTH, hover.plotWidth - TIP_HALF_WIDTH),
        ) + Y_AXIS_WIDTH;
  const inflateTipLeft =
    inflateHover === null || hoveredInflate === null
      ? 0
      : Math.min(
          Math.max(
            ((hoveredInflate.ts / 1000 - xMin) / (xMax - xMin)) * inflateHover.plotWidth,
            TIP_HALF_WIDTH,
          ),
          Math.max(TIP_HALF_WIDTH, inflateHover.plotWidth - TIP_HALF_WIDTH),
        ) + Y_AXIS_WIDTH;
  const worstSeverity = summary.worstMs > 0 ? stallSeverity(summary.worstMs) : null;
  const hasMarks = stallItems.length > 0 || violationItems.length > 0 || slow.length > 0;

  return (
    <figure
      className="lane lane--main-thread"
      aria-labelledby="lane-main-thread-title"
      style={{ flexGrow: weight }}
    >
      <figcaption className="lane-head">
        <div className="lane-name">
          <h2 id="lane-main-thread-title" className="lane-title">
            Main thread
          </h2>
          <span className="lane-unit">blocked ms · SDK watchdog</span>
          <span className="lane-hint" tabIndex={0} role="note" aria-label={LANE_HINT} title={LANE_HINT}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6 5.3v3.2M6 3.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          {onViewList && hasMarks && (
            <button type="button" className="screen-view-link" onClick={onViewList}>
              View in Stalls
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
        <ul className="lane-legend" aria-label="Main thread in this window">
          <li className="legend-item stall-ramp" title="Stall color by length">
            {SEVERITIES.map((severity) => (
              <span key={severity} className="stall-ramp-step">
                <span
                  className="legend-key"
                  data-key="bar"
                  data-color={SEVERITY_COLORS[severity]}
                  aria-hidden="true"
                />
                <span className="legend-label">{SEVERITY_KEYS[severity]}</span>
              </span>
            ))}
          </li>
          <li className="legend-item">
            <span className="legend-label">Stalls</span>
            <span className="legend-value mono">{formatInteger(summary.count)}</span>
          </li>
          <li className="legend-item">
            <span className="legend-label">Blocked</span>
            <span className="legend-value mono">
              {summary.count > 0 ? formatBlockMs(summary.totalMs) : '—'}
            </span>
          </li>
          <li className="legend-item">
            {worstSeverity !== null && (
              <span
                className="legend-key"
                data-key="bar"
                data-color={SEVERITY_COLORS[worstSeverity]}
                aria-hidden="true"
              />
            )}
            <span className="legend-label">Worst</span>
            <span className="legend-value mono">
              {summary.count > 0 ? formatBlockMs(summary.worstMs) : '—'}
            </span>
          </li>
          {(isStrictModeOn || summary.strictModeCount > 0) && (
            <li
              className="legend-item"
              title={`${formatInteger(summary.strictModeCount)} violation reports, ${formatInteger(summary.strictModeOccurrences)} occurrences (repeats of one stack within a second are coalesced)`}
            >
              <span className="stall-glyph" data-kind="strictmode" aria-hidden="true" />
              <span className="legend-label">StrictMode</span>
              <span className="legend-value mono">{formatInteger(summary.strictModeCount)}</span>
              {summary.strictModeOccurrences > summary.strictModeCount && (
                <span className="legend-label mono">×{formatInteger(summary.strictModeOccurrences)}</span>
              )}
            </li>
          )}
          {(isInflateTrackingOn || slow.length > 0) && (
            <li
              className="legend-item"
              title={`Layout inflations of ${SLOW_INFLATE_MS} ms or more, drawn as gold bars on the rail under the baseline`}
            >
              <span className="stall-glyph" data-kind="inflate" aria-hidden="true" />
              <span className="legend-label">Inflate</span>
              <span className="legend-value mono">{formatInteger(slow.length)}</span>
              {slow.length > 0 && (
                <span className="legend-label mono">max {formatInflateMs(worstInflateMs)} ms</span>
              )}
            </li>
          )}
          {summary.debuggerCount > 0 && (
            <li className="legend-item" title="Stalls while a debugger was attached (likely breakpoints)">
              <span className="stall-glyph" data-kind="debugger" aria-hidden="true" />
              <span className="legend-label">Debugger</span>
              <span className="legend-value mono">{formatInteger(summary.debuggerCount)}</span>
            </li>
          )}
        </ul>
      </figcaption>
      <div className="stall-plot" data-hit={hovered !== null || hoveredInflate !== null || undefined}>
        <TimelineChart
          spec={STALL_SPEC}
          theme={theme}
          data={data}
          xMin={xMin}
          xMax={xMax}
          backdrop={backdrop}
          events={events}
          thresholds={thresholds}
          showTimeAxis={showTimeAxis}
          showEventLabels={false}
          marks={marks}
          onPointer={handlePointer}
          probeTs={probeTs}
          onCursor={handleCursor}
        />
        {!hasMarks && (
          <p className="stall-plot-empty">
            No main-thread blocks ≥ {formatBlockMs(thresholdMs)} in this window
          </p>
        )}
        {hoveredInflate && (
          <div className="stall-tip" style={{ left: `${Math.round(inflateTipLeft)}px` }} aria-hidden="true">
            <InflateTip item={hoveredInflate} />
            <p className="stall-tip-hint">Click to open the Layouts tab</p>
          </div>
        )}
        {hovered && (
          <div className="stall-tip" style={{ left: `${Math.round(tipLeft)}px` }} aria-hidden="true">
            <StallTip item={hovered} />
            <p className="stall-tip-hint">Click for the full stack</p>
          </div>
        )}
      </div>
    </figure>
  );
}

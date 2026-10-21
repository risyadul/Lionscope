import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ScreenSpan } from '@lionscope/protocol/wire';
import { useElementWidth } from '../../hooks/useElementWidth.ts';
import { useSignal } from '../../hooks/useSignal.ts';
import { formatClockShort, formatDuration } from '../../lib/format.ts';
import {
  screenColor,
  screenKindLabel,
  spanAt,
  spanEnd,
  mergeNarrowSpans,
  spanLabel,
  visibleSpans,
  type TrackItem,
  type VisibleSpan,
} from '../../lib/screens.ts';
import type { Signal } from '../../lib/signal.ts';
import { RIGHT_PAD, Y_AXIS_WIDTH } from './uplotOptions.ts';
import './screensLane.css';

/** Bands narrower than this (px) drop their text label; the tooltip still names them. */
const MIN_LABEL_PX = 40;
/** Runs of spans narrower than this (px) merge into one cluster mark. */
const MIN_BAND_PX = 3;
const TOOLTIP_HALF_WIDTH = 130;
/** Plot-area insets shared with uPlot, so bands line up with every lane's x axis. */
const TRACK_INSETS = { left: Y_AXIS_WIDTH, right: RIGHT_PAD };

type Props = {
  spans: readonly ScreenSpan[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Where the open (current) span ends. */
  openEnd: number;
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Shown with a selection while the screens table is not on screen. */
  onViewInTable?: () => void;
  cursorX: Signal<number | null>;
  probeTs: Signal<number | null>;
};

function spanSummary(span: ScreenSpan, openEnd: number): string {
  const duration = formatDuration(spanEnd(span, openEnd) - span.start);
  if (span.screen === null) return `App in background, ${duration}`;
  return `${span.screen.name}, ${screenKindLabel(span.screen.kind)}, ${duration}${span.end === null ? ', on top now' : ''}`;
}

/** Screen under the synced cursor, else the newest span in the window. */
function ScreenReadout({
  spans,
  visible,
  openEnd,
  cursorX,
}: {
  spans: readonly ScreenSpan[];
  visible: readonly VisibleSpan[];
  openEnd: number;
  cursorX: Signal<number | null>;
}) {
  const x = useSignal(cursorX);
  const atCursor = x !== null;
  const span = atCursor ? spanAt(spans, x * 1000, openEnd) : (visible[visible.length - 1]?.span ?? null);
  if (span === null) {
    return (
      <p className="screen-readout" data-at-cursor={atCursor || undefined}>
        <span className="legend-label">{atCursor ? 'No screen reported here' : 'No screen yet'}</span>
      </p>
    );
  }
  const name = span.screen?.name;
  return (
    <p className="screen-readout" data-at-cursor={atCursor || undefined}>
      <span
        className="screen-swatch"
        data-color={name === undefined ? undefined : screenColor(name)}
        data-bg={name === undefined || undefined}
        aria-hidden="true"
      />
      <span className="screen-readout-name">{spanLabel(span)}</span>
      {span.screen && <span className="legend-label">{screenKindLabel(span.screen.kind)}</span>}
      <span className="legend-value mono">{formatDuration(spanEnd(span, openEnd) - span.start)}</span>
    </p>
  );
}

/** Synced chart cursor and log-row probe, positioned without re-rendering the bands. */
function TrackMarkers({
  cursorX,
  probeTs,
  fromTs,
  toTs,
  width,
}: Pick<Props, 'cursorX' | 'probeTs' | 'fromTs' | 'toTs'> & { width: number }) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const place = (element: HTMLDivElement | null, ts: number | null) => {
      if (!element) return;
      const frac = ts === null ? -1 : (ts - fromTs) / (toTs - fromTs);
      const isVisible = width > 0 && frac >= 0 && frac <= 1;
      element.style.opacity = isVisible ? '1' : '0';
      if (isVisible) element.style.transform = `translateX(${Math.round(frac * width)}px)`;
    };
    const placeCursor = () => {
      const x = cursorX.get();
      place(cursorRef.current, x === null ? null : x * 1000);
    };
    const placeProbe = () => place(probeRef.current, probeTs.get());
    placeCursor();
    placeProbe();
    const offCursor = cursorX.subscribe(placeCursor);
    const offProbe = probeTs.subscribe(placeProbe);
    return () => {
      offCursor();
      offProbe();
    };
  }, [cursorX, probeTs, fromTs, toTs, width]);

  return (
    <>
      <div ref={cursorRef} className="screen-track-cursor" aria-hidden="true" />
      <div ref={probeRef} className="screen-track-probe" aria-hidden="true" />
    </>
  );
}

function BandTip({ item, openEnd, center }: { item: TrackItem; openEnd: number; center: number }) {
  const style = { left: `${Math.round(center)}px` };
  if (item.kind === 'cluster') {
    return (
      <div className="screen-tip" style={style} aria-hidden="true">
        <p className="screen-tip-title">
          <span className="screen-swatch" data-bg />
          <span className="screen-tip-name">{item.count} quick screen changes</span>
        </p>
        <p className="screen-tip-class">Too short to draw apart at this zoom — pick a shorter window.</p>
        <p className="screen-tip-time mono">
          {formatDuration(item.to - item.from)}
          <span>
            {formatClockShort(item.from)} – {formatClockShort(item.to)}
          </span>
        </p>
      </div>
    );
  }
  const { span, isOpen } = item.band;
  return (
    <div className="screen-tip" style={style} aria-hidden="true">
      <p className="screen-tip-title">
        <span
          className="screen-swatch"
          data-color={span.screen ? screenColor(span.screen.name) : undefined}
          data-bg={span.screen === null || undefined}
        />
        <span className="screen-tip-name">{spanLabel(span)}</span>
        {span.screen && <span className="screen-tip-kind">{screenKindLabel(span.screen.kind)}</span>}
      </p>
      {span.screen ? (
        <p className="screen-tip-class mono">{span.screen.className}</p>
      ) : (
        <p className="screen-tip-class">App in background — no screen on top</p>
      )}
      <p className="screen-tip-time mono">
        {formatDuration(spanEnd(span, openEnd) - span.start)}
        <span>
          {formatClockShort(span.start)} – {isOpen ? 'now' : formatClockShort(spanEnd(span, openEnd))}
        </span>
      </p>
    </div>
  );
}

function itemRange(item: TrackItem): { from: number; to: number; key: number } {
  return item.kind === 'cluster' ? item : { from: item.band.from, to: item.band.to, key: item.band.key };
}

/**
 * The top-screen lane: one band per span on the shared x axis, aligned with the chart plot
 * areas. Bands are buttons (one tab stop, arrow keys move) that select the screen. Focus and
 * hover follow a span's start, so pruning or a resync never moves them to another span.
 */
export function ScreensLane({
  spans,
  fromTs,
  toTs,
  openEnd,
  selected,
  onSelect,
  onViewInTable,
  cursorX,
  probeTs,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(trackRef);
  const [hoveredKey, setHoveredKey] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);

  const range = Math.max(1, toTs - fromTs);
  const visible = visibleSpans(spans, fromTs, toTs, openEnd);
  const items = mergeNarrowSpans(visible, width > 0 ? range / width : 0, MIN_BAND_PX);
  const selectable = items.flatMap((item) =>
    item.kind === 'span' && item.band.span.screen !== null ? [item.band] : [],
  );
  const lastSelectable = selectable[selectable.length - 1]?.key ?? null;
  const tabStop = selectable.some((v) => v.key === focusKey) ? focusKey : lastSelectable;
  const hovered = items.find((item) => itemRange(item).key === hoveredKey) ?? null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = selectable.findIndex((v) => v.key === tabStop);
    const next = selectable[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    setFocusKey(next.key);
    trackRef.current?.querySelector<HTMLButtonElement>(`[data-span="${next.key}"]`)?.focus();
  };

  // Centered on the band, kept inside the track.
  const hoveredRange = hovered === null ? null : itemRange(hovered);
  const tooltipCenter =
    hoveredRange === null
      ? 0
      : width < TOOLTIP_HALF_WIDTH * 2
        ? width / 2
        : Math.min(
            Math.max(
              (((hoveredRange.from + hoveredRange.to) / 2 - fromTs) / range) * width,
              TOOLTIP_HALF_WIDTH,
            ),
            width - TOOLTIP_HALF_WIDTH,
          );

  const placement = (from: number, to: number) => ({
    left: `${((from - fromTs) / range) * 100}%`,
    width: `${((to - from) / range) * 100}%`,
  });

  return (
    <figure className="lane lane--screens" aria-labelledby="lane-screens-title">
      <figcaption className="lane-head">
        <div className="lane-name">
          <h2 id="lane-screens-title" className="lane-title">
            Screens
          </h2>
          <span className="lane-unit">top screen · SDK</span>
          {selected !== null && (
            <button
              type="button"
              className="lane-toggle screen-clear"
              onClick={() => onSelect(null)}
              title="Clear the screen selection (Esc)"
              aria-label={`Clear selection: ${selected}`}
            >
              <span className="screen-swatch" data-color={screenColor(selected)} aria-hidden="true" />
              <span className="screen-clear-name">{selected}</span>
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <path d="m1 1 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {selected !== null && onViewInTable && (
            <button type="button" className="screen-view-link" onClick={onViewInTable}>
              View in Screens
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
        <ScreenReadout spans={spans} visible={visible} openEnd={openEnd} cursorX={cursorX} />
      </figcaption>
      <div className="screen-track-host">
        <div
          ref={trackRef}
          className="screen-track"
          style={TRACK_INSETS}
          role="group"
          aria-label="Screen spans; arrow keys move, Enter selects"
          data-has-selection={selected !== null || undefined}
          onKeyDown={handleKeyDown}
          onMouseLeave={() => setHoveredKey(null)}
        >
          {visible.length === 0 && (
            <span className="screen-track-empty">No screen reported in this window</span>
          )}
          {items.map((item) => {
            if (item.kind === 'cluster') {
              return (
                <span
                  key={`c${item.key}`}
                  className="screen-band"
                  data-cluster
                  style={placement(item.from, item.to)}
                  role="img"
                  aria-label={`${item.count} quick screen changes, ${formatDuration(item.to - item.from)}`}
                  onMouseEnter={() => setHoveredKey(item.key)}
                />
              );
            }
            const v = item.band;
            const showLabel = width === 0 || ((v.to - v.from) / range) * width >= MIN_LABEL_PX;
            const name = v.span.screen?.name;
            const style = placement(v.from, v.to);
            if (name === undefined) {
              return (
                <span
                  key={v.key}
                  className="screen-band"
                  data-bg
                  data-labelled={showLabel || undefined}
                  style={style}
                  role="img"
                  aria-label={spanSummary(v.span, openEnd)}
                  onMouseEnter={() => setHoveredKey(v.key)}
                >
                  {showLabel && <span className="screen-band-label">background</span>}
                </span>
              );
            }
            const isSelected = selected === name;
            return (
              <button
                key={v.key}
                type="button"
                className="screen-band"
                data-span={v.key}
                data-color={screenColor(name)}
                data-selected={isSelected || undefined}
                data-open={v.isOpen || undefined}
                data-labelled={showLabel || undefined}
                style={style}
                tabIndex={v.key === tabStop ? 0 : -1}
                aria-pressed={isSelected}
                aria-label={spanSummary(v.span, openEnd)}
                onClick={() => onSelect(isSelected ? null : name)}
                onMouseEnter={() => setHoveredKey(v.key)}
                onFocus={() => {
                  setFocusKey(v.key);
                  setHoveredKey(v.key);
                }}
                onBlur={() => setHoveredKey(null)}
              >
                {showLabel && <span className="screen-band-label">{name}</span>}
              </button>
            );
          })}
          <TrackMarkers cursorX={cursorX} probeTs={probeTs} fromTs={fromTs} toTs={toTs} width={width} />
          {hovered && <BandTip item={hovered} openEnd={openEnd} center={tooltipCenter} />}
        </div>
      </div>
    </figure>
  );
}

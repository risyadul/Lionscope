import { useCallback, useState, type ReactNode } from 'react';
import type { TimelineEvent } from '@lionscope/protocol/wire';
import { lastIndexAtOrBefore, lastValueFrom, type Aligned, type Column } from '../../lib/series.ts';
import type { Signal } from '../../lib/signal.ts';
import type { ChartColor, ChartTheme } from '../../lib/theme.ts';
import type { ChartSpec, Threshold } from './chartSpec.ts';
import { TimelineChart } from './TimelineChart.tsx';
import type { Backdrop } from './uplotOptions.ts';

export interface LegendItem {
  label: string;
  /** Full name when `label` is abbreviated. */
  title?: string;
  color: ChartColor;
  key: 'line' | 'area' | 'bar' | 'thin';
  /** Lighter step of the same hue (e.g. slow frames under janky ones). */
  isTinted?: boolean;
  /** Index into the lane's `legendColumns`. */
  column: number;
  format: (value: number) => string;
}

type Props = {
  id: string;
  title: string;
  unit: string;
  /** Explains a caveat of the measurement; shown on hover and focus of an info mark. */
  hint?: string;
  spec: ChartSpec;
  theme: ChartTheme;
  data: Aligned;
  legendItems: readonly LegendItem[];
  /** Columns aligned with `data[0]` holding the values the legend reports. */
  legendColumns: readonly Column[];
  xMin: number;
  xMax: number;
  backdrop?: Backdrop | null;
  events: readonly TimelineEvent[];
  thresholds?: readonly Threshold[];
  /** Index of the legend item to emphasise for the shown values (e.g. the dominant stage). */
  pickEmphasis?: (values: readonly (number | null)[]) => number | null;
  showTimeAxis?: boolean;
  showEventLabels?: boolean;
  probeTs: Signal<number | null>;
  cursorX: Signal<number | null>;
  controls?: ReactNode;
  weight: number;
};

export function Lane({
  id,
  title,
  unit,
  hint,
  spec,
  theme,
  data,
  legendItems,
  legendColumns,
  xMin,
  xMax,
  backdrop,
  events,
  thresholds,
  pickEmphasis,
  showTimeAxis = false,
  showEventLabels = false,
  probeTs,
  cursorX,
  controls,
  weight,
}: Props) {
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  const handleCursor = useCallback(
    (idx: number | null, x: number | null) => {
      setCursorIdx(idx);
      cursorX.set(x);
    },
    [cursorX],
  );

  const atCursor = cursorIdx !== null;
  const idx = atCursor ? cursorIdx : lastIndexAtOrBefore(data[0], xMax);
  const headingId = `${id}-title`;
  const values = legendItems.map((item) => {
    const column = legendColumns[item.column];
    return atCursor ? (column?.[idx] ?? null) : lastValueFrom(column, idx);
  });
  const emphasized = pickEmphasis?.(values) ?? null;

  return (
    <figure className="lane" aria-labelledby={headingId} style={{ flexGrow: weight }}>
      <figcaption className="lane-head">
        <div className="lane-name">
          <h2 id={headingId} className="lane-title">
            {title}
          </h2>
          <span className="lane-unit">{unit}</span>
          {hint && (
            <span className="lane-hint" tabIndex={0} role="note" aria-label={hint} title={hint}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 5.3v3.2M6 3.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </span>
          )}
          {controls}
        </div>
        <ul className="lane-legend" data-at-cursor={atCursor || undefined} aria-label={`${title} values`}>
          {legendItems.map((item, i) => {
            const value = values[i] ?? null;
            const isEmphasized = emphasized === i;
            return (
              <li
                key={item.label}
                className="legend-item"
                title={item.title}
                data-emphasis={isEmphasized || undefined}
              >
                <span
                  className="legend-key"
                  data-key={item.key}
                  data-color={item.color}
                  data-tint={item.isTinted || undefined}
                  aria-hidden="true"
                />
                <span className="legend-label">{item.label}</span>
                <span className="legend-value mono">{value === null ? '—' : item.format(value)}</span>
                {isEmphasized && <span className="sr-only"> (largest)</span>}
              </li>
            );
          })}
        </ul>
      </figcaption>
      <TimelineChart
        spec={spec}
        theme={theme}
        data={data}
        xMin={xMin}
        xMax={xMax}
        backdrop={backdrop}
        events={events}
        thresholds={thresholds}
        showTimeAxis={showTimeAxis}
        showEventLabels={showEventLabels}
        probeTs={probeTs}
        onCursor={handleCursor}
      />
    </figure>
  );
}

import type { ReactNode } from 'react';
import { EMPTY, formatFixed, formatInteger, formatMb } from '../../lib/format.ts';
import { JANK_FLAG_PERCENT, type LiveStats } from '../../lib/stats.ts';
import './stats.css';

type ReadoutProps = {
  label: string;
  value: string;
  unit?: string;
  /** Replaces the number with a short phrase when a number would mislead (e.g. 0 FPS). */
  note?: string;
  /** Measurement caveat: tooltip on hover, description for screen readers. */
  hint?: string;
  detail?: ReactNode;
  /** A second sub-line under `detail`. */
  subDetail?: ReactNode;
  flag?: ReactNode;
};

function Readout({ label, value, unit, note, hint, detail, subDetail, flag }: ReadoutProps) {
  const isEmpty = value === EMPTY && note === undefined;
  return (
    <div className="readout" data-empty={isEmpty || undefined} title={hint}>
      <dt className="overline">{label}</dt>
      <dd className="readout-body">
        {note === undefined ? (
          <span className="readout-value">
            {value}
            {unit && !isEmpty && <span className="readout-unit">{unit}</span>}
          </span>
        ) : (
          <span className="readout-note">{note}</span>
        )}
        {flag}
        {detail && <span className="readout-detail mono">{detail}</span>}
        {subDetail && <span className="readout-detail mono">{subDetail}</span>}
        {hint && <span className="sr-only">{hint}</span>}
      </dd>
    </div>
  );
}

function WarningFlag({ children }: { children: ReactNode }) {
  return (
    <span className="readout-flag">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M5 0.8 9.6 9.2H0.4Z" fill="currentColor" />
      </svg>
      {children}
    </span>
  );
}

type Props = {
  stats: LiveStats;
};

export function StatStrip({ stats }: Props) {
  const jankFlag =
    stats.jankPercent !== null && stats.jankPercent >= JANK_FLAG_PERCENT ? (
      <WarningFlag>janky</WarningFlag>
    ) : null;
  const overBudget =
    stats.p90Ms !== null && stats.p90Ms > stats.frameIntervalMs ? (
      <WarningFlag>over budget</WarningFlag>
    ) : null;

  return (
    <div className="stat-strip">
      <dl className="readouts" aria-label="Live readouts">
        <Readout
          label="CPU"
          value={formatFixed(stats.cpuPercent, 1)}
          unit="%"
          detail={
            stats.cpuSingleCorePercent === null
              ? null
              : `${formatFixed(stats.cpuSingleCorePercent, 0)}% 1-core`
          }
        />
        <Readout label="Threads" value={formatInteger(stats.threads)} />
        <Readout
          label="Total PSS"
          value={formatMb(stats.pssMb)}
          unit="MB"
          detail={
            stats.javaMb === null ? null : (
              <>
                J {formatMb(stats.javaMb)} · N {formatMb(stats.nativeMb)}
              </>
            )
          }
        />
        <Readout
          label="FPS"
          value={formatFixed(stats.fps, 0)}
          note={stats.fps === 0 ? stats.noFramesLabel : undefined}
          hint={stats.fps === 0 ? stats.noFramesHint : undefined}
        />
        <Readout
          label="Jank · 30 s"
          value={formatFixed(stats.jankPercent, 1)}
          unit="%"
          flag={jankFlag}
          hint={stats.hasNoUiFrames ? stats.noFramesHint : undefined}
          detail={
            stats.renderedFrames > 0
              ? `${formatInteger(stats.jankFrames)} / ${formatInteger(stats.renderedFrames)} frames`
              : stats.hasNoUiFrames
                ? stats.noFramesLabel
                : 'no frames'
          }
          subDetail={stats.renderedFrames > 0 ? `slow ${formatInteger(stats.slowFrames)}` : null}
        />
        <Readout
          label="p90 frame · 30 s"
          value={formatFixed(stats.p90Ms, 1)}
          unit="ms"
          flag={overBudget}
          detail={`budget ${formatFixed(stats.frameIntervalMs, 1)} ms`}
          subDetail={stats.isFrameIntervalAssumed ? 'assumed — no vsync data yet' : null}
        />
      </dl>
    </div>
  );
}

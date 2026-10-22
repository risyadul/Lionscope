import type { MirrorSpan } from '@lionscope/protocol/wire';
import { formatClockShort, formatDuration } from '../../lib/format.ts';
import { visibleMirrorRuns, type MirrorRun } from '../../lib/mirror.ts';
import { RIGHT_PAD, Y_AXIS_WIDTH } from './uplotOptions.ts';
import './mirrorLane.css';

export const MIRROR_LEGEND_LABEL = 'Mirroring on';
export const MIRROR_HINT =
  'The device’s screen was mirrored here, so its hardware video encoder was busy: numbers in this span ' +
  'include a small mirroring cost. Emulators are mirrored without it.';

/** Plot-area insets shared with uPlot, so runs line up with every lane's x axis. */
const TRACK_INSETS = { left: Y_AXIS_WIDTH, right: RIGHT_PAD };

type Props = {
  spans: readonly MirrorSpan[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Where an open span (still mirroring) ends. */
  openEnd: number;
  /** The window follows the clock, so its right edge is "now" (not paused, not a stopped recording). */
  isLive: boolean;
};

function runSummary(run: MirrorRun, isLive: boolean): string {
  const until = run.isOpen && isLive ? 'now' : formatClockShort(run.to);
  return `${MIRROR_LEGEND_LABEL}, ${formatDuration(run.to - run.from)}, ${formatClockShort(run.from)} – ${until}`;
}

/**
 * A thin lane under Screens marking when a physical device was mirrored (its video encoder busy), so a
 * small cost in the charts isn't mistaken for the app's own.
 */
export function MirrorLane({ spans, fromTs, toTs, openEnd, isLive }: Props) {
  const range = Math.max(1, toTs - fromTs);
  const runs = visibleMirrorRuns(spans, fromTs, toTs, openEnd);
  const isOnNow = isLive && runs[runs.length - 1]?.isOpen === true;

  return (
    <figure className="lane lane--mirror" aria-labelledby="lane-mirror-title">
      <figcaption className="lane-head">
        <div className="lane-name">
          <h2 id="lane-mirror-title" className="lane-title">
            Mirroring
          </h2>
          <span className="lane-unit">device video encoder</span>
          <span className="lane-hint" tabIndex={0} role="note" aria-label={MIRROR_HINT} title={MIRROR_HINT}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6 5.3v3.2M6 3.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
        </div>
        <p className="mirror-legend" title={MIRROR_HINT}>
          <span className="mirror-swatch" aria-hidden="true" />
          <span className="legend-label">{MIRROR_LEGEND_LABEL}</span>
          {isOnNow && <span className="mirror-now mono">now</span>}
        </p>
      </figcaption>
      <div className="mirror-track-host">
        <div className="mirror-track" style={TRACK_INSETS} role="group" aria-label="Mirroring spans">
          {runs.map((run) => (
            <span
              key={run.key}
              className="mirror-run"
              data-open={run.isOpen || undefined}
              style={{
                left: `${((run.from - fromTs) / range) * 100}%`,
                width: `${((run.to - run.from) / range) * 100}%`,
              }}
              role="img"
              aria-label={`${runSummary(run, isLive)}. ${MIRROR_HINT}`}
              title={`${runSummary(run, isLive)}\n${MIRROR_HINT}`}
            />
          ))}
        </div>
      </div>
    </figure>
  );
}

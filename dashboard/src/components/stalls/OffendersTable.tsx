import { useState } from 'react';
import { formatBlockMs, formatInteger } from '../../lib/format.ts';
import {
  culpritLabel,
  frameMethod,
  SEVERITY_COLORS,
  stallSeverity,
  type Offender,
} from '../../lib/stalls.ts';

/** Rows shown before "Show all". */
export const OFFENDERS_PREVIEW = 5;

type Props = {
  offenders: readonly Offender[];
  /** Debugger-attached stalls in the window, left out of the ranking. */
  debuggerCount: number;
  /** `culpritKey` the event list is filtered to. */
  activeKey: string | null;
  onToggle: (key: string) => void;
};

/** Culprit lines ranked by total blocked time; a row filters the event list to that line. */
export function OffendersTable({ offenders, debuggerCount, activeKey, onToggle }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const worstTotal = offenders[0]?.totalMs ?? 0;
  const shown = isExpanded ? offenders : offenders.slice(0, OFFENDERS_PREVIEW);
  const hidden = offenders.length - shown.length;

  return (
    <section className="offenders" aria-labelledby="offenders-title">
      <div className="stalls-section-head">
        <h3 id="offenders-title" className="overline">
          Top offenders
        </h3>
        <span className="stalls-section-meta">
          by blocked time · visible window
          {debuggerCount > 0 &&
            ` · ${formatInteger(debuggerCount)} debugger ${debuggerCount === 1 ? 'stall' : 'stalls'} not counted`}
        </span>
      </div>
      {offenders.length === 0 ? (
        <p className="stalls-note">No app stalls in this window — only StrictMode or debugger events.</p>
      ) : (
        <table className="offenders-table">
          <thead>
            <tr>
              <th scope="col">Culprit</th>
              <th scope="col" data-num>
                Stalls
              </th>
              <th scope="col" data-num>
                Total
              </th>
              <th scope="col" data-num>
                Max
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((offender) => {
              const isActive = offender.key === activeKey;
              const share = worstTotal > 0 ? offender.totalMs / worstTotal : 0;
              return (
                <tr
                  key={offender.key}
                  data-selected={isActive || undefined}
                  onClick={() => onToggle(offender.key)}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="offender-cell"
                      aria-pressed={isActive}
                      title={isActive ? 'Show every event' : 'Show only this line’s events'}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(offender.key);
                      }}
                    >
                      <span className="offender-line mono" data-none={offender.frame === null || undefined}>
                        {culpritLabel(offender.frame)}
                      </span>
                      {offender.frame && (
                        <span className="offender-method mono">{frameMethod(offender.frame)}</span>
                      )}
                      {offender.screens.length > 0 && (
                        <span className="offender-screens">{offender.screens.join(', ')}</span>
                      )}
                    </button>
                  </th>
                  <td data-num className="mono">
                    {formatInteger(offender.count)}
                  </td>
                  <td data-num className="mono">
                    {formatBlockMs(offender.totalMs)}
                    <span className="offender-meter" aria-hidden="true">
                      <span style={{ transform: `scaleX(${share})` }} />
                    </span>
                  </td>
                  <td data-num className="mono">
                    <span className="offender-max">
                      <span
                        className="stall-glyph"
                        data-kind="stall"
                        data-color={SEVERITY_COLORS[stallSeverity(offender.maxMs)]}
                        aria-hidden="true"
                      />
                      {formatBlockMs(offender.maxMs)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(hidden > 0 || isExpanded) && offenders.length > OFFENDERS_PREVIEW && (
        <button type="button" className="stalls-more" onClick={() => setIsExpanded((v) => !v)}>
          {isExpanded ? `Show top ${OFFENDERS_PREVIEW}` : `Show all ${formatInteger(offenders.length)}`}
        </button>
      )}
    </section>
  );
}

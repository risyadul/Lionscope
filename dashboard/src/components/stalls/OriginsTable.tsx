import { useState, type ReactNode } from 'react';
import { formatBlockMs, formatInteger } from '../../lib/format.ts';
import { ORIGIN_KIND_LABELS, SEVERITY_COLORS, stallSeverity, type OriginGroup } from '../../lib/stalls.ts';
import { OFFENDERS_PREVIEW } from './OffendersTable.tsx';

type Props = {
  origins: readonly OriginGroup[];
  /** Debugger-attached stalls in the window, left out of the ranking. */
  debuggerCount: number;
  /** Origin key the event list is filtered to. */
  activeKey: string | null;
  onToggle: (key: string) => void;
  /** The By line / By origin switch, in the section head. */
  modeSwitch?: ReactNode;
};

/** Where stalls came from (Rx chain, coroutine, Handler post…), ranked by total blocked time; a row filters the list. */
export function OriginsTable({ origins, debuggerCount, activeKey, onToggle, modeSwitch }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const worstTotal = origins[0]?.totalMs ?? 0;
  const shown = isExpanded ? origins : origins.slice(0, OFFENDERS_PREVIEW);
  const hidden = origins.length - shown.length;

  return (
    <section className="offenders" aria-labelledby="origins-title">
      <div className="stalls-section-head">
        <h3 id="origins-title" className="overline">
          Top offenders
        </h3>
        <span className="stalls-section-meta">
          by blocked time · visible window
          {debuggerCount > 0 &&
            ` · ${formatInteger(debuggerCount)} debugger ${debuggerCount === 1 ? 'stall' : 'stalls'} not counted`}
        </span>
        {modeSwitch}
      </div>
      {origins.length === 0 ? (
        <p className="stalls-note">No app stalls in this window — only StrictMode or debugger events.</p>
      ) : (
        <table className="offenders-table">
          <thead>
            <tr>
              <th scope="col">Origin</th>
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
            {shown.map((group) => {
              const { origin } = group;
              const isActive = group.key === activeKey;
              const share = worstTotal > 0 ? group.totalMs / worstTotal : 0;
              return (
                <tr key={group.key} data-selected={isActive || undefined} onClick={() => onToggle(group.key)}>
                  <th scope="row">
                    <button
                      type="button"
                      className="offender-cell"
                      aria-pressed={isActive}
                      title={isActive ? 'Show every event' : 'Show only the stalls from here'}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(group.key);
                      }}
                    >
                      <span className="origin-head">
                        <span className="origin-tag" data-kind={origin.kind}>
                          {ORIGIN_KIND_LABELS[origin.kind]}
                        </span>
                        <span
                          className="offender-line origin-label"
                          data-none={origin.kind === 'unknown' || undefined}
                        >
                          {origin.label}
                        </span>
                      </span>
                      {origin.detail && <span className="offender-method mono">{origin.detail}</span>}
                      {group.screens.length > 0 && (
                        <span className="offender-screens">{group.screens.join(', ')}</span>
                      )}
                    </button>
                  </th>
                  <td data-num className="mono">
                    {formatInteger(group.count)}
                  </td>
                  <td data-num className="mono">
                    {formatBlockMs(group.totalMs)}
                    <span className="offender-meter" aria-hidden="true">
                      <span style={{ transform: `scaleX(${share})` }} />
                    </span>
                  </td>
                  <td data-num className="mono">
                    <span className="offender-max">
                      <span
                        className="stall-glyph"
                        data-kind="stall"
                        data-color={SEVERITY_COLORS[stallSeverity(group.maxMs)]}
                        aria-hidden="true"
                      />
                      {formatBlockMs(group.maxMs)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(hidden > 0 || isExpanded) && origins.length > OFFENDERS_PREVIEW && (
        <button type="button" className="stalls-more" onClick={() => setIsExpanded((v) => !v)}>
          {isExpanded ? `Show top ${OFFENDERS_PREVIEW}` : `Show all ${formatInteger(origins.length)}`}
        </button>
      )}
    </section>
  );
}

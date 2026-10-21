import { useEffect, useRef } from 'react';
import type { StackFrame } from '@lionscope/protocol/wire';
import { formatBlockMs, formatClock, formatInteger } from '../../lib/format.ts';
import {
  culpritText,
  frameLocation,
  frameMethod,
  packageName,
  SEVERITY_LABELS,
  stallColor,
  stallSeverity,
  type FeedItem,
} from '../../lib/stalls.ts';
import { CopyButton } from './CopyButton.tsx';
import { StackTrace } from './StackTrace.tsx';

type Props = {
  item: FeedItem;
  /** Position in the current list (newest first), or null when it is outside the window / filter. */
  position: { index: number; total: number } | null;
  onBack: () => void;
  onStep: (direction: -1 | 1) => void;
};

function Culprit({ frame, isFallback }: { frame: StackFrame; isFallback: boolean }) {
  const pkg = packageName(frame.className);
  return (
    <section className="culprit" aria-label="Culprit">
      <div className="culprit-head">
        <span className="overline">
          {isFallback ? 'Top frame · no app frame in this stack' : 'Culprit · first app frame'}
        </span>
        <CopyButton text={() => culpritText(frame)} label="Copy culprit" />
      </div>
      <p className="culprit-line mono">{frameLocation(frame)}</p>
      <p className="culprit-method mono">{frameMethod(frame)}</p>
      {pkg && <p className="culprit-pkg mono">{pkg}</p>}
    </section>
  );
}

function Header({ item }: { item: FeedItem }) {
  const screen = item.sample.screen ?? 'no screen';
  if (item.kind === 'strictmode') {
    const { violation, count, policy, message } = item.sample;
    return (
      <header className="detail-head">
        <p className="detail-title">
          <span className="stall-glyph" data-kind="strictmode" aria-hidden="true" />
          <span className="detail-readout">{violation}</span>
          {count > 1 && <span className="detail-count mono">×{formatInteger(count)}</span>}
        </p>
        <p className="detail-meta">
          StrictMode · {policy === 'thread' ? 'thread policy' : 'VM policy'} · {screen} ·{' '}
          <span className="mono">{formatClock(item.ts)}</span>
        </p>
        {message && <p className="detail-message mono">{message}</p>}
      </header>
    );
  }
  const { durationMs, samples, debugger: isDebugger } = item.sample;
  return (
    <header className="detail-head">
      <p className="detail-title">
        <span
          className="stall-glyph"
          data-kind="stall"
          data-color={stallColor(item.sample)}
          aria-hidden="true"
        />
        <span className="detail-readout mono">{formatBlockMs(durationMs)}</span>
        <span className="detail-kind">main thread blocked</span>
        {isDebugger && (
          <span className="stall-badge" title="A debugger was attached: this is probably a breakpoint">
            debugger
          </span>
        )}
      </p>
      <p className="detail-meta">
        {isDebugger ? 'debugger attached' : SEVERITY_LABELS[stallSeverity(durationMs)]} · {screen} ·{' '}
        <span className="mono">{formatClock(item.ts)}</span> · {formatInteger(samples)}{' '}
        {samples === 1 ? 'sample' : 'samples'}
      </p>
    </header>
  );
}

/** One stall or violation: what blocked, where, and the stack with app frames up front. */
export function StallDetail({ item, position, onBack, onStep }: Props) {
  const culprit = item.culprit;
  const truncated = item.kind === 'stall' && item.sample.truncated;
  const articleRef = useRef<HTMLElement>(null);

  // Opening the detail (from the list or a lane click) moves focus into it; stepping keeps focus put.
  useEffect(() => {
    articleRef.current?.focus();
  }, []);

  return (
    <article ref={articleRef} className="stall-detail" aria-label="Selected event" tabIndex={-1}>
      <nav className="detail-nav" aria-label="Events">
        <button type="button" className="btn detail-back" onClick={onBack} title="Back to the list (Esc)">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M8 5H2.2M4.6 2.4 2 5l2.6 2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          All events
        </button>
        {position && (
          <span className="detail-step">
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => onStep(-1)}
              disabled={position.index === 0}
              aria-label="Newer event"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
            <span className="detail-position mono">
              {formatInteger(position.index + 1)} / {formatInteger(position.total)}
            </span>
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => onStep(1)}
              disabled={position.index >= position.total - 1}
              aria-label="Older event"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 3.5 5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </span>
        )}
      </nav>
      <Header item={item} />
      {culprit && <Culprit frame={culprit} isFallback={!culprit.inApp} />}
      <StackTrace
        key={item.key}
        frames={item.sample.frames}
        truncated={truncated}
        title={item.kind === 'stall' ? 'Main thread stack' : 'Stack'}
      />
    </article>
  );
}

import { useEffect, useMemo, useRef } from 'react';
import type { StackFrame, StallSample } from '@lionscope/protocol/wire';
import { MAX_STACK_FRAMES } from '@lionscope/protocol/wire';
import { formatBlockMs, formatClock, formatInteger } from '../../lib/format.ts';
import {
  culpritText,
  frameLocation,
  frameMethod,
  ORIGIN_KIND_LABELS,
  originText,
  packageName,
  runnableLabel,
  SEVERITY_LABELS,
  stallColor,
  stallOrigin,
  stallSeverity,
  type FeedItem,
  type StallOrigin,
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

export const RX_SITE_MISSING =
  'Subscribe site not captured: the chain was subscribed before the session, or RxJava tracking is off';

const COROUTINE_DEBUG_PROPERTY = 'System.setProperty("kotlinx.coroutines.debug", "on")';

/** `HomeViewModel.load (HomeViewModel.kt:40)`. */
function frameText(frame: StackFrame): string {
  return `${frameMethod(frame)} (${frameLocation(frame)})`;
}

/** The facts that apply to this kind of origin, as label / value pairs. */
function originFacts(origin: StallOrigin): [string, string][] {
  const facts: [string, string | null][] = [];
  switch (origin.kind) {
    case 'rx':
      facts.push(['Operator', origin.operator]);
      facts.push(['Consumer', origin.consumer === null ? null : runnableLabel(origin.consumer)]);
      break;
    case 'coroutine':
      facts.push(['Dispatcher', origin.dispatcher]);
      facts.push(['Continuation', origin.frame === null ? null : frameText(origin.frame)]);
      break;
    default:
      facts.push(['Dispatched', origin.dispatched === null ? null : runnableLabel(origin.dispatched)]);
      facts.push(['Entry', origin.entry === null ? null : frameText(origin.entry)]);
  }
  return facts.filter((fact): fact is [string, string] => fact[1] !== null);
}

/** What the Looper was running: the Rx chain, the coroutine, the posted Runnable, and where it came from. */
function Origin({ origin, stallKey }: { origin: StallOrigin; stallKey: string }) {
  const facts = originFacts(origin);
  const location = origin.frame === null ? null : frameLocation(origin.frame);
  // The Rx subscribe site's detail already names its line.
  const showLocation = location !== null && !(origin.detail ?? '').includes(location);
  return (
    <section className="origin" aria-label="Origin">
      <div className="culprit-head">
        <span className="overline">Origin · what the main thread was running</span>
        {origin.frame && <CopyButton text={() => originText(origin)} label="Copy origin" />}
      </div>
      <p className="origin-title">
        <span className="origin-tag" data-kind={origin.kind}>
          {ORIGIN_KIND_LABELS[origin.kind]}
        </span>
        <span className="origin-label">{origin.label}</span>
      </p>
      {origin.detail && <p className="origin-detail mono">{origin.detail}</p>}
      {showLocation && <p className="origin-location mono">{location}</p>}
      {(facts.length > 0 || origin.kind === 'coroutine') && (
        <dl className="origin-facts">
          {origin.kind === 'coroutine' && (
            <div>
              <dt>Coroutine</dt>
              {origin.coroutine !== null ? (
                <dd className="mono">{origin.coroutine}</dd>
              ) : (
                <dd className="origin-quiet">
                  Names need kotlinx.coroutines debug mode: add{' '}
                  <code className="mono">{COROUTINE_DEBUG_PROPERTY}</code> in the debug app.
                </dd>
              )}
            </div>
          )}
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {origin.kind === 'rx' &&
        (origin.subscribedAt.length > 0 ? (
          <StackTrace
            key={`${stallKey}:subscribe`}
            frames={origin.subscribedAt}
            truncated={false}
            title="Subscribed at"
            copyName="Copy subscribe stack"
          />
        ) : (
          <p className="origin-quiet">{RX_SITE_MISSING}</p>
        ))}
    </section>
  );
}

function StallStacks({ stall, stallKey }: { stall: StallSample; stallKey: string }) {
  const outer = stall.outerFrames ?? [];
  return (
    <>
      <StackTrace
        key={stallKey}
        frames={stall.frames}
        truncated={stall.truncated}
        title="Main thread stack"
        note={
          outer.length > 0
            ? `Cut at ${MAX_STACK_FRAMES} frames on the device — the frames between it and the outermost frames below were not captured.`
            : undefined
        }
      />
      {outer.length > 0 && (
        <StackTrace
          key={`${stallKey}:outer`}
          frames={outer}
          truncated={false}
          title="Outermost frames · the Looper dispatch"
          copyName="Copy outermost frames"
        />
      )}
    </>
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
  const stall = item.kind === 'stall' ? item.sample : null;
  // Without any stack there is nothing to classify: the stack section already says so.
  const origin = useMemo(
    () =>
      stall === null || (stall.frames.length === 0 && (stall.outerFrames ?? []).length === 0)
        ? null
        : stallOrigin(stall),
    [stall],
  );
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
      {origin && <Origin origin={origin} stallKey={item.key} />}
      {stall !== null ? (
        <StallStacks stall={stall} stallKey={item.key} />
      ) : (
        <StackTrace key={item.key} frames={item.sample.frames} truncated={false} title="Stack" />
      )}
    </article>
  );
}

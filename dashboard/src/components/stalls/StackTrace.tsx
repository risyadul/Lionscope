import { useState } from 'react';
import type { StackFrame } from '@lionscope/protocol/wire';
import { MAX_STACK_FRAMES } from '@lionscope/protocol/wire';
import { formatInteger } from '../../lib/format.ts';
import {
  collapseStack,
  frameLocation,
  frameMethod,
  NO_STACK_LABEL,
  packageName,
  stackText,
} from '../../lib/stalls.ts';
import { CopyButton } from './CopyButton.tsx';

type Props = {
  frames: readonly StackFrame[];
  truncated: boolean;
  title: string;
};

function FrameRow({ frame, index }: { frame: StackFrame; index: number }) {
  const pkg = packageName(frame.className);
  return (
    <li className="frame" data-app={frame.inApp || undefined} data-index={index}>
      {frame.inApp && <span className="sr-only">App frame: </span>}
      <span className="frame-method mono">{frameMethod(frame)}</span>
      <span className="frame-loc mono">{frameLocation(frame)}</span>
      {pkg && <span className="frame-pkg mono">{pkg}</span>}
    </li>
  );
}

/**
 * A captured stack, innermost first. App frames read in ink with a marker; runs of framework and
 * library frames fold into one "+N framework frames" toggle each.
 */
export function StackTrace({ frames, truncated, title }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const items = collapseStack(frames);
  const appFrames = frames.filter((frame) => frame.inApp).length;

  const toggle = (start: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });

  if (frames.length === 0) {
    return (
      <section className="stack-empty" aria-label={title}>
        <p className="stack-empty-title">{NO_STACK_LABEL}</p>
        <p>
          The SDK couldn’t sample the main thread while it was blocked, so there is no line to point at. The
          duration and screen are still exact.
        </p>
      </section>
    );
  }

  return (
    <section className="stack" aria-label={title}>
      <div className="stack-head">
        <span className="overline">{title}</span>
        <span className="stack-count mono">
          {formatInteger(frames.length)} frames · {formatInteger(appFrames)} app · innermost first
        </span>
        <CopyButton text={() => stackText(frames)} label="Copy stack" />
      </div>
      <ol className="stack-list">
        {items.map((item) => {
          if (item.kind === 'frame')
            return <FrameRow key={item.index} frame={item.frame} index={item.index} />;
          const isOpen = expanded.has(item.start);
          const count = formatInteger(item.frames.length);
          return (
            <li key={`run-${item.start}`} className="frame-run" data-open={isOpen || undefined}>
              <button
                type="button"
                className="frame-run-toggle"
                aria-expanded={isOpen}
                onClick={() => toggle(item.start)}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                  <path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                {isOpen ? `Hide ${count} framework frames` : `+${count} framework frames`}
              </button>
              {isOpen && (
                <ol className="stack-list stack-list--run">
                  {item.frames.map((frame, i) => (
                    <FrameRow key={item.start + i} frame={frame} index={item.start + i} />
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
      {truncated && (
        <p className="stack-note">
          Cut at {MAX_STACK_FRAMES} frames on the device — the outermost frames are missing.
        </p>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long "Copied" shows before the label returns (a refusal stays twice as long). */
const CONFIRM_MS = 1600;

type Props = {
  /** Read at click time, so a long stack is only formatted when needed. */
  text: () => string;
  label: string;
  /** Accessible name when `label` alone is ambiguous (e.g. "Copy stack"). */
  ariaLabel?: string;
};

/** Copies `text()` to the clipboard and confirms in place; a refusal is announced, not swallowed. */
export function CopyButton({ text, label, ariaLabel }: Props) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? CONFIRM_MS : CONFIRM_MS * 2);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = () => {
    if (!navigator.clipboard) {
      setState('failed');
      return;
    }
    navigator.clipboard.writeText(text()).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };

  return (
    <>
      <button
        type="button"
        className="btn stall-copy"
        data-state={state === 'idle' ? undefined : state}
        aria-label={ariaLabel}
        onClick={copy}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          {state === 'copied' ? (
            <path d="m2 5.8 2.3 2.3L9 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          ) : (
            <>
              <rect
                x="3.5"
                y="3.5"
                width="6"
                height="6.5"
                rx="1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M7.5 2V1.5a.5.5 0 0 0-.5-.5H2a1 1 0 0 0-1 1v5a.5.5 0 0 0 .5.5H2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </>
          )}
        </svg>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Can’t copy' : label}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied'
          ? `${label}: copied`
          : state === 'failed'
            ? 'Copying isn’t allowed here — select the text and copy it by hand.'
            : ''}
      </span>
    </>
  );
}

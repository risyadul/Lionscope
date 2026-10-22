import type { SessionState } from '@lionscope/protocol/wire';
import { formatElapsed } from '../../lib/format.ts';

type StatusPillProps = {
  session: SessionState;
  now: number;
};

/** Only the status word (and PID) is a live region; the ticking elapsed time is visual-only. */
export function StatusPill({ session, now }: StatusPillProps) {
  switch (session.status) {
    case 'idle':
      return (
        <span className="status-pill" data-status="idle">
          <span className="status-dot" aria-hidden="true" />
          <span role="status" className="status-label">
            Idle
          </span>
        </span>
      );
    case 'waiting_for_process':
      return (
        <span className="status-pill" data-status="waiting">
          <span className="status-dot" aria-hidden="true" />
          <span role="status" className="status-label">
            Waiting for process
          </span>
        </span>
      );
    case 'running':
      // The PID collapses on narrow top bars (still read out, and in the tooltip); the time always shows.
      return (
        <span
          className="status-pill"
          data-status="running"
          title={session.pid === null ? 'Recording' : `Recording · PID ${session.pid}`}
        >
          <span className="status-dot" aria-hidden="true" />
          <span role="status" className="status-label">
            Recording
            {session.pid !== null && <span className="status-meta status-pid mono"> PID {session.pid}</span>}
          </span>
          {session.startedAt !== null && (
            <span className="status-meta status-elapsed mono" aria-hidden="true">
              {formatElapsed(now - session.startedAt)}
            </span>
          )}
        </span>
      );
    case 'error':
      return (
        <span className="status-pill" data-status="error" title={session.error}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 2 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
          <span role="status" className="status-label">
            Error
            {session.error && <span className="status-meta status-error"> {session.error}</span>}
          </span>
        </span>
      );
  }
}

type SessionButtonProps = {
  isActive: boolean;
  canStart: boolean;
  startHint: string | null;
  /** A start/stop request is in flight (until the next `session` message). */
  isPending: boolean;
  isOffline: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function SessionButton({
  isActive,
  canStart,
  startHint,
  isPending,
  isOffline,
  onStart,
  onStop,
}: SessionButtonProps) {
  if (isActive) {
    return (
      <button
        type="button"
        className="btn session-btn session-btn--stop"
        onClick={onStop}
        disabled={isPending || isOffline}
        title={isOffline ? 'Offline — waiting for the server' : undefined}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" />
        </svg>
        <span className="session-btn-label">{isPending ? 'Stopping…' : 'Stop'}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn btn--primary session-btn"
      onClick={onStart}
      disabled={!canStart || isPending}
      title={startHint ?? undefined}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2.5 1.3v7.4L8.7 5Z" fill="currentColor" />
      </svg>
      <span className="session-btn-label">{isPending ? 'Starting…' : 'Start'}</span>
    </button>
  );
}

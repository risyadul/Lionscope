import { useEffect, type ReactNode } from 'react';
import {
  ADB_UNAVAILABLE_CODE,
  type CloseReason,
  type ConnectionState,
  type ServerError,
} from '../../lib/store.ts';
import './states.css';

const ERROR_AUTO_DISMISS_MS = 12_000;

type ConnectionBannerProps = {
  connection: ConnectionState;
  /** True once the socket has been open at least once (first load shows a quieter state). */
  hasConnected: boolean;
  now: number;
  protocolMismatch: boolean;
};

export function ConnectionBanner({ connection, hasConnected, now, protocolMismatch }: ConnectionBannerProps) {
  if (protocolMismatch) {
    return (
      <div className="banner" data-tone="critical" role="alert">
        <strong>Version mismatch.</strong> The server speaks a different protocol version — rebuild with{' '}
        <code>npm run lionscope</code>.
      </div>
    );
  }
  if (connection.status === 'open') return null;
  if (connection.status === 'closed') {
    return (
      <div className="banner" data-tone="quiet" role="status">
        Paused while the page was in the background — reconnecting when it’s visible.
      </div>
    );
  }
  if (connection.status === 'connecting' && !hasConnected) {
    return (
      <div className="banner" data-tone="quiet" role="status">
        <span className="banner-spinner" aria-hidden="true" />
        Connecting to the Lionscope server…
      </div>
    );
  }
  const seconds = connection.retryAt === null ? 0 : Math.max(0, Math.ceil((connection.retryAt - now) / 1000));
  const headline = HEADLINES[connection.closeReason ?? 'disconnected'];
  // Only the stable headline is a live region; the ticking countdown is visual-only so
  // screen readers aren't re-interrupted every second.
  return (
    <div className="banner" data-tone="critical">
      <span className="banner-dot" aria-hidden="true" />
      <strong role="alert">{headline.title}</strong>
      <span aria-hidden="true">
        {seconds > 0 ? `Retrying in ${seconds} s` : 'Reconnecting…'}
        <span className="banner-meta mono"> · attempt {connection.attempt}</span>
      </span>
      <span className="banner-hint">{headline.hint}</span>
    </div>
  );
}

const HEADLINES: Record<CloseReason | 'disconnected', { title: string; hint: ReactNode }> = {
  disconnected: {
    title: 'Disconnected from the server.',
    hint: (
      <>
        Charts are frozen until it’s back. Is <code>npm run lionscope</code> still running? (The server also
        turns away more than 8 open dashboards.)
      </>
    ),
  },
  'rate-limited': {
    title: 'Rate-limited by the server.',
    hint: 'This tab sent too many requests; it backs off before reconnecting.',
  },
};

type ErrorBannerProps = {
  error: ServerError | null;
  onDismiss: (id: number) => void;
};

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  useEffect(() => {
    // adb missing is not transient: it stays until dismissed or fixed.
    if (!error || error.code === ADB_UNAVAILABLE_CODE) return;
    const timer = setTimeout(() => onDismiss(error.id), ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error, onDismiss]);

  if (!error) return null;
  return (
    <div className="banner" data-tone="critical" role="alert">
      <span className="banner-dot" aria-hidden="true" />
      <span>
        {error.message}
        {error.code && <span className="banner-meta mono"> · {error.code}</span>}
      </span>
      <button
        type="button"
        className="banner-close"
        onClick={() => onDismiss(error.id)}
        aria-label="Dismiss error"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="m1.5 1.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** Shown while the selected (or session) emulator renders with SwiftShader instead of the host GPU. */
export function SoftwareRendererBanner({ deviceLabel }: { deviceLabel: string | null }) {
  if (deviceLabel === null) return null;
  return (
    <div className="banner" data-tone="warning" role="status">
      <span className="banner-dot" aria-hidden="true" />
      <strong>{deviceLabel} renders in software (SwiftShader).</strong>
      <span className="banner-hint">
        Frame times and CPU aren’t representative of a real device. Restart it with <code>-gpu host</code> —
        emulators booted from Lionscope already use it.
      </span>
    </div>
  );
}

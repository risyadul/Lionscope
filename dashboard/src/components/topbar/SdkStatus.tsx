import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SdkStatus as SdkState } from '@lionscope/protocol/wire';

/**
 * Public artifact on JitPack: the repository is scoped to the Lionscope group so it can't serve
 * anything else, and the SDK is a debug-only dependency, so release builds never contain it.
 */
export const SDK_GRADLE_SNIPPET = `// settings.gradle (dependencyResolutionManagement) or app/build.gradle repositories
maven { url "https://jitpack.io"; content { includeGroup "com.github.risyadul.Lionscope" } }
// app/build.gradle
debugImplementation "com.github.risyadul.Lionscope:lionscope:0.11.0"`;

/** Projects that centralise repositories (FAIL_ON_PROJECT_REPOS) can't declare them per module. */
export const SDK_SETTINGS_NOTE =
  'If the project uses dependencyResolutionManagement, put the maven block in settings.gradle instead. Apps that call the Lionscope API explicitly also add releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.11.0".';

type CopyState = 'idle' | 'copied' | 'failed';

type PopoverProps = {
  id: string;
  title: string;
  /** `returnFocus`: hand focus back to the trigger (Esc, the close button). */
  onClose: (returnFocus: boolean) => void;
  children: ReactNode;
};

/**
 * A non-modal dialog under its trigger. It takes focus when it opens; Escape closes it from
 * anywhere on the page (capture phase, and marked handled so it doesn't also clear a selection).
 */
function Popover({ id, title, onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose(true);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div ref={ref} id={id} className="sdk-pop" role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <div className="sdk-pop-head">
        <h3 id={`${id}-title`} className="sdk-pop-title">
          {title}
        </h3>
        <button
          type="button"
          className="btn btn--icon sdk-pop-close"
          onClick={() => onClose(true)}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 2 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {children}
    </div>
  );
}

function InstallHint() {
  const [copy, setCopy] = useState<CopyState>('idle');
  const copySnippet = () => {
    if (!navigator.clipboard) {
      setCopy('failed');
      return;
    }
    navigator.clipboard.writeText(SDK_GRADLE_SNIPPET).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  return (
    <>
      <p className="sdk-pop-text">
        Screen bands and the per-frame breakdown come from a debug-only SDK inside the app. It is a{' '}
        <code>debugImplementation</code> dependency, so release builds never contain it.
      </p>
      <div className="sdk-snippet">
        <div className="sdk-snippet-bar">
          <span className="overline">Gradle · Groovy</span>
          <button type="button" className="btn sdk-copy" onClick={copySnippet}>
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="mono">{SDK_GRADLE_SNIPPET}</pre>
      </div>
      <p className="sdk-pop-text">{SDK_SETTINGS_NOTE}</p>
      <p className="sdk-pop-text" role="status">
        {copy === 'failed'
          ? 'Copying isn’t allowed here — select the snippet and copy it by hand.'
          : 'Then rebuild and reinstall the debug app. It connects on launch.'}
      </p>
    </>
  );
}

function LinkFailedHint({ message }: { message: string }) {
  return (
    <>
      <p className="sdk-pop-text">
        The server couldn’t map the SDK port on the device with <code>adb reverse</code>, so the app’s SDK
        can’t reach this session. CPU, memory and gfxinfo frames keep recording.
      </p>
      <p className="sdk-pop-error mono">{message}</p>
      <p className="sdk-pop-text">
        It retries when the device reconnects. Replugging the device or restarting the session usually clears
        it.
      </p>
    </>
  );
}

type Props = {
  sdk: SdkState | undefined;
  /** Sticky `adb reverse` failure for the SDK port. */
  linkError: string | null;
  isSessionActive: boolean;
};

const INFO_ICON = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 5.3v3.2M6 3.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** SDK link state beside the session pill; without an SDK, a hint on how to add it. */
export function SdkStatus({ sdk, linkError, isSessionActive }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen, close]);

  // Older servers send no SDK state; outside a session there is nothing to report.
  if (!isSessionActive || sdk === undefined) return null;

  if (sdk.connected) {
    // Everything after "SDK" collapses on narrow top bars; the tooltip and screen readers keep it all.
    const title = [
      sdk.sdkVersion && `SDK v${sdk.sdkVersion}`,
      'connected',
      sdk.framesActive && 'frames from SDK',
      sdk.processName,
      sdk.apiLevel === null ? null : `API ${sdk.apiLevel}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <span className="sdk-pill" data-state="connected" title={title}>
        <span className="sdk-dot" aria-hidden="true" />
        <span className="sdk-label">
          SDK{sdk.sdkVersion && <span className="sdk-version mono"> v{sdk.sdkVersion}</span>}
          <span className="sdk-meta sdk-connected"> connected</span>
          {sdk.framesActive && <span className="sdk-meta sdk-frames"> frames from SDK</span>}
        </span>
      </span>
    );
  }

  // It was linked this session: the app stopped or the link dropped; the SDK reconnects by itself.
  if (linkError === null && sdk.sdkVersion !== null) {
    return (
      <span
        className="sdk-pill"
        data-state="disconnected"
        title={`SDK v${sdk.sdkVersion} · disconnected. The app’s SDK link closed. It reconnects with backoff while the app is running.`}
      >
        <span className="sdk-dot" aria-hidden="true" />
        <span className="sdk-label">
          SDK<span className="sdk-version mono"> v{sdk.sdkVersion}</span>
          <span className="sdk-meta"> disconnected</span>
        </span>
      </span>
    );
  }

  const isFailed = linkError !== null;
  return (
    <div ref={rootRef} className="sdk-status">
      <button
        ref={triggerRef}
        type="button"
        className="sdk-pill"
        data-state={isFailed ? 'failed' : 'missing'}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popId : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="sdk-dot" aria-hidden="true" />
        <span className="sdk-label">{isFailed ? 'SDK link failed' : 'No SDK'}</span>
        {INFO_ICON}
      </button>
      {isOpen && (
        <Popover
          id={popId}
          title={isFailed ? 'SDK link failed (adb reverse)' : 'Add the Lionscope SDK'}
          onClose={close}
        >
          {isFailed ? <LinkFailedHint message={linkError} /> : <InstallHint />}
        </Popover>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isMdnsSerial, isPublicWirelessHost, parseWirelessAddress } from '@lionscope/protocol/wire';
import type { WirelessActionResult } from '@lionscope/protocol/wire';
import { createPortal } from 'react-dom';
import './wireless.css';

type Props = {
  isOnline: boolean;
  onConnect: (address: string) => Promise<Extract<WirelessActionResult, { action: 'connect' }>>;
  onConnected: (serial: string) => void;
  onClose: () => void;
};

/**
 * Native modal dialog for connecting to a physical Android device over wireless ADB (`host:port`).
 * Validates syntax client-side and displays a clear warning when the target is a public IP address.
 */
export function WirelessDialog({ isOnline, onConnect, onConnected, onClose }: Props) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', escape, true);
    if (dialog) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    inputRef.current?.focus();
    return () => {
      if (dialog) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      document.removeEventListener('keydown', escape, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  const trimmed = address.trim();
  const isMdns = trimmed !== '' && isMdnsSerial(trimmed);
  const parsed = trimmed !== '' && !isMdns ? parseWirelessAddress(trimmed) : null;
  const syntaxError = trimmed !== '' && !isMdns && parsed !== null && !parsed.ok ? parsed.error : null;
  const showPublicWarning = trimmed !== '' && isPublicWirelessHost(trimmed);
  const canSubmit = isOnline && !pending && trimmed !== '' && syntaxError === null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const result = await onConnect(trimmed);
      if (result.ok) {
        onConnected(result.serial);
        onClose();
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="wireless-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="wireless-heading">
        <h2 id={`${id}-title`}>Connect wireless device</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="wireless-note">
        Enter the IP address and port shown under <strong>Developer options → Wireless debugging</strong> (or
        an ADB TCP/IP port such as <code className="mono">5555</code>).
      </p>
      <form className="wireless-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="wireless-field">
          <label className="wireless-label" htmlFor={`${id}-address`}>
            IP address and port
          </label>
          <input
            ref={inputRef}
            id={`${id}-address`}
            type="text"
            className="wireless-input mono"
            placeholder="192.168.1.5:5555"
            autoComplete="off"
            spellCheck={false}
            value={address}
            disabled={!isOnline || pending}
            aria-invalid={syntaxError !== null || error !== null || undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setAddress(event.target.value);
              if (error !== null) setError(null);
            }}
          />
          <p id={`${id}-hint`} className="wireless-hint">
            Supports IPv4 (<code className="mono">192.168.1.5:5555</code>), bracketed IPv6 (
            <code className="mono">[fd00::1]:5555</code>), or a hostname with port.
          </p>
        </div>

        {showPublicWarning && (
          <div className="wireless-warning" role="status">
            <strong>Public IP address.</strong> Connecting gives this remote host access to ADB and the
            Lionscope SDK reverse tunnel on your machine. Make sure you trust this address.
          </div>
        )}

        {syntaxError && (
          <p className="wireless-error" role="alert">
            {syntaxError}
          </p>
        )}

        {error && (
          <p className="wireless-error" role="alert">
            {error}
          </p>
        )}

        <div className="wireless-actions">
          <span className="wireless-status" role="status">
            {!isOnline ? 'Offline — waiting for the server.' : pending ? 'Connecting…' : ''}
          </span>
          <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
            {pending ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

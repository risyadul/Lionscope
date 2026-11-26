import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  isMdnsSerial,
  isPublicWirelessHost,
  isValidPairingCode,
  parseWirelessAddress,
  parseWirelessPort,
  validateWirelessEndpoint,
} from '@lionscope/protocol/wire';
import type { WirelessActionResult } from '@lionscope/protocol/wire';
import { createPortal } from 'react-dom';
import './wireless.css';

type Tab = 'connect' | 'pair';

type Props = {
  isOnline: boolean;
  onConnect: (address: string) => Promise<Extract<WirelessActionResult, { action: 'connect' }>>;
  onPair: (
    address: string,
    code: string,
    connectAddress?: string,
  ) => Promise<Extract<WirelessActionResult, { action: 'pair' }>>;
  onConnected: (serial: string) => void;
  onClose: () => void;
};

function hostPrefix(host: string): string {
  return host.includes(':') ? `[${host}]:` : `${host}:`;
}

/**
 * Native modal dialog for connecting or pairing a physical Android device over wireless ADB.
 * Pairing codes are cleared immediately on submit and never persisted.
 */
export function WirelessDialog({ isOnline, onConnect, onPair, onConnected, onClose }: Props) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const connectInputRef = useRef<HTMLInputElement>(null);
  const pairInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('connect');
  const [address, setAddress] = useState('');
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [connectPort, setConnectPort] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);

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
    connectInputRef.current?.focus();
    return () => {
      if (dialog) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      document.removeEventListener('keydown', escape, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
    if (next === 'pair') setSuccessNote(null);
  };

  // Connect tab validation
  const trimmedAddress = address.trim();
  const isMdns = trimmedAddress !== '' && isMdnsSerial(trimmedAddress);
  const parsedConnect = trimmedAddress !== '' && !isMdns ? parseWirelessAddress(trimmedAddress) : null;
  const connectSyntaxError =
    trimmedAddress !== '' && !isMdns && parsedConnect !== null && !parsedConnect.ok
      ? parsedConnect.error
      : null;
  const showConnectPublicWarning = trimmedAddress !== '' && isPublicWirelessHost(trimmedAddress);
  const canConnect = isOnline && !pending && trimmedAddress !== '' && connectSyntaxError === null;

  // Pair tab validation
  const trimmedPairAddr = pairAddress.trim();
  const parsedPair = trimmedPairAddr !== '' ? parseWirelessAddress(trimmedPairAddr) : null;
  const pairAddrError = parsedPair !== null && !parsedPair.ok ? parsedPair.error : null;
  const showPairPublicWarning = trimmedPairAddr !== '' && isPublicWirelessHost(trimmedPairAddr);
  const trimmedCode = pairCode.trim();
  const codeError =
    trimmedCode !== '' && !isValidPairingCode(trimmedCode) ? 'Pairing code must be exactly 6 digits' : null;
  const trimmedConnectPort = connectPort.trim();
  const parsedConnectPort = trimmedConnectPort !== '' ? parseWirelessPort(trimmedConnectPort) : null;
  const connectPortError =
    trimmedConnectPort !== '' && parsedConnectPort === null
      ? 'Connect port must be a whole number from 1 to 65535'
      : null;
  const canPair =
    isOnline &&
    !pending &&
    trimmedPairAddr !== '' &&
    pairAddrError === null &&
    trimmedCode !== '' &&
    codeError === null &&
    connectPortError === null;

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (!canConnect) return;
    setPending(true);
    setError(null);
    try {
      const result = await onConnect(trimmedAddress);
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

  const handlePair = async (event: FormEvent) => {
    event.preventDefault();
    if (!canPair || !parsedPair?.ok) return;
    const submittedCode = trimmedCode;
    // Clear the one-time pairing code from component state immediately on submit.
    setPairCode('');
    setPending(true);
    setError(null);
    setSuccessNote(null);
    let followUpAddress: string | undefined;
    if (parsedConnectPort !== null) {
      const built = validateWirelessEndpoint(parsedPair.value.host, parsedConnectPort);
      if (built.ok) followUpAddress = built.value.target;
    }
    try {
      const result = await onPair(trimmedPairAddr, submittedCode, followUpAddress);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.connectedSerial !== null) {
        onConnected(result.connectedSerial);
        onClose();
        return;
      }
      // Paired, but connect port is separate and mDNS didn't resolve it: move user straight to Connect.
      setAddress(hostPrefix(result.host));
      setSuccessNote(
        result.connectNote ??
          `Paired with ${result.target}. Enter the separate connect port shown on the Wireless debugging screen.`,
      );
      setTab('connect');
      queueMicrotask(() => connectInputRef.current?.focus());
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
        <h2 id={`${id}-title`}>Wireless device</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="wireless-tabs" role="tablist" aria-label="Wireless connection methods">
        <button
          id={`${id}-tab-connect`}
          type="button"
          role="tab"
          aria-selected={tab === 'connect'}
          aria-controls={`${id}-panel-connect`}
          className="wireless-tab"
          onClick={() => switchTab('connect')}
        >
          Connect
        </button>
        <button
          id={`${id}-tab-pair`}
          type="button"
          role="tab"
          aria-selected={tab === 'pair'}
          aria-controls={`${id}-panel-pair`}
          className="wireless-tab"
          onClick={() => switchTab('pair')}
        >
          Pair with code
        </button>
      </div>

      {tab === 'connect' && (
        <div
          id={`${id}-panel-connect`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-connect`}
          className="wireless-panel"
        >
          <p className="wireless-note">
            Enter the IP address and port shown under <strong>Developer options → Wireless debugging</strong>{' '}
            (or an ADB TCP/IP port such as <code className="mono">5555</code>).
          </p>
          {successNote && (
            <p className="wireless-success" role="status">
              {successNote}
            </p>
          )}
          <form className="wireless-form" onSubmit={(event) => void handleConnect(event)} noValidate>
            <div className="wireless-field">
              <label className="wireless-label" htmlFor={`${id}-address`}>
                IP address and port
              </label>
              <input
                ref={connectInputRef}
                id={`${id}-address`}
                type="text"
                className="wireless-input mono"
                placeholder="192.168.1.5:5555"
                autoComplete="off"
                spellCheck={false}
                value={address}
                disabled={!isOnline || pending}
                aria-invalid={connectSyntaxError !== null || error !== null || undefined}
                aria-describedby={`${id}-connect-hint`}
                onChange={(event) => {
                  setAddress(event.target.value);
                  if (error !== null) setError(null);
                }}
              />
              <p id={`${id}-connect-hint`} className="wireless-hint">
                Supports IPv4 (<code className="mono">192.168.1.5:5555</code>), bracketed IPv6 (
                <code className="mono">[fd00::1]:5555</code>), or a hostname with port.
              </p>
            </div>

            {showConnectPublicWarning && (
              <div className="wireless-warning" role="status">
                <strong>Public IP address.</strong> Connecting gives this remote host access to ADB and the
                Lionscope SDK reverse tunnel on your machine. Make sure you trust this address.
              </div>
            )}

            {connectSyntaxError && (
              <p className="wireless-error" role="alert">
                {connectSyntaxError}
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
              <button type="submit" className="btn btn--primary" disabled={!canConnect}>
                {pending ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      )}

      {tab === 'pair' && (
        <div
          id={`${id}-panel-pair`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-pair`}
          className="wireless-panel"
        >
          <p className="wireless-note">
            On Android 11+, open <strong>Wireless debugging → Pair device with pairing code</strong>. The
            pairing port differs from the connect port; Lionscope checks mDNS automatically after pairing, or
            you can enter the connect port below.
          </p>
          <form className="wireless-form" onSubmit={(event) => void handlePair(event)} noValidate>
            <div className="wireless-field">
              <label className="wireless-label" htmlFor={`${id}-pair-address`}>
                Pairing IP address and port
              </label>
              <input
                ref={pairInputRef}
                id={`${id}-pair-address`}
                type="text"
                className="wireless-input mono"
                placeholder="192.168.1.5:37123"
                autoComplete="off"
                spellCheck={false}
                value={pairAddress}
                disabled={!isOnline || pending}
                aria-invalid={pairAddrError !== null || undefined}
                onChange={(event) => {
                  setPairAddress(event.target.value);
                  if (error !== null) setError(null);
                }}
              />
            </div>

            <div className="wireless-row">
              <div className="wireless-field">
                <label className="wireless-label" htmlFor={`${id}-pair-code`}>
                  6-digit pairing code
                </label>
                <input
                  id={`${id}-pair-code`}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  className="wireless-input mono"
                  placeholder="482910"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  value={pairCode}
                  disabled={!isOnline || pending}
                  aria-invalid={codeError !== null || undefined}
                  onChange={(event) => {
                    setPairCode(event.target.value);
                    if (error !== null) setError(null);
                  }}
                />
              </div>

              <div className="wireless-field">
                <label className="wireless-label" htmlFor={`${id}-connect-port`}>
                  Connect port (optional)
                </label>
                <input
                  id={`${id}-connect-port`}
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  className="wireless-input mono"
                  placeholder="Auto via mDNS"
                  autoComplete="off"
                  spellCheck={false}
                  value={connectPort}
                  disabled={!isOnline || pending}
                  aria-invalid={connectPortError !== null || undefined}
                  onChange={(event) => {
                    setConnectPort(event.target.value);
                    if (error !== null) setError(null);
                  }}
                />
              </div>
            </div>

            {showPairPublicWarning && (
              <div className="wireless-warning" role="status">
                <strong>Public IP address.</strong> Pairing and connecting gives this remote host access to
                ADB and the Lionscope SDK reverse tunnel on your machine. Make sure you trust this address.
              </div>
            )}

            {(pairAddrError || codeError || connectPortError) && (
              <p className="wireless-error" role="alert">
                {pairAddrError ?? codeError ?? connectPortError}
              </p>
            )}

            {error && (
              <p className="wireless-error" role="alert">
                {error}
              </p>
            )}

            <div className="wireless-actions">
              <span className="wireless-status" role="status">
                {!isOnline ? 'Offline — waiting for the server.' : pending ? 'Pairing…' : ''}
              </span>
              <button type="submit" className="btn btn--primary" disabled={!canPair}>
                {pending ? 'Pairing…' : 'Pair & connect'}
              </button>
            </div>
          </form>
        </div>
      )}
    </dialog>,
    document.body,
  );
}

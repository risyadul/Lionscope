import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  isMdnsSerial,
  isPublicWirelessHost,
  isValidPairingCode,
  parseWirelessAddress,
  parseWirelessPort,
  validateWirelessEndpoint,
} from '@lionscope/protocol/wire';
import type {
  DiscoveredWirelessDevice,
  QrPairingUpdate,
  WirelessActionResult,
} from '@lionscope/protocol/wire';
import { createPortal } from 'react-dom';
import { QrCode } from './QrCode.tsx';
import './wireless.css';

type Tab = 'connect' | 'pair' | 'qr';

interface QrSessionState {
  sessionId: string;
  payload: string;
  serviceName: string;
  expiresAt: number;
}

type Props = {
  isOnline: boolean;
  onConnect: (address: string) => Promise<Extract<WirelessActionResult, { action: 'connect' }>>;
  onPair: (
    address: string,
    code: string,
    connectAddress?: string,
  ) => Promise<Extract<WirelessActionResult, { action: 'pair' }>>;
  onListMdns?: () => Promise<Extract<WirelessActionResult, { action: 'mdns' }>>;
  onStartQrPairing?: () => Promise<Extract<WirelessActionResult, { action: 'startQr' }>>;
  onCancelQrPairing?: (sessionId: string) => void;
  qrPairing?: QrPairingUpdate | null;
  onConnected: (serial: string) => void;
  onClose: () => void;
};

function hostPrefix(host: string): string {
  return host.includes(':') ? `[${host}]:` : `${host}:`;
}

/**
 * Native modal dialog for connecting or pairing a physical Android device over wireless ADB:
 * manual IP:port + mDNS discovery, 6-digit pairing code, and Android 11+ QR code pairing.
 * Pairing codes are cleared immediately on submit and never persisted.
 */
export function WirelessDialog({
  isOnline,
  onConnect,
  onPair,
  onListMdns,
  onStartQrPairing,
  onCancelQrPairing,
  qrPairing = null,
  onConnected,
  onClose,
}: Props) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const connectInputRef = useRef<HTMLInputElement>(null);
  const pairInputRef = useRef<HTMLInputElement>(null);
  const activeQrIdRef = useRef<string | null>(null);
  const handledQrIdRef = useRef<string | null>(null);

  const [tab, setTab] = useState<Tab>('connect');
  const [address, setAddress] = useState('');
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [connectPort, setConnectPort] = useState('');
  const [pending, setPending] = useState(false);
  const [connectingTarget, setConnectingTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  // mDNS discovery state
  const [mdnsServices, setMdnsServices] = useState<DiscoveredWirelessDevice[] | null>(null);
  const [mdnsLoading, setMdnsLoading] = useState(false);
  const [mdnsError, setMdnsError] = useState<string | null>(null);

  // QR pairing session state
  const [qrSession, setQrSession] = useState<QrSessionState | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  const cancelActiveQr = useCallback(() => {
    const activeId = activeQrIdRef.current;
    if (activeId !== null) {
      activeQrIdRef.current = null;
      onCancelQrPairing?.(activeId);
    }
  }, [onCancelQrPairing]);

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
      cancelActiveQr();
      if (dialog) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      document.removeEventListener('keydown', escape, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose, cancelActiveQr]);

  const refreshMdns = useCallback(async () => {
    if (!onListMdns || !isOnline) return;
    setMdnsLoading(true);
    setMdnsError(null);
    try {
      const result = await onListMdns();
      if (result.ok) {
        setMdnsServices(result.services);
      } else {
        setMdnsServices([]);
        setMdnsError(result.message);
      }
    } finally {
      setMdnsLoading(false);
    }
  }, [onListMdns, isOnline]);

  useEffect(() => {
    if (tab !== 'connect' || !isOnline || !onListMdns) return;
    let cancelled = false;
    void onListMdns().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setMdnsServices(result.services);
        setMdnsError(null);
      } else {
        setMdnsServices([]);
        setMdnsError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab, isOnline, onListMdns]);

  const startQr = useCallback(async () => {
    if (!onStartQrPairing || !isOnline) return;
    cancelActiveQr();
    setQrSession(null);
    setQrError(null);
    setQrLoading(true);
    try {
      const result = await onStartQrPairing();
      if (result.ok) {
        activeQrIdRef.current = result.sessionId;
        handledQrIdRef.current = null;
        setQrSession({
          sessionId: result.sessionId,
          payload: result.payload,
          serviceName: result.serviceName,
          expiresAt: result.expiresAt,
        });
      } else {
        setQrError(result.message);
      }
    } finally {
      setQrLoading(false);
    }
  }, [onStartQrPairing, isOnline, cancelActiveQr]);

  const matchingQrUpdate =
    qrSession !== null && qrPairing !== null && qrPairing.sessionId === qrSession.sessionId
      ? qrPairing
      : null;

  // Auto-select and close when QR pairing also connected via mDNS.
  useEffect(() => {
    if (!matchingQrUpdate || matchingQrUpdate.status !== 'paired') return;
    if (matchingQrUpdate.connectedSerial === null) return;
    if (handledQrIdRef.current === matchingQrUpdate.sessionId) return;
    handledQrIdRef.current = matchingQrUpdate.sessionId;
    activeQrIdRef.current = null;
    onConnected(matchingQrUpdate.connectedSerial);
    onClose();
  }, [matchingQrUpdate, onConnected, onClose]);

  const switchTab = (next: Tab) => {
    if (tab === 'qr' && next !== 'qr') cancelActiveQr();
    setTab(next);
    setError(null);
    if (next !== 'connect') setSuccessNote(null);
    if (next === 'qr' && isOnline && onStartQrPairing) {
      void startQr();
    }
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

  const connectTarget = async (target: string) => {
    setPending(true);
    setConnectingTarget(target);
    setError(null);
    try {
      const result = await onConnect(target);
      if (result.ok) {
        onConnected(result.serial);
        onClose();
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
      setConnectingTarget(null);
    }
  };

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (!canConnect) return;
    await connectTarget(trimmedAddress);
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

  const qrStatusText = (): string => {
    if (!isOnline) return 'Offline — waiting for the server.';
    if (qrLoading) return 'Generating QR code…';
    if (matchingQrUpdate?.status === 'pairing') {
      return `Phone scanned QR — pairing with ${matchingQrUpdate.target}…`;
    }
    if (matchingQrUpdate?.status === 'expired') return 'QR code expired. Generate a new code to try again.';
    if (matchingQrUpdate?.status === 'failed') return '';
    return 'Waiting for your phone to scan the QR code (polling adb mdns services)…';
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
        {onStartQrPairing && (
          <button
            id={`${id}-tab-qr`}
            type="button"
            role="tab"
            aria-selected={tab === 'qr'}
            aria-controls={`${id}-panel-qr`}
            className="wireless-tab"
            onClick={() => switchTab('qr')}
          >
            Pair with QR
          </button>
        )}
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
                {pending && connectingTarget === trimmedAddress ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>

          {onListMdns && (
            <section className="wireless-mdns" aria-labelledby={`${id}-mdns-heading`}>
              <div className="wireless-mdns-head">
                <h3 id={`${id}-mdns-heading`} className="overline">
                  Discovered on Wi-Fi (mDNS)
                </h3>
                <button
                  type="button"
                  className="btn wireless-mdns-refresh"
                  onClick={() => void refreshMdns()}
                  disabled={!isOnline || mdnsLoading}
                >
                  {mdnsLoading ? 'Scanning…' : 'Refresh'}
                </button>
              </div>
              {mdnsError && (
                <p className="wireless-hint" role="status">
                  {mdnsError}
                </p>
              )}
              {!mdnsError && mdnsServices !== null && mdnsServices.length === 0 && !mdnsLoading && (
                <p className="wireless-hint">
                  No <code className="mono">_adb-tls-connect._tcp</code> devices discovered yet. Enable
                  Wireless debugging on the same Wi-Fi network, or connect manually above.
                </p>
              )}
              {mdnsServices !== null && mdnsServices.length > 0 && (
                <ul className="wireless-mdns-list">
                  {mdnsServices.map((service) => (
                    <li key={service.serial} className="wireless-mdns-item">
                      <div className="wireless-mdns-info">
                        <span className="wireless-mdns-name mono" title={service.serial}>
                          {service.instanceName}
                        </span>
                        <span className="wireless-mdns-target mono">{service.target}</span>
                      </div>
                      {service.connected ? (
                        <span className="wireless-mdns-connected">Connected</span>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          disabled={!isOnline || pending}
                          onClick={() => void connectTarget(service.target)}
                        >
                          {pending && connectingTarget === service.target ? 'Connecting…' : 'Connect'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
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

      {tab === 'qr' && (
        <div
          id={`${id}-panel-qr`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-qr`}
          className="wireless-panel"
        >
          <p className="wireless-note">
            On Android 11+, open{' '}
            <strong>Developer options → Wireless debugging → Pair device with QR code</strong> and scan this
            code. Both devices must be on the same Wi-Fi network with mDNS enabled.
          </p>
          <div className="wireless-qr-box">
            {qrSession !== null && matchingQrUpdate?.status !== 'expired' ? (
              <QrCode payload={qrSession.payload} label="Android wireless debugging pairing QR code" />
            ) : (
              <div className="wireless-qr-placeholder">{qrLoading ? 'Generating…' : 'QR code inactive'}</div>
            )}
          </div>
          {qrStatusText() !== '' && (
            <p className="wireless-status" role="status">
              {qrStatusText()}
            </p>
          )}
          {(qrError !== null || matchingQrUpdate?.status === 'failed') && (
            <p className="wireless-error" role="alert">
              {qrError ?? (matchingQrUpdate?.status === 'failed' ? matchingQrUpdate.message : '')}
            </p>
          )}
          {matchingQrUpdate?.status === 'paired' && matchingQrUpdate.connectedSerial === null && (
            <div className="wireless-success" role="status">
              <p>
                {matchingQrUpdate.connectNote ??
                  `Paired with ${matchingQrUpdate.target}. Enter the separate connect port shown on the Wireless debugging screen.`}
              </p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setAddress(hostPrefix(matchingQrUpdate.host));
                  setSuccessNote(
                    matchingQrUpdate.connectNote ??
                      `Paired with ${matchingQrUpdate.target}. Enter the separate connect port.`,
                  );
                  switchTab('connect');
                  queueMicrotask(() => connectInputRef.current?.focus());
                }}
              >
                Enter connect port
              </button>
            </div>
          )}
          <div className="wireless-actions">
            <span className="wireless-hint">
              mDNS reliability varies across adb versions; use <strong>Pair with code</strong> if scanning
              does not complete.
            </span>
            <button
              type="button"
              className="btn"
              disabled={!isOnline || qrLoading || matchingQrUpdate?.status === 'pairing'}
              onClick={() => void startQr()}
            >
              Generate new QR
            </button>
          </div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}

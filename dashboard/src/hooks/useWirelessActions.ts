import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, QrPairingUpdate, WirelessActionResult } from '@lionscope/protocol/wire';
import type { WirelessAnswer } from '../lib/store.ts';

/**
 * Per-action client deadlines aligned with the full server operation budgets:
 * - pair: adb pair (15s) + mDNS discovery (5s) + connect (10s) + refresh
 * - tcpip: read wlan IP (2×5s) + adb tcpip (10s) + 3× connect (30s) + retries + refresh
 */
export const WIRELESS_ACTION_TIMEOUTS_MS: Readonly<Record<WirelessActionResult['action'], number>> = {
  connect: 25_000,
  disconnect: 25_000,
  mdns: 15_000,
  startQr: 15_000,
  pair: 45_000,
  tcpip: 65_000,
};

interface RequestMeta {
  serial?: string;
  dialogInstanceId?: number;
}

interface PendingEntry {
  action: WirelessActionResult['action'];
  serial?: string;
  dialogInstanceId?: number;
  initiatedSelectionVersion: number;
  initiatedSerial: string | null;
  connectionGen: number;
  resolve: (result: WirelessActionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TimedOutEntry {
  action: WirelessActionResult['action'];
  serial?: string;
  dialogInstanceId?: number;
  initiatedSelectionVersion: number;
  initiatedSerial: string | null;
  connectionGen: number;
}

/**
 * Late server result exposed to an open `WirelessDialog`. Never carries a `startQr` payload (late QR starts
 * are cancelled/scrubbed immediately before reaching generic result state).
 */
export interface LateWirelessResult {
  requestId: number;
  dialogInstanceId: number | null;
  result: Exclude<WirelessActionResult, { action: 'startQr' }>;
}

export interface PendingPublicTcpip {
  usbSerial: string;
  host: string;
  port: number;
  target: string;
}

interface Input {
  send: (msg: ClientMessage) => boolean;
  answers: readonly WirelessAnswer[];
  qrPairing: QrPairingUpdate | null;
  isOpen: boolean;
  /** Currently selected device serial in the dashboard (used to detect if the user moved on). */
  currentSerial?: string | null;
  /** Monotonic counter incremented whenever the user changes device/AVD selection. */
  selectionVersion?: number;
  /** Instance id of the currently open WirelessDialog, or null when closed. */
  activeDialogId?: number | null;
  /** Called once a password-bearing `startQr` answer is consumed or cancelled so the store can discard it. */
  onConsumeQrPayload?: (sessionId?: string) => void;
  /** Called when a timed-out tcpip action later succeeds while the user is still on the initiating device. */
  onLateConnected?: (serial: string) => void;
  /** Test-only timeout overrides. */
  timeouts?: Partial<Record<WirelessActionResult['action'], number>>;
}

export interface WirelessActionsController {
  connect: (
    address: string,
    dialogInstanceId?: number,
  ) => Promise<Extract<WirelessActionResult, { action: 'connect' }>>;
  disconnect: (serial: string) => Promise<Extract<WirelessActionResult, { action: 'disconnect' }>>;
  pair: (
    address: string,
    code: string,
    connectAddress?: string,
    dialogInstanceId?: number,
  ) => Promise<Extract<WirelessActionResult, { action: 'pair' }>>;
  listMdns: () => Promise<Extract<WirelessActionResult, { action: 'mdns' }>>;
  startQrPairing: () => Promise<Extract<WirelessActionResult, { action: 'startQr' }>>;
  cancelQrPairing: (sessionId: string) => void;
  enableTcpip: (
    serial: string,
    port?: number,
    confirmPublicTarget?: string,
  ) => Promise<Extract<WirelessActionResult, { action: 'tcpip' }>>;
  pendingPublicTcpip: PendingPublicTcpip | null;
  clearPendingPublicTcpip: () => void;
  qrPairing: QrPairingUpdate | null;
  lateResult: LateWirelessResult | null;
  disconnectingSerial: string | null;
  handoffSerial: string | null;
  /** USB serial whose `tcpip` request timed out on the client while still running on the server. */
  provisionalTcpipSerial: string | null;
  actionError: string | null;
  actionNotice: string | null;
  clearActionError: () => void;
  clearActionNotice: () => void;
}

/**
 * Sends request/response wireless ADB commands over the dashboard WebSocket, matches answers by
 * `requestId`, and reconciles late server outcomes without hijacking newer user state.
 */
export function useWirelessActions({
  send,
  answers,
  qrPairing,
  isOpen,
  currentSerial,
  selectionVersion = 0,
  activeDialogId = null,
  onConsumeQrPayload,
  onLateConnected,
  timeouts,
}: Input): WirelessActionsController {
  const nextIdRef = useRef(1);
  const connectionGenRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingEntry>());
  const timedOutRef = useRef(new Map<number, TimedOutEntry>());
  const latestDialogRequestRef = useRef(new Map<number, number>());
  const sendRef = useRef(send);
  const isOpenRef = useRef(isOpen);
  const currentSerialRef = useRef<string | null | undefined>(currentSerial);
  const selectionVersionRef = useRef(selectionVersion);
  const activeDialogIdRef = useRef(activeDialogId);
  const onConsumeQrRef = useRef(onConsumeQrPayload);
  const onLateConnectedRef = useRef(onLateConnected);
  const timeoutsRef = useRef(timeouts);

  const [disconnectingSerial, setDisconnectingSerial] = useState<string | null>(null);
  const [handoffSerial, setHandoffSerial] = useState<string | null>(null);
  const [provisionalTcpipSerial, setProvisionalTcpipSerial] = useState<string | null>(null);
  const [pendingPublicTcpip, setPendingPublicTcpip] = useState<PendingPublicTcpip | null>(null);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [lateResult, setLateResult] = useState<LateWirelessResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) {
      if (provisionalTcpipSerial !== null) setProvisionalTcpipSerial(null);
      if (pendingPublicTcpip !== null) setPendingPublicTcpip(null);
      if (lateResult !== null) setLateResult(null);
    }
  }

  useEffect(() => {
    sendRef.current = send;
    isOpenRef.current = isOpen;
    currentSerialRef.current = currentSerial;
    selectionVersionRef.current = selectionVersion;
    activeDialogIdRef.current = activeDialogId;
    onConsumeQrRef.current = onConsumeQrPayload;
    onLateConnectedRef.current = onLateConnected;
    timeoutsRef.current = timeouts;
  }, [
    send,
    isOpen,
    currentSerial,
    selectionVersion,
    activeDialogId,
    onConsumeQrPayload,
    onLateConnected,
    timeouts,
  ]);

  useEffect(() => {
    for (const answer of answers) {
      const pending = pendingRef.current.get(answer.requestId);
      if (pending) {
        pendingRef.current.delete(answer.requestId);
        clearTimeout(pending.timer);
        pending.resolve(answer.result);
        if (answer.result.action === 'startQr' && answer.result.ok) {
          onConsumeQrRef.current?.(answer.result.sessionId);
        }
        continue;
      }

      const timedOut = timedOutRef.current.get(answer.requestId);
      if (!timedOut) continue;
      timedOutRef.current.delete(answer.requestId);

      const { result } = answer;
      // Handle late QR starts BEFORE generic lateResult state so the QR password payload is never retained.
      if (result.action === 'startQr') {
        if (result.ok) {
          onConsumeQrRef.current?.(result.sessionId);
          if (isOpenRef.current && connectionGenRef.current === timedOut.connectionGen) {
            sendRef.current({ type: 'cancelQrPairing', sessionId: result.sessionId });
          }
        }
        continue;
      }

      const selectionUnchanged = selectionVersionRef.current === timedOut.initiatedSelectionVersion;
      const sameDialogOpen =
        timedOut.dialogInstanceId !== undefined &&
        activeDialogIdRef.current === timedOut.dialogInstanceId &&
        latestDialogRequestRef.current.get(timedOut.dialogInstanceId) === answer.requestId;

      if (sameDialogOpen && selectionUnchanged) {
        setLateResult({
          requestId: answer.requestId,
          dialogInstanceId: timedOut.dialogInstanceId ?? null,
          result,
        });
      }

      if (result.action === 'tcpip') {
        setProvisionalTcpipSerial((current) => (current === timedOut.serial ? null : current));
        const stillOnInitiatingUsb =
          selectionUnchanged &&
          (currentSerialRef.current === undefined || currentSerialRef.current === timedOut.serial);
        if (result.ok) {
          setPendingPublicTcpip(null);
          setActionError(null);
          if (stillOnInitiatingUsb) {
            setActionNotice(
              `Switched to Wi-Fi (${result.serial}). Port ${result.port} stays open until reboot.`,
            );
            onLateConnectedRef.current?.(result.serial);
          } else {
            setActionNotice(
              `Switched ${result.usbSerial} to Wi-Fi (${result.serial}) in the background. Port ${result.port} stays open until reboot.`,
            );
          }
        } else if (result.needsPublicConfirmation) {
          setActionError(null);
          setActionNotice(null);
          if (stillOnInitiatingUsb) {
            setPendingPublicTcpip({
              usbSerial: result.usbSerial,
              host: result.host,
              port: result.port,
              target: result.target,
            });
          } else {
            setActionNotice(result.message);
          }
        } else {
          setActionNotice(null);
          setActionError(result.message);
        }
      } else if (result.action === 'disconnect') {
        if (result.ok) {
          setActionError(null);
          setActionNotice(`Disconnected ${result.target}.`);
        } else {
          setActionNotice(null);
          setActionError(result.message);
        }
      } else if (result.action === 'connect') {
        if (result.ok) {
          setActionError(null);
          // Only report as a background notice when the user moved on or closed the initiating dialog;
          // an unchanged initiating dialog handles selection/close itself via `lateResult`.
          if (!sameDialogOpen || !selectionUnchanged) {
            setActionNotice(`Connected ${result.serial} in the background.`);
          }
        }
      } else if (result.action === 'pair') {
        if (result.ok && result.connectedSerial !== null) {
          setActionError(null);
          if (!sameDialogOpen || !selectionUnchanged) {
            setActionNotice(`Paired and connected ${result.connectedSerial} in the background.`);
          }
        } else if (result.ok && !sameDialogOpen) {
          setActionError(null);
          setActionNotice(`Paired with ${result.target} in the background.`);
        }
      }
    }
  }, [answers]);

  useEffect(() => {
    if (isOpen) return;
    connectionGenRef.current += 1;
    for (const [id, entry] of pendingRef.current) {
      pendingRef.current.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({
        action: entry.action,
        ok: false,
        message: 'Disconnected from the Lionscope server before the action completed.',
      } as WirelessActionResult);
    }
    timedOutRef.current.clear();
  }, [isOpen]);

  useEffect(() => {
    const pending = pendingRef.current;
    const timedOut = timedOutRef.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      timedOut.clear();
    };
  }, []);

  const request = useCallback(
    <A extends WirelessActionResult['action']>(
      action: A,
      build: (requestId: number) => ClientMessage,
      meta: RequestMeta = {},
    ): Promise<Extract<WirelessActionResult, { action: A }>> =>
      new Promise((resolve) => {
        if (!isOpen) {
          resolve({
            action,
            ok: false,
            message: 'Offline — waiting for the server.',
          } as Extract<WirelessActionResult, { action: A }>);
          return;
        }
        const requestId = nextIdRef.current++;
        const sent = send(build(requestId));
        if (!sent) {
          resolve({
            action,
            ok: false,
            message: 'Could not send request to the server.',
          } as Extract<WirelessActionResult, { action: A }>);
          return;
        }
        const initiatedSelectionVersion = selectionVersionRef.current;
        const initiatedSerial = currentSerialRef.current ?? null;
        const connectionGen = connectionGenRef.current;
        if (meta.dialogInstanceId !== undefined) {
          latestDialogRequestRef.current.set(meta.dialogInstanceId, requestId);
        }
        const timeoutMs = timeoutsRef.current?.[action] ?? WIRELESS_ACTION_TIMEOUTS_MS[action];
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          timedOutRef.current.set(requestId, {
            action,
            ...(meta.serial !== undefined ? { serial: meta.serial } : {}),
            ...(meta.dialogInstanceId !== undefined ? { dialogInstanceId: meta.dialogInstanceId } : {}),
            initiatedSelectionVersion,
            initiatedSerial,
            connectionGen,
          });
          if (action === 'tcpip' && meta.serial !== undefined) {
            setProvisionalTcpipSerial(meta.serial);
          }
          resolve({
            action,
            ok: false,
            message:
              action === 'tcpip'
                ? 'Still waiting for USB → Wi-Fi handoff — the server is finishing the connection.'
                : 'Still waiting for adb — the server operation may still finish.',
          } as Extract<WirelessActionResult, { action: A }>);
        }, timeoutMs);
        pendingRef.current.set(requestId, {
          action,
          ...(meta.serial !== undefined ? { serial: meta.serial } : {}),
          ...(meta.dialogInstanceId !== undefined ? { dialogInstanceId: meta.dialogInstanceId } : {}),
          initiatedSelectionVersion,
          initiatedSerial,
          connectionGen,
          resolve: (result) => resolve(result as Extract<WirelessActionResult, { action: A }>),
          timer,
        });
      }),
    [isOpen, send],
  );

  const connect = useCallback(
    (address: string, dialogInstanceId?: number) =>
      request(
        'connect',
        (requestId) => ({ type: 'connectDevice', requestId, address }),
        dialogInstanceId !== undefined ? { dialogInstanceId } : {},
      ),
    [request],
  );

  const pair = useCallback(
    (address: string, code: string, connectAddress?: string, dialogInstanceId?: number) =>
      request(
        'pair',
        (requestId) => ({
          type: 'pairDevice',
          requestId,
          address,
          code,
          ...(connectAddress !== undefined && connectAddress !== '' ? { connectAddress } : {}),
        }),
        dialogInstanceId !== undefined ? { dialogInstanceId } : {},
      ),
    [request],
  );

  const disconnect = useCallback(
    async (serial: string) => {
      setDisconnectingSerial(serial);
      setActionError(null);
      setActionNotice(null);
      try {
        const result = await request(
          'disconnect',
          (requestId) => ({
            type: 'disconnectDevice',
            requestId,
            serial,
          }),
          { serial },
        );
        if (!result.ok) setActionError(result.message);
        return result;
      } finally {
        setDisconnectingSerial((current) => (current === serial ? null : current));
      }
    },
    [request],
  );

  const enableTcpip = useCallback(
    async (serial: string, port?: number, confirmPublicTarget?: string) => {
      setHandoffSerial(serial);
      setActionError(null);
      setActionNotice(null);
      setPendingPublicTcpip(null);
      try {
        const result = await request(
          'tcpip',
          (requestId) => ({
            type: 'enableWirelessTcpip',
            requestId,
            serial,
            ...(port !== undefined ? { port } : {}),
            ...(confirmPublicTarget !== undefined ? { confirmPublicTarget } : {}),
          }),
          { serial },
        );
        if (!result.ok) {
          if (result.needsPublicConfirmation) {
            setPendingPublicTcpip({
              usbSerial: result.usbSerial,
              host: result.host,
              port: result.port,
              target: result.target,
            });
          } else {
            setActionError(result.message);
          }
        }
        return result;
      } finally {
        setHandoffSerial((current) => (current === serial ? null : current));
      }
    },
    [request],
  );

  const clearPendingPublicTcpip = useCallback(() => setPendingPublicTcpip(null), []);
  const clearActionError = useCallback(() => setActionError(null), []);
  const clearActionNotice = useCallback(() => setActionNotice(null), []);

  const listMdns = useCallback(
    () => request('mdns', (requestId) => ({ type: 'listMdnsServices', requestId })),
    [request],
  );

  const startQrPairing = useCallback(
    () => request('startQr', (requestId) => ({ type: 'startQrPairing', requestId })),
    [request],
  );

  const cancelQrPairing = useCallback(
    (sessionId: string) => {
      onConsumeQrRef.current?.(sessionId);
      if (isOpen) send({ type: 'cancelQrPairing', sessionId });
    },
    [isOpen, send],
  );

  return {
    connect,
    disconnect,
    pair,
    listMdns,
    startQrPairing,
    cancelQrPairing,
    enableTcpip,
    pendingPublicTcpip,
    clearPendingPublicTcpip,
    qrPairing,
    lateResult,
    disconnectingSerial,
    handoffSerial,
    provisionalTcpipSerial,
    actionError,
    actionNotice,
    clearActionError,
    clearActionNotice,
  };
}

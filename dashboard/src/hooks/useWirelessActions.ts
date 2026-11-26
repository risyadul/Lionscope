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

interface PendingEntry {
  action: WirelessActionResult['action'];
  serial?: string;
  resolve: (result: WirelessActionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TimedOutEntry {
  action: WirelessActionResult['action'];
  serial?: string;
}

export interface LateWirelessResult {
  requestId: number;
  result: WirelessActionResult;
}

interface Input {
  send: (msg: ClientMessage) => boolean;
  answers: readonly WirelessAnswer[];
  qrPairing: QrPairingUpdate | null;
  isOpen: boolean;
  /** Called once a password-bearing `startQr` answer is consumed or cancelled so the store can discard it. */
  onConsumeQrPayload?: (sessionId?: string) => void;
  /** Called when a timed-out connect/pair/tcpip action later completes successfully on the server. */
  onLateConnected?: (serial: string) => void;
  /** Test-only timeout overrides. */
  timeouts?: Partial<Record<WirelessActionResult['action'], number>>;
}

export interface WirelessActionsController {
  connect: (address: string) => Promise<Extract<WirelessActionResult, { action: 'connect' }>>;
  disconnect: (serial: string) => Promise<Extract<WirelessActionResult, { action: 'disconnect' }>>;
  pair: (
    address: string,
    code: string,
    connectAddress?: string,
  ) => Promise<Extract<WirelessActionResult, { action: 'pair' }>>;
  listMdns: () => Promise<Extract<WirelessActionResult, { action: 'mdns' }>>;
  startQrPairing: () => Promise<Extract<WirelessActionResult, { action: 'startQr' }>>;
  cancelQrPairing: (sessionId: string) => void;
  enableTcpip: (serial: string, port?: number) => Promise<Extract<WirelessActionResult, { action: 'tcpip' }>>;
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
 * `requestId`, and reconciles late server outcomes when a slow operation finishes after the client deadline.
 */
export function useWirelessActions({
  send,
  answers,
  qrPairing,
  isOpen,
  onConsumeQrPayload,
  onLateConnected,
  timeouts,
}: Input): WirelessActionsController {
  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingEntry>());
  const timedOutRef = useRef(new Map<number, TimedOutEntry>());
  const onConsumeQrRef = useRef(onConsumeQrPayload);
  const onLateConnectedRef = useRef(onLateConnected);
  const timeoutsRef = useRef(timeouts);

  const [disconnectingSerial, setDisconnectingSerial] = useState<string | null>(null);
  const [handoffSerial, setHandoffSerial] = useState<string | null>(null);
  const [provisionalTcpipSerial, setProvisionalTcpipSerial] = useState<string | null>(null);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [lateResult, setLateResult] = useState<LateWirelessResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen && provisionalTcpipSerial !== null) {
      setProvisionalTcpipSerial(null);
    }
  }

  useEffect(() => {
    onConsumeQrRef.current = onConsumeQrPayload;
    onLateConnectedRef.current = onLateConnected;
    timeoutsRef.current = timeouts;
  }, [onConsumeQrPayload, onLateConnected, timeouts]);

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
      setLateResult({ requestId: answer.requestId, result: answer.result });

      const { result } = answer;
      if (result.action === 'startQr' && result.ok) {
        onConsumeQrRef.current?.(result.sessionId);
      } else if (result.action === 'tcpip') {
        setProvisionalTcpipSerial((current) => (current === timedOut.serial ? null : current));
        if (result.ok) {
          setActionError(null);
          setActionNotice(
            `Switched to Wi-Fi (${result.serial}). Port ${result.port} stays open until reboot.`,
          );
          onLateConnectedRef.current?.(result.serial);
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
          onLateConnectedRef.current?.(result.serial);
        }
      } else if (result.action === 'pair') {
        if (result.ok && result.connectedSerial !== null) {
          setActionError(null);
          onLateConnectedRef.current?.(result.connectedSerial);
        }
      }
    }
  }, [answers]);

  useEffect(() => {
    if (isOpen) return;
    for (const [id, entry] of pendingRef.current) {
      pendingRef.current.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({
        action: entry.action,
        ok: false,
        message: 'Disconnected from the Lionscope server before the action completed.',
      });
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
      meta: { serial?: string } = {},
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
        const timeoutMs = timeoutsRef.current?.[action] ?? WIRELESS_ACTION_TIMEOUTS_MS[action];
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          timedOutRef.current.set(requestId, {
            action,
            ...(meta.serial !== undefined ? { serial: meta.serial } : {}),
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
          resolve: (result) => resolve(result as Extract<WirelessActionResult, { action: A }>),
          timer,
        });
      }),
    [isOpen, send],
  );

  const connect = useCallback(
    (address: string) => request('connect', (requestId) => ({ type: 'connectDevice', requestId, address })),
    [request],
  );

  const pair = useCallback(
    (address: string, code: string, connectAddress?: string) =>
      request('pair', (requestId) => ({
        type: 'pairDevice',
        requestId,
        address,
        code,
        ...(connectAddress !== undefined && connectAddress !== '' ? { connectAddress } : {}),
      })),
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
    async (serial: string, port?: number) => {
      setHandoffSerial(serial);
      setActionError(null);
      setActionNotice(null);
      try {
        const result = await request(
          'tcpip',
          (requestId) => ({
            type: 'enableWirelessTcpip',
            requestId,
            serial,
            ...(port !== undefined ? { port } : {}),
          }),
          { serial },
        );
        if (!result.ok) setActionError(result.message);
        return result;
      } finally {
        setHandoffSerial((current) => (current === serial ? null : current));
      }
    },
    [request],
  );

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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, QrPairingUpdate, WirelessActionResult } from '@lionscope/protocol/wire';
import type { WirelessAnswer } from '../lib/store.ts';

const WIRELESS_REQUEST_TIMEOUT_MS = 20_000;

interface PendingEntry {
  action: WirelessActionResult['action'];
  resolve: (result: WirelessActionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Input {
  send: (msg: ClientMessage) => boolean;
  answers: readonly WirelessAnswer[];
  qrPairing: QrPairingUpdate | null;
  isOpen: boolean;
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
  disconnectingSerial: string | null;
  handoffSerial: string | null;
  actionError: string | null;
  clearActionError: () => void;
}

/** Sends request/response wireless ADB commands over the dashboard WebSocket and matches answers by requestId. */
export function useWirelessActions({ send, answers, qrPairing, isOpen }: Input): WirelessActionsController {
  const nextIdRef = useRef(1);
  const pendingRef = useRef(new Map<number, PendingEntry>());
  const [disconnectingSerial, setDisconnectingSerial] = useState<string | null>(null);
  const [handoffSerial, setHandoffSerial] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    for (const answer of answers) {
      const entry = pendingRef.current.get(answer.requestId);
      if (!entry) continue;
      pendingRef.current.delete(answer.requestId);
      clearTimeout(entry.timer);
      entry.resolve(answer.result);
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
  }, [isOpen]);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);

  const request = useCallback(
    <A extends WirelessActionResult['action']>(
      action: A,
      build: (requestId: number) => ClientMessage,
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
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({
            action,
            ok: false,
            message: 'Timed out waiting for adb to respond.',
          } as Extract<WirelessActionResult, { action: A }>);
        }, WIRELESS_REQUEST_TIMEOUT_MS);
        pendingRef.current.set(requestId, {
          action,
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
      try {
        const result = await request('disconnect', (requestId) => ({
          type: 'disconnectDevice',
          requestId,
          serial,
        }));
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
      try {
        const result = await request('tcpip', (requestId) => ({
          type: 'enableWirelessTcpip',
          requestId,
          serial,
          ...(port !== undefined ? { port } : {}),
        }));
        if (!result.ok) setActionError(result.message);
        return result;
      } finally {
        setHandoffSerial((current) => (current === serial ? null : current));
      }
    },
    [request],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

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
    disconnectingSerial,
    handoffSerial,
    actionError,
    clearActionError,
  };
}

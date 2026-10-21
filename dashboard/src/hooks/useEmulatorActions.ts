import { useCallback, useEffect, useState } from 'react';
import type { BootMode, ClientMessage, EmulatorInfo, EmulatorState } from '@lionscope/protocol/wire';
import type { EmulatorAction, PendingEmulatorAction } from '../lib/emulators.ts';

/** A request the server never answers stops showing as pending after this long. */
export const EMULATOR_REQUEST_TIMEOUT_MS = 15_000;

interface Input {
  send: (msg: ClientMessage) => boolean;
  emulators: readonly EmulatorInfo[] | null;
  errorSeq: number;
}

interface Request {
  action: PendingEmulatorAction;
  /** The AVD's state when asked; any change means the server took the request up. */
  fromState: EmulatorState | null;
  errorSeq: number;
}

export interface EmulatorActions {
  /** Booting / shutting down until the AVD's state changes, an `error` arrives or the request times out. */
  pending: PendingEmulatorAction | null;
  boot: (avdName: string, mode: BootMode) => void;
  shutdown: (avdName: string) => void;
}

function stateOf(emulators: readonly EmulatorInfo[] | null, avdName: string): EmulatorState | null {
  return (emulators ?? []).find((e) => e.avdName === avdName)?.state ?? null;
}

export function useEmulatorActions({ send, emulators, errorSeq }: Input): EmulatorActions {
  const [request, setRequest] = useState<Request | null>(null);
  const pending =
    request !== null &&
    request.errorSeq === errorSeq &&
    request.fromState !== null &&
    stateOf(emulators, request.action.avdName) === request.fromState
      ? request.action
      : null;

  useEffect(() => {
    if (request === null) return;
    const timer = setTimeout(() => setRequest(null), EMULATOR_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [request]);

  const ask = useCallback(
    (msg: ClientMessage, avdName: string, action: EmulatorAction) => {
      if (!send(msg)) return;
      setRequest({ action: { avdName, action }, fromState: stateOf(emulators, avdName), errorSeq });
    },
    [send, emulators, errorSeq],
  );
  const boot = useCallback(
    (avdName: string, mode: BootMode) => ask({ type: 'bootEmulator', avdName, mode }, avdName, 'boot'),
    [ask],
  );
  const shutdown = useCallback(
    (avdName: string) => ask({ type: 'shutdownEmulator', avdName }, avdName, 'shutdown'),
    [ask],
  );
  return { pending, boot, shutdown };
}

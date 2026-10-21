import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, SdkOptions } from '@lionscope/protocol/wire';
import {
  IDLE_SYNC,
  isSyncPending,
  OPTIONS_SYNC_TIMEOUT_MS,
  requestOptions,
  settleOptions,
  shownOptions,
  type OptionsSync,
  type SyncStep,
} from '../lib/sdkOptionsSync.ts';

interface Input {
  send: (msg: ClientMessage) => boolean;
  /** The server's options for the session. */
  options: SdkOptions;
  sessionSeq: number;
  errorSeq: number;
  isOpen: boolean;
}

export interface SdkOptionsControl {
  shown: SdkOptions;
  isPending: boolean;
  change: (patch: Partial<SdkOptions>) => void;
}

/**
 * Drives `sdkOptionsSync` against the socket. Rendering reads the state; a ref mirrors it so two changes
 * in one task see each other (React hasn't re-rendered between them).
 */
export function useSdkOptions({ send, options, sessionSeq, errorSeq, isOpen }: Input): SdkOptionsControl {
  const [sync, setSync] = useState<OptionsSync>(IDLE_SYNC);
  const syncRef = useRef<OptionsSync>(IDLE_SYNC);
  const [tick, setTick] = useState(0);

  const apply = useCallback(
    (step: SyncStep) => {
      const isLost = step.send !== null && !send({ type: 'setSdkOptions', ...step.send });
      // A send that failed put nothing on the wire, so nothing is pending.
      const next = isLost ? IDLE_SYNC : step.sync;
      syncRef.current = next;
      setSync(next);
    },
    [send],
  );

  // Every server answer, error, disconnect or timeout tick may settle or release the queued patch.
  useEffect(() => {
    const current = syncRef.current;
    if (!isOpen) {
      if (current !== IDLE_SYNC) apply({ sync: IDLE_SYNC, send: null });
      return;
    }
    const step = settleOptions(current, options, { sessionSeq, errorSeq, now: Date.now() });
    if (step.sync !== current) apply(step);
  }, [apply, options, sessionSeq, errorSeq, isOpen, tick]);

  const isPending = isOpen && isSyncPending(sync);
  useEffect(() => {
    if (!isPending) return;
    const timer = setTimeout(
      () => setTick((t) => t + 1),
      Math.max(0, sync.since + OPTIONS_SYNC_TIMEOUT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [isPending, sync.since]);

  const change = useCallback(
    (patch: Partial<SdkOptions>) => {
      const step = requestOptions(syncRef.current, patch, options, { sessionSeq, errorSeq, now: Date.now() });
      if (step.sync !== syncRef.current) apply(step);
    },
    [apply, options, sessionSeq, errorSeq],
  );

  return { shown: isOpen ? shownOptions(sync, options) : options, isPending, change };
}

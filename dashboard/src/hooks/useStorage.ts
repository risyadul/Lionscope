import { useCallback, useEffect, useRef } from 'react';
import {
  STORAGE_TIMEOUT_MS,
  type ClientMessage,
  type StorageReadInput,
  type StorageResponse,
  type StorageWriteInput,
} from '@lionscope/protocol/wire';
import type { StorageAnswer } from '../lib/store.ts';

/** The server answers within its own SDK timeout; past this the answer (or the socket) was lost. */
export const STORAGE_ANSWER_TIMEOUT_MS = STORAGE_TIMEOUT_MS + 2000;
const MAX_REQUEST_ID = 2 ** 31 - 1;

const LOST: StorageResponse = { ok: false, code: 'timeout', message: 'The server did not answer in time.' };
const OFFLINE: StorageResponse = { ok: false, code: 'failed', message: 'Not connected to the server.' };

export interface StorageRequests {
  list: () => Promise<StorageResponse>;
  read: (read: StorageReadInput) => Promise<StorageResponse>;
  write: (write: StorageWriteInput) => Promise<StorageResponse>;
  /** The server's write audit (no values). */
  audit: () => Promise<StorageResponse>;
}

interface Pending {
  resolve: (response: StorageResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Request ids of this tab: one random start per page load, then counted up (wraps at 2^31 - 1). */
let nextRequestId = Math.floor(Math.random() * 1_000_000);

/** Sends this client's storage requests and resolves each with the `storage` answer of its request id. */
export function useStorage(
  send: (msg: ClientMessage) => boolean,
  answers: readonly StorageAnswer[],
): StorageRequests {
  const pending = useRef(new Map<number, Pending>());

  useEffect(() => {
    for (const answer of answers) {
      const waiting = pending.current.get(answer.requestId);
      if (!waiting) continue;
      pending.current.delete(answer.requestId);
      clearTimeout(waiting.timer);
      waiting.resolve(answer.response);
    }
  }, [answers]);

  useEffect(
    () => () => {
      for (const waiting of pending.current.values()) clearTimeout(waiting.timer);
      pending.current.clear();
    },
    [],
  );

  const request = useCallback(
    (build: (requestId: number) => ClientMessage): Promise<StorageResponse> =>
      new Promise((resolve) => {
        nextRequestId = (nextRequestId + 1) % MAX_REQUEST_ID;
        const requestId = nextRequestId;
        if (!send(build(requestId))) return resolve(OFFLINE);
        const timer = setTimeout(() => {
          pending.current.delete(requestId);
          resolve(LOST);
        }, STORAGE_ANSWER_TIMEOUT_MS);
        pending.current.set(requestId, { resolve, timer });
      }),
    [send],
  );

  return {
    list: useCallback(() => request((requestId) => ({ type: 'storageList', requestId })), [request]),
    read: useCallback(
      (read: StorageReadInput) => request((requestId) => ({ type: 'storageRead', requestId, read })),
      [request],
    ),
    write: useCallback(
      (write: StorageWriteInput) => request((requestId) => ({ type: 'storageWrite', requestId, write })),
      [request],
    ),
    audit: useCallback(() => request((requestId) => ({ type: 'storageAudit', requestId })), [request]),
  };
}

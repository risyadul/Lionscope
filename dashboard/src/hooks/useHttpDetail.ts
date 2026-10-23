import { useEffect, useRef } from 'react';
import type { ClientMessage, HttpExchange, HttpExchangeDetail } from '@lionscope/protocol/wire';
import type { HttpDetailAnswer } from '../lib/store.ts';

/**
 * Detail requests go out at most this often: holding ↓ in the list selects a row per key repeat, and the socket is
 * rate-limited. The last selection always gets its request.
 */
export const DETAIL_REQUEST_GAP_MS = 250;

export type HttpDetailStatus = 'idle' | 'loading' | 'ready' | 'gone';

export interface HttpDetailView {
  /** Headers and bodies of the selected exchange; null until its answer arrives (or when it is gone). */
  detail: HttpExchangeDetail | null;
  /** `gone`: the server no longer keeps it. */
  status: HttpDetailStatus;
}

interface Options {
  send: (msg: ClientMessage) => boolean;
  /** The selected exchange's summary, null when nothing is selected. */
  summary: HttpExchange | null;
  /** The store's latest `httpExchange` answer. */
  answer: HttpDetailAnswer | null;
  isOpen: boolean;
}

/** What makes a detail worth asking for again: the response arrived, the call failed or ended. */
function detailKey(summary: HttpExchange): string {
  return `${summary.id}:${summary.state}:${summary.status ?? ''}:${summary.endTs ?? ''}`;
}

/**
 * Asks for the selected exchange's headers and bodies (`getHttpExchange`) when it is selected, when its summary
 * changes and after a reconnect; the answer stays shown until the next one replaces it.
 */
export function useHttpDetail({ send, summary, answer, isOpen }: Options): HttpDetailView {
  const key = summary === null ? null : detailKey(summary);
  const id = summary?.id ?? null;
  const sentKey = useRef<string | null>(null);
  const lastSentAt = useRef(-Infinity);

  useEffect(() => {
    if (!isOpen) {
      // A new connection knows nothing of what was asked before.
      sentKey.current = null;
      return;
    }
    if (key === null || id === null || sentKey.current === key) return;
    const request = () => {
      if (!send({ type: 'getHttpExchange', id })) return;
      sentKey.current = key;
      lastSentAt.current = Date.now();
    };
    const wait = lastSentAt.current + DETAIL_REQUEST_GAP_MS - Date.now();
    if (wait <= 0) {
      request();
      return;
    }
    const timer = setTimeout(request, wait);
    return () => clearTimeout(timer);
  }, [send, key, id, isOpen]);

  if (id === null) return { detail: null, status: 'idle' };
  if (answer === null || answer.id !== id) return { detail: null, status: 'loading' };
  return answer.exchange === null
    ? { detail: null, status: 'gone' }
    : { detail: answer.exchange, status: 'ready' };
}

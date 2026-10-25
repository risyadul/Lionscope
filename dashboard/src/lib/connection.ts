/** WebSocket client for the Lionscope server with exponential-backoff reconnect. */
import type { ClientMessage, ServerMessage, ServerMessageType } from '@lionscope/protocol/wire';
import { WS_PATH } from '@lionscope/protocol/wire';
import type { CloseReason, ConnectionState } from './store.ts';

export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 5000;

const SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  'hello',
  'devices',
  'emulators',
  'apps',
  'session',
  'snapshot',
  'cpu',
  'memory',
  'frames',
  'logs',
  'event',
  'screen',
  'breakdown',
  'stall',
  'strictmode',
  'inflate',
  'viewtree',
  'inspection',
  'inspectorSelection',
  'http',
  'httpExchange',
  'networkMocks',
  'viewEdit',
  'locations',
  'error',
]);

export function wsUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${WS_PATH}`;
}

/** Exponential backoff with ±20% jitter: ~250, 500, 1000, … ms, capped at 5 s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + random() * 0.4;
  return Math.min(BACKOFF_CAP_MS, Math.round(exp * jitter));
}

/** Server messages are trusted (same origin) but still shape-checked before reaching the store. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type: unknown = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_MESSAGE_TYPES.has(type as ServerMessageType)) return null;
  return parsed as ServerMessage;
}

/** The subset of the browser WebSocket used here, so tests can inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectionOptions {
  url: string;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (state: ConnectionState) => void;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  now?: () => number;
}

export interface Connection {
  /** Sends when open; returns false (message dropped) otherwise. */
  send(msg: ClientMessage): boolean;
  /** Closes the socket on purpose and stops reconnecting (reports `closed`). */
  close(): void;
  /** Re-opens after `close()`, e.g. when the page returns from the back-forward cache. */
  reconnect(): void;
}

const OPEN = 1;
/** A connection must survive this long (or receive `hello`) before backoff resets. */
export const STABLE_AFTER_MS = 5000;
/** Minimum wait after the server closes us for exceeding its message rate limit. */
export const POLICY_BACKOFF_MS = 30_000;

export function closeReasonFor(code: number | undefined): CloseReason | null {
  return code === 1008 ? 'rate-limited' : null;
}

export function createConnection(options: ConnectionOptions): Connection {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let socket: SocketLike | null = null;
  let attempt = 0;
  let closeReason: CloseReason | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const clearTimers = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (stableTimer !== null) clearTimeout(stableTimer);
    retryTimer = null;
    stableTimer = null;
  };

  const markStable = () => {
    if (stableTimer !== null) clearTimeout(stableTimer);
    stableTimer = null;
    attempt = 0;
    closeReason = null;
  };

  const connect = () => {
    if (closed) return;
    retryTimer = null;
    const status = attempt === 0 && closeReason === null ? 'connecting' : 'reconnecting';
    options.onStatus({ status, attempt, retryAt: null, closeReason });
    const ws = createSocket(options.url);
    socket = ws;

    ws.onopen = () => {
      // Backoff only resets once the connection proves stable: a server that accepts and
      // immediately drops us (rate limit, restart loop) must not be hammered.
      options.onStatus({ status: 'open', attempt, retryAt: null, closeReason: null });
      stableTimer = setTimeout(markStable, STABLE_AFTER_MS);
    };
    ws.onmessage = (event) => {
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      if (msg.type === 'hello') markStable();
      options.onMessage(msg);
    };
    ws.onerror = () => {
      // A close event always follows; reconnect is scheduled there.
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = null;
      if (closed) return;
      closeReason = closeReasonFor(event.code);
      const backoff = backoffDelay(attempt, random);
      const delay = closeReason === null ? backoff : Math.max(POLICY_BACKOFF_MS, backoff);
      attempt++;
      options.onStatus({ status: 'reconnecting', attempt, retryAt: now() + delay, closeReason });
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    send(msg) {
      if (!socket || socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimers();
      const ws = socket;
      socket = null;
      ws?.close();
      options.onStatus({ status: 'closed', attempt, retryAt: null, closeReason: null });
    },
    reconnect() {
      if (!closed) return;
      closed = false;
      attempt = 0;
      closeReason = null;
      connect();
    },
  };
}

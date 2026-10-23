import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import {
  CONTROL_SERVER_MESSAGE_TYPES,
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  WS_PATH,
} from '@lionscope/protocol';
import type { ClientMessage, ServerMessage } from '@lionscope/protocol';
import { DEV_ORIGINS } from '../config.ts';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import type { EmulatorManager } from '../emulator/emulatorManager.ts';
import type { InspectLinks } from '../device/inspectLinks.ts';
import type { InspectorService } from '../inspector/inspectorService.ts';
import type { SessionManager } from '../session/sessionManager.ts';

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MAX_CLIENTS = 8;
/** Live samples are skipped for a client with more than this much unsent data… */
export const SLOW_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;
/** …and a client this far behind is disconnected. */
export const MAX_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
/** A client that skipped live data gets a fresh snapshot once it has drained below this. */
const RESYNC_BUFFERED_BYTES = 64 * 1024;
export const PING_INTERVAL_MS = 15_000;
/** Token bucket per connection: burst size and refill rate (messages per second). */
export const RATE_LIMIT_BURST = 20;
export const RATE_LIMIT_PER_SECOND = 20;

/** Host header must name a loopback host (any port) — defeats DNS rebinding. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** The dashboard's own origins on the bound port, plus the Vite dev server in dev mode. */
export function buildAllowedOrigins(port: number, dev: boolean): ReadonlySet<string> {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  return new Set(dev ? [...origins, ...DEV_ORIGINS] : origins);
}

/** Exact match of the serialized origin (scheme + host + port) against the allowlist. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/** Seconds a client turned away by the connection cap should wait before retrying. */
export const CLIENT_CAP_RETRY_AFTER_S = 30;

/** Answer the upgrade request with a plain HTTP error; the socket is never upgraded. */
export function rejectUpgrade(
  socket: Duplex,
  status: 400 | 403 | 404 | 503,
  reason: string,
  extraHeaders = '',
): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n${extraHeaders}Content-Length: 0\r\n\r\n`);
}

interface ClientState {
  alive: boolean;
  bucket: TokenBucket;
  /** Live data was skipped; the next live broadcast after draining sends a snapshot instead. */
  needsResync: boolean;
}

/** What the gateway needs from the emulator manager. */
export type GatewayEmulators = Pick<EmulatorManager, 'getEmulators' | 'refresh' | 'boot' | 'shutdown'>;

/** What the gateway needs from the session manager. */
export type GatewayManager = Pick<
  SessionManager,
  | 'getDevices'
  | 'getSessionState'
  | 'getSnapshot'
  | 'refreshDevices'
  | 'listApps'
  | 'startSession'
  | 'stopSession'
  | 'setSdkOptions'
>;

/** What the gateway needs from the Inspector. */
export type GatewayInspector = Pick<InspectorService, 'inspect' | 'select' | 'current' | 'selection'>;

/** What the gateway needs from the inspect-only SDK links. */
export type GatewayInspectLinks = Pick<InspectLinks, 'setFocus'>;

export interface WsGatewayOptions {
  server: Server;
  manager: GatewayManager;
  emulators: GatewayEmulators;
  inspector: GatewayInspector;
  /** Which device each client's Inspector shows (`inspectorFocus`); omitted = no inspect-only links. */
  inspectLinks?: GatewayInspectLinks;
  serverVersion: string;
  bufferWindowMs: number;
  /** Read on every upgrade, so it can reflect the port bound by listen(). */
  allowedOrigins: () => ReadonlySet<string>;
  pingIntervalMs?: number;
  /** Paths whose upgrades another listener on `server` answers (the screen socket). */
  delegatedPaths?: ReadonlySet<string>;
}

export interface WsGateway {
  /** `payload`, when given, is `message` already serialized (a large Inspector snapshot is serialized once). */
  broadcast(message: ServerMessage, payload?: string): void;
  close(): Promise<void>;
}

const PUBLIC_FAILURES: Readonly<Record<ClientMessage['type'], string>> = {
  refreshDevices: 'Could not list devices',
  bootEmulator: 'Could not boot the emulator',
  shutdownEmulator: 'Could not shut down the emulator',
  listApps: 'Could not list apps on the device',
  startSession: 'Could not start the profiling session',
  stopSession: 'Could not stop the profiling session',
  setSdkOptions: 'Could not change the SDK options',
  inspect: 'Could not inspect the screen',
  selectInspectorNode: 'Could not select the Inspector node',
  inspectorFocus: 'Could not focus the Inspector',
};
export const NO_SESSION_MESSAGE = 'No profiling session: start one before changing SDK options';

export function createWsGateway(options: WsGatewayOptions): WsGateway {
  const { server, manager, emulators, inspector } = options;
  const delegatedPaths = options.delegatedPaths ?? new Set<string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const clients = new Map<WebSocket, ClientState>();

  /** Send unless the client is hopelessly behind, in which case it is disconnected. */
  const deliver = (ws: WebSocket, payload: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      log.warn('Disconnecting a WebSocket client that is not reading its messages');
      ws.terminate();
      return;
    }
    ws.send(payload);
  };
  const send = (ws: WebSocket, message: ServerMessage): void => deliver(ws, JSON.stringify(message));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (delegatedPaths.has(pathname)) return;
    if (pathname !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin, options.allowedOrigins())) {
      log.warn(
        `Rejected WebSocket upgrade (host=${req.headers.host ?? '-'}, origin=${req.headers.origin ?? '-'})`,
      );
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (clients.size >= MAX_CLIENTS) {
      log.warn(`Rejected WebSocket upgrade: ${MAX_CLIENTS} clients already connected`);
      // Rejected before the upgrade so the browser's onopen never fires (and its backoff keeps growing).
      return rejectUpgrade(
        socket,
        503,
        'Service Unavailable',
        `Retry-After: ${CLIENT_CAP_RETRY_AFTER_S}\r\n`,
      );
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const handle = async (ws: WebSocket, message: ClientMessage): Promise<void> => {
    switch (message.type) {
      case 'refreshDevices': {
        const avds = emulators.refresh();
        // Awaited below; until then a rejection must not count as unhandled (e.g. when the device list fails).
        avds.catch(() => undefined);
        send(ws, { type: 'devices', devices: await manager.refreshDevices() });
        send(ws, { type: 'emulators', emulators: await avds });
        return;
      }
      case 'bootEmulator':
        // Answered by the `emulators` broadcasts that follow the boot.
        await emulators.boot(message.avdName, message.mode);
        return;
      case 'shutdownEmulator':
        await emulators.shutdown(message.avdName, message.confirmUnmanaged === true);
        return;
      case 'listApps':
        send(ws, { type: 'apps', serial: message.serial, apps: await manager.listApps(message.serial) });
        return;
      case 'startSession':
        await manager.startSession(message.serial, message.packageName);
        return;
      case 'stopSession':
        send(ws, { type: 'session', session: await manager.stopSession() });
        return;
      case 'setSdkOptions': {
        const { stallThresholdMs, strictMode, inflateTracking } = message;
        // Answered by the `session` broadcast that carries the new options.
        if (!manager.setSdkOptions({ stallThresholdMs, strictMode, inflateTracking })) {
          send(ws, { type: 'error', code: 'no_session', message: NO_SESSION_MESSAGE });
        }
        return;
      }
      case 'inspect':
        // Answered by the `inspection` broadcast (a failure by `inspect_failed` to this client).
        await inspector.inspect(message.serial);
        return;
      case 'selectInspectorNode':
        // Answered by the `inspectorSelection` broadcast (none when nothing changed).
        inspector.select(message.snapshotId, message.nodeId, 'user');
        return;
      case 'inspectorFocus':
        // Not answered: it only keeps (or stops keeping) an inspect-only SDK link to the device.
        options.inspectLinks?.setFocus(ws, message.serial);
        return;
    }
  };

  const onMessage = (ws: WebSocket, state: ClientState, data: RawData, isBinary: boolean): void => {
    if (!state.bucket.take()) {
      log.warn('Closing a WebSocket client that exceeded the message rate limit');
      ws.close(1008, 'rate limit exceeded');
      return;
    }
    if (isBinary) {
      send(ws, { type: 'error', code: 'bad_request', message: 'binary frames are not supported' });
      return;
    }
    const parsed = parseClientMessage(String(data));
    if (!parsed.ok) {
      send(ws, { type: 'error', code: 'bad_request', message: parsed.error });
      return;
    }
    const { type } = parsed.value;
    handle(ws, parsed.value).catch((error: unknown) => {
      if (!(error instanceof PublicError)) log.warn(`${type} failed: ${errorMessage(error)}`);
      const message = error instanceof PublicError ? error.message : PUBLIC_FAILURES[type];
      send(ws, { type: 'error', code: `${type}_failed`, message });
    });
  };

  wss.on('connection', (ws: WebSocket) => {
    const state: ClientState = {
      alive: true,
      bucket: new TokenBucket(RATE_LIMIT_BURST, RATE_LIMIT_PER_SECOND),
      needsResync: false,
    };
    clients.set(ws, state);
    ws.on('close', () => {
      clients.delete(ws);
      options.inspectLinks?.setFocus(ws, null);
    });
    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('error', (error) => log.warn('WebSocket error:', error.message));
    ws.on('message', (data: RawData, isBinary: boolean) => onMessage(ws, state, data, isBinary));

    send(ws, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: options.serverVersion,
      bufferWindowMs: options.bufferWindowMs,
    });
    send(ws, { type: 'devices', devices: manager.getDevices() });
    send(ws, { type: 'emulators', emulators: emulators.getEmulators() });
    send(ws, { type: 'session', session: manager.getSessionState() });
    send(ws, { type: 'snapshot', snapshot: manager.getSnapshot() });
    const inspection = inspector.current;
    if (inspection) send(ws, { type: 'inspection', snapshot: inspection });
    send(ws, { type: 'inspectorSelection', selection: inspector.selection });
  });

  const pingTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, options.pingIntervalMs ?? PING_INTERVAL_MS);
  pingTimer.unref();

  return {
    broadcast(message, serialized) {
      const payload = serialized ?? JSON.stringify(message);
      // Everything that isn't control traffic is a droppable stream, resynced by a snapshot.
      const live = !CONTROL_SERVER_MESSAGE_TYPES.has(message.type);
      for (const [ws, state] of clients) {
        if (live && state.needsResync && ws.bufferedAmount <= RESYNC_BUFFERED_BYTES) {
          // The snapshot already contains this sample (buffers are written before broadcasting).
          state.needsResync = false;
          send(ws, { type: 'snapshot', snapshot: manager.getSnapshot() });
          continue;
        }
        if (live && ws.bufferedAmount > SLOW_CLIENT_BUFFERED_BYTES) {
          state.needsResync = true;
          continue;
        }
        if (live && state.needsResync) continue;
        deliver(ws, payload);
      }
    },
    close() {
      clearInterval(pingTimer);
      for (const ws of clients.keys()) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

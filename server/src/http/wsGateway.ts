import type { Permissions } from '@lionscope/protocol';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import {
  CONTROL_SERVER_MESSAGE_TYPES,
  MAX_CLIENT_FRAME_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  WS_PATH,
} from '@lionscope/protocol';
import type {
  ClientMessage,
  ServerMessage,
  StorageResponse,
  WirelessActionResult,
} from '@lionscope/protocol';
import { scrubSecret } from '../adb/adb.ts';
import { DEV_ORIGINS } from '../config.ts';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import type { EmulatorManager } from '../emulator/emulatorManager.ts';
import type { InspectLinks } from '../device/inspectLinks.ts';
import type { WirelessService } from '../device/wirelessService.ts';
import type { InspectorService } from '../inspector/inspectorService.ts';
import type { LocationService } from '../location/locationService.ts';
import type { ViewEditOutcome, ViewEdits } from '../inspector/viewEdits.ts';
import type { SessionManager } from '../session/sessionManager.ts';
import { STORAGE_MESSAGES } from '../storage/storageService.ts';
import type { StorageService } from '../storage/storageService.ts';

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
  | 'getHttpExchange'
  | 'getNetworkMocks'
  | 'setNetworkMock'
  | 'clearNetworkMocks'
>;

/** What the gateway needs from the Inspector. */
export type GatewayInspector = Pick<InspectorService, 'inspect' | 'select' | 'current' | 'selection'>;

/** What the gateway needs from the inspect-only SDK links. */
export type GatewayInspectLinks = Pick<InspectLinks, 'setFocus'>;

/** What the gateway needs from the live view edits. */
export type GatewayViewEdits = Pick<ViewEdits, 'set' | 'revert'>;

/** What the gateway needs from the storage inspector. */
export type GatewayStorage = Pick<
  StorageService,
  'consent' | 'list' | 'read' | 'write' | 'query' | 'auditResponse'
>;

/** What the gateway needs from the device locations. */
export type GatewayLocations = Pick<LocationService, 'getLocations' | 'setLocation' | 'clearLocation'>;

/** What the gateway needs from the wireless ADB service. */
export type GatewayWireless = Pick<
  WirelessService,
  | 'connect'
  | 'disconnect'
  | 'pair'
  | 'enableTcpipHandoff'
  | 'listMdnsConnectDevices'
  | 'startQrPairing'
  | 'cancelQrPairing'
  | 'cancelQrForOwner'
  | 'cancelPendingPublicTcpipForOwner'
>;

export interface WsGatewayOptions {
  permissions?: () => Readonly<Permissions>;
  server: Server;
  manager: GatewayManager;
  emulators: GatewayEmulators;
  inspector: GatewayInspector;
  /** Which device each client's Inspector shows (`inspectorFocus`); omitted = no inspect-only links. */
  inspectLinks?: GatewayInspectLinks;
  /** Live view edits (`setViewProperty` / `revertViewProperties`); omitted = they are refused. */
  viewEdits?: GatewayViewEdits;
  /** Device locations (`setLocation` / `clearLocation`); omitted = they are refused. */
  locations?: GatewayLocations;
  /** The storage inspector (`storageList` / `storageRead` / `storageWrite`); omitted = consent `off`. */
  storage?: GatewayStorage;
  /** Wireless ADB actions (`connectDevice` / `disconnectDevice`); omitted = they are refused. */
  wireless?: GatewayWireless;
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
  getHttpExchange: 'Could not read the HTTP exchange',
  setNetworkMock: 'Could not set the mock rule',
  clearNetworkMocks: 'Could not remove the mock rules',
  setViewProperty: 'Could not edit the view',
  revertViewProperties: 'Could not revert the edits',
  setLocation: 'Could not change the location',
  clearLocation: 'Could not reset the location',
  storageList: 'Could not list the app storage',
  storageRead: 'Could not read the app storage',
  storageWrite: 'Could not change the app storage',
  storageQuery: 'Could not run the SQL query',
  storageAudit: 'Could not read the storage audit',
  connectDevice: 'Could not connect to the wireless device',
  disconnectDevice: 'Could not disconnect the wireless device',
  pairDevice: 'Could not pair with the wireless device',
  listMdnsServices: 'Could not list discovered wireless devices',
  startQrPairing: 'Could not start QR pairing',
  cancelQrPairing: 'Could not cancel QR pairing',
  enableWirelessTcpip: 'Could not switch the USB device to Wi-Fi',
};

/** The `viewEdit` answer to one client's edit or revert. */
function viewEditMessage(requestId: number, outcome: ViewEditOutcome): ServerMessage {
  if (outcome.ok) return { type: 'viewEdit', requestId, ok: true, liveEdits: outcome.liveEdits };
  const { error, message, liveEdits } = outcome;
  return {
    type: 'viewEdit',
    requestId,
    ok: false,
    error,
    message,
    ...(liveEdits === undefined ? {} : { liveEdits }),
  };
}
export const NO_SESSION_MESSAGE = 'No profiling session: start one before changing SDK options';
export const NO_LOCATIONS_MESSAGE = 'This server cannot change device locations';

export function createWsGateway(options: WsGatewayOptions): WsGateway {
  const { server, manager, emulators, inspector } = options;
  const delegatedPaths = options.delegatedPaths ?? new Set<string>();
  // The larger cap is for `setNetworkMock` only: parseClientMessage holds every other type to 4 KB.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });
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

  /** Every edit gets its `viewEdit` answer, also when it threw (the dashboard waits for it). */
  const answerEdit = async (
    ws: WebSocket,
    requestId: number,
    edit: (edits: GatewayViewEdits) => Promise<ViewEditOutcome>,
  ): Promise<void> => {
    const edits = options.viewEdits;
    let outcome: ViewEditOutcome;
    try {
      outcome = edits
        ? await edit(edits)
        : { ok: false, error: 'failed', message: 'This server cannot edit views live.' };
    } catch (error) {
      log.warn(`Live view edit failed: ${errorMessage(error)}`);
      outcome = { ok: false, error: 'failed', message: 'The edit failed on the server.' };
    }
    send(ws, viewEditMessage(requestId, outcome));
  };

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
        const { stallThresholdMs, strictMode, inflateTracking, rxTracking, savedStateTracking } = message;
        // Answered by the `session` broadcast that carries the new options.
        if (
          !manager.setSdkOptions({
            stallThresholdMs,
            strictMode,
            inflateTracking,
            rxTracking,
            savedStateTracking,
          })
        ) {
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
      case 'getHttpExchange':
        send(ws, { type: 'httpExchange', id: message.id, exchange: manager.getHttpExchange(message.id) });
        return;
      case 'setNetworkMock':
        // Answered by the `networkMocks` broadcast (a refusal by `setNetworkMock_failed` to this client).
        manager.setNetworkMock(message.rule, 'user');
        return;
      case 'clearNetworkMocks':
        // Answered by the `networkMocks` broadcast; an unknown id (or no session) changes nothing.
        manager.clearNetworkMocks(message.id);
        return;
      case 'setViewProperty': {
        const { requestId, snapshotId, nodeId, property, value } = message;
        // Answered with `viewEdit` to this client; a change is then shown by the `inspection` that follows.
        await answerEdit(ws, requestId, (edits) => edits.set({ snapshotId, nodeId, property, value }));
        return;
      }
      case 'revertViewProperties': {
        const { requestId, snapshotId, nodeId, property } = message;
        await answerEdit(ws, requestId, (edits) => edits.revert({ snapshotId, nodeId, property }));
        return;
      }
      case 'setLocation': {
        // Answered by the `locations` broadcast (a refusal by `setLocation_failed` to this client).
        if (!options.locations) throw new PublicError(NO_LOCATIONS_MESSAGE);
        const { serial, latitude, longitude } = message;
        await options.locations.setLocation(serial, { latitude, longitude });
        return;
      }
      case 'clearLocation':
        // Answered by the `locations` broadcast (none when no location was set there).
        if (!options.locations) throw new PublicError(NO_LOCATIONS_MESSAGE);
        await options.locations.clearLocation(message.serial);
        return;
      case 'storageList':
      case 'storageRead':
      case 'storageWrite':
      case 'storageQuery':
      case 'storageAudit': {
        // Answered with `storage` to this client; refusals (consent off first) come the same way.
        const storage = options.storage;
        const response: StorageResponse = !storage
          ? { ok: false, code: 'consent_required', message: STORAGE_MESSAGES.consent_required! }
          : message.type === 'storageList'
            ? await storage.list()
            : message.type === 'storageRead'
              ? await storage.read(message.read)
              : message.type === 'storageAudit'
                ? storage.auditResponse()
                : message.type === 'storageQuery'
                  ? await storage.query(message.query)
                  : await storage.write(message.write);
        send(ws, { type: 'storage', requestId: message.requestId, response });
        return;
      }
      case 'connectDevice':
      case 'disconnectDevice':
      case 'pairDevice': {
        const action =
          message.type === 'connectDevice'
            ? 'connect'
            : message.type === 'disconnectDevice'
              ? 'disconnect'
              : 'pair';
        const wireless = options.wireless;
        let result: WirelessActionResult;
        if (!wireless) {
          result = { action, ok: false, message: 'Wireless ADB is not available on this server' };
        } else {
          try {
            if (message.type === 'connectDevice') {
              const connected = await wireless.connect(message.address, 'dashboard');
              result = { action: 'connect', ok: true, ...connected };
            } else if (message.type === 'disconnectDevice') {
              const disconnected = await wireless.disconnect(message.serial, 'dashboard');
              result = { action: 'disconnect', ok: true, ...disconnected };
            } else {
              const paired = await wireless.pair(message.address, message.code, 'dashboard', {
                ...(message.connectAddress !== undefined ? { connectAddress: message.connectAddress } : {}),
              });
              result = { action: 'pair', ok: true, ...paired };
            }
          } catch (error) {
            const secret = message.type === 'pairDevice' ? message.code : '';
            const safeDetail = scrubSecret(errorMessage(error), secret);
            if (!(error instanceof PublicError)) log.warn(`${message.type} failed: ${safeDetail}`);
            result = {
              action,
              ok: false,
              message: error instanceof PublicError ? safeDetail : PUBLIC_FAILURES[message.type],
            };
          }
        }
        send(ws, { type: 'wirelessResult', requestId: message.requestId, result });
        return;
      }
      case 'listMdnsServices': {
        const wireless = options.wireless;
        let result: WirelessActionResult;
        if (!wireless) {
          result = { action: 'mdns', ok: false, message: 'Wireless ADB is not available on this server' };
        } else {
          try {
            result = { action: 'mdns', ok: true, services: await wireless.listMdnsConnectDevices() };
          } catch (error) {
            if (!(error instanceof PublicError)) log.warn(`listMdnsServices failed: ${errorMessage(error)}`);
            result = {
              action: 'mdns',
              ok: false,
              message: error instanceof PublicError ? error.message : PUBLIC_FAILURES.listMdnsServices,
            };
          }
        }
        send(ws, { type: 'wirelessResult', requestId: message.requestId, result });
        return;
      }
      case 'startQrPairing': {
        const wireless = options.wireless;
        let result: WirelessActionResult;
        if (!wireless) {
          result = { action: 'startQr', ok: false, message: 'Wireless ADB is not available on this server' };
        } else {
          try {
            const started = wireless.startQrPairing(ws, (update) => {
              send(ws, { type: 'qrPairing', update });
            });
            result = { action: 'startQr', ok: true, ...started };
          } catch (error) {
            if (!(error instanceof PublicError)) log.warn(`startQrPairing failed: ${errorMessage(error)}`);
            result = {
              action: 'startQr',
              ok: false,
              message: error instanceof PublicError ? error.message : PUBLIC_FAILURES.startQrPairing,
            };
          }
        }
        send(ws, { type: 'wirelessResult', requestId: message.requestId, result });
        return;
      }
      case 'cancelQrPairing':
        options.wireless?.cancelQrPairing(message.sessionId);
        return;
      case 'enableWirelessTcpip': {
        const wireless = options.wireless;
        let result: WirelessActionResult;
        if (!wireless) {
          result = { action: 'tcpip', ok: false, message: 'Wireless ADB is not available on this server' };
        } else {
          try {
            const handedOff = await wireless.enableTcpipHandoff(message.serial, 'dashboard', {
              owner: ws,
              isOwnerAlive: () => clients.has(ws) && ws.readyState === WebSocket.OPEN,
              ...(message.port !== undefined ? { port: message.port } : {}),
              ...(message.confirmPublic !== undefined ? { confirmPublic: message.confirmPublic } : {}),
            });
            if (handedOff.status === 'confirm_public') {
              result = {
                action: 'tcpip',
                ok: false,
                needsPublicConfirmation: true,
                confirmationId: handedOff.confirmationId,
                usbSerial: handedOff.usbSerial,
                host: handedOff.host,
                port: handedOff.port,
                target: handedOff.target,
                message: handedOff.message,
              };
            } else {
              result = {
                action: 'tcpip',
                ok: true,
                usbSerial: handedOff.usbSerial,
                serial: handedOff.serial,
                target: handedOff.target,
                port: handedOff.port,
                alreadyConnected: handedOff.alreadyConnected,
              };
            }
          } catch (error) {
            if (!(error instanceof PublicError))
              log.warn(`enableWirelessTcpip failed: ${errorMessage(error)}`);
            result = {
              action: 'tcpip',
              ok: false,
              message: error instanceof PublicError ? error.message : PUBLIC_FAILURES.enableWirelessTcpip,
            };
          }
        }
        send(ws, { type: 'wirelessResult', requestId: message.requestId, result });
        return;
      }
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
      options.wireless?.cancelQrForOwner(ws);
      options.wireless?.cancelPendingPublicTcpipForOwner(ws);
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
      storageConsent: options.storage?.consent ?? 'off',
      ...(options.permissions ? { permissions: options.permissions() } : {}),
    });
    send(ws, { type: 'devices', devices: manager.getDevices() });
    send(ws, { type: 'emulators', emulators: emulators.getEmulators() });
    send(ws, { type: 'session', session: manager.getSessionState() });
    send(ws, { type: 'snapshot', snapshot: manager.getSnapshot() });
    send(ws, { type: 'networkMocks', mocks: manager.getNetworkMocks() });
    const inspection = inspector.current;
    if (inspection) send(ws, { type: 'inspection', snapshot: inspection });
    send(ws, { type: 'inspectorSelection', selection: inspector.selection });
    send(ws, { type: 'locations', locations: options.locations?.getLocations() ?? [] });
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

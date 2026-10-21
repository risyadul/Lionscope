import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import {
  DEFAULT_SCREEN_SIZE,
  isValidSerial,
  MAX_SCREEN_CLIENT_MESSAGE_BYTES,
  MAX_SCREEN_INPUT_PER_SECOND,
  parseScreenClientMessage,
  SCREEN_SIZES,
  SCREEN_WS_PATH,
} from '@lionscope/protocol';
import type { ScreenServerMessage, ScreenSize } from '@lionscope/protocol';
import { isAllowedHost, isAllowedOrigin, PING_INTERVAL_MS, rejectUpgrade } from '../http/wsGateway.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import type { EmulatorClientFactory } from './emulatorClient.ts';
import type { EmulatorManager } from './emulatorManager.ts';
import { ENDED_MESSAGE, ScreenSession } from './screenSession.ts';

/** Concurrent screen sockets (each one is a PNG stream from an emulator). */
export const MAX_SCREEN_SOCKETS = 4;
/**
 * Input over MAX_SCREEN_INPUT_PER_SECOND is dropped; a client this many times over it (invalid messages count
 * too) is disconnected.
 */
export const SCREEN_ABUSE_FACTOR = 3;
/** `rotate` and `setSize` per second (each restarts the screen stream). */
export const SCREEN_CONTROLS_PER_SECOND = 2;

export interface ScreenGatewayOptions {
  server: Server;
  emulators: Pick<EmulatorManager, 'mirrorTarget' | 'onChange'>;
  /** null: no usable proto, every socket gets `unavailable`. */
  createClient: EmulatorClientFactory | null;
  /** The same allowlist as the main socket. */
  allowedOrigins: () => ReadonlySet<string>;
  pingIntervalMs?: number;
}

export interface ScreenGateway {
  close(): Promise<void>;
}

interface ScreenSocketState {
  session: ScreenSession;
  alive: boolean;
}

function sizeOf(raw: string | null): ScreenSize | null {
  if (raw === null) return DEFAULT_SCREEN_SIZE;
  return SCREEN_SIZES.find((size) => String(size) === raw) ?? null;
}

function sendError(
  ws: WebSocket,
  code: Extract<ScreenServerMessage, { type: 'screenError' }>['code'],
  message: string,
): void {
  ws.send(JSON.stringify({ type: 'screenError', code, message } satisfies ScreenServerMessage));
  ws.close(1000, code);
}

/** `/ws/screen?serial=…&size=…`: mirrors one running emulator per socket. */
export function createScreenGateway(options: ScreenGatewayOptions): ScreenGateway {
  const { server, emulators } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SCREEN_CLIENT_MESSAGE_BYTES });
  const sockets = new Map<WebSocket, ScreenSocketState>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return; // The main gateway answers malformed requests.
    }
    if (url.pathname !== SCREEN_WS_PATH) return;
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin, options.allowedOrigins())) {
      log.warn(
        `Rejected screen socket upgrade (host=${req.headers.host ?? '-'}, origin=${req.headers.origin ?? '-'})`,
      );
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const size = sizeOf(url.searchParams.get('size'));
    if (size === null) return rejectUpgrade(socket, 400, 'Bad Request');
    const serial = url.searchParams.get('serial') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, serial, size));
  });

  const onConnection = (ws: WebSocket, serial: string, size: ScreenSize): void => {
    ws.on('error', (error) => log.warn('Screen socket error:', error.message));
    if (sockets.size >= MAX_SCREEN_SOCKETS) {
      return sendError(ws, 'busy', `At most ${MAX_SCREEN_SOCKETS} screens can be mirrored at once`);
    }
    if (!isValidSerial(serial)) return sendError(ws, 'not_emulator', 'invalid adb serial');
    const target = emulators.mirrorTarget(serial);
    if (!target.ok) return sendError(ws, target.code, target.message);
    if (!options.createClient) return sendError(ws, 'unavailable', 'Emulator mirroring is not available');

    const session = new ScreenSession(ws, options.createClient(target.endpoint), serial, size);
    const state: ScreenSocketState = { session, alive: true };
    sockets.set(ws, state);
    const input = new TokenBucket(MAX_SCREEN_INPUT_PER_SECOND, MAX_SCREEN_INPUT_PER_SECOND);
    const abuse = new TokenBucket(
      MAX_SCREEN_INPUT_PER_SECOND * SCREEN_ABUSE_FACTOR,
      MAX_SCREEN_INPUT_PER_SECOND * SCREEN_ABUSE_FACTOR,
    );
    const controls = new TokenBucket(SCREEN_CONTROLS_PER_SECOND, SCREEN_CONTROLS_PER_SECOND);
    let invalidReported = false;
    ws.on('close', () => {
      sockets.delete(ws);
      session.close();
    });
    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!abuse.take()) {
        log.warn('Closing a screen socket that exceeded the input rate limit');
        ws.close(1008, 'rate limit exceeded');
        return;
      }
      const parsed = isBinary ? null : parseScreenClientMessage(String(data));
      if (!parsed?.ok) {
        if (!invalidReported) log.warn(`Ignoring invalid screen input: ${parsed?.error ?? 'binary message'}`);
        invalidReported = true;
        return;
      }
      const { type } = parsed.value;
      // Rotation and size changes restart the stream: they get their own, slower budget.
      const bucket = type === 'rotate' || type === 'setSize' ? controls : input;
      if (bucket.take()) session.handle(parsed.value);
    });
    session.start().catch((error: unknown) => log.warn(`Screen of ${serial} failed: ${errorMessage(error)}`));
  };

  // A screen whose emulator stopped (or lost its endpoint) ends even if its stream never noticed.
  const unsubscribe = emulators.onChange(() => {
    for (const { session } of sockets.values()) {
      if (!session.isClosed && !emulators.mirrorTarget(session.serial).ok)
        session.fail('ended', ENDED_MESSAGE);
    }
  });

  const pingTimer = setInterval(() => {
    for (const [ws, state] of sockets) {
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
    close() {
      clearInterval(pingTimer);
      unsubscribe();
      for (const [ws, state] of sockets) {
        state.session.close();
        ws.terminate();
      }
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

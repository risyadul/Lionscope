import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import {
  DEFAULT_SCREEN_SIZE,
  isValidSerial,
  MAX_SCREEN_SOCKET_FRAME_BYTES,
  MAX_SCREEN_INPUT_PER_SECOND,
  parseScreenClientMessage,
  SCREEN_SIZES,
  SCREEN_WS_PATH,
} from '@lionscope/protocol';
import type {
  DeviceInfo,
  ScreenClientMessage,
  ScreenErrorCode,
  ScreenServerMessage,
  ScreenSize,
} from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { isAllowedHost, isAllowedOrigin, PING_INTERVAL_MS, rejectUpgrade } from '../http/wsGateway.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import type { EmulatorClientFactory } from './emulatorClient.ts';
import { DeviceScreenSession } from '../scrcpy/deviceScreenSession.ts';
import { resolveScrcpyJar } from '../scrcpy/scrcpyServer.ts';
import type { EmulatorManager, MirrorTarget } from './emulatorManager.ts';
import { ENDED_MESSAGE, ScreenSession } from './screenSession.ts';

/** Concurrent screen sockets (each one a PNG stream from an emulator or an H.264 stream from a device). */
export const MAX_SCREEN_SOCKETS = 4;
/**
 * Input over MAX_SCREEN_INPUT_PER_SECOND is dropped; a client this many times over it (invalid messages count
 * too) is disconnected.
 */
export const SCREEN_ABUSE_FACTOR = 3;
/** `rotate` and `setSize` per second (each restarts the screen stream). */
export const SCREEN_CONTROLS_PER_SECOND = 2;
/** `clipboardSync`, `clipboard` and `paste` per second. */
export const SCREEN_CLIPBOARD_PER_SECOND = 5;
export const SCREEN_INPUT_FAILED_MESSAGE = 'The screen stream stopped after an internal error';
/** `keyFrame` requests per second (each restarts a physical device's capture). */
export const SCREEN_KEY_FRAMES_PER_SECOND = 3;

/** Physical devices, mirrored through scrcpy-server. */
export interface DeviceMirroringOptions {
  adb: Adb;
  /** The last adb device listing. */
  devices: () => readonly DeviceInfo[];
  /** A device's mirror came up (true) or went down (false): the session's mirroring spans. */
  onMirroring?: (serial: string, open: boolean) => void;
  /** Defaults to the vendored scrcpy-server (resolveScrcpyJar). */
  jarPath?: string;
}

export interface ScreenGatewayOptions {
  server: Server;
  emulators: Pick<EmulatorManager, 'mirrorTarget' | 'onChange'>;
  /** null: no usable proto, every emulator socket gets `unavailable`. */
  createClient: EmulatorClientFactory | null;
  /** Omitted: physical devices are refused (`not_emulator`). */
  devices?: DeviceMirroringOptions;
  /** The same allowlist as the main socket. */
  allowedOrigins: () => ReadonlySet<string>;
  pingIntervalMs?: number;
}

export interface ScreenGateway {
  close(): Promise<void>;
}

/** What the gateway needs of a screen session, emulator (ScreenSession) or device (DeviceScreenSession). */
interface MirrorSession {
  readonly serial: string;
  readonly isClosed: boolean;
  start(): Promise<void>;
  handle(message: ScreenClientMessage): void;
  fail(code: ScreenErrorCode, message: string): void;
  close(): void | Promise<void>;
}

interface ScreenSocketState {
  session: MirrorSession;
  /** Emulator screens end when the emulator stops; device screens end with their scrcpy streams. */
  isEmulator: boolean;
  alive: boolean;
}

/** adb serials of emulators: never mirrored through scrcpy, even before the emulator manager knows them. */
const EMULATOR_SERIAL = /^emulator-\d+$/;

export function isEmulatorSerial(serial: string): boolean {
  return EMULATOR_SERIAL.test(serial);
}

export type ScreenBackend<D> =
  | { kind: 'emulator'; target: Extract<MirrorTarget, { ok: true }> }
  | { kind: 'device'; mirroring: D }
  | { kind: 'refused'; code: ScreenErrorCode; message: string };

/**
 * An emulator with a gRPC endpoint is mirrored over gRPC; any other adb device in the `device` state through
 * scrcpy (when `devices` is given). Everything else is refused: emulators keep their own reasons, other serials
 * get `not_emulator` (not connected, offline, unauthorized).
 */
export function chooseScreenBackend<D extends Pick<DeviceMirroringOptions, 'devices'>>(
  serial: string,
  target: MirrorTarget,
  mirroring: D | undefined,
): ScreenBackend<D> {
  if (target.ok) return { kind: 'emulator', target };
  if (isEmulatorSerial(serial) || target.code !== 'not_emulator' || !mirroring) {
    return { kind: 'refused', code: target.code, message: target.message };
  }
  const device = mirroring.devices().find((candidate) => candidate.serial === serial);
  if (!device) return { kind: 'refused', code: 'not_emulator', message: `${serial} is not connected` };
  if (device.state !== 'device') {
    return { kind: 'refused', code: 'not_emulator', message: `${serial} is ${device.state}` };
  }
  return { kind: 'device', mirroring };
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

/** `/ws/screen?serial=…&size=…`: mirrors one running emulator or physical device per socket. */
export function createScreenGateway(options: ScreenGatewayOptions): ScreenGateway {
  const { server, emulators } = options;
  const jarPath = options.devices?.jarPath ?? resolveScrcpyJar();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SCREEN_SOCKET_FRAME_BYTES });
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
    const backend = chooseScreenBackend(serial, emulators.mirrorTarget(serial), options.devices);
    if (backend.kind === 'refused') return sendError(ws, backend.code, backend.message);
    let session: MirrorSession;
    if (backend.kind === 'emulator') {
      if (!options.createClient) return sendError(ws, 'unavailable', 'Emulator mirroring is not available');
      session = new ScreenSession(ws, options.createClient(backend.target.endpoint), serial, size);
    } else {
      const { adb, onMirroring } = backend.mirroring;
      session = new DeviceScreenSession({
        socket: ws,
        adb,
        serial,
        size,
        jarPath,
        onMirroring: (open) => onMirroring?.(serial, open),
      });
    }
    const state: ScreenSocketState = { session, alive: true, isEmulator: backend.kind === 'emulator' };
    sockets.set(ws, state);
    const input = new TokenBucket(MAX_SCREEN_INPUT_PER_SECOND, MAX_SCREEN_INPUT_PER_SECOND);
    const abuse = new TokenBucket(
      MAX_SCREEN_INPUT_PER_SECOND * SCREEN_ABUSE_FACTOR,
      MAX_SCREEN_INPUT_PER_SECOND * SCREEN_ABUSE_FACTOR,
    );
    const controls = new TokenBucket(SCREEN_CONTROLS_PER_SECOND, SCREEN_CONTROLS_PER_SECOND);
    const clipboard = new TokenBucket(SCREEN_CLIPBOARD_PER_SECOND, SCREEN_CLIPBOARD_PER_SECOND);
    const keyFrames = new TokenBucket(SCREEN_KEY_FRAMES_PER_SECOND, SCREEN_KEY_FRAMES_PER_SECOND);
    let invalidReported = false;
    ws.on('close', () => {
      sockets.delete(ws);
      void session.close();
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
      // Rotation and size changes restart the stream, clipboard messages carry up to 32 KB: each kind has its
      // own, slower budget.
      const bucket =
        type === 'rotate' || type === 'setSize'
          ? controls
          : type === 'clipboard' || type === 'paste' || type === 'clipboardSync'
            ? clipboard
            : type === 'keyFrame'
              ? keyFrames
              : input;
      if (!bucket.take()) return;
      // One bad message must never take the server down: the socket fails instead.
      try {
        session.handle(parsed.value);
      } catch (error) {
        log.warn(`Screen input for ${serial} failed: ${errorMessage(error)}`);
        session.fail('ended', SCREEN_INPUT_FAILED_MESSAGE);
      }
    });
    session.start().catch((error: unknown) => log.warn(`Screen of ${serial} failed: ${errorMessage(error)}`));
  };

  // A screen whose emulator stopped (or lost its endpoint) ends even if its stream never noticed.
  const unsubscribe = emulators.onChange(() => {
    for (const { session, isEmulator } of sockets.values()) {
      if (isEmulator && !session.isClosed && !emulators.mirrorTarget(session.serial).ok)
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
    async close() {
      clearInterval(pingTimer);
      unsubscribe();
      const closing: (void | Promise<void>)[] = [];
      for (const [ws, state] of sockets) {
        closing.push(state.session.close());
        ws.terminate();
      }
      // Device screens resolve once their scrcpy server is gone from the device.
      await Promise.all(closing);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

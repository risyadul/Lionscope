/**
 * Screen mirror WebSocket (`SCREEN_WS_PATH`): binary PNG frames (emulators) or H.264 access units (physical
 * devices) in, JSON input out, reconnect with backoff.
 */
import type {
  ScreenClientMessage,
  ScreenErrorCode,
  ScreenFpsCap,
  ScreenServerMessage,
  ScreenSize,
} from '@lionscope/protocol/wire';
import {
  MAX_SCREEN_CLIENT_MESSAGE_BYTES,
  MAX_SCREEN_SOCKET_FRAME_BYTES,
  SCREEN_BINARY_KIND,
  SCREEN_VIDEO_FLAG,
  SCREEN_VIDEO_HEADER_BYTES,
  SCREEN_WS_PATH,
} from '@lionscope/protocol/wire';
import { backoffDelay, type SocketLike } from './connection.ts';
import type { VideoPacket } from './videoDecoder.ts';

export function screenUrl(
  location: Pick<Location, 'protocol' | 'host'>,
  serial: string,
  size: ScreenSize,
  fpsCap?: ScreenFpsCap,
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = new URLSearchParams({ serial, size: String(size) });
  if (fpsCap !== undefined) query.set('fps', String(fpsCap));
  return `${scheme}://${location.host}${SCREEN_WS_PATH}?${query.toString()}`;
}

export type ScreenBinaryKind = keyof typeof SCREEN_BINARY_KIND;

export type ScreenBinary =
  { kind: 'frame' | 'screenshot'; png: Blob } | { kind: 'video'; packet: VideoPacket };

function parseVideo(data: ArrayBuffer): VideoPacket | null {
  if (data.byteLength <= SCREEN_VIDEO_HEADER_BYTES) return null;
  const view = new DataView(data);
  const flags = view.getUint8(1);
  const pts = view.getFloat64(2, false);
  if (!Number.isFinite(pts) || pts < 0) return null;
  return {
    isConfig: (flags & SCREEN_VIDEO_FLAG.config) !== 0,
    isKey: (flags & SCREEN_VIDEO_FLAG.key) !== 0,
    pts,
    data: new Uint8Array(data, SCREEN_VIDEO_HEADER_BYTES),
  };
}

/**
 * One kind byte, then a PNG, or for `video` a flags byte, the PTS (µs, big-endian float64) and the Annex B
 * payload. Unknown kinds and empty payloads are dropped.
 */
export function parseScreenBinary(data: ArrayBuffer): ScreenBinary | null {
  if (data.byteLength < 2) return null;
  const kindByte = new Uint8Array(data, 0, 1)[0];
  const kind = (Object.keys(SCREEN_BINARY_KIND) as ScreenBinaryKind[]).find(
    (k) => SCREEN_BINARY_KIND[k] === kindByte,
  );
  if (kind === undefined) return null;
  if (kind === 'video') {
    const packet = parseVideo(data);
    return packet === null ? null : { kind, packet };
  }
  return { kind, png: new Blob([new Uint8Array(data, 1)], { type: 'image/png' }) };
}

export function parseScreenMessage(raw: unknown): ScreenServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type: unknown = (parsed as { type?: unknown }).type;
  if (type === 'clipboard') {
    return typeof (parsed as { text?: unknown }).text === 'string' ? (parsed as ScreenServerMessage) : null;
  }
  return type === 'screenInfo' || type === 'screenError' ? (parsed as ScreenServerMessage) : null;
}

/** Retrying can't fix these: the panel shows the reason and stops reconnecting. */
export const PERMANENT_SCREEN_ERRORS: ReadonlySet<ScreenErrorCode> = new Set([
  'not_emulator',
  'mirror_failed',
  'unavailable',
  'auth',
]);

export type ScreenStatus = 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface ScreenError {
  code: ScreenErrorCode;
  message: string;
}

export interface ScreenConnectionState {
  status: ScreenStatus;
  /** Consecutive attempts without a frame. */
  attempt: number;
  /** The last error the server reported; kept while reconnecting so the panel can say why. */
  error: ScreenError | null;
}

export type ScreenInfo = Extract<ScreenServerMessage, { type: 'screenInfo' }>;

export interface ScreenSocketLike extends SocketLike {
  binaryType: BinaryType;
}

export interface ScreenConnectionOptions {
  /** Read on every (re)connect, so a size or fps cap picked meanwhile is used. */
  url: () => string;
  onBinary: (msg: ScreenBinary) => void;
  onInfo: (info: ScreenInfo) => void;
  onState: (state: ScreenConnectionState) => void;
  /** Every time a socket opens (the server's per-socket settings, like `clipboardSync`, start over). */
  onOpen?: () => void;
  /** Text copied inside Android (only sent while `clipboardSync` is on). */
  onClipboard?: (text: string) => void;
  /** The device refuses input (`input_denied`); the video keeps streaming. */
  onInputDenied?: (message: string) => void;
  createSocket?: (url: string) => ScreenSocketLike;
  random?: () => number;
}

export interface ScreenConnection {
  /**
   * Sends when open; returns false (dropped) otherwise or when the message is over the size limit. A
   * `setSize` or `setFpsCap` sent before the socket opens is held (the newest of each) and sent on open; a
   * reconnect takes them from `url`.
   */
  send(msg: ScreenClientMessage): boolean;
  /** The first picture of this socket is on screen (decoded video); a no-op once live. */
  markLive(): void;
  close(): void;
}

const OPEN = 1;
const encoder = new TextEncoder();

/** Stream settings: held until the socket opens (the URL it was opened with may predate them). */
type HeldSetting = Extract<ScreenClientMessage, { type: 'setSize' | 'setFpsCap' }>;

function isHeldSetting(msg: ScreenClientMessage): msg is HeldSetting {
  return msg.type === 'setSize' || msg.type === 'setFpsCap';
}

export function createScreenConnection(options: ScreenConnectionOptions): ScreenConnection {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  let socket: ScreenSocketLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let error: ScreenError | null = null;
  let isLive = false;
  let isClosed = false;
  let isFailed = false;
  const held = new Map<HeldSetting['type'], HeldSetting>();

  const report = (status: ScreenStatus) => options.onState({ status, attempt, error });

  const markLive = () => {
    if (isLive) return;
    isLive = true;
    attempt = 0;
    error = null;
    report('live');
  };

  const connect = () => {
    retryTimer = null;
    if (isClosed) return;
    isLive = false;
    held.clear();
    report(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = createSocket(options.url());
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      for (const msg of held.values()) ws.send(JSON.stringify(msg));
      held.clear();
      options.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        const binary = parseScreenBinary(event.data);
        if (!binary) return;
        // Video goes live on its first decoded frame (`markLive`), not on SPS / PPS that show nothing.
        if (binary.kind === 'frame') markLive();
        options.onBinary(binary);
        return;
      }
      const msg = parseScreenMessage(event.data);
      if (!msg) return;
      if (msg.type === 'screenInfo') {
        options.onInfo(msg);
        return;
      }
      if (msg.type === 'clipboard') {
        options.onClipboard?.(msg.text);
        return;
      }
      if (msg.code === 'input_denied') {
        options.onInputDenied?.(msg.message);
        return;
      }
      error = { code: msg.code, message: msg.message };
      if (PERMANENT_SCREEN_ERRORS.has(msg.code)) {
        isFailed = true;
        report('failed');
        ws.close();
      }
    };
    ws.onerror = () => {
      // A close event always follows; the retry is scheduled there.
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (isClosed || isFailed) return;
      const delay = backoffDelay(attempt, random);
      attempt++;
      report('reconnecting');
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    send(msg) {
      if (isClosed || isFailed) return false;
      if (isHeldSetting(msg) && socket?.readyState !== OPEN) {
        held.set(msg.type, msg);
        return true;
      }
      if (!socket || socket.readyState !== OPEN) return false;
      const json = JSON.stringify(msg);
      const limit =
        msg.type === 'clipboard' || msg.type === 'paste'
          ? MAX_SCREEN_SOCKET_FRAME_BYTES
          : MAX_SCREEN_CLIENT_MESSAGE_BYTES;
      if (encoder.encode(json).length > limit) return false;
      socket.send(json);
      return true;
    },
    markLive() {
      if (isClosed || isFailed || socket === null) return;
      markLive();
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
}

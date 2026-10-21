import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { DEVICE_PROTOCOL_VERSION, MAX_DEVICE_LINE_BYTES, parseDeviceMessage } from '@lionscope/protocol';
import type { GatewayMessage } from '@lionscope/protocol';
import { HOST } from '../config.ts';
import { ErrorThrottle } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import type { ByeReason, SdkLinkHandler, SdkLinkTarget } from './sdkLink.ts';

export interface DeviceGatewayLimits {
  /** Connections still waiting for their hello; a new one evicts the oldest (it can't lock others out). */
  maxHandshakes: number;
  /** Connections past the hello; one more gets `bye too_many_connections`. */
  maxLinks: number;
  /** The first line must be a valid `hello` within this time. */
  helloTimeoutMs: number;
  /** A connection without any traffic for this long is dropped (the SDK sends a heartbeat every 5 s). */
  idleTimeoutMs: number;
  /** Token bucket per connection, in lines. */
  linesPerSecond: number;
  lineBurst: number;
  /** Gateway-wide token bucket for hellos: reconnecting must not reset the per-connection limit. */
  hellosPerSecond: number;
  helloBurst: number;
}

export const DEFAULT_DEVICE_LIMITS: DeviceGatewayLimits = {
  maxHandshakes: 4,
  maxLinks: 4,
  helloTimeoutMs: 1000,
  idleTimeoutMs: 20_000,
  linesPerSecond: 100,
  lineBurst: 200,
  hellosPerSecond: 1,
  helloBurst: 5,
};

/** Browsers can send requests to localhost ports: a request line ends the connection at once. */
const HTTP_REQUEST_LINE = /^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH|CONNECT) /;
/** After `end()`, a peer that doesn't close its side is destroyed this much later. */
const CLOSE_GRACE_MS = 1000;
const NEWLINE = 0x0a;
const MAX_LOGGED_TYPE_LENGTH = 64;

export interface DeviceGatewayOptions {
  /** 0 picks a free port (tests). */
  port: number;
  target: SdkLinkTarget;
  limits?: Partial<DeviceGatewayLimits>;
  /** Clock of the rate limiters (tests). */
  now?: () => number;
}

export interface DeviceGateway {
  /** Listen on `port` (default: the configured one). */
  listen(port?: number): Promise<AddressInfo>;
  close(): Promise<void>;
  readonly address: AddressInfo | null;
}

/**
 * TCP listener for the in-app SDK (reached through `adb reverse`), loopback only. Speaks NDJSON: every
 * line is validated with `parseDeviceMessage`; the first one must be a `hello` that the target accepts, and
 * `welcome` answers with the negotiated protocol version. Later lines of an unknown `type` (a newer SDK) are
 * skipped; any other protocol violation closes the connection, and the SDK reconnects with backoff.
 */
export function createDeviceGateway(options: DeviceGatewayOptions): DeviceGateway {
  const limits = { ...DEFAULT_DEVICE_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const handshaking = new Set<Socket>();
  const linked = new Set<Socket>();
  const hellos = new TokenBucket(limits.helloBurst, limits.hellosPerSecond, now);
  const warnings = new ErrorThrottle();
  let address: AddressInfo | null = null;
  let ignoredMessages = 0;

  const warn = (reason: string): void => {
    if (warnings.shouldReport(reason)) log.warn(`Device gateway: closed a connection (${reason})`);
  };
  const ignore = (type: string): void => {
    ignoredMessages += 1;
    if (!warnings.shouldReport('unknown message type')) return;
    // `type` is untrusted: shortened and reduced to printable ASCII before it reaches the log.
    const shown = type.slice(0, MAX_LOGGED_TYPE_LENGTH).replace(/[^\x20-\x7e]/g, '?');
    log.warn(
      `Device gateway: ignoring SDK messages of unknown type "${shown}" (a newer SDK?), ${ignoredMessages} so far`,
    );
  };

  const server = createServer((socket) => {
    socket.on('error', () => undefined); // resets from the phone side are routine
    if (handshaking.size >= limits.maxHandshakes) {
      const oldest = handshaking.values().next().value;
      if (oldest) {
        warn('handshake pool full, evicted the oldest');
        handshaking.delete(oldest);
        oldest.destroy();
      }
    }
    handshaking.add(socket);
    socket.on('close', () => {
      handshaking.delete(socket);
      linked.delete(socket);
    });
    const admit = (): ByeReason | null => {
      if (linked.size >= limits.maxLinks || !hellos.take()) return 'too_many_connections';
      handshaking.delete(socket);
      linked.add(socket);
      return null;
    };
    serveConnection(socket, { target: options.target, limits, now, warn, ignore, admit });
  });

  return {
    get address() {
      return address;
    },
    listen(port = options.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          address = server.address() as AddressInfo;
          resolve(address);
        });
      });
    },
    close() {
      for (const socket of [...handshaking, ...linked]) socket.destroy();
      address = null;
      return new Promise((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
    },
  };
}

function endSocket(socket: Socket, message?: GatewayMessage): void {
  if (message) socket.end(`${JSON.stringify(message)}\n`);
  else socket.end();
  setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
}

interface ConnectionContext {
  target: SdkLinkTarget;
  limits: DeviceGatewayLimits;
  now: () => number;
  warn: (reason: string) => void;
  /** A message of a type this build does not know arrived after the hello (skipped, counted). */
  ignore: (type: string) => void;
  /** A valid hello arrived: move the socket to the link pool, or say why not. */
  admit: () => ByeReason | null;
}

function serveConnection(socket: Socket, context: ConnectionContext): void {
  const { target, limits, warn, ignore } = context;
  const bucket = new TokenBucket(limits.lineBurst, limits.linesPerSecond, context.now);
  let partial: Buffer[] = [];
  let partialBytes = 0;
  let handler: SdkLinkHandler | null = null;
  let closing = false;

  const close = (bye?: ByeReason): void => {
    if (closing) return;
    closing = true;
    clearTimeout(helloTimer);
    endSocket(socket, bye && { type: 'bye', reason: bye });
  };
  const abort = (reason: string): void => {
    warn(reason);
    closing = true;
    socket.destroy();
  };
  const helloTimer = setTimeout(() => abort('no hello'), limits.helloTimeoutMs);
  socket.setTimeout(limits.idleTimeoutMs, () => abort('idle'));

  const onHello = (line: string): void => {
    if (HTTP_REQUEST_LINE.test(line)) return abort('HTTP request');
    const parsed = parseDeviceMessage(line);
    if (!parsed.ok || parsed.value.type !== 'hello') {
      warn(!parsed.ok && parsed.unsupportedVersion !== undefined ? parsed.error : 'invalid hello');
      return close('protocol_error');
    }
    clearTimeout(helloTimer);
    const refused = context.admit();
    if (refused) {
      warn('too many SDK connections');
      return close(refused);
    }
    // The schema already refused versions below MIN_DEVICE_PROTOCOL_VERSION; a newer SDK speaks ours.
    const protocolVersion = Math.min(parsed.value.protocolVersion, DEVICE_PROTOCOL_VERSION);
    const result = target.attachSdk(parsed.value, { close, protocolVersion });
    if (!result.ok) return close(result.reason);
    handler = result.handler;
    const welcome: GatewayMessage = { type: 'welcome', protocolVersion };
    socket.write(`${JSON.stringify(welcome)}\n`);
  };

  const onLine = (raw: string): void => {
    if (!bucket.take()) {
      warn('rate limit');
      return close('protocol_error');
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!handler) return onHello(line);
    const parsed = parseDeviceMessage(line);
    if (!parsed.ok && parsed.unknownType !== undefined) return ignore(parsed.unknownType);
    if (!parsed.ok || parsed.value.type === 'hello') {
      warn('invalid message');
      return close('protocol_error');
    }
    handler.onMessage(parsed.value);
  };

  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (!closing) {
      const newline = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      // Lines are split on raw bytes: `\n` never occurs inside a multi-byte UTF-8 sequence.
      if (partialBytes + piece.length > MAX_DEVICE_LINE_BYTES) return abort('line too long');
      if (newline === -1) {
        if (piece.length > 0) partial.push(piece);
        partialBytes += piece.length;
        return;
      }
      const line = Buffer.concat([...partial, piece]).toString('utf8');
      partial = [];
      partialBytes = 0;
      start = newline + 1;
      try {
        onLine(line);
      } catch (error) {
        // A bug downstream must not take the server down; the SDK reconnects.
        log.error('Device gateway: failed to handle a line:', errorMessage(error));
        close('protocol_error');
      }
    }
  });

  socket.on('close', () => {
    closing = true;
    clearTimeout(helloTimer);
    const linked = handler;
    handler = null;
    linked?.onClose();
  });
}

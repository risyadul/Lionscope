import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import {
  DEVICE_PROTOCOL_V2,
  DEVICE_PROTOCOL_V4,
  DEVICE_PROTOCOL_V5,
  DEVICE_PROTOCOL_V7,
  DEVICE_PROTOCOL_V8,
  DEVICE_PROTOCOL_VERSION,
  INSPECT_TIMEOUT_MS,
  MAX_DEVICE_LINE_BYTES,
  maxDeviceLineBytes,
  parseDeviceMessage,
  VIEW_EDIT_TIMEOUT_MS,
  peekLineType,
} from '@lionscope/protocol';
import type {
  GatewayMessage,
  HttpHeader,
  InspectorNode,
  NetworkMockRule,
  SdkOptions,
} from '@lionscope/protocol';
import { HOST } from '../config.ts';
import { ErrorThrottle } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import { MAX_INSPECT_ANSWER_BYTES, SdkEditError, SdkInspectError } from './sdkLink.ts';
import type {
  ByeReason,
  SdkEditFailure,
  SdkInspectBegin,
  SdkInspection,
  SdkInspectFailure,
  SdkInspectMessage,
  SdkAttachResult,
  SdkLink,
  SdkLinkHandler,
  SdkLinkMessage,
  SdkLinkMode,
  SdkLinkTarget,
  SdkViewEditResult,
} from './sdkLink.ts';

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
  /**
   * An `inspect` request fails when no answer line arrived this long after it was sent or after its previous
   * line, or when it is not complete `inspectTotalTimeoutMs` after it was sent.
   */
  inspectTimeoutMs: number;
  inspectTotalTimeoutMs: number;
  /** Bytes of one `inspect` answer at most (MAX_INSPECT_ANSWER_BYTES). */
  maxInspectAnswerBytes: number;
  /** A v8 edit fails (`timeout`) without its answer this long after it was sent. */
  viewEditTimeoutMs: number;
  /** Edits waiting for their answer per link; one more is refused (`busy`). */
  maxPendingEdits: number;
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
  inspectTimeoutMs: INSPECT_TIMEOUT_MS,
  inspectTotalTimeoutMs: 15_000,
  maxInspectAnswerBytes: MAX_INSPECT_ANSWER_BYTES,
  viewEditTimeoutMs: VIEW_EDIT_TIMEOUT_MS,
  maxPendingEdits: 8,
};

/** Browsers can send requests to localhost ports: a request line ends the connection at once. */
const HTTP_REQUEST_LINE = /^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH|CONNECT) /;
/** After `end()`, a peer that doesn't close its side is destroyed this much later. */
const CLOSE_GRACE_MS = 1000;
const NEWLINE = 0x0a;
const MAX_LOGGED_TYPE_LENGTH = 64;
/**
 * Messages a connection may send while its hello is being checked (its current screen, a heartbeat): held and
 * handed on once it is welcomed, discarded if it is refused. Beyond this they are dropped.
 */
export const MAX_HELD_LINES = 16;

export interface DeviceGatewayOptions {
  /** 0 picks a free port (tests). */
  port: number;
  target: SdkLinkTarget;
  limits?: Partial<DeviceGatewayLimits>;
  /** Clock of the rate limiters (tests). */
  now?: () => number;
  /**
   * A hello token bucket shared with the other inspect-only listeners (one per device), taken from after this
   * listener's own: the hello rate stays bounded however many listeners there are.
   */
  sharedHellos?: TokenBucket;
}

/** The shared hello bucket of the inspect-only listeners (sharedHellos): a few devices' worth of one's rate. */
export const SHARED_HELLO_BURST = 10;
export const SHARED_HELLOS_PER_SECOND = 3;

export interface DeviceGateway {
  /** Listen on `port` (default: the configured one). */
  listen(port?: number): Promise<AddressInfo>;
  close(): Promise<void>;
  readonly address: AddressInfo | null;
}

/**
 * TCP listener for the in-app SDK (reached through `adb reverse`), loopback only. Speaks NDJSON: every
 * line is validated with `parseDeviceMessage`; the first one must be a `hello` that the target accepts (it may
 * check the PID first: nothing is sent until it decided), and `welcome` answers with the negotiated protocol
 * version, on a v5 link the link's mode and on a v7 session link the target's link proof (on a v2 session link
 * followed by `config`). Later lines of an
 * unknown `type` (a newer SDK) or of a type the negotiated version lacks are skipped; any other protocol
 * violation closes the connection, and the SDK reconnects with backoff.
 */
export function createDeviceGateway(options: DeviceGatewayOptions): DeviceGateway {
  const limits = { ...DEFAULT_DEVICE_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const handshaking = new Set<Socket>();
  const linked = new Set<Socket>();
  const hellos = new TokenBucket(limits.helloBurst, limits.hellosPerSecond, now);
  const sharedHellos = options.sharedHellos;
  const warnings = new ErrorThrottle();
  let address: AddressInfo | null = null;
  let ignoredMessages = 0;
  let unnegotiatedMessages = 0;
  let invalidDiagnostics = 0;
  let shedDiagnostics = 0;

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
  const skipUnnegotiated = (type: string, since: number, negotiated: number): void => {
    unnegotiatedMessages += 1;
    if (!warnings.shouldReport('unnegotiated type')) return;
    log.warn(
      `Device gateway: ignoring "${type}": SDK sent a v${since} message on a v${negotiated} link, ` +
        `${unnegotiatedMessages} so far`,
    );
  };
  const dropDiagnostic = (type: string, error: string): void => {
    invalidDiagnostics += 1;
    if (!warnings.shouldReport('invalid diagnostic')) return;
    log.warn(
      `Device gateway: dropped an invalid SDK ${type} message (${error.slice(0, 200)}), ${invalidDiagnostics} so far`,
    );
  };

  const shedDiagnostic = (type: string): void => {
    shedDiagnostics += 1;
    if (!warnings.shouldReport('shed diagnostic')) return;
    log.warn(
      `Device gateway: dropped an SDK ${type} message over the line rate limit, ${shedDiagnostics} so far`,
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
      if (linked.size >= limits.maxLinks || !hellos.take() || sharedHellos?.take() === false) {
        return 'too_many_connections';
      }
      handshaking.delete(socket);
      linked.add(socket);
      return null;
    };
    serveConnection(socket, {
      target: options.target,
      limits,
      now,
      warn,
      ignore,
      skipUnnegotiated,
      dropDiagnostic,
      shedDiagnostic,
      admit,
    });
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

/**
 * One gateway line: `JSON.stringify` keeps insertion order, so `type` (written first) is the first key, and leaves out
 * fields that are `undefined`. The golden lines (protocol/fixtures/gateway-messages.ndjson) are its output.
 */
export function gatewayLine(message: GatewayMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The `welcome` line: `mode` on v5 links, `proof` (after it) on v7 session links that have one, as in
 * protocol/fixtures/gateway-messages.ndjson.
 */
export function encodeWelcome(protocolVersion: number, mode: SdkLinkMode, proof?: string): string {
  if (protocolVersion < DEVICE_PROTOCOL_V5) return gatewayLine({ type: 'welcome', protocolVersion });
  const proven = carriesProof(protocolVersion, mode, proof);
  return gatewayLine(
    proven ? { type: 'welcome', protocolVersion, mode, proof } : { type: 'welcome', protocolVersion, mode },
  );
}

/** Whether the welcome of a link like this goes out with its link proof. */
function carriesProof(protocolVersion: number, mode: SdkLinkMode, proof: string | undefined): boolean {
  return proof !== undefined && mode === 'session' && protocolVersion >= DEVICE_PROTOCOL_V7;
}

/** A mock rule set waits for 'drain' (only the latest one) while the socket buffers more than this. */
export const MAX_PENDING_MOCK_BYTES = 1024 * 1024;

function configMessage(options: SdkOptions): GatewayMessage {
  return {
    type: 'config',
    stallThresholdMs: options.stallThresholdMs,
    strictMode: options.strictMode,
    inflateTracking: options.inflateTracking,
  };
}

/** `Name: value` lines joined by `\n` (names are tokens, values hold no CR / LF): the SDK splits them back. */
function encodeMockHeaders(headers: readonly HttpHeader[]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join('\n');
}

/**
 * A mock rule set as the SDK reads it: `mocks`, then one flat `mock` per rule in precedence order (keys in the
 * order of protocol/fixtures/gateway-messages.ndjson; method `*` = any; failures carry no response).
 */
function mockMessages(rev: number, rules: readonly NetworkMockRule[]): GatewayMessage[] {
  return [
    { type: 'mocks', rev, count: rules.length },
    ...rules.map((rule, index): GatewayMessage => {
      const respond = rule.action === 'respond';
      return {
        type: 'mock',
        rev,
        index,
        id: rule.id,
        method: rule.method ?? '*',
        match: rule.match,
        url: rule.url,
        action: rule.action,
        status: respond ? rule.status : 0,
        headers: respond ? encodeMockHeaders(rule.headers) : '',
        bodyBase64: respond ? Buffer.from(rule.body, 'utf8').toString('base64') : '',
        delayMs: rule.delayMs,
      };
    }),
  ];
}

/** The lines `mockMessages` sends, as written to the socket. */
export function encodeMocks(rev: number, rules: readonly NetworkMockRule[]): string {
  return mockMessages(rev, rules).map(gatewayLine).join('');
}

const INSPECT_TYPES: ReadonlySet<string> = new Set(['inspectBegin', 'inspectNodes', 'inspectError']);
/** Dropped (counted) rather than fatal when over the line budget (a dropped edit answer times out). */
const SHEDDABLE_TYPES: ReadonlySet<string> = new Set([
  'stall',
  'strictmode',
  'inflate',
  'viewtree',
  'viewPropertyResult',
  ...INSPECT_TYPES,
  'httpRequest',
  'httpResponse',
  'mocksApplied',
]);

function isInspectMessage(message: { type: string }): message is SdkInspectMessage {
  return INSPECT_TYPES.has(message.type);
}

interface PendingInspect {
  begin: SdkInspectBegin | null;
  chunks: Map<number, InspectorNode[]>;
  /** seq of the chunk marked `last`, once it arrived. */
  lastSeq: number | null;
  received: number;
  /** Bytes of its lines so far. */
  bytes: number;
  /** performance.now() by which it must be complete. */
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (inspection: SdkInspection) => void;
  reject: (error: SdkInspectError) => void;
}

interface PendingEdit {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: SdkViewEditResult) => void;
  reject: (error: SdkEditError) => void;
}

/** The nodes of a complete answer in seq order, or null when they don't form the snapshot `begin` announced. */
function assembleNodes(pending: PendingInspect, begin: SdkInspectBegin): InspectorNode[] | null {
  const nodes: InspectorNode[] = [];
  for (let seq = 0; seq < pending.chunks.size; seq++) {
    const chunk = pending.chunks.get(seq);
    if (!chunk) return null;
    nodes.push(...chunk);
  }
  if (nodes.length !== begin.nodeCount) return null;
  const consistent = nodes.every(
    (node, index) =>
      node.id === index &&
      (node.parent === null || node.parent < index) &&
      node.window < begin.windows.length,
  );
  return consistent ? nodes : null;
}
/** Bytes of a line's start that hold its `type` (`{"type":"httpResponse"`), whatever the chunking. */
const LINE_HEAD_BYTES = 64;

/** Java's `int`: the SDK reads request ids into one. */
const MAX_REQUEST_ID = 2_147_483_647;
let lastRequestId = 0;

/**
 * Request ids (inspect and edits) are unique across every link of this process, so a late answer that reaches another
 * connection can never settle one of its requests.
 */
function nextRequestId(): number {
  lastRequestId = lastRequestId >= MAX_REQUEST_ID ? 1 : lastRequestId + 1;
  return lastRequestId;
}

/** The `type` a parse found: the parsed message's, or the one its failure names. */
function parsedTypeOf(parsed: ReturnType<typeof parseDeviceMessage>): string | null {
  return parsed.ok
    ? parsed.value.type
    : (parsed.invalidDiagnostic ?? parsed.unknownType ?? parsed.unnegotiated?.type ?? null);
}

function endSocket(socket: Socket, message?: GatewayMessage): void {
  if (message) socket.end(gatewayLine(message));
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
  /** A message of a type the negotiated protocol version lacks (skipped, counted). */
  skipUnnegotiated: (type: string, since: number, negotiated: number) => void;
  /** A diagnostic (`stall` / `strictmode`) or Inspector answer failed validation (dropped, counted; the link stays up). */
  dropDiagnostic: (type: string, error: string) => void;
  /** A diagnostic line over the connection's line budget was dropped (counted; the link stays up). */
  shedDiagnostic: (type: string) => void;
  /** A valid hello arrived: move the socket to the link pool, or say why not. */
  admit: () => ByeReason | null;
}

function serveConnection(socket: Socket, context: ConnectionContext): void {
  const { target, limits, warn, ignore, skipUnnegotiated, dropDiagnostic, shedDiagnostic } = context;
  const bucket = new TokenBucket(limits.lineBurst, limits.linesPerSecond, context.now);
  let partial: Buffer[] = [];
  let partialBytes = 0;
  let handler: SdkLinkHandler | null = null;
  /** Negotiated on the hello. */
  let protocolVersion = 0;
  /** A `config` asked for before the `welcome` went out. */
  let pendingConfig: GatewayMessage | null = null;
  /** The latest mock rule set asked for before the `welcome` went out (sent after it, on a session link). */
  let pendingMocks: string | null = null;
  /** The latest mock rule set asked for while the socket's buffer was over MAX_PENDING_MOCK_BYTES. */
  let drainingMocks: { rev: number; rules: readonly NetworkMockRule[] } | null = null;
  let mode: SdkLinkMode = 'session';
  /** The welcome went out with the link proof (LINK_KEY_RECEIVER): the SDK can tell this server is the one adb trusts. */
  let proven = false;
  /** The hello is being checked by the target: later lines are held (up to MAX_HELD_LINES) until it decided. */
  let attaching = false;
  let held: SdkLinkMessage[] = [];
  /** The socket is closed (its `close` event fired). */
  let gone = false;
  let closing = false;
  const inspects = new Map<number, PendingInspect>();
  const edits = new Map<number, PendingEdit>();
  /** Edit answers that may still bypass the line budget: one per edit sent; reset when none is pending. */
  let editAllowance = 0;
  /**
   * Inspector answer lines (and bytes) of pending requests that may still bypass the line budget: one line per
   * request sent (its begin or error) and, once a begin arrived, one per announced node (a chunk holds at least
   * one); maxInspectAnswerBytes per request. Reset when no request is pending.
   */
  let inspectAllowance = 0;
  let inspectBytesAllowance = 0;

  const settleInspect = (requestId: number): PendingInspect | null => {
    const pending = inspects.get(requestId);
    if (!pending) return null;
    inspects.delete(requestId);
    clearTimeout(pending.timer);
    if (inspects.size === 0) {
      inspectAllowance = 0;
      inspectBytesAllowance = 0;
    }
    return pending;
  };
  /** (Re-)arm a request's timer: the next line is due within inspectTimeoutMs, all of them by its deadline. */
  const armInspectTimer = (requestId: number, pending: PendingInspect): void => {
    clearTimeout(pending.timer);
    const left = Math.min(limits.inspectTimeoutMs, pending.deadline - performance.now());
    pending.timer = setTimeout(() => failInspect(requestId, 'timeout'), Math.max(0, left));
  };
  const failInspect = (requestId: number, reason: SdkInspectFailure): void => {
    settleInspect(requestId)?.reject(new SdkInspectError(reason));
  };
  const failAllInspects = (reason: SdkInspectFailure): void => {
    for (const requestId of [...inspects.keys()]) failInspect(requestId, reason);
  };
  const settleEdit = (requestId: number): PendingEdit | null => {
    const pending = edits.get(requestId);
    if (!pending) return null;
    edits.delete(requestId);
    clearTimeout(pending.timer);
    if (edits.size === 0) editAllowance = 0;
    return pending;
  };
  const failAllEdits = (reason: SdkEditFailure): void => {
    for (const requestId of [...edits.keys()]) settleEdit(requestId)?.reject(new SdkEditError(reason));
  };
  const failPending = (): void => {
    failAllInspects('closed');
    failAllEdits('closed');
  };

  /** Send one v8 edit request (built around its request id) and wait for its `viewPropertyResult`. */
  const edit = (line: (requestId: number) => GatewayMessage): Promise<SdkViewEditResult> =>
    new Promise((resolve, reject) => {
      if (protocolVersion < DEVICE_PROTOCOL_V8) return reject(new SdkEditError('unsupported'));
      if (closing || !handler) return reject(new SdkEditError('closed'));
      if (edits.size >= limits.maxPendingEdits) return reject(new SdkEditError('busy'));
      const requestId = nextRequestId();
      const timer = setTimeout(
        () => settleEdit(requestId)?.reject(new SdkEditError('timeout')),
        limits.viewEditTimeoutMs,
      );
      edits.set(requestId, { timer, resolve, reject });
      editAllowance += 1;
      socket.write(gatewayLine(line(requestId)));
    });

  const inspect = (): Promise<SdkInspection> =>
    new Promise((resolve, reject) => {
      if (protocolVersion < DEVICE_PROTOCOL_V4) return reject(new SdkInspectError('unsupported'));
      if (closing || !handler) return reject(new SdkInspectError('closed'));
      const requestId = nextRequestId();
      const pending: PendingInspect = {
        begin: null,
        chunks: new Map(),
        lastSeq: null,
        received: 0,
        bytes: 0,
        deadline: performance.now() + limits.inspectTotalTimeoutMs,
        timer: undefined,
        resolve,
        reject,
      };
      inspects.set(requestId, pending);
      armInspectTimer(requestId, pending);
      inspectAllowance += 1;
      inspectBytesAllowance += limits.maxInspectAnswerBytes;
      socket.write(gatewayLine({ type: 'inspect', requestId }));
    });

  /** One Inspector answer line; anything inconsistent fails its request (the link stays up). */
  const onInspectMessage = (message: SdkInspectMessage, bytes: number): void => {
    const pending = inspects.get(message.requestId);
    // An answer after its request timed out (or to none at all) is stale: dropped quietly.
    if (!pending) return;
    if (message.type === 'inspectError') return failInspect(message.requestId, message.reason);
    pending.bytes += bytes;
    if (pending.bytes > limits.maxInspectAnswerBytes) return failInspect(message.requestId, 'too_large');
    armInspectTimer(message.requestId, pending);
    if (message.type === 'inspectBegin') {
      const windowsInOrder = message.windows.every((window, index) => window.id === index);
      if (pending.begin || !windowsInOrder) return failInspect(message.requestId, 'invalid');
      pending.begin = message;
      inspectAllowance += Math.max(1, message.nodeCount);
      return;
    }
    const { begin } = pending;
    if (!begin || pending.chunks.has(message.seq)) return failInspect(message.requestId, 'invalid');
    pending.received += message.nodes.length;
    const tooMany =
      pending.received > begin.nodeCount ||
      (message.nodes.length === 0 && begin.nodeCount > 0) ||
      pending.chunks.size >= Math.max(1, begin.nodeCount) ||
      (pending.lastSeq !== null && (message.last || message.seq > pending.lastSeq));
    if (tooMany) return failInspect(message.requestId, 'invalid');
    pending.chunks.set(message.seq, message.nodes);
    if (message.last) pending.lastSeq = message.seq;
    if (pending.lastSeq === null || pending.chunks.size <= pending.lastSeq) return;
    // Every chunk 0..lastSeq is in (chunks may arrive out of order).
    const nodes = assembleNodes(pending, begin);
    settleInspect(message.requestId);
    if (nodes) pending.resolve({ begin, nodes });
    else pending.reject(new SdkInspectError('invalid'));
  };

  const close = (bye?: ByeReason): void => {
    if (closing) return;
    closing = true;
    clearTimeout(helloTimer);
    failPending();
    endSocket(socket, bye && { type: 'bye', reason: bye });
  };
  const abort = (reason: string): void => {
    warn(reason);
    closing = true;
    failPending();
    socket.destroy();
  };
  const writeMocks = (rev: number, rules: readonly NetworkMockRule[]): void => {
    if (drainingMocks === null && socket.writableLength <= MAX_PENDING_MOCK_BYTES) {
      socket.write(encodeMocks(rev, rules));
      return;
    }
    // A slow phone: only the latest set waits; older ones would be replaced by it anyway.
    if (drainingMocks === null) {
      socket.once('drain', () => {
        const latest = drainingMocks;
        drainingMocks = null;
        if (latest && !closing) writeMocks(latest.rev, latest.rules);
      });
    }
    drainingMocks = { rev, rules };
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
    protocolVersion = Math.min(parsed.value.protocolVersion, DEVICE_PROTOCOL_VERSION);
    const link: SdkLink = {
      protocolVersion,
      get mode() {
        return mode;
      },
      get proven() {
        return proven;
      },
      close,
      sendConfig: (options) => {
        // An inspect-only link gets no options (its SDK runs no collectors).
        if (protocolVersion < DEVICE_PROTOCOL_V2 || closing || mode === 'inspect') return;
        if (handler) socket.write(gatewayLine(configMessage(options)));
        else pendingConfig = configMessage(options);
      },
      sendMocks: (rev, rules) => {
        // Mocks belong to a profiling session: inspect-only links never get them.
        if (protocolVersion < DEVICE_PROTOCOL_V7 || closing) return;
        if (!handler) pendingMocks = encodeMocks(rev, rules);
        else if (mode === 'session') writeMocks(rev, rules);
      },
      inspect,
      setViewProperty: (viewKey, property, value) =>
        edit((requestId) => ({ type: 'setViewProperty', requestId, viewKey, property, value })),
      revertViewProperties: (viewKey, property) =>
        edit((requestId) => ({ type: 'revertViewProperties', requestId, viewKey, property })),
    };
    let result: SdkAttachResult | Promise<SdkAttachResult>;
    try {
      result = target.attachSdk(parsed.value, link);
    } catch (error) {
      return onAttachFailed(error);
    }
    if (!(result instanceof Promise)) return onAttached(result);
    attaching = true;
    result.then(onAttached, onAttachFailed);
  };

  const onAttachFailed = (error: unknown): void => {
    attaching = false;
    held = [];
    log.error('Device gateway: failed to attach an SDK link:', errorMessage(error));
    close('protocol_error');
  };

  const onAttached = (result: SdkAttachResult): void => {
    attaching = false;
    const pending = held;
    held = [];
    if (!result.ok) return close(result.reason);
    handler = result.handler;
    if (gone) {
      // The connection went away while the target checked it.
      handler = null;
      return result.handler.onClose();
    }
    // The target may have closed the link while attaching it.
    if (closing) return;
    mode = result.mode ?? 'session';
    if (mode === 'inspect' && protocolVersion < DEVICE_PROTOCOL_V5) {
      warn('inspect mode below v5');
      return close('no_session');
    }
    proven = carriesProof(protocolVersion, mode, result.proof);
    socket.write(encodeWelcome(protocolVersion, mode, result.proof));
    if (pendingConfig && mode === 'session') socket.write(gatewayLine(pendingConfig));
    if (pendingMocks !== null && mode === 'session') socket.write(pendingMocks);
    pendingConfig = null;
    pendingMocks = null;
    try {
      for (const message of pending) {
        if (closing || !handler) return;
        handler.onMessage(message);
      }
    } catch (error) {
      log.error('Device gateway: failed to handle a line:', errorMessage(error));
      close('protocol_error');
    }
  };

  /** A validated message: to the handler, or held while the hello is being checked. */
  const deliver = (message: SdkLinkMessage): void => {
    if (handler) handler.onMessage(message);
    else if (held.length < MAX_HELD_LINES) held.push(message);
  };

  /**
   * Over the line budget: a diagnostic is dropped (counted), anything else closes the link. `stale`: an Inspector
   * answer known to belong to no pending request.
   */
  const overBudget = (type: string | null, stale = false): void => {
    if (type === null || !SHEDDABLE_TYPES.has(type)) {
      warn('rate limit');
      return close('protocol_error');
    }
    // A snapshot missing a line can't be completed.
    if (INSPECT_TYPES.has(type) && !stale) failAllInspects('invalid');
    shedDiagnostic(type);
  };

  const onLine = (raw: string, rawBytes: number): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const helloSeen = handler !== null || attaching;
    const type = helloSeen ? peekLineType(line) : null;
    // A snapshot's chunks come in a burst: while a request waits for them, its answer lines don't count against
    // the line budget, up to the announced node count and MAX_INSPECT_ANSWER_BYTES (they still go through every
    // other check). Whether a line really is such an answer is only known once parsed.
    const exempt =
      type !== null &&
      INSPECT_TYPES.has(type) &&
      inspects.size > 0 &&
      inspectAllowance > 0 &&
      rawBytes <= inspectBytesAllowance;
    // An edit's answer is one line: the edits waiting for one may bypass the budget by that many lines.
    const exemptEdit = type === 'viewPropertyResult' && edits.size > 0 && editAllowance > 0;
    if (!exempt && !exemptEdit && !bucket.take()) return overBudget(type);
    if (!helloSeen) return onHello(line);
    const parsed = parseDeviceMessage(line, protocolVersion);
    // JSON.parse keeps the last of duplicate keys: the type peeked at must be the type parsed.
    if ((exempt || exemptEdit) && parsedTypeOf(parsed) !== type) {
      warn('answer of another type');
      return close('protocol_error');
    }
    if (exemptEdit) editAllowance -= 1;
    if (exempt) {
      // Only answers to a pending request are exempt; a stale one spends the budget like any line.
      const requestId = parsed.ok && isInspectMessage(parsed.value) ? parsed.value.requestId : null;
      if (requestId === null || inspects.has(requestId)) {
        inspectAllowance -= 1;
        inspectBytesAllowance -= rawBytes;
      } else if (!bucket.take()) return overBudget(type, true);
    }
    if (!parsed.ok && parsed.unknownType !== undefined) return ignore(parsed.unknownType);
    if (!parsed.ok && parsed.unnegotiated) {
      return skipUnnegotiated(parsed.unnegotiated.type, parsed.unnegotiated.since, protocolVersion);
    }
    if (!parsed.ok && parsed.invalidDiagnostic !== undefined) {
      dropDiagnostic(parsed.invalidDiagnostic, parsed.error);
      if (INSPECT_TYPES.has(parsed.invalidDiagnostic)) return failAllInspects('invalid');
      return handler?.onInvalidDiagnostic();
    }
    if (!parsed.ok || parsed.value.type === 'hello') {
      warn('invalid message');
      return close('protocol_error');
    }
    if (isInspectMessage(parsed.value)) return onInspectMessage(parsed.value, rawBytes);
    // An answer after its edit timed out (or to none at all) is dropped quietly.
    if (parsed.value.type === 'viewPropertyResult')
      return settleEdit(parsed.value.requestId)?.resolve(parsed.value);
    deliver(parsed.value);
  };

  /**
   * The size cap of the line being read, decided once it grows past MAX_DEVICE_LINE_BYTES: by then its start (and
   * so its `type`) has arrived, however the chunks split it. `httpRequest` / `httpResponse` lines on a v7 link
   * may be larger.
   */
  let lineCap: number | null = null;
  const capOf = (parts: Buffer[], bytes: number): number => {
    const head = Buffer.concat(parts, Math.min(bytes, LINE_HEAD_BYTES)).toString('utf8');
    return maxDeviceLineBytes(peekLineType(head), protocolVersion);
  };

  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (!closing) {
      const newline = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      // Lines are split on raw bytes: `\n` never occurs inside a multi-byte UTF-8 sequence.
      const lineBytes = partialBytes + piece.length;
      if (
        lineBytes > MAX_DEVICE_LINE_BYTES &&
        lineBytes > (lineCap ??= capOf([...partial, piece], lineBytes))
      ) {
        return abort('line too long');
      }
      if (newline === -1) {
        if (piece.length > 0) partial.push(piece);
        partialBytes += piece.length;
        return;
      }
      const bytes = partialBytes + piece.length;
      const line = Buffer.concat([...partial, piece]).toString('utf8');
      partial = [];
      partialBytes = 0;
      lineCap = null;
      start = newline + 1;
      try {
        onLine(line, bytes);
      } catch (error) {
        // A bug downstream must not take the server down; the SDK reconnects.
        log.error('Device gateway: failed to handle a line:', errorMessage(error));
        close('protocol_error');
      }
    }
  });

  socket.on('close', () => {
    gone = true;
    closing = true;
    clearTimeout(helloTimer);
    failPending();
    const linked = handler;
    handler = null;
    linked?.onClose();
  });
}

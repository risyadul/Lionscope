import type { DeviceMessage, GatewayMessage, InspectorNode, SdkOptions } from '@lionscope/protocol';

export type SdkHello = Extract<DeviceMessage, { type: 'hello' }>;
/** The answers to a gateway `inspect`: the gateway consumes them itself (SdkLink.inspect). */
export type SdkInspectMessage = Extract<
  DeviceMessage,
  { type: 'inspectBegin' } | { type: 'inspectNodes' } | { type: 'inspectError' }
>;
export type SdkInspectBegin = Extract<DeviceMessage, { type: 'inspectBegin' }>;
/** Everything the SDK may send after its hello, except the Inspector answers. */
export type SdkLinkMessage = Exclude<DeviceMessage, { type: 'hello' } | SdkInspectMessage>;
export type ByeReason = Extract<GatewayMessage, { type: 'bye' }>['reason'];

/** The device gateway's side of one accepted SDK connection. */
export interface SdkLink {
  /**
   * Negotiated device protocol version: min(the SDK's hello, DEVICE_PROTOCOL_VERSION). Messages added in later
   * versions are only sent to links that negotiated them.
   */
  readonly protocolVersion: number;
  /** Close the connection, telling the SDK why when a reason is given. */
  close(reason?: ByeReason): void;
  /**
   * Send the session's SDK options as `config`. Only links at protocol ≥ 2 get it (a no-op otherwise); called
   * before the `welcome` went out, it is sent right after it.
   */
  sendConfig(options: SdkOptions): void;
  /**
   * Ask for an Inspector snapshot (links at protocol ≥ 4): resolves with the reassembled answer, rejects with an
   * SdkInspectError.
   */
  inspect(): Promise<SdkInspection>;
}

/** A complete SDK answer to `inspect`: nodes in id order, ids 0..nodeCount-1, parents before children. */
export interface SdkInspection {
  begin: SdkInspectBegin;
  nodes: InspectorNode[];
}

/** Bytes of all lines of one `inspect` answer at most (begin, chunks); more fails it as `too_large`. */
export { MAX_INSPECT_ANSWER_BYTES } from '@lionscope/protocol';

/**
 * Why an `inspect` failed: the SDK's own reasons (`inspectError`), or `timeout` (no complete answer within
 * INSPECT_TIMEOUT_MS of the request or its last line, or not complete within the total limit), `invalid` (a
 * malformed, inconsistent or shed answer), `too_large` (over MAX_INSPECT_ANSWER_BYTES), `closed` (the link went
 * away) and `unsupported` (a link below protocol 4).
 */
export type SdkInspectFailure =
  | Extract<SdkInspectMessage, { type: 'inspectError' }>['reason']
  | 'timeout'
  | 'invalid'
  | 'too_large'
  | 'closed'
  | 'unsupported';

export class SdkInspectError extends Error {
  override name = 'SdkInspectError';
  constructor(readonly reason: SdkInspectFailure) {
    super(`SDK inspect failed: ${reason}`);
  }
}

/** Receives the messages of one accepted SDK connection. */
export interface SdkLinkHandler {
  onMessage(message: SdkLinkMessage): void;
  /** A diagnostic line (`stall` / `strictmode`) failed validation and was dropped; the link stays up. */
  onInvalidDiagnostic(): void;
  /** The connection is gone (either side closed it). */
  onClose(): void;
}

export type SdkAttachResult = { ok: true; handler: SdkLinkHandler } | { ok: false; reason: ByeReason };

/** Where the gateway hands validated hellos (the session manager). */
export interface SdkLinkTarget {
  attachSdk(hello: SdkHello, link: SdkLink): SdkAttachResult;
}

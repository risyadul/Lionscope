import type { DeviceMessage, GatewayMessage, SdkOptions } from '@lionscope/protocol';

export type SdkHello = Extract<DeviceMessage, { type: 'hello' }>;
/** Everything the SDK may send after its hello. */
export type SdkLinkMessage = Exclude<DeviceMessage, { type: 'hello' }>;
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

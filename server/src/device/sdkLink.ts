import type { DeviceMessage, GatewayMessage } from '@lionscope/protocol';

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
}

/** Receives the messages of one accepted SDK connection. */
export interface SdkLinkHandler {
  onMessage(message: SdkLinkMessage): void;
  /** The connection is gone (either side closed it). */
  onClose(): void;
}

export type SdkAttachResult = { ok: true; handler: SdkLinkHandler } | { ok: false; reason: ByeReason };

/** Where the gateway hands validated hellos (the session manager). */
export interface SdkLinkTarget {
  attachSdk(hello: SdkHello, link: SdkLink): SdkAttachResult;
}

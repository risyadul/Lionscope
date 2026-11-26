/**
 * Wireless ADB connection management shared by the dashboard WebSocket gateway and AI agent tools.
 *
 * Host validation policy:
 * - Dashboard: accepts any syntactically valid IPv4/IPv6/hostname + port (or mDNS serial).
 * - Agent tools: restricts to private IPv4 (10/8, 172.16/12, 192.168/16), link-local, IPv6 ULA
 *   (fc00::/7), Tailscale (100.64/10), mDNS serials, or a host:port already connected from the
 *   dashboard in this server run.
 */
import {
  checkAgentWirelessTarget,
  isMdnsSerial,
  isValidPairingCode,
  MDNS_CONNECT_SERVICE,
  parseWirelessAddress,
} from '@lionscope/protocol';
import type { DeviceInfo } from '@lionscope/protocol';
import { scrubSecret } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { adbConnect, adbDisconnect, adbMdnsServices, adbPair } from '../adb/wireless.ts';
import type { AdbConnectResult, AdbDisconnectResult, MdnsService } from '../adb/wireless.ts';
import { PublicError } from '../errors.ts';
import { errorMessage } from '../log.ts';

export type WirelessRequestSource = 'dashboard' | 'agent';

export interface WirelessPairOutcome {
  target: string;
  host: string;
  connectedSerial: string | null;
  connectNote?: string;
}

export interface WirelessServiceOptions {
  adb: Adb;
  refreshDevices: () => Promise<DeviceInfo[]>;
  stopSessionOn: (serial: string) => Promise<void>;
  getDevices: () => readonly DeviceInfo[];
}

export class WirelessService {
  private readonly adb: Adb;
  private readonly refreshDevices: () => Promise<DeviceInfo[]>;
  private readonly stopSessionOn: (serial: string) => Promise<void>;
  private readonly getDevices: () => readonly DeviceInfo[];
  /** Normalized `host:port` endpoints connected by the user from the dashboard during this server run. */
  private readonly dashboardApproved = new Set<string>();

  constructor(options: WirelessServiceOptions) {
    this.adb = options.adb;
    this.refreshDevices = options.refreshDevices;
    this.stopSessionOn = options.stopSessionOn;
    this.getDevices = options.getDevices;
  }

  /** Remember a normalized `host:port` approved by the user from the dashboard. */
  approveFromDashboard(rawTarget: string): void {
    const parsed = parseWirelessAddress(rawTarget);
    if (parsed.ok) this.dashboardApproved.add(parsed.value.target);
  }

  isDashboardApproved(rawTarget: string): boolean {
    const parsed = parseWirelessAddress(rawTarget);
    return parsed.ok && this.dashboardApproved.has(parsed.value.target);
  }

  private validateTarget(rawTarget: string, source: WirelessRequestSource, allowMdns: boolean): string {
    if (source === 'agent') {
      const check = checkAgentWirelessTarget(rawTarget, {
        allowMdns,
        dashboardApproved: this.dashboardApproved,
      });
      if (!check.ok) throw new PublicError(check.error);
      return check.value.target;
    }
    if (allowMdns && isMdnsSerial(rawTarget)) return rawTarget;
    const parsed = parseWirelessAddress(rawTarget);
    if (!parsed.ok) throw new PublicError(parsed.error);
    return parsed.value.target;
  }

  async connect(rawAddress: string, source: WirelessRequestSource): Promise<AdbConnectResult> {
    const target = this.validateTarget(rawAddress, source, true);
    let result: AdbConnectResult;
    try {
      result = await adbConnect(this.adb, target);
    } catch (error) {
      throw new PublicError(errorMessage(error), { cause: error });
    }
    if (source === 'dashboard') {
      this.approveFromDashboard(result.target);
      this.approveFromDashboard(result.serial);
    }
    await this.refreshDevices().catch(() => undefined);
    return result;
  }

  async disconnect(rawSerial: string, source: WirelessRequestSource): Promise<AdbDisconnectResult> {
    const target = this.validateTarget(rawSerial, source, true);
    // Stop any profiling session running on this serial before tearing down its adb transport.
    await this.stopSessionOn(target).catch(() => undefined);
    const matching = this.getDevices().find((d) => d.serial === target);
    if (matching && matching.serial !== target) {
      await this.stopSessionOn(matching.serial).catch(() => undefined);
    }
    let result: AdbDisconnectResult;
    try {
      result = await adbDisconnect(this.adb, target);
    } catch (error) {
      throw new PublicError(errorMessage(error), { cause: error });
    }
    await this.refreshDevices().catch(() => undefined);
    return result;
  }

  /**
   * Pair an Android 11+ device via `adb pair <address> <code>`, then connect on the separate connect port
   * (either `connectAddress` if supplied, or a matching `_adb-tls-connect._tcp` mDNS service when available).
   * The pairing code is never stored, logged, or echoed in any return value or error.
   */
  async pair(
    rawAddress: string,
    code: string,
    source: WirelessRequestSource,
    options: { connectAddress?: string; allowQrPassword?: boolean } = {},
  ): Promise<WirelessPairOutcome> {
    const target = this.validateTarget(rawAddress, source, false);
    const parsedPair = parseWirelessAddress(target);
    if (!parsedPair.ok) throw new PublicError(parsedPair.error);
    if (!options.allowQrPassword && !isValidPairingCode(code)) {
      throw new PublicError('Pairing code must be exactly 6 digits');
    }

    let explicitConnectTarget: string | null = null;
    if (options.connectAddress !== undefined && options.connectAddress !== '') {
      explicitConnectTarget = this.validateTarget(options.connectAddress, source, true);
    }

    let pairedGuid: string | undefined;
    try {
      const paired = await adbPair(this.adb, target, code, {
        allowQrPassword: options.allowQrPassword,
      });
      pairedGuid = paired.guid;
    } catch (error) {
      // Never attach the raw caught error as cause because it could carry the pairing secret.
      throw new PublicError(scrubSecret(errorMessage(error), code));
    }

    // Attempt follow-up connect on the separate connect port (explicit target or mDNS discovery).
    let connectTarget = explicitConnectTarget;
    if (connectTarget === null) {
      connectTarget = await this.findConnectTargetViaMdns(parsedPair.value.host, pairedGuid, source);
    }

    if (connectTarget === null) {
      await this.refreshDevices().catch(() => undefined);
      return {
        target,
        host: parsedPair.value.host,
        connectedSerial: null,
        connectNote:
          'Paired successfully. Enter the separate connect IP:port shown on the Wireless debugging screen.',
      };
    }

    try {
      const connected = await this.connect(connectTarget, source);
      return {
        target,
        host: parsedPair.value.host,
        connectedSerial: connected.serial,
      };
    } catch (error) {
      await this.refreshDevices().catch(() => undefined);
      return {
        target,
        host: parsedPair.value.host,
        connectedSerial: null,
        connectNote: `Paired successfully, but connecting to ${connectTarget} failed: ${scrubSecret(errorMessage(error), code)}`,
      };
    }
  }

  private async findConnectTargetViaMdns(
    host: string,
    guid: string | undefined,
    source: WirelessRequestSource,
  ): Promise<string | null> {
    let services: MdnsService[];
    try {
      services = await adbMdnsServices(this.adb);
    } catch {
      return null;
    }
    const connectServices = services.filter((service) => service.serviceType === MDNS_CONNECT_SERVICE);
    const byGuid = guid ? connectServices.find((service) => service.instanceName === guid) : undefined;
    const byHost = connectServices.find((service) => service.host === host);
    const match = byGuid ?? byHost;
    if (!match) return null;
    // Verify policy before auto-connecting on behalf of an agent.
    if (source === 'agent') {
      const check = checkAgentWirelessTarget(match.target, {
        allowMdns: true,
        dashboardApproved: this.dashboardApproved,
      });
      if (!check.ok) return null;
    }
    return match.target;
  }
}

/**
 * Wireless ADB connection management shared by the dashboard WebSocket gateway and AI agent tools.
 *
 * Host validation policy:
 * - Dashboard: accepts any syntactically valid IPv4/IPv6/hostname + port (or mDNS serial).
 * - Agent tools: restricts to private IPv4 (10/8, 172.16/12, 192.168/16), link-local, IPv6 ULA
 *   (fc00::/7), Tailscale (100.64/10), mDNS serials, or a host:port already connected from the
 *   dashboard in this server run.
 */
import { checkAgentWirelessTarget, isMdnsSerial, parseWirelessAddress } from '@lionscope/protocol';
import type { DeviceInfo } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';
import { adbConnect, adbDisconnect } from '../adb/wireless.ts';
import type { AdbConnectResult, AdbDisconnectResult } from '../adb/wireless.ts';
import { PublicError } from '../errors.ts';
import { errorMessage } from '../log.ts';

export type WirelessRequestSource = 'dashboard' | 'agent';

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
}

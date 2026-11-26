/**
 * Wireless ADB connection management shared by the dashboard WebSocket gateway and AI agent tools.
 *
 * Host validation policy:
 * - Dashboard: accepts any syntactically valid IPv4/IPv6/hostname + port (or mDNS serial).
 * - Agent tools: restricts to private IPv4 (10/8, 172.16/12, 192.168/16), link-local, IPv6 ULA
 *   (fc00::/7), Tailscale (100.64/10), mDNS serials, or a host:port already connected from the
 *   dashboard in this server run.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  checkAgentWirelessTarget,
  DEFAULT_ADB_TCP_PORT,
  formatAdbQrPayload,
  isMdnsSerial,
  isUsbTcpipEligible,
  isValidPairingCode,
  isValidSerial,
  MDNS_CONNECT_SERVICE,
  MDNS_PAIRING_SERVICE,
  parseWirelessAddress,
  parseWirelessPort,
  resolveDeviceTransport,
} from '@lionscope/protocol';
import type { DeviceInfo, DiscoveredWirelessDevice, QrPairingUpdate } from '@lionscope/protocol';
import { scrubSecret } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import {
  adbConnect,
  adbDisconnect,
  adbMdnsServices,
  adbPair,
  adbTcpip,
  readDeviceWifiIp,
} from '../adb/wireless.ts';
import type { AdbConnectResult, AdbDisconnectResult, MdnsService } from '../adb/wireless.ts';
import { PublicError } from '../errors.ts';
import { errorMessage } from '../log.ts';

export type WirelessRequestSource = 'dashboard' | 'agent';

const DEFAULT_QR_POLL_MS = 1000;
const DEFAULT_QR_TIMEOUT_MS = 120_000;
const DEFAULT_TCPIP_RETRY_DELAY_MS = 750;
const TCPIP_CONNECT_ATTEMPTS = 3;
const QR_PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const QR_PASSWORD_LENGTH = 16;

function generateQrPassword(): string {
  let result = '';
  for (let i = 0; i < QR_PASSWORD_LENGTH; i += 1) {
    result += QR_PASSWORD_ALPHABET[randomInt(0, QR_PASSWORD_ALPHABET.length)]!;
  }
  return result;
}

export interface WirelessPairOutcome {
  target: string;
  host: string;
  connectedSerial: string | null;
  connectNote?: string;
}

export interface QrPairingStartResult {
  sessionId: string;
  payload: string;
  serviceName: string;
  expiresAt: number;
}

export interface WirelessTcpipOutcome {
  usbSerial: string;
  serial: string;
  target: string;
  port: number;
  alreadyConnected: boolean;
}

interface ActiveQrSession {
  sessionId: string;
  owner: unknown;
  serviceName: string;
  password: string;
  expiresAt: number;
  polling: boolean;
  timer: ReturnType<typeof setInterval>;
  onUpdate: (update: QrPairingUpdate) => void;
}

export interface WirelessServiceOptions {
  adb: Adb;
  refreshDevices: () => Promise<DeviceInfo[]>;
  stopSessionOn: (serial: string) => Promise<void>;
  getDevices: () => readonly DeviceInfo[];
  now?: () => number;
  qrPollMs?: number;
  qrTimeoutMs?: number;
  tcpipRetryDelayMs?: number;
}

export class WirelessService {
  private readonly adb: Adb;
  private readonly refreshDevices: () => Promise<DeviceInfo[]>;
  private readonly stopSessionOn: (serial: string) => Promise<void>;
  private readonly getDevices: () => readonly DeviceInfo[];
  private readonly now: () => number;
  private readonly qrPollMs: number;
  private readonly qrTimeoutMs: number;
  private readonly tcpipRetryDelayMs: number;
  /** Normalized `host:port` endpoints connected by the user from the dashboard during this server run. */
  private readonly dashboardApproved = new Set<string>();
  private readonly qrSessions = new Map<string, ActiveQrSession>();
  private closed = false;

  constructor(options: WirelessServiceOptions) {
    this.adb = options.adb;
    this.refreshDevices = options.refreshDevices;
    this.stopSessionOn = options.stopSessionOn;
    this.getDevices = options.getDevices;
    this.now = options.now ?? Date.now;
    this.qrPollMs = options.qrPollMs ?? DEFAULT_QR_POLL_MS;
    this.qrTimeoutMs = options.qrTimeoutMs ?? DEFAULT_QR_TIMEOUT_MS;
    this.tcpipRetryDelayMs = options.tcpipRetryDelayMs ?? DEFAULT_TCPIP_RETRY_DELAY_MS;
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

  /** Discover wireless devices advertising `_adb-tls-connect._tcp` via `adb mdns services`. */
  async listMdnsConnectDevices(): Promise<DiscoveredWirelessDevice[]> {
    let services: MdnsService[];
    try {
      services = await adbMdnsServices(this.adb);
    } catch (error) {
      throw new PublicError(
        `Could not query mDNS services (check adb version / mDNS support): ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const connectedSerials = new Set(this.getDevices().map((d) => d.serial));
    return services
      .filter((service) => service.serviceType === MDNS_CONNECT_SERVICE)
      .map((service) => ({
        instanceName: service.instanceName,
        host: service.host,
        port: service.port,
        target: service.target,
        serial: service.serial,
        connected: connectedSerials.has(service.target) || connectedSerials.has(service.serial),
      }));
  }

  /**
   * Start an ephemeral Android 11+ QR pairing session (`WIFI:T:ADB;S:<name>;P:<password>;;`) and poll
   * `adb mdns services` for the matching `_adb-tls-pairing._tcp` advertisement.
   */
  startQrPairing(owner: unknown, onUpdate: (update: QrPairingUpdate) => void): QrPairingStartResult {
    if (this.closed) throw new PublicError('Server is shutting down');
    this.cancelQrForOwner(owner);
    const sessionId = randomBytes(8).toString('hex');
    const serviceName = `ADB_WIFI_${randomBytes(6).toString('hex')}`;
    const password = generateQrPassword();
    const expiresAt = this.now() + this.qrTimeoutMs;
    const payload = formatAdbQrPayload(serviceName, password);

    const session: ActiveQrSession = {
      sessionId,
      owner,
      serviceName,
      password,
      expiresAt,
      polling: false,
      timer: setInterval(() => void this.pollQrSession(sessionId), this.qrPollMs),
      onUpdate,
    };
    session.timer.unref();
    this.qrSessions.set(sessionId, session);
    return { sessionId, payload, serviceName, expiresAt };
  }

  cancelQrPairing(sessionId: string): void {
    const session = this.qrSessions.get(sessionId);
    if (!session) return;
    this.disposeQrSession(session);
    session.onUpdate({ sessionId, status: 'cancelled' });
  }

  cancelQrForOwner(owner: unknown): void {
    for (const session of this.qrSessions.values()) {
      if (session.owner === owner) this.disposeQrSession(session);
    }
  }

  close(): void {
    this.closed = true;
    for (const session of this.qrSessions.values()) this.disposeQrSession(session);
  }

  private disposeQrSession(session: ActiveQrSession): void {
    clearInterval(session.timer);
    session.password = '';
    this.qrSessions.delete(session.sessionId);
  }

  private async pollQrSession(sessionId: string): Promise<void> {
    const session = this.qrSessions.get(sessionId);
    if (!session || session.polling || this.closed) return;
    if (this.now() >= session.expiresAt) {
      this.disposeQrSession(session);
      session.onUpdate({ sessionId, status: 'expired' });
      return;
    }
    session.polling = true;
    let services: MdnsService[];
    try {
      services = await adbMdnsServices(this.adb);
    } catch {
      session.polling = false;
      return;
    }
    // Re-check after await in case the session was cancelled meanwhile.
    if (!this.qrSessions.has(sessionId) || this.closed) return;
    session.polling = false;

    const match = services.find(
      (service) =>
        service.serviceType === MDNS_PAIRING_SERVICE && service.instanceName === session.serviceName,
    );
    if (!match) {
      if (this.now() >= session.expiresAt) {
        this.disposeQrSession(session);
        session.onUpdate({ sessionId, status: 'expired' });
      }
      return;
    }

    const password = session.password;
    const onUpdate = session.onUpdate;
    this.disposeQrSession(session);
    onUpdate({ sessionId, status: 'pairing', target: match.target });
    try {
      const outcome = await this.pair(match.target, password, 'dashboard', { allowQrPassword: true });
      onUpdate({
        sessionId,
        status: 'paired',
        target: outcome.target,
        host: outcome.host,
        connectedSerial: outcome.connectedSerial,
        ...(outcome.connectNote ? { connectNote: outcome.connectNote } : {}),
      });
    } catch (error) {
      onUpdate({
        sessionId,
        status: 'failed',
        message: scrubSecret(errorMessage(error), password),
      });
    }
  }

  /**
   * USB → Wi-Fi handoff: read the USB-connected phone's Wi-Fi IP, validate it against the caller's
   * host policy, switch adbd to TCP/IP mode (`adb tcpip <port>`), and connect over Wi-Fi.
   * Port stays open on the phone's Wi-Fi network until reboot (or `adb usb`).
   */
  async enableTcpipHandoff(
    usbSerial: string,
    source: WirelessRequestSource,
    options: { port?: number } = {},
  ): Promise<WirelessTcpipOutcome> {
    if (!isValidSerial(usbSerial)) throw new PublicError('Invalid adb serial');
    const port = parseWirelessPort(options.port ?? DEFAULT_ADB_TCP_PORT);
    if (port === null) throw new PublicError('Port must be a whole number from 1 to 65535');

    const device = this.getDevices().find((candidate) => candidate.serial === usbSerial);
    if (!device) throw new PublicError(`Device ${usbSerial} is not connected`);
    if (device.state !== 'device') throw new PublicError(`Device ${usbSerial} is ${device.state}`);
    const transport = resolveDeviceTransport(device);
    if (transport === 'emulator') {
      throw new PublicError('Emulators cannot be switched to wireless TCP/IP mode');
    }
    if (transport === 'wireless') {
      throw new PublicError(`Device ${usbSerial} is already connected wirelessly`);
    }
    if (!isUsbTcpipEligible(device)) {
      throw new PublicError(`Device ${usbSerial} is not an eligible USB device`);
    }

    let wifiIp: string;
    try {
      wifiIp = await readDeviceWifiIp(this.adb, usbSerial);
    } catch (error) {
      throw new PublicError(errorMessage(error), { cause: error });
    }

    // Validate the device-reported IP against caller host policy BEFORE opening TCP/IP or connecting.
    const target = this.validateTarget(`${wifiIp}:${port}`, source, false);

    try {
      await adbTcpip(this.adb, usbSerial, port);
    } catch (error) {
      throw new PublicError(errorMessage(error), { cause: error });
    }

    let connected: AdbConnectResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= TCPIP_CONNECT_ATTEMPTS; attempt += 1) {
      if (attempt > 1 && this.tcpipRetryDelayMs > 0) await sleep(this.tcpipRetryDelayMs);
      try {
        connected = await adbConnect(this.adb, target);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!connected) {
      throw new PublicError(
        `Enabled TCP/IP mode on port ${port}, but connecting to ${target} failed: ${errorMessage(lastError)}`,
        { cause: lastError },
      );
    }

    if (source === 'dashboard') {
      this.approveFromDashboard(connected.target);
      this.approveFromDashboard(connected.serial);
    }
    await this.refreshDevices().catch(() => undefined);
    return {
      usbSerial,
      serial: connected.serial,
      target: connected.target,
      port,
      alreadyConnected: connected.alreadyConnected,
    };
  }
}

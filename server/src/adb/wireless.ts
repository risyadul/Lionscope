/**
 * Host-side wireless ADB operations (`pair`, `connect`, `disconnect`, `tcpip`, `mdns services`).
 * Every call validates its arguments, passes them via argv arrays (never a shell), and keeps
 * pairing secrets out of return values and errors.
 */
import {
  classifyIpv4,
  DEFAULT_ADB_TCP_PORT,
  isAdbMdnsTransportSerial,
  isMdnsSerial,
  isValidPairingCode,
  isValidSerial,
  MDNS_CONNECT_SERVICE,
  MDNS_PAIRING_SERVICE,
  parseIpv4,
  parseWirelessAddress,
  parseWirelessPort,
  validateWirelessEndpoint,
} from '@lionscope/protocol';
import type { MdnsServiceType } from '@lionscope/protocol';
import { adbShell, scrubSecret } from './adb.ts';
import type { Adb, ExecOptions } from './adb.ts';

const PAIR_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_TIMEOUT_MS = 10_000;
const TCPIP_TIMEOUT_MS = 10_000;
const MDNS_TIMEOUT_MS = 5_000;

/** Safe instance name for mDNS service records (no whitespace, control chars, or leading `-`). */
const MDNS_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Safe QR pairing password: printable ASCII without whitespace, delimiters or leading `-`. */
const QR_PASSWORD_PATTERN = /^[A-Za-z0-9._~+=!@#$%^&*]{6,64}$/;

export interface AdbPairResult {
  target: string;
  guid?: string;
}

export interface AdbConnectResult {
  target: string;
  serial: string;
  alreadyConnected: boolean;
}

export interface AdbDisconnectResult {
  target: string;
}

export interface AdbTcpipResult {
  serial: string;
  port: number;
}

export interface MdnsService {
  instanceName: string;
  serviceType: MdnsServiceType;
  host: string;
  port: number;
  target: string;
  serial: string;
}

function cleanOutput(output: string): string {
  return output.trim().replace(/\s+/g, ' ');
}

/**
 * `adb pair <host:port> <code>`. By default requires a 6-digit pairing code; QR pairing may pass
 * `allowQrPassword: true` for a generated random password. Never includes `code` in results or errors.
 */
export async function adbPair(
  adb: Adb,
  rawTarget: string,
  code: string,
  options: ExecOptions & { allowQrPassword?: boolean } = {},
): Promise<AdbPairResult> {
  const parsed = parseWirelessAddress(rawTarget);
  if (!parsed.ok) throw new Error(parsed.error);
  const validCode = options.allowQrPassword ? QR_PASSWORD_PATTERN.test(code) : isValidPairingCode(code);
  if (!validCode) {
    throw new Error(
      options.allowQrPassword ? 'Invalid pairing password' : 'Pairing code must be exactly 6 digits',
    );
  }
  let stdout: string;
  try {
    stdout = await adb.exec(['pair', parsed.value.target, code], {
      timeoutMs: options.timeoutMs ?? PAIR_TIMEOUT_MS,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line preserve-caught-error -- Never retain raw caught error as cause: it could hold the pairing secret.
    throw new Error(scrubSecret(raw, code));
  }
  const safeStdout = scrubSecret(cleanOutput(stdout), code);
  if (!/\bsuccessfully paired\b/i.test(safeStdout)) {
    throw new Error(safeStdout || `Failed to pair with ${parsed.value.target}`);
  }
  const guid = /\[guid=([A-Za-z0-9._-]+)\]/.exec(safeStdout)?.[1];
  return guid ? { target: parsed.value.target, guid } : { target: parsed.value.target };
}

/** `adb connect <host:port | mdns-serial>`. Throws when adb prints a refusal despite exiting 0. */
export async function adbConnect(
  adb: Adb,
  rawTarget: string,
  options: ExecOptions = {},
): Promise<AdbConnectResult> {
  let target: string;
  if (isMdnsSerial(rawTarget) || isAdbMdnsTransportSerial(rawTarget)) {
    target = rawTarget;
  } else {
    const parsed = parseWirelessAddress(rawTarget);
    if (!parsed.ok) throw new Error(parsed.error);
    target = parsed.value.target;
  }
  const stdout = await adb.exec(['connect', target], {
    timeoutMs: options.timeoutMs ?? CONNECT_TIMEOUT_MS,
  });
  const text = cleanOutput(stdout);
  const already = /\balready connected to\s+(\S+)/i.exec(text);
  if (already?.[1]) {
    return { target, serial: already[1], alreadyConnected: true };
  }
  const connected = /\bconnected to\s+(\S+)/i.exec(text);
  if (connected?.[1] && !/\b(?:cannot|failed|unable)\b/i.test(text)) {
    return { target, serial: connected[1], alreadyConnected: false };
  }
  throw new Error(text || `Could not connect to ${target}`);
}

/**
 * `adb disconnect <target>`. Always requires a specific validated wireless target so it can never
 * invoke bare `adb disconnect` (which disconnects every wireless device).
 */
export async function adbDisconnect(
  adb: Adb,
  rawTarget: string,
  options: ExecOptions = {},
): Promise<AdbDisconnectResult> {
  let target: string;
  if (isMdnsSerial(rawTarget) || isAdbMdnsTransportSerial(rawTarget)) {
    target = rawTarget;
  } else {
    const parsed = parseWirelessAddress(rawTarget);
    if (!parsed.ok) throw new Error(parsed.error);
    // Preserve exact hostname casing as listed by `adb devices` while still enforcing full endpoint validation.
    target = rawTarget;
  }
  const stdout = await adb.exec(['disconnect', target], {
    timeoutMs: options.timeoutMs ?? DISCONNECT_TIMEOUT_MS,
  });
  const text = cleanOutput(stdout);
  if (/^error:/i.test(text) || /\bno such device\b/i.test(text)) {
    throw new Error(text);
  }
  return { target };
}

/** `adb -s <serial> tcpip <port>` (defaults to 5555). */
export async function adbTcpip(
  adb: Adb,
  serial: string,
  port: number = DEFAULT_ADB_TCP_PORT,
  options: ExecOptions = {},
): Promise<AdbTcpipResult> {
  if (!isValidSerial(serial)) throw new Error('Invalid adb serial');
  const validPort = parseWirelessPort(port);
  if (validPort === null) throw new Error('Invalid TCP port');
  const stdout = await adb.exec(['-s', serial, 'tcpip', String(validPort)], {
    timeoutMs: options.timeoutMs ?? TCPIP_TIMEOUT_MS,
  });
  const text = cleanOutput(stdout);
  if (/^error:/i.test(text)) throw new Error(text);
  return { serial, port: validPort };
}

function parseMdnsAddress(raw: string): { host: string; port: number; target: string } | null {
  const direct = parseWirelessAddress(raw);
  if (direct.ok) {
    return { host: direct.value.host, port: direct.value.port, target: direct.value.target };
  }
  // Some adb versions print unbracketed IPv6 in `adb mdns services`, e.g. `fe80::1:37421`.
  const lastColon = raw.lastIndexOf(':');
  if (lastColon <= 0 || raw.startsWith('[')) return null;
  const endpoint = validateWirelessEndpoint(raw.slice(0, lastColon), raw.slice(lastColon + 1));
  if (!endpoint.ok || endpoint.value.kind !== 'ipv6') return null;
  return { host: endpoint.value.host, port: endpoint.value.port, target: endpoint.value.target };
}

/** Parse `adb mdns services` into validated connect/pairing records. */
export function parseMdnsServices(output: string): MdnsService[] {
  const services: MdnsService[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of discovered') || line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [instanceName = '', rawType = '', rawAddr = ''] = parts;
    if (!MDNS_INSTANCE_PATTERN.test(instanceName)) continue;
    const serviceType = rawType.replace(/\.$/, '');
    if (serviceType !== MDNS_CONNECT_SERVICE && serviceType !== MDNS_PAIRING_SERVICE) continue;
    const parsed = parseMdnsAddress(rawAddr);
    if (!parsed) continue;
    services.push({
      instanceName,
      serviceType,
      host: parsed.host,
      port: parsed.port,
      target: parsed.target,
      serial: `${instanceName}.${serviceType}`,
    });
  }
  return services;
}

/** `adb mdns services`, parsed into discovered wireless ADB endpoints. */
export async function adbMdnsServices(adb: Adb, options: ExecOptions = {}): Promise<MdnsService[]> {
  const stdout = await adb.exec(['mdns', 'services'], {
    timeoutMs: options.timeoutMs ?? MDNS_TIMEOUT_MS,
  });
  return parseMdnsServices(stdout);
}

/** Extract a non-loopback IPv4 address from `ip -f inet addr show wlan0` or `ip route`. */
export function parseDeviceWifiIp(output: string): string | null {
  for (const match of output.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)\/\d+\b/g)) {
    const ip = match[1] ?? '';
    const octets = parseIpv4(ip);
    if (octets && classifyIpv4(octets) !== 'loopback') return ip;
  }
  for (const line of output.split(/\r?\n/)) {
    if (!/\bdev\s+(?:wlan|wifi)\w*\b/.test(line)) continue;
    const match = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/.exec(line);
    const ip = match?.[1] ?? '';
    const octets = parseIpv4(ip);
    if (octets && classifyIpv4(octets) !== 'loopback') return ip;
  }
  return null;
}

/** Read a USB-connected phone's Wi-Fi IPv4 address via `ip -f inet addr show wlan0` (fallback: `ip route`). */
export async function readDeviceWifiIp(adb: Adb, serial: string, options: ExecOptions = {}): Promise<string> {
  if (!isValidSerial(serial)) throw new Error('Invalid adb serial');
  const timeoutMs = options.timeoutMs ?? MDNS_TIMEOUT_MS;
  const wlanOut = await adbShell(adb, serial, 'ip -f inet addr show wlan0', { timeoutMs }).catch(() => '');
  const fromWlan = parseDeviceWifiIp(wlanOut);
  if (fromWlan) return fromWlan;
  const routeOut = await adbShell(adb, serial, 'ip route', { timeoutMs }).catch(() => '');
  const fromRoute = parseDeviceWifiIp(routeOut);
  if (fromRoute) return fromRoute;
  throw new Error("Could not read the phone's Wi-Fi IP address. Connect the phone to Wi-Fi and try again.");
}

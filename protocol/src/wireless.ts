/**
 * Wireless ADB validation and host classification helpers.
 *
 * Dependency-free so both the server and the dashboard (`@lionscope/protocol/wire`) can reuse the
 * exact same syntax, port, pairing-code and network-scope rules.
 */

export type DeviceTransport = 'usb' | 'wireless' | 'emulator';

export const MIN_WIRELESS_PORT = 1;
export const MAX_WIRELESS_PORT = 65535;
export const DEFAULT_ADB_TCP_PORT = 5555;

/** Android 11+ manual wireless pairing code: exactly 6 ASCII digits. */
export const PAIRING_CODE_PATTERN = /^\d{6}$/;

export const MDNS_CONNECT_SERVICE = '_adb-tls-connect._tcp';
export const MDNS_PAIRING_SERVICE = '_adb-tls-pairing._tcp';
export type MdnsServiceType = typeof MDNS_CONNECT_SERVICE | typeof MDNS_PAIRING_SERVICE;

/**
 * Wireless ADB mDNS serial as reported by `adb devices -l` / `adb mdns services`, e.g.
 * `adb-R58M123ABC-abc123._adb-tls-connect._tcp`.
 */
export const MDNS_SERIAL_PATTERN = /^adb-[A-Za-z0-9._-]{1,80}\._adb-tls-(?:connect|pairing)\._tcp$/;

export type WirelessHostKind = 'ipv4' | 'ipv6' | 'hostname';

/**
 * Network scope of a wireless host:
 * - `private`: RFC 1918 IPv4 (10/8, 172.16/12, 192.168/16) or IPv6 ULA (fc00::/7)
 * - `link_local`: IPv4 169.254/16 or IPv6 fe80::/10
 * - `tailscale`: CGNAT / Tailscale 100.64/10
 * - `loopback`: 127/8, 0/8, ::, ::1
 * - `public`: any other IPv4/IPv6 literal
 * - `hostname`: DNS / mDNS hostname (scope unknown without resolution)
 * - `mdns`: adb mDNS TLS serial
 */
export type WirelessHostScope =
  'private' | 'link_local' | 'tailscale' | 'mdns' | 'loopback' | 'public' | 'hostname';

export interface ParsedWirelessEndpoint {
  /** Bare host (no brackets for IPv6). */
  host: string;
  port: number;
  /** Normalized `host:port` (bracketed `[ipv6]:port` for IPv6). */
  target: string;
  kind: WirelessHostKind;
  scope: Exclude<WirelessHostScope, 'mdns'>;
  /** True when the host is a global/public IP literal (dashboard shows a warning). */
  isPublicIp: boolean;
}

export type WirelessValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Disallowed in every host, port or code input: whitespace, control/format chars, shell metacharacters. */
const UNSAFE_INPUT_CHARS = /[\s\p{Cc}\p{Cf};&|$`<>\\'"*?#!~{}=/%()[\]]/u;
const IPV4_PATTERN = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
const PORT_STRING_PATTERN = /^[1-9]\d{0,4}$/;
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ALL_DIGITS_PATTERN = /^\d+$/;
const IPV6_CHARS_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/;
const MAX_HOSTNAME_LENGTH = 253;

export const AGENT_ALLOWED_HOST_SCOPES: ReadonlySet<WirelessHostScope> = new Set([
  'private',
  'link_local',
  'tailscale',
  'mdns',
]);

export const AGENT_HOST_POLICY_MESSAGE =
  'Agent wireless actions only allow private IPv4 (10/8, 172.16/12, 192.168/16), link-local, IPv6 ULA (fc00::/7), Tailscale (100.64/10), mDNS serials, or a host:port already connected from the dashboard in this server run.';

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code);
}

export function isMdnsSerial(value: string): boolean {
  return MDNS_SERIAL_PATTERN.test(value);
}

export function parseWirelessPort(raw: number | string): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= MIN_WIRELESS_PORT && raw <= MAX_WIRELESS_PORT ? raw : null;
  }
  if (!PORT_STRING_PATTERN.test(raw)) return null;
  const port = Number(raw);
  return port >= MIN_WIRELESS_PORT && port <= MAX_WIRELESS_PORT ? port : null;
}

export function parseIpv4(host: string): [number, number, number, number] | null {
  if (!IPV4_PATTERN.test(host)) return null;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((octet) => octet < 0 || octet > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

export function classifyIpv4(
  octets: readonly [number, number, number, number],
): 'private' | 'link_local' | 'tailscale' | 'loopback' | 'public' {
  const [a, b] = octets;
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (a === 127 || a === 0) return 'loopback';
  return 'public';
}

function parseIpv6Groups(segment: string): number[] | null {
  if (segment === '') return [];
  const parts = segment.split(':');
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.includes('.')) {
      // Embedded IPv4 is only valid as the trailing 32 bits.
      if (i !== parts.length - 1) return null;
      const ipv4 = parseIpv4(part);
      if (!ipv4) return null;
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    } else {
      if (!IPV6_GROUP_PATTERN.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
  }
  return groups;
}

export function parseIpv6(host: string): number[] | null {
  if (!host.includes(':') || !IPV6_CHARS_PATTERN.test(host)) return null;
  if (host.includes(':::')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = parseIpv6Groups(halves[0]!);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = parseIpv6Groups(halves[0]!);
  const right = parseIpv6Groups(halves[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function classifyIpv6(
  groups: readonly number[],
): 'private' | 'link_local' | 'tailscale' | 'loopback' | 'public' {
  if (groups.length !== 8) return 'public';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // :: (unspecified) and ::1 (loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) {
    return 'loopback';
  }
  // IPv4-mapped IPv6 ::ffff:a.b.c.d — classify by embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
  }
  // ULA fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return 'link_local';
  return 'public';
}

export function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false;
  if (host.startsWith('-') || host.startsWith('.') || host.endsWith('.')) return false;
  if (UNSAFE_INPUT_CHARS.test(host)) return false;
  const labels = host.split('.');
  if (labels.some((label) => !HOSTNAME_LABEL_PATTERN.test(label))) return false;
  // Reject all-numeric final labels (e.g. "12345" or malformed IPv4 "1.2.3" / "999.1.1.1").
  const last = labels[labels.length - 1]!;
  if (ALL_DIGITS_PATTERN.test(last)) return false;
  return true;
}

/** Validate a bare host (IPv4, IPv6, or RFC 1123 hostname) and classify its network scope. */
export function classifyWirelessHost(rawHost: string): WirelessValidationResult<{
  host: string;
  kind: WirelessHostKind;
  scope: Exclude<WirelessHostScope, 'mdns'>;
  isPublicIp: boolean;
}> {
  if (rawHost.length === 0) return { ok: false, error: 'Host is required' };
  if (rawHost.startsWith('-')) return { ok: false, error: 'Host must not start with -' };

  // Reject brackets on bare host; IPv6 brackets are stripped by parseWirelessAddress.
  if (UNSAFE_INPUT_CHARS.test(rawHost)) {
    return { ok: false, error: 'Host contains unsupported or unsafe characters' };
  }

  const ipv4 = parseIpv4(rawHost);
  if (ipv4) {
    const scope = classifyIpv4(ipv4);
    return { ok: true, value: { host: rawHost, kind: 'ipv4', scope, isPublicIp: scope === 'public' } };
  }

  if (rawHost.includes(':')) {
    const ipv6 = parseIpv6(rawHost);
    if (!ipv6) return { ok: false, error: 'Invalid IPv6 address' };
    const scope = classifyIpv6(ipv6);
    return {
      ok: true,
      value: { host: rawHost.toLowerCase(), kind: 'ipv6', scope, isPublicIp: scope === 'public' },
    };
  }

  if (isValidHostname(rawHost)) {
    const normalized = rawHost.toLowerCase();
    const scope = normalized === 'localhost' ? 'loopback' : 'hostname';
    return { ok: true, value: { host: normalized, kind: 'hostname', scope, isPublicIp: false } };
  }

  return { ok: false, error: 'Invalid IP address or hostname' };
}

/** Validate a host + port pair into a normalized wireless ADB endpoint. */
export function validateWirelessEndpoint(
  rawHost: string,
  rawPort: number | string,
): WirelessValidationResult<ParsedWirelessEndpoint> {
  // Strip outer IPv6 brackets if the caller passed "[fd00::1]" in a separate host field.
  const bareHost =
    rawHost.startsWith('[') && rawHost.endsWith(']') && rawHost.includes(':')
      ? rawHost.slice(1, -1)
      : rawHost;
  const classified = classifyWirelessHost(bareHost);
  if (!classified.ok) return classified;
  const port = parseWirelessPort(rawPort);
  if (port === null) {
    return {
      ok: false,
      error: `Port must be a whole number from ${MIN_WIRELESS_PORT} to ${MAX_WIRELESS_PORT}`,
    };
  }
  const { host, kind, scope, isPublicIp } = classified.value;
  const target = kind === 'ipv6' ? `[${host}]:${port}` : `${host}:${port}`;
  return { ok: true, value: { host, port, target, kind, scope, isPublicIp } };
}

/**
 * Parse a `host:port` string (IPv4:port, [IPv6]:port, or hostname:port).
 * Rejects leading `-`, whitespace, control chars, shell metacharacters, and out-of-range ports.
 */
export function parseWirelessAddress(raw: string): WirelessValidationResult<ParsedWirelessEndpoint> {
  if (raw.length === 0) return { ok: false, error: 'Address is required' };
  if (raw.startsWith('-')) return { ok: false, error: 'Address must not start with -' };
  if (/[\s\p{Cc}\p{Cf}]/u.test(raw)) {
    return { ok: false, error: 'Address must not contain whitespace or control characters' };
  }

  if (raw.startsWith('[')) {
    const closeBracket = raw.indexOf(']');
    if (closeBracket <= 1 || raw[closeBracket + 1] !== ':') {
      return { ok: false, error: 'IPv6 addresses must use [host]:port format' };
    }
    const host = raw.slice(1, closeBracket);
    const portPart = raw.slice(closeBracket + 2);
    if (!host.includes(':')) return { ok: false, error: 'Invalid IPv6 address' };
    return validateWirelessEndpoint(host, portPart);
  }

  const firstColon = raw.indexOf(':');
  const lastColon = raw.lastIndexOf(':');
  if (firstColon === -1) return { ok: false, error: 'Address must include a port (host:port)' };
  if (firstColon !== lastColon) {
    return { ok: false, error: 'IPv6 addresses must use [host]:port format' };
  }

  return validateWirelessEndpoint(raw.slice(0, lastColon), raw.slice(lastColon + 1));
}

/** True when `serial` looks like a wireless ADB serial (`host:port` or mDNS TLS service serial). */
export function isWirelessSerial(serial: string): boolean {
  return isMdnsSerial(serial) || parseWirelessAddress(serial).ok;
}

/** True when `rawHostOrAddress` is a syntactically valid public IP address (IPv4 or IPv6). */
export function isPublicWirelessHost(rawHostOrAddress: string): boolean {
  const addr = parseWirelessAddress(rawHostOrAddress);
  if (addr.ok) return addr.value.isPublicIp;
  const bare =
    rawHostOrAddress.startsWith('[') && rawHostOrAddress.endsWith(']') && rawHostOrAddress.includes(':')
      ? rawHostOrAddress.slice(1, -1)
      : rawHostOrAddress;
  const host = classifyWirelessHost(bare);
  return host.ok && host.value.isPublicIp;
}

export interface AgentTargetCheck {
  target: string;
  scope: WirelessHostScope;
  /** True when permitted because the user connected this exact host:port from the dashboard. */
  approvedByDashboard: boolean;
}

/**
 * Validate a wireless target for AI agent tools:
 * permits private IPv4, link-local, IPv6 ULA, Tailscale (100.64/10), mDNS serials, or a `host:port`
 * already connected from the dashboard in this server run.
 */
export function checkAgentWirelessTarget(
  rawTarget: string,
  options: {
    allowMdns?: boolean;
    dashboardApproved?: ReadonlySet<string>;
  } = {},
): WirelessValidationResult<AgentTargetCheck> {
  if (options.allowMdns && isMdnsSerial(rawTarget)) {
    return { ok: true, value: { target: rawTarget, scope: 'mdns', approvedByDashboard: false } };
  }
  const parsed = parseWirelessAddress(rawTarget);
  if (!parsed.ok) return parsed;
  const { target, scope } = parsed.value;
  if (AGENT_ALLOWED_HOST_SCOPES.has(scope)) {
    return { ok: true, value: { target, scope, approvedByDashboard: false } };
  }
  if (options.dashboardApproved?.has(target)) {
    return { ok: true, value: { target, scope, approvedByDashboard: true } };
  }
  return { ok: false, error: AGENT_HOST_POLICY_MESSAGE };
}

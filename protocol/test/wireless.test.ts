// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_POLICY_MESSAGE,
  checkAgentWirelessTarget,
  classifyWirelessHost,
  deriveDeviceTransport,
  isLegacyNumericIpv4,
  isMdnsSerial,
  isPublicWirelessHost,
  isUsbTcpipEligible,
  isValidPairingCode,
  isWirelessSerial,
  parseIpv4,
  parseIpv6,
  parseWirelessAddress,
  parseWirelessPort,
  resolveDeviceTransport,
  validateWirelessEndpoint,
} from '../src/wireless.ts';

describe('wireless host & port validation', () => {
  it('validates ports in 1..65535 and rejects invalid ones', () => {
    expect(parseWirelessPort(1)).toBe(1);
    expect(parseWirelessPort(5555)).toBe(5555);
    expect(parseWirelessPort(65535)).toBe(65535);
    expect(parseWirelessPort('37421')).toBe(37421);

    for (const bad of [0, -1, 65536, 1.5, Number.NaN, '', '0', '05555', '-5555', '5555 ', '5555;id', 'abc']) {
      expect(parseWirelessPort(bad)).toBeNull();
    }
  });

  it('validates 6-digit pairing codes strictly', () => {
    expect(isValidPairingCode('000000')).toBe(true);
    expect(isValidPairingCode('482910')).toBe(true);
    for (const bad of ['', '12345', '1234567', '12345a', '123 456', '-12345', '123456\n']) {
      expect(isValidPairingCode(bad)).toBe(false);
    }
  });

  it('parses and classifies IPv4 addresses across private, link-local, Tailscale, loopback, and public ranges', () => {
    expect(parseIpv4('192.168.1.5')).toEqual([192, 168, 1, 5]);
    expect(parseIpv4('010.0.0.1')).toBeNull();
    expect(parseIpv4('256.0.0.1')).toBeNull();

    const cases: readonly [string, string, boolean][] = [
      ['10.0.0.1', 'private', false],
      ['10.255.255.254', 'private', false],
      ['172.16.0.1', 'private', false],
      ['172.31.255.254', 'private', false],
      ['192.168.0.1', 'private', false],
      ['192.168.1.42', 'private', false],
      ['169.254.10.20', 'link_local', false],
      ['100.64.0.1', 'tailscale', false],
      ['100.127.255.254', 'tailscale', false],
      ['127.0.0.1', 'loopback', false],
      ['0.0.0.0', 'loopback', false],
      ['172.15.0.1', 'public', true],
      ['172.32.0.1', 'public', true],
      ['100.63.255.255', 'public', true],
      ['100.128.0.1', 'public', true],
      ['8.8.8.8', 'public', true],
      ['1.1.1.1', 'public', true],
    ];
    for (const [host, scope, isPublicIp] of cases) {
      const res = classifyWirelessHost(host);
      expect(res, host).toEqual({
        ok: true,
        value: { host, kind: 'ipv4', scope, isPublicIp },
      });
    }
  });

  it('parses and classifies IPv6 addresses including ULA, link-local, loopback, IPv4-mapped, and public', () => {
    expect(parseIpv6('fd00::1')).toEqual([0xfd00, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:192.168.1.5')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0105]);
    expect(parseIpv6('fd00:::1')).toBeNull();
    expect(parseIpv6('fd00::1::2')).toBeNull();
    expect(parseIpv6('fd00::gggg')).toBeNull();
    // Embedded IPv4 before `::` is invalid per RFC 4291 and node:net isIP.
    for (const badIpv6 of ['192.168.1.1::1', '192.168.1.1::', 'fd00:192.168.1.1::1']) {
      expect(isIP(badIpv6)).toBe(0);
      expect(parseIpv6(badIpv6), badIpv6).toBeNull();
      expect(parseWirelessAddress(`[${badIpv6}]:5555`).ok, badIpv6).toBe(false);
    }

    const cases: readonly [string, string, boolean][] = [
      ['fc00::1', 'private', false],
      ['fd12:3456:789a::1', 'private', false],
      ['fe80::1', 'link_local', false],
      ['febf::1234', 'link_local', false],
      ['::1', 'loopback', false],
      ['::', 'loopback', false],
      ['::ffff:192.168.1.5', 'private', false],
      ['::ffff:100.64.1.2', 'tailscale', false],
      ['::ffff:8.8.8.8', 'public', true],
      ['2001:4860:4860::8888', 'public', true],
      ['fe00::1', 'public', true],
    ];
    for (const [host, scope, isPublicIp] of cases) {
      const res = classifyWirelessHost(host);
      expect(res, host).toEqual({
        ok: true,
        value: { host, kind: 'ipv6', scope, isPublicIp },
      });
    }
  });

  it('parses host:port endpoints and rejects leading dashes, whitespace, and shell metacharacters', () => {
    expect(parseWirelessAddress('192.168.1.5:5555')).toEqual({
      ok: true,
      value: {
        host: '192.168.1.5',
        port: 5555,
        target: '192.168.1.5:5555',
        kind: 'ipv4',
        scope: 'private',
        isPublicIp: false,
      },
    });
    expect(parseWirelessAddress('[FD00::1]:37123')).toEqual({
      ok: true,
      value: {
        host: 'fd00::1',
        port: 37123,
        target: '[fd00::1]:37123',
        kind: 'ipv6',
        scope: 'private',
        isPublicIp: false,
      },
    });
    expect(parseWirelessAddress('pixel-9.local:5555')).toEqual({
      ok: true,
      value: {
        host: 'pixel-9.local',
        port: 5555,
        target: 'pixel-9.local:5555',
        kind: 'hostname',
        scope: 'hostname',
        isPublicIp: false,
      },
    });
    expect(validateWirelessEndpoint('[fd00::1]', 5555)).toMatchObject({
      ok: true,
      value: { host: 'fd00::1', port: 5555, target: '[fd00::1]:5555' },
    });

    const badAddresses = [
      '',
      '192.168.1.5',
      '-192.168.1.5:5555',
      '-s:5555',
      '192.168.1.5:0',
      '192.168.1.5:65536',
      '192.168.1.5:5555;id',
      '192.168.1.5:5555 && ls',
      '$(whoami):5555',
      'foo`id`:5555',
      '192.168.1.5 :5555',
      '192.168.1.5:5555\n',
      'fd00::1:5555',
      '1.2.3:5555',
      '999.1.1.1:5555',
      '12345:5555',
      'bad_host:5555',
      // Legacy inet_aton numeric IPv4 forms (hex, octal, short integer) must never slip through as hostnames.
      '0x7f.1:5555',
      '0x7f.0x1:5555',
      '0x7f000001:5555',
      '0177.0.0.1:5555',
      '127.1:5555',
      '3232235777:5555',
      '8.8.8.0x8:5555',
      '0x08080808:5555',
      // Reserved single-label ADB socket_spec prefixes must not be accepted as connect hostnames (any case).
      'usb:5555',
      'USB:5555',
      'tcp:5555',
      'TCP:5555',
      'vsock:5555',
      'localabstract:5555',
      'acceptfd:5555',
    ];
    for (const addr of badAddresses) {
      expect(parseWirelessAddress(addr).ok, addr).toBe(false);
    }
    // Qualified hostnames sharing those labels remain valid.
    expect(parseWirelessAddress('usb.local:5555').ok).toBe(true);
    expect(isLegacyNumericIpv4('0x7f.1')).toBe(true);
    expect(isLegacyNumericIpv4('3232235777')).toBe(true);
    expect(isLegacyNumericIpv4('0x7f000001')).toBe(true);
    expect(isLegacyNumericIpv4('my-phone.local')).toBe(false);
  });

  it('derives USB transport even when libusb adb omits the usb: prop and shares handoff eligibility', () => {
    expect(deriveDeviceTransport('R58M123ABC', 'device', false)).toBe('usb');
    expect(deriveDeviceTransport('R58M123ABC', 'unauthorized', true)).toBe('usb');
    expect(deriveDeviceTransport('R58M123ABC', 'unauthorized', false)).toBeUndefined();
    expect(deriveDeviceTransport('R58M123ABC', 'offline', false)).toBeUndefined();
    expect(deriveDeviceTransport('emulator-5554', 'device', false)).toBe('emulator');
    expect(deriveDeviceTransport('192.168.1.5:5555', 'device', false)).toBe('wireless');
    expect(deriveDeviceTransport('[::ffff:192.168.1.20]:5555', 'device', false)).toBe('wireless');
    // ADB mDNS service types (both `_adb._tcp` and arbitrary-prefix `_adb-tls-connect._tcp`) are wireless, never USB.
    expect(deriveDeviceTransport('adb-SAMPLE._adb._tcp', 'device', false)).toBe('wireless');
    expect(deriveDeviceTransport('lab._adb-tls-connect._tcp', 'device', false)).toBe('wireless');
    expect(deriveDeviceTransport('lab._adb-tls-connect._tcp', 'offline', false)).toBe('wireless');
    // AOSP vsock transport (including uint32 ports > 65535) and ambiguous `usb:<port>` without `usb:` prop are not USB.
    expect(deriveDeviceTransport('vsock:2:5555', 'device', false)).toBeUndefined();
    expect(deriveDeviceTransport('vsock:2:70000', 'device', false)).toBeUndefined();
    expect(deriveDeviceTransport('usb:5555', 'device', false)).toBeUndefined();
    expect(deriveDeviceTransport('USB:5555', 'device', false)).toBeUndefined();
    expect(deriveDeviceTransport('TCP:5555', 'device', false)).toBeUndefined();
    expect(deriveDeviceTransport('usb:5555', 'device', true)).toBe('usb');
    expect(deriveDeviceTransport('usb:1-2.3', 'device', false)).toBe('usb');

    expect(resolveDeviceTransport({ serial: 'R58M123ABC', state: 'device' })).toBe('usb');
    expect(isUsbTcpipEligible({ serial: 'R58M123ABC', state: 'device' })).toBe(true);
    expect(isUsbTcpipEligible({ serial: 'R58M123ABC', state: 'unauthorized', transport: 'usb' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'R58M123ABC', state: 'offline' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: '192.168.1.5:5555', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'adb-SAMPLE._adb._tcp', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'lab._adb-tls-connect._tcp', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'vsock:2:5555', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'usb:5555', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'USB:5555', state: 'device' })).toBe(false);
    expect(isUsbTcpipEligible({ serial: 'usb:1-2.3', state: 'device' })).toBe(true);
    expect(isUsbTcpipEligible({ serial: 'emulator-5554', state: 'device' })).toBe(false);
  });

  it('detects public IPs for dashboard warnings and wireless/mDNS serials', () => {
    expect(isPublicWirelessHost('8.8.8.8:5555')).toBe(true);
    expect(isPublicWirelessHost('8.8.8.8')).toBe(true);
    expect(isPublicWirelessHost('[2001:4860:4860::8888]:5555')).toBe(true);
    expect(isPublicWirelessHost('192.168.1.5:5555')).toBe(false);
    expect(isPublicWirelessHost('100.100.1.2:5555')).toBe(false);
    expect(isPublicWirelessHost('pixel.local:5555')).toBe(false);

    expect(isMdnsSerial('adb-R58M123ABC-xyz._adb-tls-connect._tcp')).toBe(true);
    expect(isMdnsSerial('adb-R58M123ABC-xyz._adb-tls-pairing._tcp')).toBe(true);
    expect(isMdnsSerial('192.168.1.5:5555')).toBe(false);
    expect(isWirelessSerial('192.168.1.5:5555')).toBe(true);
    expect(isWirelessSerial('[fd00::1]:5555')).toBe(true);
    expect(isWirelessSerial('adb-R58M123ABC-xyz._adb-tls-connect._tcp')).toBe(true);
    expect(isWirelessSerial('R58M123ABC')).toBe(false);
    expect(isWirelessSerial('emulator-5554')).toBe(false);
  });

  it('enforces the agent host policy (private/LAN/link-local/ULA/Tailscale/mDNS or dashboard-approved)', () => {
    expect(checkAgentWirelessTarget('192.168.1.5:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('10.0.0.4:37421').ok).toBe(true);
    expect(checkAgentWirelessTarget('172.16.4.5:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('169.254.1.2:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('100.100.1.2:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('[fd00::1]:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('[fe80::1]:5555').ok).toBe(true);
    expect(checkAgentWirelessTarget('adb-R58M123ABC-xyz._adb-tls-connect._tcp', { allowMdns: true })).toEqual(
      {
        ok: true,
        value: {
          target: 'adb-R58M123ABC-xyz._adb-tls-connect._tcp',
          scope: 'mdns',
          approvedByDashboard: false,
        },
      },
    );

    // Reject public IPs, loopback, and arbitrary DNS hostnames when not approved from the dashboard.
    for (const target of [
      '8.8.8.8:5555',
      '[2001:4860:4860::8888]:5555',
      '127.0.0.1:5555',
      '[::1]:5555',
      'localhost:5555',
      'attacker.example:5555',
    ]) {
      expect(checkAgentWirelessTarget(target), target).toEqual({
        ok: false,
        error: AGENT_HOST_POLICY_MESSAGE,
      });
    }

    // Once connected by the user from the dashboard in this server run, that exact host:port is permitted.
    const approved = new Set(['8.8.8.8:5555', 'phone.example:5555']);
    expect(checkAgentWirelessTarget('8.8.8.8:5555', { dashboardApproved: approved })).toEqual({
      ok: true,
      value: { target: '8.8.8.8:5555', scope: 'public', approvedByDashboard: true },
    });
    expect(checkAgentWirelessTarget('phone.example:5555', { dashboardApproved: approved })).toEqual({
      ok: true,
      value: { target: 'phone.example:5555', scope: 'hostname', approvedByDashboard: true },
    });
    // Different port is still rejected.
    expect(checkAgentWirelessTarget('8.8.8.8:5556', { dashboardApproved: approved }).ok).toBe(false);
  });
});

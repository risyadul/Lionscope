import { describe, expect, it } from 'vitest';
import { describeArgs, scrubSecret } from '../src/adb/adb.ts';
import {
  adbConnect,
  adbDisconnect,
  adbMdnsServices,
  adbPair,
  adbTcpip,
  parseDeviceWifiIp,
  parseMdnsServices,
  readDeviceWifiIp,
} from '../src/adb/wireless.ts';
import { FakeAdb } from './helpers/fakes.ts';

describe('describeArgs & scrubSecret', () => {
  it('redacts adb pair pairing codes with or without global adb flags', () => {
    expect(describeArgs(['pair', '192.168.1.5:37123', '482910'])).toBe('pair 192.168.1.5:37123 <redacted>');
    expect(describeArgs(['-H', '127.0.0.1', '-P', '5037', 'pair', '[fd00::1]:40000', 'QrPass99'])).toBe(
      '-H 127.0.0.1 -P 5037 pair [fd00::1]:40000 <redacted>',
    );
    expect(describeArgs(['-s', 'R58M123ABC', 'shell', 'echo pair 192.168.1.5:37123 482910'])).toBe(
      '-s R58M123ABC shell echo pair 192.168.1.5:37123 482910',
    );
  });

  it('scrubs every literal occurrence of a secret', () => {
    expect(scrubSecret('failed with code 482910 (retry 482910)', '482910')).toBe(
      'failed with code <redacted> (retry <redacted>)',
    );
    expect(scrubSecret('plain text', '')).toBe('plain text');
  });
});

describe('adb wireless helpers', () => {
  it('pairs a device and never leaks the pairing code in results or errors', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'pair') return 'Successfully paired to 192.168.1.5:37123 [guid=adb-R58M123ABC-xyz]\n';
      return '';
    });
    const result = await adbPair(adb, '192.168.1.5:37123', '482910');
    expect(result).toEqual({ target: '192.168.1.5:37123', guid: 'adb-R58M123ABC-xyz' });
    expect(adb.execCalls.at(-1)).toEqual(['pair', '192.168.1.5:37123', '482910']);

    const failingAdb = new FakeAdb(() => {
      throw new Error('adb pair 192.168.1.5:37123 failed: bad code 482910');
    });
    await expect(adbPair(failingAdb, '192.168.1.5:37123', '482910')).rejects.toThrow(/<redacted>/);
    await expect(adbPair(failingAdb, '192.168.1.5:37123', '482910')).rejects.not.toThrow(/482910/);

    const softFailAdb = new FakeAdb(() => 'Failed: Wrong pairing code 482910\n');
    await expect(adbPair(softFailAdb, '192.168.1.5:37123', '482910')).rejects.not.toThrow(/482910/);

    await expect(adbPair(adb, '192.168.1.5:37123', '12345')).rejects.toThrow(/6 digits/);
    await expect(adbPair(adb, '-192.168.1.5:37123', '123456')).rejects.toThrow(/must not start with -/);
  });

  it('connects and detects soft adb connect failures that exit 0', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] !== 'connect') return '';
      if (args[1] === '192.168.1.5:5555') return 'connected to 192.168.1.5:5555\n';
      if (args[1] === '192.168.1.6:5555') return 'already connected to 192.168.1.6:5555\n';
      if (args[1] === '192.168.1.7:5555') return 'cannot connect to 192.168.1.7:5555: Connection refused\n';
      if (args[1] === 'adb-R58M._adb-tls-connect._tcp')
        return 'connected to adb-R58M._adb-tls-connect._tcp\n';
      return '';
    });

    expect(await adbConnect(adb, '192.168.1.5:5555')).toEqual({
      target: '192.168.1.5:5555',
      serial: '192.168.1.5:5555',
      alreadyConnected: false,
    });
    expect(await adbConnect(adb, '192.168.1.6:5555')).toEqual({
      target: '192.168.1.6:5555',
      serial: '192.168.1.6:5555',
      alreadyConnected: true,
    });
    expect(await adbConnect(adb, 'adb-R58M._adb-tls-connect._tcp')).toEqual({
      target: 'adb-R58M._adb-tls-connect._tcp',
      serial: 'adb-R58M._adb-tls-connect._tcp',
      alreadyConnected: false,
    });
    await expect(adbConnect(adb, '192.168.1.7:5555')).rejects.toThrow(/Connection refused/);
    await expect(adbConnect(adb, '192.168.1.5;id:5555')).rejects.toThrow();
  });

  it('disconnects only explicit validated wireless targets', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] !== 'disconnect') return '';
      if (args[1] === '192.168.1.5:5555') return 'disconnected 192.168.1.5:5555\n';
      if (args[1] === '192.168.1.9:5555') return "error: no such device '192.168.1.9:5555'\n";
      return '';
    });
    expect(await adbDisconnect(adb, '192.168.1.5:5555')).toEqual({ target: '192.168.1.5:5555' });
    await expect(adbDisconnect(adb, '192.168.1.9:5555')).rejects.toThrow(/no such device/);
    await expect(adbDisconnect(adb, '')).rejects.toThrow();
    await expect(adbDisconnect(adb, 'R58M123ABC')).rejects.toThrow();
  });

  it('switches a USB device into TCP/IP mode with validated serial and port', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === '-s' && args[2] === 'tcpip') return 'restarting in TCP mode port: 5555\n';
      return '';
    });
    expect(await adbTcpip(adb, 'R58M123ABC')).toEqual({ serial: 'R58M123ABC', port: 5555 });
    expect(adb.execCalls.at(-1)).toEqual(['-s', 'R58M123ABC', 'tcpip', '5555']);
    await expect(adbTcpip(adb, '-bad', 5555)).rejects.toThrow();
    await expect(adbTcpip(adb, 'R58M123ABC', 0)).rejects.toThrow();
  });

  it('parses `adb mdns services` output for connect and pairing services including IPv6', async () => {
    const output = [
      'List of discovered mdns services',
      'adb-R58M123ABC-xyz\t_adb-tls-connect._tcp\t192.168.1.42:37421',
      'studio-9911\t_adb-tls-pairing._tcp.\t192.168.1.42:43129',
      'adb-IP6-abc\t_adb-tls-connect._tcp\tfe80::1:40001',
      'adb-Other-1\t_adb-tls-connect._tcp\t[fd00::2]:40002',
      'ignored-svc\t_http._tcp\t192.168.1.42:80',
      '-badname\t_adb-tls-connect._tcp\t192.168.1.42:37421',
      'adb-badaddr\t_adb-tls-connect._tcp\t192.168.1.42:99999',
    ].join('\n');

    expect(parseMdnsServices(output)).toEqual([
      {
        instanceName: 'adb-R58M123ABC-xyz',
        serviceType: '_adb-tls-connect._tcp',
        host: '192.168.1.42',
        port: 37421,
        target: '192.168.1.42:37421',
        serial: 'adb-R58M123ABC-xyz._adb-tls-connect._tcp',
      },
      {
        instanceName: 'studio-9911',
        serviceType: '_adb-tls-pairing._tcp',
        host: '192.168.1.42',
        port: 43129,
        target: '192.168.1.42:43129',
        serial: 'studio-9911._adb-tls-pairing._tcp',
      },
      {
        instanceName: 'adb-IP6-abc',
        serviceType: '_adb-tls-connect._tcp',
        host: 'fe80::1',
        port: 40001,
        target: '[fe80::1]:40001',
        serial: 'adb-IP6-abc._adb-tls-connect._tcp',
      },
      {
        instanceName: 'adb-Other-1',
        serviceType: '_adb-tls-connect._tcp',
        host: 'fd00::2',
        port: 40002,
        target: '[fd00::2]:40002',
        serial: 'adb-Other-1._adb-tls-connect._tcp',
      },
    ]);

    const adb = new FakeAdb((args) => (args[0] === 'mdns' && args[1] === 'services' ? output : ''));
    expect(await adbMdnsServices(adb)).toHaveLength(4);
  });

  it('extracts a device Wi-Fi IPv4 from `ip addr show wlan0` or `ip route` fallback', async () => {
    expect(
      parseDeviceWifiIp(
        '14: wlan0: <BROADCAST,MULTICAST,UP>\n    inet 192.168.1.77/24 brd 192.168.1.255 scope global wlan0\n',
      ),
    ).toBe('192.168.1.77');
    expect(parseDeviceWifiIp('192.168.1.0/24 dev wlan1 proto kernel scope link src 192.168.1.88\n')).toBe(
      '192.168.1.88',
    );
    expect(parseDeviceWifiIp('127.0.0.0/8 dev lo scope host src 127.0.0.1\n')).toBeNull();

    const adb = new FakeAdb((args) => {
      if (args[2] === 'shell' && args[3] === 'ip -f inet addr show wlan0') return '';
      if (args[2] === 'shell' && args[3] === 'ip route') {
        return '10.0.0.0/24 dev wlan0 proto kernel scope link src 10.0.0.55\n';
      }
      return '';
    });
    expect(await readDeviceWifiIp(adb, 'R58M123ABC')).toBe('10.0.0.55');
  });
});

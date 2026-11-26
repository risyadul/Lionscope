import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_HOST_POLICY_MESSAGE } from '@lionscope/protocol';
import type { QrPairingUpdate } from '@lionscope/protocol';
import { callTool } from '../src/agent/registry.ts';
import { WirelessService } from '../src/device/wirelessService.ts';
import { createLionscopeServer } from '../src/server.ts';
import type { LionscopeServer } from '../src/server.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';
import { Client } from './helpers/net.ts';

function makeServer(adb: FakeAdb, allowDeviceControl = true): LionscopeServer {
  return createLionscopeServer({
    port: 0,
    devicePort: 0,
    adb,
    allowDeviceControl,
    devicePollMs: 60_000,
    emulatorPollMs: 60_000,
  });
}

describe('wireless connect & disconnect (WS + agent tools)', () => {
  let server: LionscopeServer | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    await server?.close();
    server = null;
  });

  it('connects and disconnects over WebSocket, refreshes devices, and approves dashboard host:port for agents', async () => {
    let devicesOutput = fixture('adb-devices.txt');
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return devicesOutput;
      if (args[0] === 'connect') {
        devicesOutput =
          'List of devices attached\n8.8.8.8:5555 device product:panther model:Pixel_7 transport_id:8\n';
        return `connected to ${args[1]}\n`;
      }
      if (args[0] === 'disconnect') {
        devicesOutput = 'List of devices attached\n';
        return `disconnected ${args[1]}\n`;
      }
      return '';
    });

    server = makeServer(adb);
    const address = await server.listen();

    // Before dashboard connect, agent cannot touch a public IP.
    const refusedBefore = await callTool(server.agent, 'connect_device', { address: '8.8.8.8:5555' }, true);
    expect(refusedBefore).toEqual({
      ok: false,
      code: 'failed',
      error: AGENT_HOST_POLICY_MESSAGE,
    });

    // Dashboard connects the public IP via WS.
    client = await Client.open(address.port);
    await client.waitFor('locations');

    client.send({ type: 'connectDevice', requestId: 1, address: '8.8.8.8:5555' });
    const connectAnswer = await client.next('wirelessResult');
    expect(connectAnswer).toEqual({
      type: 'wirelessResult',
      requestId: 1,
      result: {
        action: 'connect',
        ok: true,
        target: '8.8.8.8:5555',
        serial: '8.8.8.8:5555',
        alreadyConnected: false,
      },
    });
    expect(server.manager.getDevices()).toEqual([
      {
        serial: '8.8.8.8:5555',
        state: 'device',
        product: 'panther',
        model: 'Pixel_7',
        transportId: '8',
        transport: 'wireless',
      },
    ]);

    // Now the agent can reconnect / disconnect that exact dashboard-approved host:port.
    const approvedReconnect = await callTool(
      server.agent,
      'connect_device',
      { address: '8.8.8.8:5555' },
      true,
    );
    expect(approvedReconnect).toEqual({
      ok: true,
      result: { target: '8.8.8.8:5555', serial: '8.8.8.8:5555', alreadyConnected: false },
    });

    // Another port on the same public IP is still refused.
    const otherPort = await callTool(server.agent, 'connect_device', { address: '8.8.8.8:5556' }, true);
    expect(otherPort.ok).toBe(false);

    // Dashboard disconnects via WS.
    client.send({ type: 'disconnectDevice', requestId: 2, serial: '8.8.8.8:5555' });
    const disconnectAnswer = await client.next('wirelessResult');
    expect(disconnectAnswer).toEqual({
      type: 'wirelessResult',
      requestId: 2,
      result: { action: 'disconnect', ok: true, target: '8.8.8.8:5555' },
    });
    expect(server.manager.getDevices()).toEqual([]);
  });

  it('enforces deviceControl permission and private-network policy on agent tools', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return 'List of devices attached\n';
      if (args[0] === 'connect') return `connected to ${args[1]}\n`;
      if (args[0] === 'disconnect') return `disconnected ${args[1]}\n`;
      return '';
    });

    server = makeServer(adb, true);
    await server.listen();

    // Private IPv4, Tailscale, IPv6 ULA, and mDNS succeed for agent.
    for (const address of [
      '192.168.1.42:5555',
      '100.100.1.2:37421',
      '[fd00::1]:5555',
      'adb-R58M123ABC-xyz._adb-tls-connect._tcp',
    ]) {
      const res = await callTool(server.agent, 'connect_device', { address }, true);
      expect(res.ok, address).toBe(true);
    }

    const disc = await callTool(server.agent, 'disconnect_device', { serial: '192.168.1.42:5555' }, true);
    expect(disc).toEqual({
      ok: true,
      result: { target: '192.168.1.42:5555', disconnected: true },
    });

    // Hostname / loopback / public IP rejected for agent.
    for (const address of ['evil.example:5555', '127.0.0.1:5555', '1.1.1.1:5555']) {
      const res = await callTool(server.agent, 'connect_device', { address }, true);
      expect(res.ok, address).toBe(false);
    }

    // Disabled deviceControl blocks both tools.
    const forbidden = await callTool(server.agent, 'connect_device', { address: '192.168.1.42:5555' }, false);
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe('forbidden');
  });

  it('returns structured failure in wirelessResult when adb connect refuses', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return 'List of devices attached\n';
      if (args[0] === 'connect') return 'cannot connect to 192.168.1.99:5555: Connection refused\n';
      return '';
    });
    server = makeServer(adb);
    const address = await server.listen();
    client = await Client.open(address.port);
    await client.waitFor('locations');

    client.send({ type: 'connectDevice', requestId: 7, address: '192.168.1.99:5555' });
    const answer = await client.next('wirelessResult');
    expect(answer).toEqual({
      type: 'wirelessResult',
      requestId: 7,
      result: {
        action: 'connect',
        ok: false,
        message: 'cannot connect to 192.168.1.99:5555: Connection refused',
      },
    });
  });

  it('pairs via 6-digit code, connects via mDNS or explicit connect port, and never leaks the pairing code', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return 'List of devices attached\n';
      if (args[0] === 'pair') {
        if (args[2] === '000000') throw new Error('adb pair 192.168.1.42:37123 failed: wrong code 000000');
        return 'Successfully paired to 192.168.1.42:37123 [guid=adb-R58M123ABC-xyz]\n';
      }
      if (args[0] === 'mdns' && args[1] === 'services') {
        return 'List of discovered mdns services\nadb-R58M123ABC-xyz\t_adb-tls-connect._tcp\t192.168.1.42:41234\n';
      }
      if (args[0] === 'connect') return `connected to ${args[1]}\n`;
      return '';
    });

    server = makeServer(adb);
    const address = await server.listen();
    client = await Client.open(address.port);
    await client.waitFor('locations');

    // WS pair auto-connects via mDNS connect port.
    client.send({ type: 'pairDevice', requestId: 11, address: '192.168.1.42:37123', code: '482910' });
    const pairedViaMdns = await client.next('wirelessResult');
    expect(pairedViaMdns).toEqual({
      type: 'wirelessResult',
      requestId: 11,
      result: {
        action: 'pair',
        ok: true,
        target: '192.168.1.42:37123',
        host: '192.168.1.42',
        connectedSerial: '192.168.1.42:41234',
      },
    });
    expect(JSON.stringify(pairedViaMdns)).not.toContain('482910');

    // WS pair failure scrubs the pairing code from the response.
    client.send({ type: 'pairDevice', requestId: 12, address: '192.168.1.42:37123', code: '000000' });
    const pairFailed = await client.next('wirelessResult');
    expect(pairFailed.result.ok).toBe(false);
    expect(JSON.stringify(pairFailed)).not.toContain('000000');

    // Agent pair_device with explicit connectAddress succeeds and never echoes the code.
    const agentPaired = await callTool(
      server.agent,
      'pair_device',
      { address: '192.168.1.42:37123', code: '654321', connectAddress: '192.168.1.42:45555' },
      true,
    );
    expect(agentPaired).toEqual({
      ok: true,
      result: {
        paired: true,
        target: '192.168.1.42:37123',
        connectedSerial: '192.168.1.42:45555',
      },
    });
    expect(JSON.stringify(agentPaired)).not.toContain('654321');

    // Agent pair_device rejects public IP and invalid code without echoing the code.
    const refusedPublic = await callTool(
      server.agent,
      'pair_device',
      { address: '8.8.8.8:37123', code: '654321' },
      true,
    );
    expect(refusedPublic.ok).toBe(false);
    expect(JSON.stringify(refusedPublic)).not.toContain('654321');

    const badCode = await callTool(
      server.agent,
      'pair_device',
      { address: '192.168.1.42:37123', code: '99999x' },
      true,
    );
    expect(badCode.ok).toBe(false);
    expect(JSON.stringify(badCode)).not.toContain('99999x');
  });

  it('succeeds pairing without auto-connect when mDNS has no matching connect service', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return 'List of devices attached\n';
      if (args[0] === 'pair') return 'Successfully paired to 192.168.1.42:37123\n';
      if (args[0] === 'mdns') return 'List of discovered mdns services\n';
      return '';
    });
    server = makeServer(adb);
    await server.listen();

    const res = await callTool(
      server.agent,
      'pair_device',
      { address: '192.168.1.42:37123', code: '123456' },
      true,
    );
    expect(res).toEqual({
      ok: true,
      result: {
        paired: true,
        target: '192.168.1.42:37123',
        connectedSerial: null,
        note: 'Paired successfully. Enter the separate connect IP:port shown on the Wireless debugging screen.',
      },
    });
  });

  it('lists discovered mDNS connect devices over WS and flags already-connected entries', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') {
        return 'List of devices attached\n192.168.1.42:41234 device product:panther model:Pixel_7 transport_id:4\n';
      }
      if (args[0] === 'mdns' && args[1] === 'services') {
        return [
          'List of discovered mdns services',
          'adb-R58M123ABC-xyz\t_adb-tls-connect._tcp\t192.168.1.42:41234',
          'adb-PIXEL8-abc\t_adb-tls-connect._tcp\t192.168.1.50:42000',
          'ADB_WIFI_999\t_adb-tls-pairing._tcp\t192.168.1.50:37123',
        ].join('\n');
      }
      return '';
    });

    server = makeServer(adb);
    const address = await server.listen();
    await server.manager.refreshDevices();
    client = await Client.open(address.port);
    await client.waitFor('locations');

    client.send({ type: 'listMdnsServices', requestId: 21 });
    const mdnsAnswer = await client.next('wirelessResult');
    expect(mdnsAnswer).toEqual({
      type: 'wirelessResult',
      requestId: 21,
      result: {
        action: 'mdns',
        ok: true,
        services: [
          {
            instanceName: 'adb-R58M123ABC-xyz',
            host: '192.168.1.42',
            port: 41234,
            target: '192.168.1.42:41234',
            serial: 'adb-R58M123ABC-xyz._adb-tls-connect._tcp',
            connected: true,
          },
          {
            instanceName: 'adb-PIXEL8-abc',
            host: '192.168.1.50',
            port: 42000,
            target: '192.168.1.50:42000',
            serial: 'adb-PIXEL8-abc._adb-tls-connect._tcp',
            connected: false,
          },
        ],
      },
    });
  });

  it('runs QR pairing lifecycle: generates payload, polls mdns, pairs on match, and connects', async () => {
    let mdnsLines: string[] = [];
    const adb = new FakeAdb((args) => {
      if (args[0] === 'mdns' && args[1] === 'services') {
        return ['List of discovered mdns services', ...mdnsLines].join('\n');
      }
      if (args[0] === 'pair') {
        return 'Successfully paired to 192.168.1.50:39000 [guid=adb-PIXEL8-abc]\n';
      }
      if (args[0] === 'connect') return `connected to ${args[1]}\n`;
      return '';
    });

    const service = new WirelessService({
      adb,
      refreshDevices: async () => [],
      stopSessionOn: async () => undefined,
      getDevices: () => [],
      qrPollMs: 20,
      qrTimeoutMs: 5000,
    });

    const updates: QrPairingUpdate[] = [];
    const started = service.startQrPairing('owner-1', (update) => updates.push(update));
    expect(started.payload).toMatch(/^WIFI:T:ADB;S:ADB_WIFI_[0-9a-f]{12};P:[A-Za-z0-9]{16};;$/);

    // Simulate the phone scanning the QR and advertising the matching pairing service + connect service.
    mdnsLines = [
      `${started.serviceName}\t_adb-tls-pairing._tcp\t192.168.1.50:39000`,
      'adb-PIXEL8-abc\t_adb-tls-connect._tcp\t192.168.1.50:42000',
    ];

    const deadline = Date.now() + 2000;
    while (!updates.some((u) => u.status === 'paired') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    service.close();
    expect(updates).toEqual([
      { sessionId: started.sessionId, status: 'pairing', target: '192.168.1.50:39000' },
      {
        sessionId: started.sessionId,
        status: 'paired',
        target: '192.168.1.50:39000',
        host: '192.168.1.50',
        connectedSerial: '192.168.1.50:42000',
      },
    ]);
    // Verify the QR password was passed to `adb pair` and never echoed in updates.
    const pairCall = adb.execCalls.find((call) => call[0] === 'pair');
    expect(pairCall?.[1]).toBe('192.168.1.50:39000');
    expect(JSON.stringify(updates)).not.toContain(pairCall?.[2] ?? 'impossible');
  });

  it('performs USB to Wi-Fi handoff via WS and agent tool, validating the reported IP against agent policy', async () => {
    let devicesOutput =
      'List of devices attached\nR58M123ABC device usb:1-1 product:panther model:Pixel_7 transport_id:2\n';
    let wifiIp = '192.168.1.42';
    const adb = new FakeAdb((args) => {
      if (args[0] === 'devices') return devicesOutput;
      if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'ip -f inet addr show wlan0') {
        return `14: wlan0: <UP>\n    inet ${wifiIp}/24 scope global wlan0\n`;
      }
      if (args[0] === '-s' && args[2] === 'tcpip') return `restarting in TCP mode port: ${args[3]}\n`;
      if (args[0] === 'connect') {
        devicesOutput += `${args[1]} device product:panther model:Pixel_7 transport_id:9\n`;
        return `connected to ${args[1]}\n`;
      }
      return '';
    });

    server = makeServer(adb);
    const address = await server.listen();
    await server.manager.refreshDevices();

    // Agent tool rejects a device-reported public IP before running `adb tcpip`.
    wifiIp = '8.8.8.8';
    const refusedPublic = await callTool(
      server.agent,
      'enable_wireless_adb',
      { serial: 'R58M123ABC', port: 5555 },
      true,
    );
    expect(refusedPublic.ok).toBe(false);
    expect(adb.execCalls.some((c) => c[2] === 'tcpip')).toBe(false);

    // Private Wi-Fi IP succeeds via agent tool.
    wifiIp = '192.168.1.42';
    const agentRes = await callTool(
      server.agent,
      'enable_wireless_adb',
      { serial: 'R58M123ABC', port: 5555 },
      true,
    );
    expect(agentRes).toEqual({
      ok: true,
      result: {
        usbSerial: 'R58M123ABC',
        serial: '192.168.1.42:5555',
        target: '192.168.1.42:5555',
        port: 5555,
        alreadyConnected: false,
        note: "TCP/IP port 5555 stays open on the device's Wi-Fi network until reboot (or `adb usb`).",
      },
    });

    // WS enableWirelessTcpip works too.
    client = await Client.open(address.port);
    await client.waitFor('locations');
    client.send({ type: 'enableWirelessTcpip', requestId: 31, serial: 'R58M123ABC' });
    const wsAnswer = await client.next('wirelessResult');
    expect(wsAnswer).toEqual({
      type: 'wirelessResult',
      requestId: 31,
      result: {
        action: 'tcpip',
        ok: true,
        usbSerial: 'R58M123ABC',
        serial: '192.168.1.42:5555',
        target: '192.168.1.42:5555',
        port: 5555,
        alreadyConnected: false,
      },
    });
  });
});

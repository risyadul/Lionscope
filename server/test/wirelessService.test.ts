import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_HOST_POLICY_MESSAGE } from '@lionscope/protocol';
import { callTool } from '../src/agent/registry.ts';
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
});

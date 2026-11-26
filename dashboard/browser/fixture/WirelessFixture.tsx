import { useEffect } from 'react';
import { App } from '../../src/App.tsx';
import { useServices } from '../../src/app/services.ts';
import { DEFAULT_PERMISSIONS } from '@lionscope/protocol/wire';
import type { ClientMessage, ServerMessage } from '@lionscope/protocol/wire';

export function WirelessFixture() {
  const { store } = useServices();

  useEffect(() => {
    store.dispatch({
      kind: 'connection',
      connection: { status: 'open', attempt: 0, retryAt: null, closeReason: null },
    });
    store.dispatch({ kind: 'server', msg: { type: 'permissions', permissions: { ...DEFAULT_PERMISSIONS } } });
    store.dispatch({
      kind: 'server',
      msg: {
        type: 'devices',
        devices: [
          {
            serial: '192.168.1.42:5555',
            state: 'device',
            model: 'Pixel_8_Pro',
            transport: 'wireless',
          },
          {
            serial: 'R58M123ABC',
            state: 'device',
            model: 'Pixel_7',
            transport: 'usb',
          },
        ],
      },
    });
    store.dispatch({ kind: 'server', msg: { type: 'emulators', emulators: [] } });

    let qrTimer: ReturnType<typeof setTimeout> | null = null;
    let tcpipTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingConnect: { requestId: number; address: string } | null = null;
    const includePublicDiscovery = new URLSearchParams(window.location.search).get('publicDiscovery') === '1';
    document.documentElement.dataset.qrCancelledCount = '0';

    const reply = (serverMsg: ServerMessage) => {
      store.dispatch({ kind: 'server', msg: serverMsg });
      store.flush();
    };

    const onResolveConnect = () => {
      if (!pendingConnect) return;
      const { requestId, address } = pendingConnect;
      pendingConnect = null;
      reply({
        type: 'devices',
        devices: [
          { serial: '192.168.1.42:5555', state: 'device', model: 'Pixel_8_Pro', transport: 'wireless' },
          { serial: 'R58M123ABC', state: 'device', model: 'Pixel_7', transport: 'usb' },
          { serial: address, state: 'device', model: 'Pixel_9', transport: 'wireless' },
        ],
      });
      reply({
        type: 'wirelessResult',
        requestId,
        result: {
          action: 'connect',
          ok: true,
          serial: address,
          target: address,
          alreadyConnected: false,
        },
      });
    };

    const onSend = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const msg = event.detail as ClientMessage;
      if (msg.type === 'connectDevice') {
        pendingConnect = { requestId: msg.requestId, address: msg.address };
        return;
      }
      if (msg.type === 'listMdnsServices') {
        const services = [
          {
            instanceName: 'adb-PIXEL9-abc123',
            host: '192.168.1.50',
            port: 41234,
            target: '192.168.1.50:41234',
            serial: 'adb-PIXEL9-abc123._adb-tls-connect._tcp',
            connected: false,
          },
          ...(includePublicDiscovery
            ? [
                {
                  instanceName: 'adb-PUBLIC-999',
                  host: '198.51.100.20',
                  port: 41234,
                  target: '198.51.100.20:41234',
                  serial: 'adb-PUBLIC-999._adb-tls-connect._tcp',
                  connected: false,
                },
              ]
            : []),
        ];
        reply({
          type: 'wirelessResult',
          requestId: msg.requestId,
          result: {
            action: 'mdns',
            ok: true,
            services,
          },
        });
      } else if (msg.type === 'startQrPairing') {
        const sessionId = '0123456789abcdef';
        reply({
          type: 'wirelessResult',
          requestId: msg.requestId,
          result: {
            action: 'startQr',
            ok: true,
            sessionId,
            payload: 'WIFI:T:ADB;S:ADB_WIFI_aabbccddeeff;P:SyntheticPass123;;',
            serviceName: 'ADB_WIFI_aabbccddeeff',
            expiresAt: Date.now() + 120_000,
          },
        });
        if (qrTimer !== null) clearTimeout(qrTimer);
        // Push a pairing update AFTER at least one real 1s App clock tick to verify QR stays alive.
        qrTimer = setTimeout(() => {
          reply({
            type: 'qrPairing',
            update: { sessionId, status: 'pairing', target: '192.168.1.50:39000' },
          });
        }, 1250);
      } else if (msg.type === 'cancelQrPairing') {
        const prev = Number(document.documentElement.dataset.qrCancelledCount ?? '0');
        document.documentElement.dataset.qrCancelledCount = String(prev + 1);
      } else if (msg.type === 'enableWirelessTcpip') {
        const port = msg.port ?? 5555;
        if (!msg.confirmPublic) {
          reply({
            type: 'wirelessResult',
            requestId: msg.requestId,
            result: {
              action: 'tcpip',
              ok: false,
              needsPublicConfirmation: true,
              confirmationId: 'aabbccdd11223344',
              usbSerial: msg.serial,
              host: '192.0.2.15',
              port,
              target: `192.0.2.15:${port}`,
              message: `Device ${msg.serial} reported public Wi-Fi address 192.0.2.15:${port}.`,
            },
          });
          return;
        }
        // Complete confirmed public handoff before the client deadline (350ms) so Playwright can change selection mid-flight.
        if (tcpipTimer !== null) clearTimeout(tcpipTimer);
        const serial = `192.0.2.15:${port}`;
        tcpipTimer = setTimeout(() => {
          reply({
            type: 'devices',
            devices: [
              { serial: '192.168.1.42:5555', state: 'device', model: 'Pixel_8_Pro', transport: 'wireless' },
              { serial: 'R58M123ABC', state: 'device', model: 'Pixel_7', transport: 'usb' },
              { serial, state: 'device', model: 'Pixel_7', transport: 'wireless' },
            ],
          });
          reply({
            type: 'wirelessResult',
            requestId: msg.requestId,
            result: {
              action: 'tcpip',
              ok: true,
              usbSerial: msg.serial,
              serial,
              target: serial,
              port,
              alreadyConnected: false,
            },
          });
        }, 350);
      }
    };
    window.addEventListener('fixture-send', onSend);
    window.addEventListener('fixture-resolve-connect', onResolveConnect);
    return () => {
      if (qrTimer !== null) clearTimeout(qrTimer);
      if (tcpipTimer !== null) clearTimeout(tcpipTimer);
      window.removeEventListener('fixture-send', onSend);
      window.removeEventListener('fixture-resolve-connect', onResolveConnect);
    };
  }, [store]);

  return <App />;
}

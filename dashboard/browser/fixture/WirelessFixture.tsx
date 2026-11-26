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

    const onSend = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const msg = event.detail as ClientMessage;
      const reply = (serverMsg: ServerMessage) => {
        store.dispatch({ kind: 'server', msg: serverMsg });
        store.flush();
      };
      if (msg.type === 'listMdnsServices') {
        reply({
          type: 'wirelessResult',
          requestId: msg.requestId,
          result: {
            action: 'mdns',
            ok: true,
            services: [
              {
                instanceName: 'adb-PIXEL9-abc123',
                host: '192.168.1.50',
                port: 41234,
                target: '192.168.1.50:41234',
                serial: 'adb-PIXEL9-abc123._adb-tls-connect._tcp',
                connected: false,
              },
            ],
          },
        });
      } else if (msg.type === 'startQrPairing') {
        reply({
          type: 'wirelessResult',
          requestId: msg.requestId,
          result: {
            action: 'startQr',
            ok: true,
            sessionId: '0123456789abcdef',
            payload: 'WIFI:T:ADB;S:ADB_WIFI_aabbccddeeff;P:SyntheticPass123;;',
            serviceName: 'ADB_WIFI_aabbccddeeff',
            expiresAt: Date.now() + 120_000,
          },
        });
      }
    };
    window.addEventListener('fixture-send', onSend);
    return () => window.removeEventListener('fixture-send', onSend);
  }, [store]);

  return <App />;
}

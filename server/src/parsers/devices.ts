import { isValidSerial, isWirelessSerial } from '@lionscope/protocol';
import type { DeviceInfo, DeviceState, DeviceTransport } from '@lionscope/protocol';

const KNOWN_STATES: ReadonlySet<string> = new Set<DeviceState>(['device', 'offline', 'unauthorized']);
const EMULATOR_SERIAL = /^emulator-\d+$/;

function deriveTransport(serial: string, hasUsbProp: boolean): DeviceTransport | undefined {
  if (EMULATOR_SERIAL.test(serial)) return 'emulator';
  if (hasUsbProp) return 'usb';
  if (isWirelessSerial(serial)) return 'wireless';
  return undefined;
}

/** Parse `adb devices -l`. Lines with invalid serials are dropped (they could never be used safely). */
export function parseDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, rawState, ...props] = line.split(/\s+/);
    if (!serial || !rawState || !isValidSerial(serial)) continue;

    const device: DeviceInfo = {
      serial,
      state: KNOWN_STATES.has(rawState) ? (rawState as DeviceState) : 'unknown',
    };
    let hasUsbProp = false;
    for (const prop of props) {
      const sep = prop.indexOf(':');
      if (sep <= 0) continue;
      const key = prop.slice(0, sep);
      const value = prop.slice(sep + 1);
      if (key === 'model') device.model = value;
      else if (key === 'product') device.product = value;
      else if (key === 'transport_id') device.transportId = value;
      else if (key === 'usb') hasUsbProp = true;
    }
    const transport = deriveTransport(serial, hasUsbProp);
    if (transport !== undefined) device.transport = transport;
    devices.push(device);
  }
  return devices;
}

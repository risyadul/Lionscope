import { isValidSerial } from '@lionscope/protocol';
import type { DeviceInfo, DeviceState } from '@lionscope/protocol';

const KNOWN_STATES: ReadonlySet<string> = new Set<DeviceState>(['device', 'offline', 'unauthorized']);

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
    for (const prop of props) {
      const sep = prop.indexOf(':');
      if (sep <= 0) continue;
      const key = prop.slice(0, sep);
      const value = prop.slice(sep + 1);
      if (key === 'model') device.model = value;
      else if (key === 'product') device.product = value;
      else if (key === 'transport_id') device.transportId = value;
    }
    devices.push(device);
  }
  return devices;
}

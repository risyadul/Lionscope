import type { AppInfo, DeviceInfo, DeviceState } from '@lionscope/protocol/wire';

export function isReady(device: DeviceInfo): boolean {
  return device.state === 'device';
}

/** `Pixel_7_Pro` → `Pixel 7 Pro`; falls back to the product or a generic name. */
export function deviceName(device: DeviceInfo): string {
  const raw = device.model ?? device.product;
  return raw ? raw.replace(/_/g, ' ') : 'Unknown device';
}

/** Why a device can't be profiled, phrased as the fix. Null when it's ready. */
export function deviceStateReason(state: DeviceState): string | null {
  switch (state) {
    case 'device':
      return null;
    case 'unauthorized':
      return 'unauthorized — accept the USB debugging prompt on the phone';
    case 'offline':
      return 'offline — reconnect the cable or run adb reconnect';
    case 'unknown':
      return 'not ready — check adb devices';
  }
}

/**
 * Serial to show in the picker: the session's device while one is active, else the user's
 * explicit choice — kept even when that device goes offline or disappears, so the dashboard
 * never silently switches phones — else the first ready device.
 */
export function resolveSerial(
  devices: readonly DeviceInfo[] | null,
  chosen: string | null,
  sessionSerial: string | null,
  sessionActive: boolean,
): string | null {
  if (sessionActive && sessionSerial) return sessionSerial;
  if (chosen) return chosen;
  return (devices ?? []).find(isReady)?.serial ?? null;
}

/** Why `serial` can't start a session right now, or null when it's ready. */
export function serialUnavailableReason(
  devices: readonly DeviceInfo[] | null,
  serial: string,
): string | null {
  const device = (devices ?? []).find((d) => d.serial === serial);
  if (!device) return `${serial} is disconnected — reconnect it or pick another device`;
  const reason = deviceStateReason(device.state);
  return reason === null ? null : `${deviceName(device)} is ${reason}`;
}

/** Running apps first, then alphabetical by package name. */
export function sortApps(apps: readonly AppInfo[]): AppInfo[] {
  return [...apps].sort((a, b) => {
    const running = Number(b.pid !== null) - Number(a.pid !== null);
    return running !== 0 ? running : a.packageName.localeCompare(b.packageName);
  });
}

export interface AppQuery {
  query: string;
  thirdPartyOnly: boolean;
}

export function filterApps(apps: readonly AppInfo[], { query, thirdPartyOnly }: AppQuery): AppInfo[] {
  const needle = query.trim().toLowerCase();
  return apps.filter(
    (app) =>
      (!thirdPartyOnly || app.thirdParty) &&
      (needle === '' || app.packageName.toLowerCase().includes(needle)),
  );
}

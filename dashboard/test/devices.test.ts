import { describe, expect, it } from 'vitest';
import type { AppInfo, DeviceInfo } from '@lionscope/protocol/wire';
import {
  deviceName,
  deviceStateReason,
  filterApps,
  isReady,
  resolveSerial,
  serialUnavailableReason,
  sortApps,
} from '../src/lib/devices.ts';

const devices: DeviceInfo[] = [
  { serial: 'R58M123ABC', state: 'unauthorized' },
  { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' },
  { serial: 'emulator-5556', state: 'device', product: 'Pixel_7' },
];

describe('device helpers', () => {
  it('names devices from model, product or a fallback', () => {
    expect(deviceName(devices[1]!)).toBe('sdk gphone64 arm64');
    expect(deviceName(devices[2]!)).toBe('Pixel 7');
    expect(deviceName(devices[0]!)).toBe('Unknown device');
  });

  it('explains every non-ready state', () => {
    expect(deviceStateReason('device')).toBeNull();
    expect(deviceStateReason('unauthorized')).toMatch(/accept the USB debugging prompt/);
    expect(deviceStateReason('offline')).toMatch(/reconnect/);
    expect(deviceStateReason('unknown')).toMatch(/adb devices/);
    expect(isReady(devices[0]!)).toBe(false);
  });

  it('resolveSerial prefers the session, then the explicit choice (even if not ready), then the first ready device', () => {
    expect(resolveSerial(devices, null, 'emulator-5556', true)).toBe('emulator-5556');
    expect(resolveSerial(devices, 'emulator-5556', null, false)).toBe('emulator-5556');
    // Never silently switch phones: an offline or vanished choice is kept.
    expect(resolveSerial(devices, 'R58M123ABC', null, false)).toBe('R58M123ABC');
    expect(resolveSerial(devices, 'gone', 'emulator-5556', false)).toBe('gone');
    expect(resolveSerial(devices, null, null, false)).toBe('emulator-5554');
    expect(resolveSerial(null, null, null, false)).toBeNull();
    expect(resolveSerial([devices[0]!], null, null, false)).toBeNull();
  });

  it('serialUnavailableReason explains why a chosen device cannot start', () => {
    expect(serialUnavailableReason(devices, 'emulator-5554')).toBeNull();
    expect(serialUnavailableReason(devices, 'R58M123ABC')).toMatch(/unauthorized/);
    expect(serialUnavailableReason(devices, 'gone')).toMatch(/gone is disconnected/);
    expect(serialUnavailableReason(null, 'gone')).toMatch(/disconnected/);
  });
});

describe('app helpers', () => {
  const apps: AppInfo[] = [
    { packageName: 'com.zeta.app', pid: null, thirdParty: true },
    { packageName: 'com.android.settings', pid: 300, thirdParty: false },
    { packageName: 'com.example.shop', pid: 1234, thirdParty: true },
    { packageName: 'com.alpha.app', pid: null, thirdParty: true },
  ];

  it('sorts running apps first, then by package name', () => {
    expect(sortApps(apps).map((a) => a.packageName)).toEqual([
      'com.android.settings',
      'com.example.shop',
      'com.alpha.app',
      'com.zeta.app',
    ]);
    expect(apps[0]?.packageName).toBe('com.zeta.app');
  });

  it('filters by third-party flag and query', () => {
    expect(filterApps(apps, { query: '', thirdPartyOnly: true })).toHaveLength(3);
    expect(filterApps(apps, { query: 'SETTINGS', thirdPartyOnly: false }).map((a) => a.packageName)).toEqual([
      'com.android.settings',
    ]);
    expect(filterApps(apps, { query: 'settings', thirdPartyOnly: true })).toEqual([]);
  });
});

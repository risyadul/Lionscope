import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '@lionscope/protocol/wire';
import { isValidSerial } from '@lionscope/protocol/wire';
import {
  AVD_VALUE_PREFIX,
  avdValue,
  emulatorBusy,
  emulatorForSerial,
  emulatorLabel,
  emulatorStateNote,
  isSoftwareRendered,
  parseAvdValue,
  resolveTarget,
  standaloneAvds,
  type TargetInput,
} from '../src/lib/emulators.ts';
import { startHint } from '../src/lib/viewState.ts';
import { emulator } from './screenFakes.ts';

const RUNNING = emulator();
const OFF = emulator({ avdName: 'Pixel_Tablet', displayName: null, state: 'off', serial: null });
const PHONE: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };

function input(overrides: Partial<TargetInput> = {}): TargetInput {
  return {
    devices: [EMU_DEVICE, PHONE],
    emulators: [RUNNING, OFF],
    chosenSerial: null,
    chosenAvd: null,
    sessionSerial: null,
    isSessionActive: false,
    ...overrides,
  };
}

describe('emulator helpers', () => {
  it('names AVDs by display name, else the id with spaces', () => {
    expect(emulatorLabel(RUNNING)).toBe('Pixel 9a');
    expect(emulatorLabel(OFF)).toBe('Pixel Tablet');
  });

  it('round-trips picker values that can never be an adb serial', () => {
    expect(avdValue('Pixel_9a')).toBe('avd/Pixel_9a');
    expect(parseAvdValue('avd/Pixel_9a')).toBe('Pixel_9a');
    expect(parseAvdValue('emulator-5554')).toBeNull();
    expect(isValidSerial(`${AVD_VALUE_PREFIX}x`)).toBe(false);
  });

  it('lists AVDs on their own only while adb has no entry for them', () => {
    expect(standaloneAvds([RUNNING, OFF], [EMU_DEVICE])).toEqual([OFF]);
    // Running, but adb hasn't listed it yet.
    expect(standaloneAvds([RUNNING], [PHONE])).toEqual([RUNNING]);
    expect(standaloneAvds(null, [PHONE])).toEqual([]);
    expect(emulatorForSerial([RUNNING, OFF], 'emulator-5554')).toBe(RUNNING);
    expect(emulatorForSerial([RUNNING], null)).toBeNull();
  });

  it('notes the state of standalone AVDs', () => {
    expect(emulatorStateNote(OFF)).toBe('off');
    expect(emulatorStateNote({ ...OFF, state: 'booting' })).toBe('booting…');
    expect(emulatorStateNote({ ...OFF, state: 'shutting_down' })).toBe('shutting down…');
    expect(emulatorStateNote(RUNNING)).toBe('waiting for adb…');
  });

  it('flags only running software-rendered emulators', () => {
    expect(isSoftwareRendered({ ...RUNNING, renderer: 'software' })).toBe(true);
    expect(isSoftwareRendered({ ...RUNNING, renderer: 'unknown' })).toBe(false);
    expect(isSoftwareRendered({ ...OFF, renderer: 'software' })).toBe(false);
    expect(isSoftwareRendered(null)).toBe(false);
  });

  it('counts an unanswered request as busy, but the server state wins', () => {
    expect(emulatorBusy(OFF, null)).toBeNull();
    expect(emulatorBusy(OFF, { avdName: 'Pixel_Tablet', action: 'boot' })).toBe('booting');
    expect(emulatorBusy(OFF, { avdName: 'Pixel_9a', action: 'boot' })).toBeNull();
    expect(emulatorBusy(RUNNING, { avdName: 'Pixel_9a', action: 'shutdown' })).toBe('shutting_down');
    expect(emulatorBusy({ ...OFF, state: 'booting' }, null)).toBe('booting');
  });
});

describe('resolveTarget', () => {
  it('falls back to the first ready device and maps it to its AVD', () => {
    expect(resolveTarget(input())).toEqual({ serial: 'emulator-5554', emulator: RUNNING });
  });

  it('keeps an explicit physical choice without an emulator', () => {
    expect(resolveTarget(input({ chosenSerial: 'R58M123ABC' }))).toEqual({
      serial: 'R58M123ABC',
      emulator: null,
    });
  });

  it('selects an AVD that is off without a serial, and follows it once it runs', () => {
    expect(resolveTarget(input({ chosenAvd: 'Pixel_Tablet' }))).toEqual({ serial: null, emulator: OFF });
    const booted = { ...OFF, state: 'running' as const, serial: 'emulator-5556' };
    expect(resolveTarget(input({ chosenAvd: 'Pixel_Tablet', emulators: [RUNNING, booted] }))).toEqual({
      serial: 'emulator-5556',
      emulator: booted,
    });
    // Booting already has a port, but nothing can be profiled before it runs.
    const booting = { ...OFF, state: 'booting' as const, serial: 'emulator-5556' };
    expect(resolveTarget(input({ chosenAvd: 'Pixel_Tablet', emulators: [booting] })).serial).toBeNull();
  });

  it('prefers the session device and ignores an AVD that vanished from the list', () => {
    expect(
      resolveTarget(input({ chosenAvd: 'Pixel_Tablet', sessionSerial: 'R58M123ABC', isSessionActive: true })),
    ).toEqual({ serial: 'R58M123ABC', emulator: null });
    expect(resolveTarget(input({ chosenAvd: 'Gone', chosenSerial: 'R58M123ABC' })).serial).toBe('R58M123ABC');
  });
});

describe('startHint', () => {
  const base = { isOpen: true, serial: null, emulator: null, deviceReason: null, packageName: null };

  it('asks to boot an AVD that is off, or to wait while it boots', () => {
    expect(startHint({ ...base, emulator: OFF })).toBe('Boot the emulator first');
    expect(startHint({ ...base, emulator: { ...OFF, state: 'booting' } })).toBe(
      'Wait for the emulator to boot',
    );
  });

  it('keeps the existing hints', () => {
    expect(startHint({ ...base, isOpen: false })).toBe('Offline — waiting for the server');
    expect(startHint(base)).toBe('Connect a device first');
    expect(startHint({ ...base, serial: 'emulator-5554', emulator: RUNNING })).toBe('Pick an app to profile');
    expect(startHint({ ...base, serial: 'emulator-5554', packageName: 'com.example.shop' })).toBeNull();
  });
});

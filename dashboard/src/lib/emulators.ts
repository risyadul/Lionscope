/** AVDs from the server's `emulators` list, and how they map onto adb devices and the device picker. */
import type { DeviceInfo, EmulatorInfo } from '@lionscope/protocol/wire';
import { resolveSerial } from './devices.ts';

/** Picker values for AVDs; `/` never occurs in an adb serial, so the two can't collide. */
export const AVD_VALUE_PREFIX = 'avd/';

export function avdValue(avdName: string): string {
  return `${AVD_VALUE_PREFIX}${avdName}`;
}

export function parseAvdValue(value: string): string | null {
  return value.startsWith(AVD_VALUE_PREFIX) ? value.slice(AVD_VALUE_PREFIX.length) : null;
}

/** `Pixel 9a` from the AVD config, else the id with underscores as spaces (`Pixel_9a` → `Pixel 9a`). */
export function emulatorLabel(emulator: EmulatorInfo): string {
  return emulator.displayName ?? emulator.avdName.replace(/_/g, ' ');
}

export function emulatorForSerial(
  emulators: readonly EmulatorInfo[] | null,
  serial: string | null,
): EmulatorInfo | null {
  if (serial === null) return null;
  return (emulators ?? []).find((e) => e.serial === serial) ?? null;
}

/** AVDs the picker lists on their own: every one without a connected adb device entry (off, booting, …). */
export function standaloneAvds(
  emulators: readonly EmulatorInfo[] | null,
  devices: readonly DeviceInfo[] | null,
): EmulatorInfo[] {
  const serials = new Set((devices ?? []).map((d) => d.serial));
  return (emulators ?? []).filter((e) => e.serial === null || !serials.has(e.serial));
}

/** Short state suffix for a standalone AVD option. */
export function emulatorStateNote(emulator: EmulatorInfo): string {
  switch (emulator.state) {
    case 'off':
      return 'off';
    case 'booting':
      return 'booting…';
    case 'shutting_down':
      return 'shutting down…';
    case 'running':
      return 'waiting for adb…';
  }
}

/** The emulator draws with SwiftShader / lavapipe: frame times say nothing about a real device. */
export function isSoftwareRendered(emulator: EmulatorInfo | null): boolean {
  return emulator !== null && emulator.state === 'running' && emulator.renderer === 'software';
}

export interface DeviceTarget {
  /** adb serial to profile, list apps for and mirror; null while nothing (or an AVD that is off) is selected. */
  serial: string | null;
  /** The AVD behind the selection, when it is (or will be) an emulator. */
  emulator: EmulatorInfo | null;
}

export interface TargetInput {
  devices: readonly DeviceInfo[] | null;
  emulators: readonly EmulatorInfo[] | null;
  chosenSerial: string | null;
  /** Set when the user picked an AVD (or a device that is one): the selection follows it through boot / shutdown. */
  chosenAvd: string | null;
  sessionSerial: string | null;
  isSessionActive: boolean;
}

/**
 * The session's device while one is active; else the chosen AVD (its serial once it runs, so a fresh boot
 * becomes profilable without picking it again); else `resolveSerial`'s explicit-choice-or-first-ready rule.
 */
export function resolveTarget(input: TargetInput): DeviceTarget {
  const { devices, emulators, chosenSerial, chosenAvd, sessionSerial, isSessionActive } = input;
  if (isSessionActive && sessionSerial) {
    return { serial: sessionSerial, emulator: emulatorForSerial(emulators, sessionSerial) };
  }
  if (chosenAvd !== null) {
    const emulator = (emulators ?? []).find((e) => e.avdName === chosenAvd);
    if (emulator) {
      const serial = emulator.state === 'running' ? emulator.serial : null;
      return { serial, emulator };
    }
  }
  const serial = resolveSerial(devices, chosenSerial, sessionSerial, false);
  return { serial, emulator: emulatorForSerial(emulators, serial) };
}

export type EmulatorAction = 'boot' | 'shutdown';

/** A boot / shutdown request the server hasn't answered yet (no new `emulators` list or `error` since). */
export interface PendingEmulatorAction {
  avdName: string;
  action: EmulatorAction;
}

/** What the emulator is busy with, counting a request still in flight; null when it's settled. */
export function emulatorBusy(
  emulator: EmulatorInfo,
  pending: PendingEmulatorAction | null,
): 'booting' | 'shutting_down' | null {
  if (emulator.state === 'booting' || emulator.state === 'shutting_down') return emulator.state;
  if (pending === null || pending.avdName !== emulator.avdName) return null;
  return pending.action === 'boot' ? 'booting' : 'shutting_down';
}

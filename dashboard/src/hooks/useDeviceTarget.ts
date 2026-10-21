import { useState } from 'react';
import type { DeviceInfo, EmulatorInfo } from '@lionscope/protocol/wire';
import { emulatorForSerial, resolveTarget, type DeviceTarget } from '../lib/emulators.ts';

interface Input {
  devices: readonly DeviceInfo[] | null;
  emulators: readonly EmulatorInfo[] | null;
  sessionSerial: string | null;
  isSessionActive: boolean;
}

export interface DeviceSelection {
  target: DeviceTarget;
  /** A connected device; when it is an emulator the selection follows its AVD through shutdown and boot. */
  chooseSerial: (serial: string) => void;
  chooseAvd: (avdName: string) => void;
}

/** What the picker selects: an adb serial, an AVD (also while it is off), or the first ready device. */
export function useDeviceTarget({
  devices,
  emulators,
  sessionSerial,
  isSessionActive,
}: Input): DeviceSelection {
  const [chosenSerial, setChosenSerial] = useState<string | null>(null);
  const [chosenAvd, setChosenAvd] = useState<string | null>(null);
  const target = resolveTarget({
    devices,
    emulators,
    chosenSerial,
    chosenAvd,
    sessionSerial,
    isSessionActive,
  });
  return {
    target,
    chooseSerial(serial) {
      setChosenSerial(serial);
      setChosenAvd(emulatorForSerial(emulators, serial)?.avdName ?? null);
    },
    chooseAvd(avdName) {
      setChosenAvd(avdName);
      setChosenSerial(null);
    },
  };
}

import type { ReactNode } from 'react';
import type { DeviceInfo, EmulatorInfo } from '@lionscope/protocol/wire';
import { deviceName, deviceStateReason, isReady } from '../../lib/devices.ts';
import {
  avdValue,
  emulatorForSerial,
  emulatorLabel,
  emulatorStateNote,
  parseAvdValue,
  standaloneAvds,
} from '../../lib/emulators.ts';

export const DEVICE_PICKER_ID = 'device-picker';

type Props = {
  devices: readonly DeviceInfo[] | null;
  /** Every AVD; null from servers that don't list them. */
  emulators: readonly EmulatorInfo[] | null;
  value: string | null;
  /** The AVD behind the selection, if any (selected even while it is off). */
  emulator: EmulatorInfo | null;
  onChange: (serial: string) => void;
  onAvdChange: (avdName: string) => void;
  onRefresh: () => void;
  isLocked: boolean;
  isOffline: boolean;
  /** Boot / Shut down for the selected emulator, beside the select. */
  actions?: ReactNode;
};

function deviceOptionLabel(device: DeviceInfo, emulators: readonly EmulatorInfo[] | null): string {
  const emulator = emulatorForSerial(emulators, device.serial);
  // adb lists an emulator (often as offline) while it boots or shuts down: say what it's doing.
  const isTransient = emulator?.state === 'booting' || emulator?.state === 'shutting_down';
  const reason = emulator && isTransient ? emulatorStateNote(emulator) : deviceStateReason(device.state);
  const name = emulator ? emulatorLabel(emulator) : deviceName(device);
  return `${name} · ${device.serial}${reason ? ` — ${reason}` : ''}`;
}

export function DevicePicker({
  devices,
  emulators,
  value,
  emulator,
  onChange,
  onAvdChange,
  onRefresh,
  isLocked,
  isOffline,
  actions,
}: Props) {
  const list = devices ?? [];
  const avds = standaloneAvds(emulators, devices);
  const hasReady = list.some(isReady);
  const placeholder =
    devices === null
      ? 'Looking for devices…'
      : avds.length > 0
        ? 'Select a device or emulator'
        : !hasReady
          ? 'No ready device'
          : 'Select a device';
  // The selected AVD shows as its own option while adb doesn't list it (off, booting…), else as its
  // adb entry — also while booting or shutting down, when it has a serial but nothing to profile yet.
  const emulatorSerial = emulator?.serial ?? null;
  const selected =
    emulator !== null && avds.some((e) => e.avdName === emulator.avdName)
      ? avdValue(emulator.avdName)
      : emulatorSerial !== null && list.some((d) => d.serial === emulatorSerial)
        ? emulatorSerial
        : value;
  const isListed = selected !== null && list.some((d) => d.serial === selected);

  const deviceOptions = list.map((device) => (
    <option key={device.serial} value={device.serial} disabled={deviceStateReason(device.state) !== null}>
      {deviceOptionLabel(device, emulators)}
    </option>
  ));

  return (
    <div className="field">
      <label className="overline" htmlFor={DEVICE_PICKER_ID}>
        Device
      </label>
      <div className="field-row">
        <div className="select-wrap">
          <select
            id={DEVICE_PICKER_ID}
            className="select"
            value={selected ?? ''}
            disabled={isLocked || (list.length === 0 && avds.length === 0)}
            title={isLocked ? 'Stop the session to change device' : undefined}
            onChange={(e) => {
              const avdName = parseAvdValue(e.target.value);
              if (avdName === null) onChange(e.target.value);
              else onAvdChange(avdName);
            }}
          >
            {selected === null && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {selected !== null && selected === value && !isListed && (
              <option value={value} disabled>
                {value} — disconnected
              </option>
            )}
            {avds.length === 0 ? (
              deviceOptions
            ) : (
              <>
                {list.length > 0 && <optgroup label="Connected">{deviceOptions}</optgroup>}
                <optgroup label="Emulators">
                  {avds.map((avd) => (
                    <option key={avd.avdName} value={avdValue(avd.avdName)}>
                      {emulatorLabel(avd)} · {emulatorStateNote(avd)}
                    </option>
                  ))}
                </optgroup>
              </>
            )}
          </select>
          <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
        {actions}
        <button
          type="button"
          className="btn btn--icon"
          onClick={onRefresh}
          disabled={isOffline}
          aria-label="Refresh devices"
          title="Refresh devices and emulators"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <path
              d="M11 6.5A4.5 4.5 0 1 1 9.4 3M11 1.5V4H8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

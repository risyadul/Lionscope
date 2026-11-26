import { useState, type ReactNode } from 'react';
import {
  isUsbTcpipEligible,
  resolveDeviceTransport,
  type DeviceInfo,
  type DeviceTransport,
  type EmulatorInfo,
} from '@lionscope/protocol/wire';
import { deviceName, deviceStateReason, isReady } from '../../lib/devices.ts';
import {
  avdValue,
  emulatorForSerial,
  emulatorLabel,
  emulatorStateNote,
  parseAvdValue,
  standaloneAvds,
} from '../../lib/emulators.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Select } from '../ui/Select.tsx';

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
  /** Opens the wireless ADB connect/pair dialog. */
  onOpenWireless?: () => void;
  /** Disconnects the selected wireless device (`adb disconnect`). */
  onDisconnectWireless?: (serial: string) => void;
  /** True while the selected wireless device is disconnecting. */
  isDisconnecting?: boolean;
  /** Switches a USB physical device to TCP/IP mode (`adb tcpip 5555`) and connects over Wi-Fi. */
  onSwitchToWifi?: (serial: string) => void;
  /** True while the selected USB device is switching to Wi-Fi. */
  isSwitchingToWifi?: boolean;
  isLocked: boolean;
  isOffline: boolean;
  /** Boot / Shut down for the selected emulator, beside the select. */
  actions?: ReactNode;
};

function transportBadgeLabel(transport: DeviceTransport | undefined): string | null {
  if (transport === 'wireless') return 'Wi-Fi';
  if (transport === 'usb') return 'USB';
  return null;
}

function deviceOptionLabel(device: DeviceInfo, emulators: readonly EmulatorInfo[] | null): string {
  const emulator = emulatorForSerial(emulators, device.serial);
  // adb lists an emulator (often as offline) while it boots or shuts down: say what it's doing.
  const isTransient = emulator?.state === 'booting' || emulator?.state === 'shutting_down';
  const reason = emulator && isTransient ? emulatorStateNote(emulator) : deviceStateReason(device.state);
  const name = emulator ? emulatorLabel(emulator) : deviceName(device);
  const badge = emulator ? null : transportBadgeLabel(resolveDeviceTransport(device));
  const suffix = badge ? ` (${badge})` : '';
  return `${name} · ${device.serial}${suffix}${reason ? ` — ${reason}` : ''}`;
}

export function DevicePicker({
  devices,
  emulators,
  value,
  emulator,
  onChange,
  onAvdChange,
  onRefresh,
  onOpenWireless,
  onDisconnectWireless,
  isDisconnecting = false,
  onSwitchToWifi,
  isSwitchingToWifi = false,
  isLocked,
  isOffline,
  actions,
}: Props) {
  const [confirmDisconnectSerial, setConfirmDisconnectSerial] = useState<string | null>(null);
  const [confirmWifiHandoffSerial, setConfirmWifiHandoffSerial] = useState<string | null>(null);
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
  const selectedDevice = selected !== null ? (list.find((d) => d.serial === selected) ?? null) : null;
  const isListed = selectedDevice !== null;
  const selectedTransport = selectedDevice ? resolveDeviceTransport(selectedDevice) : undefined;
  const selectedBadge = emulator === null ? transportBadgeLabel(selectedTransport) : null;
  const canDisconnect =
    emulator === null && selectedTransport === 'wireless' && onDisconnectWireless !== undefined;
  const canSwitchToWifi =
    emulator === null &&
    selectedDevice !== null &&
    isUsbTcpipEligible(selectedDevice) &&
    onSwitchToWifi !== undefined;

  // Resolve confirmation targets by the serial captured when opening, never by the current selection.
  const disconnectTarget =
    confirmDisconnectSerial !== null
      ? (list.find((d) => d.serial === confirmDisconnectSerial) ?? null)
      : null;
  const disconnectTargetEligible =
    disconnectTarget !== null &&
    resolveDeviceTransport(disconnectTarget) === 'wireless' &&
    onDisconnectWireless !== undefined;

  const handoffTarget =
    confirmWifiHandoffSerial !== null
      ? (list.find((d) => d.serial === confirmWifiHandoffSerial) ?? null)
      : null;
  const handoffTargetEligible =
    handoffTarget !== null && isUsbTcpipEligible(handoffTarget) && !isLocked && onSwitchToWifi !== undefined;

  if (confirmDisconnectSerial !== null && !disconnectTargetEligible) {
    setConfirmDisconnectSerial(null);
  }
  if (confirmWifiHandoffSerial !== null && !handoffTargetEligible) {
    setConfirmWifiHandoffSerial(null);
  }

  const deviceOptions = list.map((device) => (
    <option key={device.serial} value={device.serial} disabled={deviceStateReason(device.state) !== null}>
      {deviceOptionLabel(device, emulators)}
    </option>
  ));

  const requestDisconnect = () => {
    if (!selectedDevice || !onDisconnectWireless) return;
    if (isLocked) setConfirmDisconnectSerial(selectedDevice.serial);
    else onDisconnectWireless(selectedDevice.serial);
  };

  return (
    <div className="field">
      <div className="field-head">
        <label className="overline" htmlFor={DEVICE_PICKER_ID}>
          Device
        </label>
        {selectedBadge !== null && (
          <span
            className="transport-badge"
            data-transport={selectedTransport}
            title={selectedTransport === 'wireless' ? 'Connected over Wi-Fi' : 'Connected over USB'}
          >
            {selectedBadge}
          </span>
        )}
      </div>
      <div className="field-row">
        <Select
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
        </Select>
        {actions}
        {canDisconnect && selectedDevice && (
          <button
            type="button"
            className="btn emu-action"
            onClick={requestDisconnect}
            disabled={isOffline || isDisconnecting}
            title={
              isOffline
                ? 'Offline — waiting for the server'
                : `Disconnect wireless device ${selectedDevice.serial}`
            }
          >
            {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        {canSwitchToWifi && selectedDevice && (
          <button
            type="button"
            className="btn emu-action"
            onClick={() => setConfirmWifiHandoffSerial(selectedDevice.serial)}
            disabled={isOffline || isSwitchingToWifi || isLocked}
            title={
              isOffline
                ? 'Offline — waiting for the server'
                : isLocked
                  ? 'Stop the session before switching to Wi-Fi'
                  : `Switch ${deviceName(selectedDevice)} from USB to Wi-Fi (adb tcpip 5555)`
            }
          >
            {isSwitchingToWifi ? 'Switching…' : 'Use Wi-Fi'}
          </button>
        )}
        {onOpenWireless && (
          <button
            type="button"
            className="btn btn--icon"
            onClick={onOpenWireless}
            disabled={isOffline}
            aria-label="Connect wireless device"
            aria-haspopup="dialog"
            title={isOffline ? 'Offline — waiting for the server' : 'Connect wireless device'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M1.5 5.2a7.8 7.8 0 0 1 11 0M3.7 7.6a4.7 4.7 0 0 1 6.6 0M5.8 9.9a1.8 1.8 0 0 1 2.4 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="7" cy="11.8" r="0.9" fill="currentColor" />
            </svg>
          </button>
        )}
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
      {disconnectTarget && disconnectTargetEligible && onDisconnectWireless && (
        <ConfirmDialog
          title={`Disconnect ${deviceName(disconnectTarget)}?`}
          confirmLabel="Disconnect"
          onConfirm={() => {
            const targetSerial = disconnectTarget.serial;
            setConfirmDisconnectSerial(null);
            onDisconnectWireless(targetSerial);
          }}
          onCancel={() => setConfirmDisconnectSerial(null)}
        >
          <p>
            The active profiling session on <strong className="mono">{disconnectTarget.serial}</strong> will
            stop before disconnecting wireless ADB.
          </p>
        </ConfirmDialog>
      )}
      {handoffTarget && handoffTargetEligible && onSwitchToWifi && (
        <ConfirmDialog
          title={`Switch ${deviceName(handoffTarget)} to Wi-Fi?`}
          confirmLabel="Enable Wi-Fi ADB"
          onConfirm={() => {
            const targetSerial = handoffTarget.serial;
            setConfirmWifiHandoffSerial(null);
            onSwitchToWifi(targetSerial);
          }}
          onCancel={() => setConfirmWifiHandoffSerial(null)}
        >
          <p>
            Lionscope will read this phone’s Wi-Fi IP, run <code className="mono">adb tcpip 5555</code>, and
            connect wirelessly so you can unplug the USB cable.
          </p>
          <p>
            <strong>
              TCP/IP port 5555 stays open on the phone’s Wi-Fi network until the phone is rebooted
            </strong>{' '}
            (or switched back with <code className="mono">adb usb</code>). Only enable this on a network you
            trust.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

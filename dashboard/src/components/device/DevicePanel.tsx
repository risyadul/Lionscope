import type { ReactNode } from 'react';
import type { BootMode, DeviceInfo } from '@lionscope/protocol/wire';
import { deviceName, deviceStateReason, serialUnavailableReason } from '../../lib/devices.ts';
import {
  emulatorBusy,
  emulatorLabel,
  type DeviceTarget,
  type PendingEmulatorAction,
} from '../../lib/emulators.ts';
import { videoUnavailableMessage, webCodecsApi } from '../../lib/videoDecoder.ts';
import { ScreenView } from './ScreenView.tsx';

type NoteProps = {
  title: string;
  isBusy?: boolean;
  children?: ReactNode;
};

function Note({ title, isBusy = false, children }: NoteProps) {
  return (
    <div className="device-note" role="status">
      <div className="device-note-glyph" data-busy={isBusy || undefined} aria-hidden="true">
        {isBusy && <span className="banner-spinner" />}
      </div>
      <p className="device-note-title">{title}</p>
      {children}
    </div>
  );
}

/** Screenshot file names keep to letters, digits, `.`, `-` and `_` (a network serial has a colon). */
function fileNamePart(raw: string): string {
  return raw.replace(/[^\w.-]+/g, '_');
}

/** A physical device: mirrored over scrcpy once adb lists it as ready and the browser can decode H.264. */
function PhysicalDevice({
  serial,
  device,
  hasDeviceList,
  isVisible,
}: {
  serial: string;
  device: DeviceInfo | null;
  hasDeviceList: boolean;
  isVisible: boolean;
}) {
  if (!hasDeviceList) return <Note title="Connecting…" isBusy />;
  if (device === null) {
    return (
      <Note title="Device not connected">
        <p>{serialUnavailableReason(null, serial)}.</p>
      </Note>
    );
  }
  const label = deviceName(device);
  const reason = deviceStateReason(device.state);
  if (reason !== null) {
    return (
      <Note title={`Can’t mirror ${label}`}>
        <p>
          {label} is {reason}. The screen appears as soon as it is ready.
        </p>
      </Note>
    );
  }
  if (webCodecsApi() === null) {
    return (
      <Note title={`Can’t show ${label}`}>
        <p>{videoUnavailableMessage()}.</p>
      </Note>
    );
  }
  return (
    <ScreenView
      key={serial}
      serial={serial}
      name={fileNamePart(device.model ?? serial)}
      label={label}
      kind="device"
      isVisible={isVisible}
    />
  );
}

type Props = {
  target: DeviceTarget;
  /** The adb entry for `target.serial`, when adb lists it. */
  device?: DeviceInfo | null;
  /** False until the server's first device list: a missing `device` then means "not known yet". */
  hasDeviceList?: boolean;
  isOnline: boolean;
  /** The column is open and the tab visible: the screen may stream. */
  isVisible: boolean;
  pending: PendingEmulatorAction | null;
  onBoot: (avdName: string, mode: BootMode) => void;
};

/** The selected device's live screen, or why there is none. Mirroring doesn't need a profiling session. */
export function DevicePanel({
  target,
  device = null,
  hasDeviceList = true,
  isOnline,
  isVisible,
  pending,
  onBoot,
}: Props) {
  const { serial, emulator } = target;
  if (!isOnline) {
    return <Note title="Offline — waiting for the server" />;
  }
  if (emulator === null) {
    if (serial === null) {
      return (
        <Note title="No device selected">
          <p>Pick a device or an emulator in the top bar to see its screen here.</p>
        </Note>
      );
    }
    return (
      <PhysicalDevice serial={serial} device={device} hasDeviceList={hasDeviceList} isVisible={isVisible} />
    );
  }

  const label = emulatorLabel(emulator);
  const busy = emulatorBusy(emulator, pending);
  if (busy === 'booting') {
    return (
      <Note title={`Booting ${label}…`} isBusy>
        <p>Headless, with the host GPU. The screen appears as soon as it is up.</p>
      </Note>
    );
  }
  if (busy === 'shutting_down') {
    return <Note title={`Shutting down ${label}…`} isBusy />;
  }
  if (emulator.state === 'off') {
    return (
      <Note title={`${label} is off`}>
        <p>Boot it here; Lionscope shuts it down again when the server stops.</p>
        <div className="device-note-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onBoot(emulator.avdName, 'quick')}
          >
            Quick boot
          </button>
          <button type="button" className="btn" onClick={() => onBoot(emulator.avdName, 'cold')}>
            Cold boot
          </button>
        </div>
      </Note>
    );
  }
  if (emulator.serial === null) {
    return <Note title={`Waiting for adb to see ${label}…`} isBusy />;
  }
  if (!emulator.canMirror) {
    return (
      <Note title={`Can’t mirror ${label}`}>
        <p>
          Lionscope found no gRPC endpoint for this emulator. Update the Android Emulator, or boot the AVD
          from Lionscope. Profiling works as usual.
        </p>
      </Note>
    );
  }
  return (
    <ScreenView
      key={emulator.serial}
      serial={emulator.serial}
      name={emulator.avdName}
      label={label}
      kind="emulator"
      isVisible={isVisible}
    />
  );
}

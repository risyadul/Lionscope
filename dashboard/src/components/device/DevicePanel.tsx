import type { ReactNode } from 'react';
import type { BootMode } from '@lionscope/protocol/wire';
import {
  emulatorBusy,
  emulatorLabel,
  type DeviceTarget,
  type PendingEmulatorAction,
} from '../../lib/emulators.ts';
import { ScreenView } from './ScreenView.tsx';

export const PHYSICAL_MIRROR_NOTE = 'Mirroring physical devices arrives in 0.3.1';

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

type Props = {
  target: DeviceTarget;
  isOnline: boolean;
  /** The column is open and the tab visible: the screen may stream. */
  isVisible: boolean;
  pending: PendingEmulatorAction | null;
  onBoot: (avdName: string, mode: BootMode) => void;
};

/** The selected device's live screen, or why there is none. Mirroring doesn't need a profiling session. */
export function DevicePanel({ target, isOnline, isVisible, pending, onBoot }: Props) {
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
      <Note title={PHYSICAL_MIRROR_NOTE}>
        <p>Emulators can be mirrored and operated here today. Profiling this device works as usual.</p>
      </Note>
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
      avdName={emulator.avdName}
      label={label}
      isVisible={isVisible}
    />
  );
}

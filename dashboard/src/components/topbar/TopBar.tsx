import type { ReactNode } from 'react';
import type { AppInfo, DeviceInfo, EmulatorInfo, SessionState } from '@lionscope/protocol/wire';
import type { ConnectionStatus } from '../../lib/store.ts';
import { BrandMark } from '../brand/BrandMark.tsx';
import { AppCombobox } from './AppCombobox.tsx';
import { DevicePicker } from './DevicePicker.tsx';
import { SdkStatus } from './SdkStatus.tsx';
import { SessionButton, StatusPill } from './SessionControls.tsx';
import './topbar.css';

type Props = {
  connection: ConnectionStatus;
  serverVersion: string | null;
  devices: readonly DeviceInfo[] | null;
  emulators: readonly EmulatorInfo[] | null;
  serial: string | null;
  /** The AVD behind the selection (also while it is off). */
  emulator: EmulatorInfo | null;
  onSerialChange: (serial: string) => void;
  onAvdChange: (avdName: string) => void;
  /** Boot / Shut down beside the device picker. */
  emulatorActions: ReactNode;
  /** Opens the device drawer on narrow screens. */
  deviceToggle: ReactNode;
  /** Profiler · Inspector · Device, beside the server link. */
  viewSwitch: ReactNode;
  onRefreshDevices: () => void;
  apps: readonly AppInfo[] | null;
  packageName: string | null;
  onPackageChange: (packageName: string) => void;
  onRequestApps: () => void;
  session: SessionState;
  /** Sticky `adb reverse` failure for the SDK port, if any. */
  sdkLinkError: string | null;
  isSessionActive: boolean;
  canStart: boolean;
  startHint: string | null;
  isPending: boolean;
  onStart: () => void;
  onStop: () => void;
  now: number;
};

export function TopBar({
  connection,
  serverVersion,
  devices,
  emulators,
  serial,
  emulator,
  onSerialChange,
  onAvdChange,
  emulatorActions,
  deviceToggle,
  viewSwitch,
  onRefreshDevices,
  apps,
  packageName,
  onPackageChange,
  onRequestApps,
  session,
  sdkLinkError,
  isSessionActive,
  canStart,
  startHint,
  isPending,
  onStart,
  onStop,
  now,
}: Props) {
  const isOffline = connection !== 'open';
  const appDisabledReason = isOffline
    ? 'Offline — waiting for the server'
    : isSessionActive
      ? 'Stop the session to change app'
      : serial === null
        ? emulator !== null
          ? 'Boot the emulator first'
          : 'Select a device first'
        : undefined;
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <BrandMark />
        <span className="topbar-version mono" title="Server version">
          {serverVersion ? `v${serverVersion}` : 'adb profiler'}
        </span>
      </div>
      <div className="topbar-controls">
        {deviceToggle}
        <DevicePicker
          devices={devices}
          emulators={emulators}
          value={serial}
          emulator={emulator}
          onChange={onSerialChange}
          onAvdChange={onAvdChange}
          onRefresh={onRefreshDevices}
          isLocked={isSessionActive}
          isOffline={isOffline}
          actions={emulatorActions}
        />
        <AppCombobox
          apps={apps}
          value={packageName}
          onChange={onPackageChange}
          onOpen={onRequestApps}
          isDisabled={serial === null || isSessionActive || isOffline}
          disabledReason={appDisabledReason}
        />
        <div className="topbar-session">
          <SessionButton
            isActive={isSessionActive}
            canStart={canStart}
            startHint={startHint}
            isPending={isPending}
            isOffline={isOffline}
            onStart={onStart}
            onStop={onStop}
          />
          <StatusPill session={session} now={now} />
          <SdkStatus sdk={session.sdk} linkError={sdkLinkError} isSessionActive={isSessionActive} />
        </div>
      </div>
      {viewSwitch}
      <div className="topbar-link" data-state={connection} title={`Server connection: ${connection}`}>
        <span className="link-dot" aria-hidden="true" />
        <span className="link-label">{connection === 'open' ? 'Connected' : 'Offline'}</span>
      </div>
    </header>
  );
}

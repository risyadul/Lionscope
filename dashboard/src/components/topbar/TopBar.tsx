import type { AppInfo, DeviceInfo, SessionState } from '@lionscope/protocol/wire';
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
  serial: string | null;
  onSerialChange: (serial: string) => void;
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
  serial,
  onSerialChange,
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
        ? 'Select a device first'
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
        <DevicePicker
          devices={devices}
          value={serial}
          onChange={onSerialChange}
          onRefresh={onRefreshDevices}
          isLocked={isSessionActive}
          isOffline={isOffline}
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
      <div className="topbar-link" data-state={connection} title={`Server connection: ${connection}`}>
        <span className="link-dot" aria-hidden="true" />
        <span className="link-label">{connection === 'open' ? 'Connected' : 'Offline'}</span>
      </div>
    </header>
  );
}

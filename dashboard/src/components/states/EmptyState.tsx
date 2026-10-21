import type { ReactNode } from 'react';
import { deviceName, deviceStateReason } from '../../lib/devices.ts';
import type { TimelineState } from '../../lib/viewState.ts';
import './states.css';

type PanelProps = {
  label: string;
  title: string;
  tone?: 'neutral' | 'critical';
  children?: ReactNode;
};

function Panel({ label, title, tone = 'neutral', children }: PanelProps) {
  return (
    <div className="empty-state" data-tone={tone} role="status">
      <p className="overline">{label}</p>
      <h3 className="empty-title">{title}</h3>
      {children}
    </div>
  );
}

/** Overlay content for states where the timeline has nothing meaningful to show. */
export function EmptyState({ state }: { state: TimelineState }) {
  switch (state.kind) {
    case 'disconnected':
      return (
        <Panel label="Server" title="Can’t reach the Lionscope server">
          <p>
            The dashboard reconnects on its own. If it keeps failing, start the server from the repository
            root:
          </p>
          <pre className="empty-code">npm run lionscope</pre>
        </Panel>
      );
    case 'loading':
      return (
        <Panel label="Devices" title="Looking for devices…">
          <p>Asking adb for connected devices.</p>
        </Panel>
      );
    case 'adb-unavailable':
      return (
        <Panel label="adb" title="Lionscope can’t run adb" tone="critical">
          <p className="empty-error mono">{state.message}</p>
          <ol className="empty-steps">
            <li>
              <span>
                Install the Android SDK platform-tools, or open Android Studio once so it installs them.
              </span>
            </li>
            <li>
              <span>
                Make <code>adb</code> reachable: put it on <code>PATH</code>, or set{' '}
                <code>LIONSCOPE_ADB</code> / <code>ANDROID_HOME</code>.
              </span>
            </li>
            <li>
              <span>Restart the server; this clears as soon as a device is listed.</span>
            </li>
          </ol>
        </Panel>
      );
    case 'no-devices':
      return (
        <Panel label="Devices" title="No device connected">
          <ol className="empty-steps">
            <li>
              <span>Connect a phone over USB, or start an emulator.</span>
            </li>
            <li>
              <span>
                Enable <strong>USB debugging</strong> in Developer options.
              </span>
            </li>
            <li>
              <span>
                Check it shows up in <code>adb devices</code> — the list here refreshes every 2 s.
              </span>
            </li>
          </ol>
        </Panel>
      );
    case 'no-ready-device':
      return (
        <Panel label="Devices" title="No device is ready to profile">
          <ul className="empty-devices">
            {state.devices.map((device) => (
              <li key={device.serial}>
                <span className="mono">{device.serial}</span>
                <span>
                  {deviceName(device)} · {deviceStateReason(device.state)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      );
    case 'idle':
      return (
        <Panel label="Session" title="Pick an app to profile">
          <p>
            Choose a device and an app in the top bar, then press <strong>Start</strong>. CPU, memory and
            frames are sampled through adb — nothing is installed in the app.
          </p>
        </Panel>
      );
    case 'waiting':
      return (
        <Panel label="Session" title="Waiting for the app to start">
          <p>
            Launch <code>{state.packageName ?? 'the app'}</code> on the device. Recording begins as soon as
            its process appears.
          </p>
        </Panel>
      );
    case 'error':
      return (
        <Panel label="Session" title="The session stopped with an error" tone="critical">
          <p className="empty-error mono">{state.message}</p>
          <p>Check the device connection, then press Start to try again.</p>
        </Panel>
      );
    case 'ready':
      return null;
  }
}

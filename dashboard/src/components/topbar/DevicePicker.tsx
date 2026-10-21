import type { DeviceInfo } from '@lionscope/protocol/wire';
import { deviceName, deviceStateReason, isReady } from '../../lib/devices.ts';

type Props = {
  devices: readonly DeviceInfo[] | null;
  value: string | null;
  onChange: (serial: string) => void;
  onRefresh: () => void;
  isLocked: boolean;
  isOffline: boolean;
};

export function DevicePicker({ devices, value, onChange, onRefresh, isLocked, isOffline }: Props) {
  const list = devices ?? [];
  const hasReady = list.some(isReady);
  const placeholder =
    devices === null ? 'Looking for devices…' : !hasReady ? 'No ready device' : 'Select a device';

  return (
    <div className="field">
      <label className="overline" htmlFor="device-picker">
        Device
      </label>
      <div className="field-row">
        <div className="select-wrap">
          <select
            id="device-picker"
            className="select"
            value={value ?? ''}
            disabled={isLocked || list.length === 0}
            title={isLocked ? 'Stop the session to change device' : undefined}
            onChange={(e) => onChange(e.target.value)}
          >
            {value === null && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {value !== null && !list.some((d) => d.serial === value) && (
              <option value={value} disabled>
                {value} — disconnected
              </option>
            )}
            {list.map((device) => {
              const reason = deviceStateReason(device.state);
              return (
                <option key={device.serial} value={device.serial} disabled={reason !== null}>
                  {deviceName(device)} · {device.serial}
                  {reason ? ` — ${reason}` : ''}
                </option>
              );
            })}
          </select>
          <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onRefresh}
          disabled={isOffline}
          aria-label="Refresh devices"
          title="Refresh devices"
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

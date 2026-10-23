import type { KeyboardEvent, ReactNode } from 'react';
import { VIEW_MODES, type ViewMode } from '../../lib/viewMode.ts';
import { ChartIcon, InspectIcon, PhoneIcon } from '../device/icons.tsx';

const ICONS: Record<ViewMode, ReactNode> = {
  profile: <ChartIcon />,
  inspect: <InspectIcon />,
  device: <PhoneIcon />,
};

type Props = {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
};

/** Profiler · Inspector · Device: a segmented radio group (arrows move and select, Home/End jump). */
export function ViewSwitch({ value, onChange }: Props) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = VIEW_MODES.findIndex((mode) => mode.id === value);
    let index: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (at + 1) % VIEW_MODES.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      index = (at - 1 + VIEW_MODES.length) % VIEW_MODES.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = VIEW_MODES.length - 1;
    else return;
    const next = VIEW_MODES[index];
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view='${next.id}']`)?.focus();
  };

  return (
    <div className="segmented view-switch" role="radiogroup" aria-label="View" onKeyDown={handleKeyDown}>
      {VIEW_MODES.map((mode) => {
        const isChecked = mode.id === value;
        return (
          <button
            key={mode.id}
            type="button"
            role="radio"
            className="view-switch-option"
            data-view={mode.id}
            aria-checked={isChecked}
            aria-label={mode.label}
            title={`${mode.label}: ${mode.description}`}
            tabIndex={isChecked ? 0 : -1}
            onClick={() => onChange(mode.id)}
          >
            {ICONS[mode.id]}
            <span className="view-switch-label" aria-hidden="true">
              {mode.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

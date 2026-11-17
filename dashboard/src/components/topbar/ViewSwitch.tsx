import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { VIEW_MODES, type ViewMode } from '../../lib/viewMode.ts';
import { ChartIcon, InspectIcon, PhoneIcon } from '../device/icons.tsx';

const ICONS: Record<ViewMode, ReactNode> = {
  profile: <ChartIcon />,
  inspect: <InspectIcon />,
  device: <PhoneIcon />,
  network: <span aria-hidden="true">⇄</span>,
  storage: <span aria-hidden="true">▤</span>,
};

type Props = {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
};

/** Labeled workspace sidebar; a dismissible navigation drawer in narrow windows. */
export function ViewSwitch({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const links = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) links.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    menu.current?.focus();
  };
  const select = (mode: ViewMode) => {
    onChange(mode);
    if (open) close();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open && event.key === 'Tab') {
      const first = links.current?.querySelector<HTMLButtonElement>('.workspace-menu-close');
      const last = links.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      if (event.shiftKey && event.target === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
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
    <nav
      className="workspace-navigation"
      aria-label="Workspaces"
      data-open={open || undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={menu}
        className="btn workspace-menu"
        aria-expanded={open}
        aria-controls="workspace-links"
        onClick={() => setOpen(!open)}
      >
        ☰ Workspaces
      </button>
      {open && (
        <button
          type="button"
          className="workspace-backdrop"
          aria-label="Close workspace navigation"
          onClick={close}
        />
      )}
      <div
        ref={links}
        id="workspace-links"
        className="view-switch"
        role="radiogroup"
        aria-label="View"
        onKeyDown={handleKeyDown}
      >
        <button type="button" className="btn workspace-menu-close" hidden={!open} onClick={close}>
          Close navigation
        </button>
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
              onClick={() => select(mode.id)}
            >
              {ICONS[mode.id]}
              <span className="view-switch-label" aria-hidden="true">
                {mode.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

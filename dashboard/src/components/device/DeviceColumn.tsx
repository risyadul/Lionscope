import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon, CollapseIcon, ExpandIcon, PhoneIcon } from './icons.tsx';
import './device.css';

export const DEVICE_COLUMN_ID = 'device-column';
/** The top-bar button that opens the overlay drawer; focus returns to it when the drawer closes. */
export const DEVICE_TOGGLE_ID = 'device-toggle';

/** `docked`: a column beside the timeline. `overlay`: narrow viewports, a drawer over the page. */
export type DeviceColumnMode = 'docked' | 'overlay';

type Props = {
  mode: DeviceColumnMode;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Name of the selected device, under the heading. */
  subtitle: string | null;
  /** Pinned open by the view: no collapse button. */
  isPinned?: boolean;
  children: ReactNode;
};

/** The left-hand Device column. Collapsed it is a slim rail; on narrow screens a drawer opened from the top bar. */
export function DeviceColumn({ mode, isOpen, onOpenChange, subtitle, isPinned = false, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const isOverlay = mode === 'overlay';

  useEffect(() => {
    if (!isOverlay || !isOpen) return;
    ref.current?.focus();
    // Focus outside the drawer: bubble phase and only if unhandled (one Escape closes one thing).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // The drawer is gone with whatever had focus in it: hand focus back to its toggle.
      if (document.activeElement === null || document.activeElement === document.body) {
        document.getElementById(DEVICE_TOGGLE_ID)?.focus();
      }
    };
  }, [isOverlay, isOpen, onOpenChange]);

  if (isOverlay && !isOpen) return null;

  if (!isOpen) {
    return (
      <aside id={DEVICE_COLUMN_ID} className="device-col" data-mode={mode} data-collapsed aria-label="Device">
        <button
          type="button"
          className="device-rail"
          aria-expanded={false}
          aria-controls={DEVICE_COLUMN_ID}
          onClick={() => onOpenChange(true)}
          title="Show the device screen"
        >
          <ExpandIcon />
          <span className="device-rail-label">Device</span>
        </button>
      </aside>
    );
  }

  return (
    <>
      {isOverlay && (
        <div className="device-backdrop" aria-hidden="true" onClick={() => onOpenChange(false)} />
      )}
      <aside
        ref={ref}
        id={DEVICE_COLUMN_ID}
        className="device-col"
        data-mode={mode}
        aria-labelledby="device-col-title"
        tabIndex={isOverlay ? -1 : undefined}
        // Focus inside the drawer: it is the top layer, so it closes before anything behind it. Esc on the
        // focused screen never gets here (it is the device's Back button and stops propagating).
        onKeyDown={
          isOverlay
            ? (event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return;
                event.preventDefault();
                onOpenChange(false);
              }
            : undefined
        }
      >
        <header className="device-head">
          <div className="device-head-text">
            <h2 id="device-col-title" className="overline">
              Device
            </h2>
            {subtitle && <p className="device-head-name">{subtitle}</p>}
          </div>
          {!isPinned && (
            <button
              type="button"
              className="btn btn--icon device-collapse"
              aria-expanded={true}
              aria-controls={DEVICE_COLUMN_ID}
              aria-label={isOverlay ? 'Close the device screen' : 'Collapse the device column'}
              title={isOverlay ? 'Close' : 'Collapse'}
              onClick={() => onOpenChange(false)}
            >
              {isOverlay ? <CloseIcon /> : <CollapseIcon />}
            </button>
          )}
        </header>
        <div className="device-body">{children}</div>
      </aside>
    </>
  );
}

type ToggleProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

/** Top-bar button for the overlay drawer (narrow screens). */
export function DeviceToggle({ isOpen, onOpenChange }: ToggleProps) {
  return (
    <button
      id={DEVICE_TOGGLE_ID}
      type="button"
      className="btn device-toggle"
      aria-expanded={isOpen}
      aria-controls={isOpen ? DEVICE_COLUMN_ID : undefined}
      onClick={() => onOpenChange(!isOpen)}
    >
      <PhoneIcon />
      Screen
    </button>
  );
}

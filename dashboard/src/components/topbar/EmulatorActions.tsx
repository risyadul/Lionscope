import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BootMode, EmulatorInfo } from '@lionscope/protocol/wire';
import { emulatorBusy, emulatorLabel, type PendingEmulatorAction } from '../../lib/emulators.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { DEVICE_PICKER_ID } from './DevicePicker.tsx';

const BOOT_MODES: readonly { mode: BootMode; label: string; detail: string }[] = [
  { mode: 'quick', label: 'Quick boot', detail: 'Load the snapshot; save it on shutdown' },
  { mode: 'cold', label: 'Cold boot', detail: 'Start from scratch, ignore the snapshot' },
];

type BootMenuProps = {
  emulator: EmulatorInfo;
  disabledReason: string | null;
  onBoot: (avdName: string, mode: BootMode) => void;
};

/** Menu button (WAI-ARIA menu pattern): Quick or Cold boot, chosen per boot. */
function BootMenu({ emulator, disabledReason, onBoot }: BootMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen, close]);

  // The menu button gives way to "Booting…": focus moves to the picker instead of being lost.
  const choose = (mode: BootMode) => {
    close(false);
    onBoot(emulator.avdName, mode);
    document.getElementById(DEVICE_PICKER_ID)?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    } else if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="boot-menu">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--primary emu-action"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        disabled={disabledReason !== null}
        title={disabledReason ?? `Boot ${emulatorLabel(emulator)}`}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || isOpen) return;
          event.preventDefault();
          setIsOpen(true);
        }}
      >
        Boot
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          id={menuId}
          className="boot-pop"
          role="menu"
          aria-label={`Boot ${emulatorLabel(emulator)}`}
          onKeyDown={handleMenuKeyDown}
        >
          {BOOT_MODES.map(({ mode, label, detail }) => (
            <button
              key={mode}
              type="button"
              role="menuitem"
              className="boot-item"
              tabIndex={-1}
              onClick={() => choose(mode)}
            >
              <span className="boot-item-label">{label}</span>
              <span className="boot-item-detail">{detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type ShutdownProps = {
  emulator: EmulatorInfo;
  /** A profiling session runs on this emulator: it stops first. */
  isInSession: boolean;
  onShutdown: (avdName: string, confirmUnmanaged: boolean) => void;
  /** The button that asks, given its click handler. */
  renderTrigger: (onClick: () => void) => ReactNode;
};

/**
 * Shut down a running emulator. Asks first when Lionscope didn't boot it (the server then needs
 * `confirmUnmanaged`) or when a profiling session runs on it.
 */
export function ShutdownControl({ emulator, isInSession, onShutdown, renderTrigger }: ShutdownProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const label = emulatorLabel(emulator);
  const shutDown = () => onShutdown(emulator.avdName, !emulator.managed);
  const ask = () => (emulator.managed && !isInSession ? shutDown() : setIsConfirming(true));
  // The trigger gives way to "Shutting down…": focus moves to the picker instead of being lost.
  const confirm = () => {
    setIsConfirming(false);
    shutDown();
    document.getElementById(DEVICE_PICKER_ID)?.focus();
  };
  return (
    <>
      {renderTrigger(ask)}
      {isConfirming && (
        <ConfirmDialog
          title={`Shut down ${label}?`}
          confirmLabel="Shut down"
          onConfirm={confirm}
          onCancel={() => setIsConfirming(false)}
        >
          {!emulator.managed && (
            <p>
              {label} wasn’t started by Lionscope (for example Android Studio). Apps running in it are closed.
            </p>
          )}
          {emulator.managed && <p>Apps running in it are closed.</p>}
          {isInSession && <p>The profiling session on {label} stops.</p>}
        </ConfirmDialog>
      )}
    </>
  );
}

type Props = {
  emulator: EmulatorInfo | null;
  pending: PendingEmulatorAction | null;
  isOffline: boolean;
  /** A session is running on this emulator: shutting it down stops the session first. */
  isInSession: boolean;
  onBoot: (avdName: string, mode: BootMode) => void;
  onShutdown: (avdName: string, confirmUnmanaged: boolean) => void;
};

/** Boot an AVD that is off; shut down one that runs; show progress in between. */
export function EmulatorActions({ emulator, pending, isOffline, isInSession, onBoot, onShutdown }: Props) {
  if (emulator === null) return null;
  const busy = emulatorBusy(emulator, pending);
  if (busy !== null) {
    return (
      <span className="emu-busy" role="status">
        <span className="banner-spinner" aria-hidden="true" />
        {busy === 'booting' ? 'Booting…' : 'Shutting down…'}
      </span>
    );
  }
  const offlineReason = isOffline ? 'Offline — waiting for the server' : null;
  if (emulator.state === 'off') {
    return <BootMenu emulator={emulator} disabledReason={offlineReason} onBoot={onBoot} />;
  }
  if (emulator.state !== 'running') return null;
  const origin = emulator.managed ? 'booted by Lionscope' : 'not started by Lionscope';
  return (
    <ShutdownControl
      emulator={emulator}
      isInSession={isInSession}
      onShutdown={onShutdown}
      renderTrigger={(onClick) => (
        <button
          type="button"
          className="btn emu-action"
          disabled={offlineReason !== null}
          title={offlineReason ?? `Shut down ${emulatorLabel(emulator)} (${origin})`}
          onClick={onClick}
        >
          Shut down
        </button>
      )}
    />
  );
}

import { useEffect } from 'react';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Calls `onEscape` for an Escape press anywhere on the page while `isActive`, unless a control
 * already handled it (popovers call preventDefault) or focus is in a text field. It marks the press
 * handled, so one Escape closes one thing (e.g. not also the device drawer).
 */
export function useEscape(isActive: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isActive, onEscape]);
}

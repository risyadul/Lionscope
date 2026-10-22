import { createContext, useContext } from 'react';

/**
 * Where the logcat drawer's bar takes its controls: `undefined` outside a drawer (the panel draws its own
 * toolbar), `null` while the bar is still mounting, then the element to portal the toolbar into.
 */
export const DrawerSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export function useDrawerSlot(): HTMLElement | null | undefined {
  return useContext(DrawerSlotContext);
}

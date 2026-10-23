import { useCallback, useState } from 'react';
import type { DeviceColumnMode } from '../components/device/DeviceColumn.tsx';
import { LAYOUT_KEYS, parseBoolean } from '../lib/layoutPrefs.ts';
import { useDocumentVisible } from './useDocumentVisible.ts';
import { useMediaQuery } from './useMediaQuery.ts';
import { useStoredState } from './useStoredState.ts';

/** Below this width the timeline needs the room: the device column becomes a drawer. */
export const DEVICE_OVERLAY_QUERY = '(max-width: 1279px)';

const parseCollapsed = (raw: string | null) => parseBoolean(raw, false);

export interface DeviceColumnState {
  mode: DeviceColumnMode;
  isOpen: boolean;
  setOpen: (isOpen: boolean) => void;
  /** Open and the tab in front: the only time the screen streams. */
  isVisible: boolean;
  /** Pinned open (the Inspector and Device views): no collapse, no drawer. */
  isPinned: boolean;
}

/**
 * Docked: collapsed or not, remembered per viewer. Overlay: a drawer that starts closed on every load.
 * Pinned (`isPinned`, the views built around the device): always docked and open; the remembered collapse
 * comes back in the Profiler view.
 */
export function useDeviceColumn(isPinned = false): DeviceColumnState {
  const isOverlay = useMediaQuery(DEVICE_OVERLAY_QUERY);
  const isPageVisible = useDocumentVisible();
  const [isCollapsed, setIsCollapsed] = useStoredState(LAYOUT_KEYS.deviceCollapsed, parseCollapsed);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // Pinning closes the drawer for good: back in the Profiler it starts closed again (adjusting state while rendering).
  const [wasPinned, setWasPinned] = useState(isPinned);
  if (wasPinned !== isPinned) {
    setWasPinned(isPinned);
    if (isPinned) setIsDrawerOpen(false);
  }
  const setOpen = useCallback(
    (open: boolean) => {
      if (isPinned) return;
      if (isOverlay) setIsDrawerOpen(open);
      else setIsCollapsed(!open);
    },
    [isPinned, isOverlay, setIsCollapsed],
  );
  if (isPinned) return { mode: 'docked', isOpen: true, setOpen, isVisible: isPageVisible, isPinned };
  const isOpen = isOverlay ? isDrawerOpen : !isCollapsed;
  return {
    mode: isOverlay ? 'overlay' : 'docked',
    isOpen,
    setOpen,
    isVisible: isOpen && isPageVisible,
    isPinned,
  };
}

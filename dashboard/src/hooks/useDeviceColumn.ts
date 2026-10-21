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
}

/** Docked: collapsed or not, remembered per viewer. Overlay: a drawer that starts closed on every load. */
export function useDeviceColumn(): DeviceColumnState {
  const isOverlay = useMediaQuery(DEVICE_OVERLAY_QUERY);
  const isPageVisible = useDocumentVisible();
  const [isCollapsed, setIsCollapsed] = useStoredState(LAYOUT_KEYS.deviceCollapsed, parseCollapsed);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const isOpen = isOverlay ? isDrawerOpen : !isCollapsed;
  const setOpen = useCallback(
    (open: boolean) => (isOverlay ? setIsDrawerOpen(open) : setIsCollapsed(!open)),
    [isOverlay, setIsCollapsed],
  );
  return { mode: isOverlay ? 'overlay' : 'docked', isOpen, setOpen, isVisible: isOpen && isPageVisible };
}

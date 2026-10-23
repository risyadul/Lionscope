import { useCallback, useEffect, useRef, useState } from 'react';
import { LAYOUT_KEYS, readStored, writeStored } from '../lib/layoutPrefs.ts';
import { initialViewMode, searchWithViewMode, type ViewMode } from '../lib/viewMode.ts';

/** Replaces the address's `?view=` (no new history entry). */
function writeSearch(mode: ViewMode): void {
  const { pathname, search, hash } = window.location;
  const nextSearch = searchWithViewMode(search, mode);
  if (nextSearch === search) return;
  try {
    window.history.replaceState(window.history.state, '', `${pathname}${nextSearch}${hash}`);
  } catch {
    // Some embedded contexts refuse history writes: the mode still applies, only the URL lags.
  }
}

/** The workspace's view mode: read from the URL or storage once, written back to both (`replaceState`, so no history entries). */
export function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() =>
    initialViewMode(window.location.search, readStored(LAYOUT_KEYS.viewMode)),
  );

  const change = useCallback((next: ViewMode) => {
    setMode(next);
    writeStored(LAYOUT_KEYS.viewMode, next);
    writeSearch(next);
  }, []);

  // The mode the page opened in counts as used: remember it, and put a remembered one in the address too, so
  // the page can be bookmarked or shared as is. Once; changes write both themselves.
  const opened = useRef(mode);
  useEffect(() => {
    writeStored(LAYOUT_KEYS.viewMode, opened.current);
    writeSearch(opened.current);
  }, []);

  return [mode, change];
}

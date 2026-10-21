import { useCallback, useSyncExternalStore } from 'react';

function media(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

/** Whether `query` matches now; false where `matchMedia` is unavailable (tests, old engines). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = media(query);
      mql?.addEventListener('change', onChange);
      return () => mql?.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = () => media(query)?.matches ?? false;
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

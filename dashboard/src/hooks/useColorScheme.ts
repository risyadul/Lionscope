import { useSyncExternalStore } from 'react';

export type ColorScheme = 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const mql = media();
  mql?.addEventListener('change', onChange);
  return () => mql?.removeEventListener('change', onChange);
}

function getSnapshot(): ColorScheme {
  return media()?.matches ? 'dark' : 'light';
}

/** The OS color scheme; charts re-read their canvas colors when it flips. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'light');
}

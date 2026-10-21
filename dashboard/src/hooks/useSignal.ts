import { useSyncExternalStore } from 'react';
import type { Signal } from '../lib/signal.ts';

export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get, signal.get);
}

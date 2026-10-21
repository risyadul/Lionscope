import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ClientMessage } from '@lionscope/protocol/wire';
import type { Signal } from '../lib/signal.ts';
import type { DashboardState, DashboardStore } from '../lib/store.ts';

export interface DashboardServices {
  store: DashboardStore;
  send: (msg: ClientMessage) => boolean;
  /** Epoch ms of the log row under the pointer; charts draw a probe line there. */
  probeTs: Signal<number | null>;
  /** Epoch seconds under the synced chart cursor. */
  cursorX: Signal<number | null>;
}

export const ServicesContext = createContext<DashboardServices | null>(null);

export function useServices(): DashboardServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('ServicesContext is missing');
  return services;
}

export function useDashboardState(): DashboardState {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

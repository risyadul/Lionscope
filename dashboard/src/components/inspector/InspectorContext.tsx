import { createContext, useContext, useSyncExternalStore } from 'react';
import type { InspectorController } from '../../hooks/useInspector.ts';

/** The Layout Inspector, shared by the device column (toggle, frozen screen) and the side tab. Null outside the app. */
export const InspectorContext = createContext<InspectorController | null>(null);

export function useInspectorContext(): InspectorController | null {
  return useContext(InspectorContext);
}

/** The hovered node id. Only the overlay and the tree subscribe, so hovering re-renders nothing else. */
export function useHoverId(controller: InspectorController): number | null {
  const { hoverId } = controller;
  return useSyncExternalStore(hoverId.subscribe, hoverId.get, hoverId.get);
}

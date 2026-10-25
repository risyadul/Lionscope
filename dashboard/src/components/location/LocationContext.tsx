import { createContext, useContext } from 'react';
import type { LocationsController } from '../../hooks/useDeviceLocations.ts';

/** Device locations for the device column's Location panel. Null outside the app (the panel is then not offered). */
export const LocationContext = createContext<LocationsController | null>(null);

export function useLocationContext(): LocationsController | null {
  return useContext(LocationContext);
}

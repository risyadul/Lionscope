import { useCallback, useMemo, useState } from 'react';
import type { ClientMessage, DeviceLocation } from '@lionscope/protocol/wire';
import type { LatLng } from '../lib/location.ts';
import type { ServerError } from '../lib/store.ts';

export interface LocationsController {
  /** Null while offline or with a server older than 0.10.0 (it can't change locations). */
  locations: DeviceLocation[] | null;
  /** Why locations can't be changed right now; null when they can. */
  blocker: string | null;
  /** The device a `setLocation` / `clearLocation` went out for and is not answered yet. */
  pendingSerial: string | null;
  /** Why the last change failed (the server's message), until the next one goes out. */
  error: string | null;
  set: (serial: string, point: LatLng) => void;
  clear: (serial: string) => void;
}

interface Pending {
  serial: string;
  /** The `locations` list when it went out: a new list answers it… */
  locations: DeviceLocation[] | null;
  /** …and so does a newer error. */
  errorId: number;
}

interface Options {
  send: (msg: ClientMessage) => boolean;
  locations: DeviceLocation[] | null;
  locationError: ServerError | null;
  isOpen: boolean;
}

export function locationBlocker(isOpen: boolean, locations: DeviceLocation[] | null): string | null {
  if (!isOpen) return 'Offline — waiting for the server.';
  if (locations === null) return 'This Lionscope server can’t change locations — update it to 0.10.0.';
  return null;
}

/** Location changes for the device column: what is set, what is on its way, and the last refusal. */
export function useDeviceLocations({ send, locations, locationError, isOpen }: Options): LocationsController {
  const [pending, setPending] = useState<Pending | null>(null);
  // The error id the user has seen past: an older refusal is not shown again after a new request.
  const [errorFloor, setErrorFloor] = useState(0);
  const errorId = locationError?.id ?? 0;
  const isAnswered =
    pending !== null && (locations !== pending.locations || errorId > pending.errorId || !isOpen);
  const activePending = pending !== null && !isAnswered ? pending : null;

  const request = useCallback(
    (serial: string, message: ClientMessage) => {
      if (!send(message)) return;
      setPending({ serial, locations, errorId });
      setErrorFloor(errorId);
    },
    [send, locations, errorId],
  );
  const set = useCallback(
    (serial: string, { latitude, longitude }: LatLng) =>
      request(serial, { type: 'setLocation', serial, latitude, longitude }),
    [request],
  );
  const clear = useCallback(
    (serial: string) => request(serial, { type: 'clearLocation', serial }),
    [request],
  );

  return useMemo(
    () => ({
      locations: isOpen ? locations : null,
      blocker: locationBlocker(isOpen, locations),
      pendingSerial: activePending?.serial ?? null,
      error: locationError !== null && locationError.id > errorFloor ? locationError.message : null,
      set,
      clear,
    }),
    [isOpen, locations, activePending?.serial, locationError, errorFloor, set, clear],
  );
}

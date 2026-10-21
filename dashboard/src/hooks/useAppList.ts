import { useCallback, useEffect, useRef } from 'react';
import type { ClientMessage } from '@lionscope/protocol/wire';

/** Opening the app picker refreshes the package list at most this often per device. */
export const APPS_REFRESH_THROTTLE_MS = 5000;

/**
 * Keeps the package list in sync with the selected device (and refetches after reconnecting); opening the
 * picker refreshes it, throttled. Returns that open handler.
 */
export function useAppList(
  send: (msg: ClientMessage) => boolean,
  serial: string | null,
  canRequest: boolean,
) {
  const lastRequest = useRef<{ serial: string; at: number } | null>(null);

  const sendListApps = useCallback(
    (target: string) => {
      lastRequest.current = { serial: target, at: Date.now() };
      send({ type: 'listApps', serial: target });
    },
    [send],
  );

  useEffect(() => {
    if (canRequest && serial !== null) sendListApps(serial);
  }, [canRequest, serial, sendListApps]);

  return () => {
    if (!canRequest || serial === null) return;
    const last = lastRequest.current;
    if (last && last.serial === serial && Date.now() - last.at < APPS_REFRESH_THROTTLE_MS) return;
    sendListApps(serial);
  };
}

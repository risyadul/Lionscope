import { useEffect, useRef } from 'react';
import type { ClientMessage } from '@lionscope/protocol/wire';
import { useDocumentVisible } from './useDocumentVisible.ts';

interface Options {
  send: (msg: ClientMessage) => boolean;
  /** The Inspector is on screen: its view, or the Profiler's Inspector tab. */
  isInspectorShown: boolean;
  /** The inspector's device (null: none, or an invalid serial). */
  serial: string | null;
  isOpen: boolean;
}

/**
 * Tells the server which device's Inspector is being looked at, so it keeps the SDK link up for it. Sent only on
 * change; a new connection starts unfocused on the server, so the current focus is sent again once it opens.
 */
export function useInspectorFocus({ send, isInspectorShown, serial, isOpen }: Options): void {
  const isVisible = useDocumentVisible();
  const focus = isInspectorShown && isVisible ? serial : null;
  // What the server holds for the current connection.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      sent.current = null;
      return;
    }
    if (sent.current === focus) return;
    if (send({ type: 'inspectorFocus', serial: focus })) sent.current = focus;
  }, [send, focus, isOpen]);
}

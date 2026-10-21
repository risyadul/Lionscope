import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenClientMessage } from '@lionscope/protocol/wire';
import { useStoredState } from '../../hooks/useStoredState.ts';
import {
  clipboardReadAccess,
  isClipboardReadGranted,
  limitClipboardText,
  readDesktopClipboard,
  resolveClipboardReadAccess,
  writeDesktopClipboard,
  type ReadAccess,
} from '../../lib/clipboard.ts';
import { LAYOUT_KEYS, parseBoolean } from '../../lib/layoutPrefs.ts';

/** How long each toast stays: a manual Copy needs time to be clicked. */
const TOAST_MS = { copied: 3000, manual: 10_000, failed: 5000 } as const;

/**
 * `manual`: the browser refused to write (page not focused, no user gesture); the text waits, outside the
 * DOM, for the Copy button.
 */
export type ClipboardToast = { kind: 'copied' } | { kind: 'manual'; text: string } | { kind: 'failed' };

const parseEnabled = (raw: string | null) => parseBoolean(raw, true);

export interface ClipboardShare {
  isEnabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** The screen was focused or pressed: push the desktop clipboard to Android if it changed. */
  pushFromDesktop: () => void;
  /** Sharing is on but the browser won't let the clipboard be read: only Cmd/Ctrl+V sends it. */
  isPasteOnly: boolean;
  /** A new screen socket opened: the server's sync setting starts over (off). */
  onSocketOpen: () => void;
  /** Text copied inside Android. */
  onRemoteClipboard: (text: string) => void;
  toast: ClipboardToast | null;
  copyManually: () => void;
}

/** Two-way clipboard between the desktop and the emulator, on by default and remembered per viewer. */
export function useClipboardShare(
  send: (msg: ScreenClientMessage) => boolean,
  isLive: boolean,
): ClipboardShare {
  const [isEnabled, setEnabled] = useStoredState(LAYOUT_KEYS.clipboardShare, parseEnabled);
  const [toast, setToast] = useState<ClipboardToast | null>(null);
  const enabledRef = useRef(isEnabled);
  const liveRef = useRef(isLive);
  /** Last text known to be on both sides: not pushed again, and an Android copy isn't echoed back. */
  const lastSynced = useRef<string | null>(null);
  const isReading = useRef(false);
  const [readAccess, setReadAccess] = useState<ReadAccess>(clipboardReadAccess);

  useEffect(() => {
    liveRef.current = isLive;
  }, [isLive]);

  useEffect(() => {
    enabledRef.current = isEnabled;
    send({ type: 'clipboardSync', enabled: isEnabled });
  }, [isEnabled, send]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (isEnabled) void resolveClipboardReadAccess().then(setReadAccess);
  }, [isEnabled]);

  const onSocketOpen = useCallback(() => {
    send({ type: 'clipboardSync', enabled: enabledRef.current });
  }, [send]);

  const pushFromDesktop = useCallback(() => {
    if (!enabledRef.current || !liveRef.current || isReading.current) return;
    isReading.current = true;
    void readDesktopClipboard().then((text) => {
      isReading.current = false;
      setReadAccess(clipboardReadAccess());
      if (text === null || text === '' || text === lastSynced.current) return;
      if (!enabledRef.current || !liveRef.current) return;
      if (send({ type: 'clipboard', text: limitClipboardText(text).text })) lastSynced.current = text;
    });
  }, [send]);

  // Back from another app: the desktop clipboard may have changed. No gesture here, so never risk a prompt.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || !enabledRef.current || !liveRef.current) return;
      void isClipboardReadGranted().then((isGranted) => {
        if (isGranted) pushFromDesktop();
      });
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [pushFromDesktop]);

  const onRemoteClipboard = useCallback((text: string) => {
    if (!enabledRef.current) return;
    lastSynced.current = text;
    void writeDesktopClipboard(text).then((ok) =>
      setToast(ok ? { kind: 'copied' } : { kind: 'manual', text }),
    );
  }, []);

  const copyManually = () => {
    if (toast?.kind !== 'manual') return;
    void writeDesktopClipboard(toast.text).then((ok) =>
      setToast(ok ? { kind: 'copied' } : { kind: 'failed' }),
    );
  };

  return {
    isEnabled,
    setEnabled,
    pushFromDesktop,
    isPasteOnly: isEnabled && (readAccess === 'unsupported' || readAccess === 'denied'),
    onSocketOpen,
    onRemoteClipboard,
    toast: isEnabled ? toast : null,
    copyManually,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClientMessage,
  NetworkMockInput,
  NetworkMockRule,
  NetworkMocksState,
} from '@lionscope/protocol/wire';
import { ruleInput, type MockDraft } from '../lib/network.ts';
import type { ServerError } from '../lib/store.ts';

export interface MockEditorState {
  draft: MockDraft;
  /** About the pre-filled values (a cut body, one that wasn't captured). */
  note: string | null;
  /** A `setNetworkMock` went out and is not answered yet. */
  isSaving: boolean;
  /** Why the last save failed (the server's message, or offline). */
  error: string | null;
}

export interface MockRulesController {
  /** The open editor, null when closed. */
  editor: MockEditorState | null;
  /** Why rules can't be changed right now; null when they can. */
  blocker: string | null;
  openEditor: (draft: MockDraft, note?: string | null) => void;
  closeEditor: () => void;
  save: (input: NetworkMockInput) => void;
  setEnabled: (rule: NetworkMockRule, enabled: boolean) => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

interface Pending {
  /** `networkMocks.rev` when the request went out: a higher one answers it. */
  rev: number;
  /** `mockError.id` when it went out: a newer error refuses it. */
  errorId: number;
}

interface Options {
  send: (msg: ClientMessage) => boolean;
  mocks: NetworkMocksState | null;
  mockError: ServerError | null;
  isOpen: boolean;
  isSessionActive: boolean;
}

const OFFLINE = 'Offline — waiting for the server.';

/** Why the rules can't be changed: offline, no session, or a server without mocks. */
export function mockBlocker(isOpen: boolean, isSessionActive: boolean, mocks: NetworkMocksState | null) {
  if (!isOpen) return OFFLINE;
  if (!isSessionActive) return 'Start a session to add mocks: rules belong to the running session.';
  if (mocks === null) return 'This Lionscope server can’t mock requests — update it to 0.7.0.';
  return null;
}

/**
 * The mock rules' edits: the editor (open, saving, refused) and the list's toggles and deletes. A save closes the
 * editor once a newer `networkMocks` arrives; a `setNetworkMock_failed` error keeps it open with the message.
 */
export function useMockRules({
  send,
  mocks,
  mockError,
  isOpen,
  isSessionActive,
}: Options): MockRulesController {
  const [editor, setEditor] = useState<MockEditorState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const rev = mocks?.rev ?? -1;
  const errorId = mockError?.id ?? 0;
  // What `save` reads, so it doesn't change identity with every store flush.
  const latest = useRef({ rev, errorId });
  useEffect(() => {
    latest.current = { rev, errorId };
  });

  // Answers arrive as store state; settle the save when one does (adjusting state while rendering).
  if (pending !== null) {
    if (!isOpen) {
      setPending(null);
      setEditor((current) => current && { ...current, isSaving: false, error: OFFLINE });
    } else if (errorId > pending.errorId) {
      setPending(null);
      setEditor((current) => current && { ...current, isSaving: false, error: mockError?.message ?? null });
    } else if (rev > pending.rev) {
      setPending(null);
      setEditor(null);
    }
  }

  const blocker = mockBlocker(isOpen, isSessionActive, mocks);

  const openEditor = useCallback((draft: MockDraft, note: string | null = null) => {
    setPending(null);
    setEditor({ draft, note, isSaving: false, error: null });
  }, []);

  const closeEditor = useCallback(() => {
    setPending(null);
    setEditor(null);
  }, []);

  const save = useCallback(
    (input: NetworkMockInput) => {
      const { rev: sentRev, errorId: sentErrorId } = latest.current;
      if (!send({ type: 'setNetworkMock', rule: input })) {
        setEditor((current) => current && { ...current, error: OFFLINE });
        return;
      }
      setPending({ rev: sentRev, errorId: sentErrorId });
      setEditor((current) => current && { ...current, isSaving: true, error: null });
    },
    [send],
  );

  const setEnabled = useCallback(
    (rule: NetworkMockRule, enabled: boolean) => {
      send({ type: 'setNetworkMock', rule: ruleInput(rule, { enabled }) });
    },
    [send],
  );

  const remove = useCallback((id: string) => send({ type: 'clearNetworkMocks', id }), [send]);
  const clearAll = useCallback(() => send({ type: 'clearNetworkMocks' }), [send]);

  return useMemo(
    () => ({ editor, blocker, openEditor, closeEditor, save, setEnabled, remove, clearAll }),
    [editor, blocker, openEditor, closeEditor, save, setEnabled, remove, clearAll],
  );
}

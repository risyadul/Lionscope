import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, InspectorSelection, InspectorSnapshot } from '@lionscope/protocol/wire';
import { buildIndex, type InspectorIndex } from '../lib/inspector.ts';
import { createSignal, type Signal } from '../lib/signal.ts';
import type { DashboardState } from '../lib/store.ts';
import { useViewEdits, type ViewEdits } from './useViewEdits.ts';

/** The server's error code for a failed `inspect`. */
export const INSPECT_FAILED_CODE = 'inspect_failed';
/** After the top screen changes, wait this long (animations, transitions) before re-capturing. */
export const AUTO_REFRESH_MS = 700;
/** Screen names come from the app: however fast they change, a device is captured at most this often on its own. */
export const MIN_AUTO_INTERVAL_MS = 2000;
/**
 * Frees the UI if the server never answers. The server's own worst case is its SDK wait (up to ~15 s) plus a
 * uiautomator dump (up to 20 s) plus the screencap, so this must stay well above that.
 */
export const CAPTURE_TIMEOUT_MS = 40_000;

export interface InspectorController {
  /** Inspect mode is on for the selected device: the screen is frozen to the snapshot. */
  isActive: boolean;
  /** A capture was requested for this device and not answered yet. */
  isCapturing: boolean;
  /**
   * Inspect was just turned on and the snapshot is still the one from before: it may not match the screen any
   * more, so it is dimmed and can't be picked from until a newer one arrives.
   */
  isStale: boolean;
  /** Why the last capture failed; cleared by the next request or a newer snapshot. */
  failure: string | null;
  /** Can ask the server for a snapshot (connected, a device with a valid serial). */
  canInspect: boolean;
  /** The latest snapshot of the selected device. */
  snapshot: InspectorSnapshot | null;
  index: InspectorIndex | null;
  selectedId: number | null;
  /** Who made the selection: the user's click or an AI agent's `select_inspector_node`. */
  selectionOrigin: InspectorSelection['origin'] | null;
  /** The view under the pointer or tree row; a signal so hovering never re-renders the app. */
  hoverId: Signal<number | null>;
  /** 0.8.0. Live view edits on this snapshot. */
  edits: ViewEdits;
  toggle: () => void;
  exit: () => void;
  refresh: () => void;
  select: (nodeId: number | null) => void;
  hover: (nodeId: number | null) => void;
}

interface Pending {
  serial: string;
  errorSeq: number;
  /** The newest `inspection` id (any device) when the request went out. */
  inspectionId: string | null;
}

interface Options {
  state: DashboardState;
  send: (msg: ClientMessage) => boolean;
  /** The selected device's serial (null: none). */
  serial: string | null;
  canInspect: boolean;
}

/** Top screen of the session: changes whenever the app navigates. */
function screenKey(state: DashboardState): string | null {
  const span = state.screens[state.screens.length - 1];
  return span === undefined ? null : `${span.start}:${span.screen?.name ?? ''}`;
}

/**
 * Inspect mode, the capture request in flight and the selection: what the device column and the tab share. The
 * returned controller keeps its identity until one of its values changes, so store flushes that don't touch the
 * Inspector never re-render the tree.
 */
export function useInspector({ state, send, serial, canInspect }: Options): InspectorController {
  const [activeSerial, setActiveSerial] = useState<string | null>(null);
  const [staleId, setStaleId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [hoverId] = useState(() => createSignal<number | null>(null));
  const baseline = useRef<string | null>(null);
  const lastCapture = useRef<{ serial: string; at: number } | null>(null);

  const inspection = state.inspection;
  const inspectionId = inspection?.id ?? null;
  const snapshot = inspection !== null && inspection.serial === serial ? inspection : null;
  const index = useMemo(() => (snapshot === null ? null : buildIndex(snapshot)), [snapshot]);
  const isActive = activeSerial !== null && activeSerial === serial;
  const selection = state.inspectorSelection;
  const hasSelection =
    snapshot !== null &&
    selection !== null &&
    selection.snapshotId === snapshot.id &&
    index?.byId.has(selection.nodeId);
  const selectedId = hasSelection ? selection.nodeId : null;
  const selectionOrigin = hasSelection ? selection.origin : null;
  const isStale = isActive && snapshot !== null && snapshot.id === staleId;
  const isCapturing = pending !== null && pending.serial === serial;
  const edits = useViewEdits({ state, send, snapshot, index, isEnabled: !isStale });

  // Answers arrive as store state; settle the request when one does (adjusting state while rendering).
  const [seen, setSeen] = useState({ errorSeq: state.errorSeq, inspectionId });
  if (seen.errorSeq !== state.errorSeq || seen.inspectionId !== inspectionId) {
    setSeen({ errorSeq: state.errorSeq, inspectionId });
    const isOwn = inspection !== null && inspection.serial === serial && inspectionId !== seen.inspectionId;
    if (pending !== null && pending.serial === serial) {
      if (state.errorSeq !== pending.errorSeq && state.lastError?.code === INSPECT_FAILED_CODE) {
        setPending(null);
        setFailure(state.lastError.message);
      } else if (isOwn && inspectionId !== pending.inspectionId) {
        // Only a snapshot of this device settles it: another device's answer is not ours.
        setPending(null);
      }
    }
    if (isOwn) setFailure(null);
  }

  // What the stable callbacks read, so they don't change identity with every store flush.
  const latest = useRef({
    serial,
    canInspect,
    errorSeq: state.errorSeq,
    inspectionId,
    snapshotId: snapshot?.id ?? null,
    isStale,
    key: screenKey(state),
  });
  useEffect(() => {
    latest.current = {
      serial,
      canInspect,
      errorSeq: state.errorSeq,
      inspectionId,
      snapshotId: snapshot?.id ?? null,
      isStale,
      key: screenKey(state),
    };
  });

  const request = useCallback(() => {
    const { serial: target, canInspect: can, errorSeq, inspectionId: newest } = latest.current;
    if (target === null || !can) return;
    if (!send({ type: 'inspect', serial: target })) {
      setFailure('Not connected to the server.');
      return;
    }
    lastCapture.current = { serial: target, at: Date.now() };
    setFailure(null);
    setPending({ serial: target, errorSeq, inspectionId: newest });
  }, [send]);

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setPending(null);
      setFailure('The device did not answer in time.');
    }, CAPTURE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const key = screenKey(state);
  useEffect(() => {
    if (!isActive || baseline.current === key) return;
    const last = lastCapture.current;
    const since = last !== null && last.serial === serial ? Date.now() - last.at : Infinity;
    const wait = Math.max(AUTO_REFRESH_MS, MIN_AUTO_INTERVAL_MS - since);
    const timer = setTimeout(() => {
      baseline.current = key;
      request();
    }, wait);
    return () => clearTimeout(timer);
  }, [isActive, key, serial, request]);

  const exit = useCallback(() => {
    setActiveSerial(null);
    hoverId.set(null);
    setPending(null);
    setFailure(null);
  }, [hoverId]);

  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  });
  const toggle = useCallback(() => {
    if (isActiveRef.current) {
      exit();
      return;
    }
    const { serial: target, canInspect: can, snapshotId, key: screen } = latest.current;
    if (target === null || !can) return;
    baseline.current = screen;
    setActiveSerial(target);
    setStaleId(snapshotId);
    request();
  }, [exit, request]);

  const select = useCallback(
    (nodeId: number | null) => {
      const { snapshotId, isStale: stale } = latest.current;
      if (snapshotId === null || stale) return;
      send({ type: 'selectInspectorNode', snapshotId, nodeId });
    },
    [send],
  );

  const hover = useCallback((nodeId: number | null) => hoverId.set(nodeId), [hoverId]);

  return useMemo(
    () => ({
      isActive,
      isCapturing,
      isStale,
      failure,
      canInspect,
      snapshot,
      index,
      selectedId,
      selectionOrigin,
      hoverId,
      edits,
      toggle,
      exit,
      refresh: request,
      select,
      hover,
    }),
    [
      isActive,
      isCapturing,
      isStale,
      failure,
      canInspect,
      snapshot,
      index,
      selectedId,
      selectionOrigin,
      hoverId,
      edits,
      toggle,
      exit,
      request,
      select,
      hover,
    ],
  );
}

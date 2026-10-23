import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  editableProperties,
  normalizeViewValue,
  VIEW_EDIT_TIMEOUT_MS,
  VIEW_PROPERTIES,
  type ClientMessage,
  type InspectorSnapshot,
  type ViewProperty,
  type ViewPropertyGroup,
  type ViewPropertyValue,
} from '@lionscope/protocol/wire';
import type { InspectorIndex } from '../lib/inspector.ts';
import type { DashboardState, ViewEditAnswer } from '../lib/store.ts';
import { covers, editErrorMessage, isCurrentValue } from '../lib/viewEdits.ts';

/** After an edit went through, the server re-captures the device on its own (~250 ms): wait this long for it. */
export const SETTLE_MS = 3000;
/** The server answers within its own SDK timeout; past this the answer (or the socket) was lost. */
export const ANSWER_TIMEOUT_MS = VIEW_EDIT_TIMEOUT_MS + 2000;
export const NOT_CONNECTED = 'Not connected to the server.';
export const NO_ANSWER = 'The server did not answer in time.';
const MAX_REQUEST_ID = 2 ** 31 - 1;

/** A property, the four sides of padding / margins, or (null) every property. */
export type EditName = ViewProperty | ViewPropertyGroup;

export type EditStatus = { kind: 'idle' } | { kind: 'applying' } | { kind: 'error'; message: string };

/** `refused`: nothing was sent (no snapshot, not editable, an invalid value or no connection; errors say so). */
export type EditResult = 'sent' | 'unchanged' | 'refused';

export interface ViewEdits {
  /** The snapshot can be edited now (not one from before Inspect was turned on again). */
  canEdit: boolean;
  /** Live edits in effect in the snapshot's app: the latest answer's count, else the snapshot's. */
  liveEdits: number;
  edit: (nodeId: number, property: ViewProperty, value: ViewPropertyValue) => EditResult;
  /** One property or group of `nodeId`, all of it (no name), or every live edit in the app (null). */
  revert: (nodeId: number | null, name?: EditName) => void;
  /** Shows why a typed value was not sent, next to its field. */
  reject: (nodeId: number, name: EditName, message: string) => void;
  /** Clears a field's error (Esc). */
  dismiss: (nodeId: number | null, name?: EditName) => void;
  status: (nodeId: number | null, name?: EditName) => EditStatus;
  /**
   * Why the last edit could not reach its view (`stale`, `no_link`): the server takes a new snapshot then, so this
   * outlives snapshots (unlike a field's error) until the next edit or revert.
   */
  notice: string | null;
}

interface Request {
  id: number;
  snapshotId: string;
  nodeId: number | null;
  name: EditName | null;
  /** What a `setViewProperty` sent (a second change of the same field compares with it, not the snapshot). */
  value?: ViewPropertyValue;
  /** `sent`: waiting for the answer; `applied`: done, waiting for the snapshot that shows it. */
  phase: 'sent' | 'applied';
}

interface EditsState {
  /** The snapshot the errors and the live-edit count belong to. */
  snapshotId: string | null;
  requests: readonly Request[];
  errors: ReadonlyMap<string, string>;
  liveEdits: number | null;
  notice: string | null;
  /** Snapshot changes the notice has lived through: it outlasts the one the server takes after a refusal, no more. */
  noticeAge: number;
  /** The device of the snapshot: another one drops the notice. */
  serial: string | null;
  /** `viewEditSeq` of the last answer read. */
  seenSeq: number;
}

/** Refusals that say the snapshot is out of date rather than anything about the field. */
const SNAPSHOT_ERRORS: ReadonlySet<string> = new Set(['stale', 'no_link']);

const IDLE: EditStatus = { kind: 'idle' };
const APPLYING: EditStatus = { kind: 'applying' };

function errorKey(nodeId: number | null, name: EditName | null | undefined): string {
  return `${nodeId ?? '*'}:${name ?? '*'}`;
}

function overlaps(a: EditName | null, b: EditName | null): boolean {
  if (a === null || b === null) return true;
  return VIEW_PROPERTIES.some((property) => covers(a, property) && covers(b, property));
}

function withError(errors: ReadonlyMap<string, string>, key: string, message: string | null) {
  if (message === null && !errors.has(key)) return errors;
  const next = new Map(errors);
  if (message === null) next.delete(key);
  else next.set(key, message);
  return next;
}

function settle(state: EditsState, answers: readonly ViewEditAnswer[]): EditsState {
  let { requests, errors, liveEdits, notice, noticeAge } = state;
  for (const answer of answers) {
    const request = requests.find((r) => r.id === answer.requestId && r.phase === 'sent');
    if (request === undefined) continue;
    requests = requests.filter((r) => r !== request);
    const isCurrent = request.snapshotId === state.snapshotId;
    // An answer about an older snapshot can't be shown at its field (node ids are per capture): a refusal goes to
    // the head, like one saying the view is gone.
    const isNotice =
      !answer.ok && (!isCurrent || (answer.error !== undefined && SNAPSHOT_ERRORS.has(answer.error)));
    if (isNotice) {
      notice = editErrorMessage(answer.error, answer.message);
      noticeAge = 0;
      continue;
    }
    if (!isCurrent) continue;
    if (answer.liveEdits !== undefined) liveEdits = answer.liveEdits;
    if (answer.ok) {
      requests = [...requests, { ...request, phase: 'applied' }];
    } else {
      const message = editErrorMessage(answer.error, answer.message);
      errors = withError(errors, errorKey(request.nodeId, request.name), message);
    }
  }
  return { ...state, requests, errors, liveEdits, notice, noticeAge };
}

interface Options {
  state: DashboardState;
  send: (msg: ClientMessage) => boolean;
  snapshot: InspectorSnapshot | null;
  index: InspectorIndex | null;
  isEnabled: boolean;
}

/**
 * Live view edits on the current snapshot: what is in flight, what failed and why, per node and property. An edit
 * stays `applying` from the request until the server's next snapshot of the device shows it (or SETTLE_MS).
 */
export function useViewEdits({ state, send, snapshot, index, isEnabled }: Options): ViewEdits {
  const snapshotId = snapshot?.id ?? null;
  const [edits, setEdits] = useState<EditsState>(() => ({
    snapshotId,
    requests: [],
    errors: new Map(),
    liveEdits: null,
    notice: null,
    noticeAge: 0,
    serial: snapshot?.serial ?? null,
    seenSeq: state.viewEditSeq,
  }));

  // Answers and snapshots arrive as store state; settle against them while rendering.
  let current = edits;
  if (current.seenSeq !== state.viewEditSeq) {
    const count = Math.min(state.viewEditSeq - current.seenSeq, state.viewEditAnswers.length);
    current = settle({ ...current, seenSeq: state.viewEditSeq }, state.viewEditAnswers.slice(-count));
  }
  if (current.snapshotId !== snapshotId) {
    // A new snapshot shows what was applied; errors named nodes of the old one.
    const serial = snapshot?.serial ?? null;
    const keepsNotice = current.notice !== null && current.noticeAge < 1 && serial === current.serial;
    current = {
      ...current,
      snapshotId,
      serial,
      requests: current.requests.filter((r) => r.phase === 'sent'),
      errors: new Map(),
      liveEdits: null,
      notice: keepsNotice ? current.notice : null,
      noticeAge: current.noticeAge + 1,
    };
  }
  if (current !== edits) setEdits(current);

  const latest = useRef({ snapshot, index, isEnabled, requests: edits.requests });
  // Before any event or timer can read it: a commit right after a new snapshot must see that snapshot.
  useLayoutEffect(() => {
    latest.current = { snapshot, index, isEnabled, requests: edits.requests };
  });
  const nextId = useRef(1);

  // When each request entered its phase: timers only, so rendering never reads the clock.
  const since = useRef(new Map<number, { phase: Request['phase']; at: number }>());
  const { requests } = edits;
  useEffect(() => {
    const now = Date.now();
    const seen = since.current;
    for (const id of [...seen.keys()]) if (!requests.some((r) => r.id === id)) seen.delete(id);
    let wait = Infinity;
    for (const request of requests) {
      let entry = seen.get(request.id);
      if (entry === undefined || entry.phase !== request.phase) {
        entry = { phase: request.phase, at: now };
        seen.set(request.id, entry);
      }
      const limit = request.phase === 'sent' ? ANSWER_TIMEOUT_MS : SETTLE_MS;
      wait = Math.min(wait, entry.at + limit - now);
    }
    if (wait === Infinity) return;
    const timer = setTimeout(
      () => {
        const at = Date.now();
        setEdits((prev) => {
          const expired = prev.requests.filter((r) => {
            const entry = seen.get(r.id);
            return (
              entry !== undefined && at - entry.at >= (r.phase === 'sent' ? ANSWER_TIMEOUT_MS : SETTLE_MS)
            );
          });
          if (expired.length === 0) return prev;
          let errors = prev.errors;
          for (const r of expired) {
            if (r.phase === 'sent' && r.snapshotId === prev.snapshotId) {
              errors = withError(errors, errorKey(r.nodeId, r.name), NO_ANSWER);
            }
          }
          return { ...prev, requests: prev.requests.filter((r) => !expired.includes(r)), errors };
        });
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(timer);
  }, [requests]);

  /** Sends `msg` for (nodeId, name) of the current snapshot and marks it applying, or says why it could not. */
  const request = useCallback(
    (
      target: string,
      nodeId: number | null,
      name: EditName | null,
      msg: (requestId: number) => ClientMessage,
      value?: ViewPropertyValue,
    ) => {
      const id = nextId.current;
      nextId.current = id >= MAX_REQUEST_ID ? 1 : id + 1;
      const key = errorKey(nodeId, name);
      if (!send(msg(id))) {
        setEdits((prev) => ({ ...prev, errors: withError(prev.errors, key, NOT_CONNECTED) }));
        return false;
      }
      setEdits((prev) => ({
        ...prev,
        requests: [
          ...prev.requests,
          { id, snapshotId: target, nodeId, name, phase: 'sent', ...(value === undefined ? {} : { value }) },
        ],
        errors: withError(prev.errors, key, null),
        notice: null,
      }));
      return true;
    },
    [send],
  );

  const edit = useCallback(
    (nodeId: number, property: ViewProperty, value: ViewPropertyValue): EditResult => {
      const { snapshot: shot, index: idx, isEnabled: enabled, requests: pending } = latest.current;
      const node = idx?.byId.get(nodeId);
      if (shot === null || node === undefined || !enabled || !editableProperties(node).includes(property)) {
        return 'refused';
      }
      const normalized = normalizeViewValue(property, value);
      const key = errorKey(nodeId, property);
      if (normalized === null) {
        setEdits((prev) => ({ ...prev, errors: withError(prev.errors, key, 'Not a valid value.') }));
        return 'refused';
      }
      // While a change of this field is on its way, the snapshot still shows the value before it.
      const inFlight = pending.findLast(
        (r) =>
          r.snapshotId === shot.id && r.nodeId === nodeId && r.name === property && r.value !== undefined,
      );
      const isUnchanged =
        inFlight === undefined ? isCurrentValue(node, property, normalized) : inFlight.value === normalized;
      if (isUnchanged) {
        setEdits((prev) => ({ ...prev, errors: withError(prev.errors, key, null) }));
        return 'unchanged';
      }
      const sent = request(
        shot.id,
        nodeId,
        property,
        (requestId) => ({
          type: 'setViewProperty',
          requestId,
          snapshotId: shot.id,
          nodeId,
          property,
          value: normalized,
        }),
        normalized,
      );
      return sent ? 'sent' : 'refused';
    },
    [request],
  );

  const revert = useCallback(
    (nodeId: number | null, name?: EditName) => {
      const { snapshot: shot, isEnabled: enabled } = latest.current;
      if (shot === null || !enabled) return;
      request(shot.id, nodeId, name ?? null, (requestId) => ({
        type: 'revertViewProperties',
        requestId,
        snapshotId: shot.id,
        ...(nodeId === null ? {} : { nodeId }),
        ...(name === undefined ? {} : { property: name }),
      }));
    },
    [request],
  );

  const reject = useCallback((nodeId: number, name: EditName, message: string) => {
    setEdits((prev) => ({ ...prev, errors: withError(prev.errors, errorKey(nodeId, name), message) }));
  }, []);

  const dismiss = useCallback((nodeId: number | null, name?: EditName) => {
    setEdits((prev) => ({ ...prev, errors: withError(prev.errors, errorKey(nodeId, name), null) }));
  }, []);

  const shown = current;
  const liveEdits = shown.liveEdits ?? snapshot?.liveEdits ?? 0;
  return useMemo(() => {
    const status = (nodeId: number | null, name?: EditName): EditStatus => {
      const own = name ?? null;
      const busy = shown.requests.some(
        (r) =>
          r.snapshotId === shown.snapshotId &&
          (r.nodeId === null || (nodeId !== null && r.nodeId === nodeId && overlaps(r.name, own))),
      );
      if (busy) return APPLYING;
      const message = shown.errors.get(errorKey(nodeId, own));
      return message === undefined ? IDLE : { kind: 'error', message };
    };
    return { canEdit: isEnabled, liveEdits, edit, revert, reject, dismiss, status, notice: shown.notice };
  }, [shown, isEnabled, liveEdits, edit, revert, reject, dismiss]);
}

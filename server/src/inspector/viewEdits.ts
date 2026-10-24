/**
 * Live view edits (0.8.0): change a property of a View in the current Inspector snapshot through the SDK link that
 * captured it, then take a new snapshot so every dashboard sees the result. Shared by the dashboards
 * (`setViewProperty` / `revertViewProperties`) and the agent tools; one rate limit per device for all of them.
 * Only the current snapshot's own app is reached, by the view keys of its latest capture (see the SDK's ViewEditor).
 */
import {
  DEVICE_PROTOCOL_V8,
  editableProperties,
  normalizeViewValue,
  VIEW_EDIT_BURST,
  VIEW_EDITS_PER_SECOND,
} from '@lionscope/protocol';
import type {
  InspectorNode,
  InspectorSnapshot,
  ViewEditError,
  ViewProperty,
  ViewPropertyGroup,
  ViewPropertyValue,
} from '@lionscope/protocol';
import { errorMessage, log } from '../log.ts';
import { TokenBucket } from '../net/tokenBucket.ts';
import { SdkEditError } from '../device/sdkLink.ts';
import type { SdkEditFailure, SdkLink, SdkViewEditResult } from '../device/sdkLink.ts';
import type { InspectorService } from './inspectorService.ts';

/** After an edit, the device is captured again this much later: the frame with the change is on screen by then. */
export const RESNAPSHOT_DELAY_MS = 250;
/** Devices whose edit rate is tracked at most (the oldest is forgotten first). */
const MAX_TRACKED_DEVICES = 32;

/**
 * `next`: the snapshot taken after the change (null when it failed or the server is closing). `applied`: for a
 * request of several properties that failed part way, the ones that were set before it.
 */
export type ViewEditOutcome =
  | { ok: true; liveEdits: number; next: Promise<InspectorSnapshot | null> }
  | {
      ok: false;
      error: ViewEditError;
      message: string;
      liveEdits?: number;
      applied?: ViewProperty[];
    };

export interface SetViewPropertyRequest {
  /** The snapshot the caller looked at; omitted: the current one (agents). */
  snapshotId?: string;
  nodeId: number;
  property: ViewProperty;
  value: ViewPropertyValue;
}

/** Several properties of one node, set in order as one request (an agent's padding or margins). */
export interface SetViewPropertiesRequest {
  snapshotId?: string;
  nodeId: number;
  values: readonly { property: ViewProperty; value: ViewPropertyValue }[];
}

export interface RevertViewPropertiesRequest {
  snapshotId?: string;
  /** Omitted: every live edit in the app. */
  nodeId?: number;
  property?: ViewProperty | ViewPropertyGroup;
}

export interface ViewEditsOptions {
  inspector: Pick<InspectorService, 'current' | 'editSource' | 'inspectFresh'>;
  now?: () => number;
  resnapshotDelayMs?: number;
}

const SDK_ERRORS: Readonly<Record<NonNullable<SdkViewEditResult['error']>, ViewEditError>> = {
  stale: 'stale',
  unsupported: 'not_editable',
  password: 'password',
  invalid: 'invalid_value',
  limit: 'limit',
  failed: 'failed',
  disabled: 'failed',
  busy: 'rate_limited',
  unauthenticated: 'unauthenticated',
};

const LINK_ERRORS: Readonly<Record<SdkEditFailure, ViewEditError>> = {
  unsupported: 'old_sdk',
  closed: 'no_link',
  timeout: 'timeout',
  busy: 'rate_limited',
};

/** What each failure tells the user (the dashboard shows it next to the field; agents get it as the error). */
export const VIEW_EDIT_MESSAGES: Readonly<Record<ViewEditError, string>> = {
  stale:
    'The view is not in the app’s latest capture any more (recreated or removed): a new snapshot is being taken, retry in it.',
  not_editable: 'This property cannot be edited live on this element.',
  password: 'The text of a password field is never read or changed.',
  invalid_value: 'That value is out of range or malformed for this property.',
  old_sdk: "The app's Lionscope SDK is older than 0.9.0: update it to edit views live.",
  no_link: "The app's SDK link is gone (it reconnected or closed): inspect again and retry.",
  rate_limited: 'Too many edits at once on this device: wait a moment and retry.',
  limit: 'The app already has the most live edits it keeps: revert some first.',
  timeout: 'The app did not answer the edit in time; it may still apply it: a new snapshot is being taken.',
  failed: 'The app could not apply the edit.',
  unauthenticated:
    'The app takes live edits only from a profiling session whose SDK link has the link proof: start a session and inspect again.',
};

/** Why a snapshot's views can't be edited (InspectorSnapshot.editBlocked), as said to the user. */
export const EDIT_BLOCKED_MESSAGES: Readonly<Record<NonNullable<InspectorSnapshot['editBlocked']>, string>> =
  {
    needs_session:
      'Live edits need a profiling session: this snapshot came over an inspect-only link, which has no link proof. Start a session and inspect again.',
    unverified:
      "The session's SDK link has no link proof (the link key could not be handed to the app over adb), so the app takes no live edits: restart the session.",
  };

/** Outcomes after which the app may have changed although nothing says so: a new snapshot shows what it has. */
const UNCERTAIN: ReadonlySet<ViewEditError> = new Set(['stale', 'timeout', 'failed']);

function failure(
  error: ViewEditError,
  message = VIEW_EDIT_MESSAGES[error],
  liveEdits?: number,
): ViewEditOutcome {
  return liveEdits === undefined ? { ok: false, error, message } : { ok: false, error, message, liveEdits };
}

interface Target {
  snapshot: InspectorSnapshot;
  link: SdkLink;
}

/** Node `nodeId` of an SDK snapshot and its view key, or why it can't be edited at all. */
function editableNode(
  snapshot: InspectorSnapshot,
  nodeId: number,
): { node: InspectorNode; key: number } | ViewEditOutcome {
  const node = snapshot.nodes[nodeId];
  if (!node) return failure('stale', `The snapshot has no node ${nodeId}: inspect again.`);
  // Messages carry no app strings (class names, ids, files): they reach agents as tool errors, which are not marked
  // as untrusted app data.
  if (node.composable) {
    return failure('not_editable', 'A composable cannot be edited live: change it in code at its call site.');
  }
  // An SDK View node without its view state: an SDK before 0.8.0.
  if (!node.view) return failure('old_sdk');
  return { node, key: node.view.key };
}

export class ViewEdits {
  private readonly now: () => number;
  private readonly delayMs: number;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly resnapshots = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (snapshot: InspectorSnapshot | null) => void;
      done: Promise<InspectorSnapshot | null>;
    }
  >();

  constructor(private readonly options: ViewEditsOptions) {
    this.now = options.now ?? Date.now;
    this.delayMs = options.resnapshotDelayMs ?? RESNAPSHOT_DELAY_MS;
  }

  set(request: SetViewPropertyRequest): Promise<ViewEditOutcome> {
    const { snapshotId, nodeId, property, value } = request;
    return this.setAll({ snapshotId, nodeId, values: [{ property, value }] });
  }

  /**
   * Every value is checked first, then they are sent in order to the node's view (by its key, through the link of the
   * snapshot that was current at the start), stopping at the first that fails.
   */
  async setAll(request: SetViewPropertiesRequest): Promise<ViewEditOutcome> {
    const found = this.target(request.snapshotId);
    if ('ok' in found) return found;
    const editable = editableNode(found.snapshot, request.nodeId);
    if ('ok' in editable) return editable;
    const { node, key } = editable;
    const steps: { property: ViewProperty; value: ViewPropertyValue }[] = [];
    for (const { property, value } of request.values) {
      if (!editableProperties(node).includes(property)) {
        if (property === 'text' && node.view?.password) return failure('password');
        return failure('not_editable', `${property} does not apply to this element.`);
      }
      const normalized = normalizeViewValue(property, value);
      if (normalized === null) return failure('invalid_value', `That is not a valid ${property}.`);
      steps.push({ property, value: normalized });
    }
    const applied: ViewProperty[] = [];
    let outcome: ViewEditOutcome = failure('invalid_value', 'Nothing to set.');
    for (const { property, value } of steps) {
      outcome = await this.send(found, () => found.link.setViewProperty(key, property, value));
      if (!outcome.ok) return applied.length > 0 ? { ...outcome, applied } : outcome;
      applied.push(property);
    }
    return outcome;
  }

  async revert(request: RevertViewPropertiesRequest): Promise<ViewEditOutcome> {
    const found = this.target(request.snapshotId);
    if ('ok' in found) return found;
    if (request.nodeId === undefined) {
      if (request.property !== undefined)
        return failure('not_editable', 'Name the element whose property to revert.');
      return this.send(found, () => found.link.revertViewProperties());
    }
    const editable = editableNode(found.snapshot, request.nodeId);
    if ('ok' in editable) return editable;
    return this.send(found, () => found.link.revertViewProperties(editable.key, request.property));
  }

  /** Stops the pending re-snapshots (server shutdown). */
  close(): void {
    for (const { timer, resolve } of this.resnapshots.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.resnapshots.clear();
  }

  /** The current snapshot (it must be `snapshotId` when given) and the SDK link that captured it. */
  private target(snapshotId: string | undefined): Target | ViewEditOutcome {
    const snapshot = this.options.inspector.current;
    if (!snapshot) return failure('stale', 'Nothing is inspected yet: inspect the screen first.');
    if (snapshotId !== undefined && snapshotId !== snapshot.id) {
      return failure('stale', 'A newer snapshot replaced this one: edit in the current snapshot.');
    }
    if (snapshot.source !== 'sdk') {
      return failure(
        'not_editable',
        'Only views of an SDK snapshot can be edited live; this one came from uiautomator (no Lionscope SDK answered).',
      );
    }
    if (snapshot.editBlocked) return failure('unauthenticated', EDIT_BLOCKED_MESSAGES[snapshot.editBlocked]);
    const source = this.options.inspector.editSource(snapshot.id);
    if (!source?.link) return failure('no_link');
    if (source.link.protocolVersion < DEVICE_PROTOCOL_V8) return failure('old_sdk');
    return { snapshot, link: source.link };
  }

  private async send(target: Target, request: () => Promise<SdkViewEditResult>): Promise<ViewEditOutcome> {
    const { serial } = target.snapshot;
    if (!this.bucket(serial).take()) return failure('rate_limited');
    let result: SdkViewEditResult;
    try {
      result = await request();
    } catch (error) {
      if (!(error instanceof SdkEditError)) throw error;
      const reason = LINK_ERRORS[error.reason];
      if (UNCERTAIN.has(reason)) void this.resnapshot(serial);
      return failure(reason);
    }
    if (!result.ok) {
      const error = SDK_ERRORS[result.error ?? 'failed'];
      // A view the app recreated (a new snapshot gives the dashboard its new key), or a change half made.
      if (UNCERTAIN.has(error)) void this.resnapshot(serial);
      return failure(error, VIEW_EDIT_MESSAGES[error], result.liveEdits);
    }
    return { ok: true, liveEdits: result.liveEdits, next: this.resnapshot(serial) };
  }

  private bucket(serial: string): TokenBucket {
    let bucket = this.buckets.get(serial);
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED_DEVICES) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = new TokenBucket(VIEW_EDIT_BURST, VIEW_EDITS_PER_SECOND, this.now);
      this.buckets.set(serial, bucket);
    }
    return bucket;
  }

  /**
   * One new snapshot RESNAPSHOT_DELAY_MS after the first edit of a burst (later ones in that time are in it too). An
   * edit after that schedules the next one, which waits for a capture that is still running (inspectFresh).
   */
  private resnapshot(serial: string): Promise<InspectorSnapshot | null> {
    const scheduled = this.resnapshots.get(serial);
    if (scheduled) return scheduled.done;
    let resolve: (snapshot: InspectorSnapshot | null) => void = () => undefined;
    const done = new Promise<InspectorSnapshot | null>((settle) => (resolve = settle));
    const timer = setTimeout(() => {
      this.resnapshots.delete(serial);
      this.options.inspector.inspectFresh(serial).then(resolve, (error: unknown) => {
        log.warn(`Inspector: no snapshot after a live edit on ${serial}: ${errorMessage(error)}`);
        resolve(null);
      });
    }, this.delayMs);
    timer.unref();
    this.resnapshots.set(serial, { timer, resolve, done });
    return done;
  }
}

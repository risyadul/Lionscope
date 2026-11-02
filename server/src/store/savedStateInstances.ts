import { pruneSavedStateInstances } from '@lionscope/protocol/insights';
import type { DeviceMessage, SavedStateInstance, ServerMessage } from '@lionscope/protocol';

type LiveActivity = Extract<DeviceMessage, { type: 'liveActivities' }>['activities'][number];

export interface SavedStateInstancesOptions {
  windowMs: number;
  emit: (message: ServerMessage) => void;
  now: () => number;
}

const keyOf = (pid: number, id: number) => `${pid}:${id}`;

/**
 * The SDK's Activity instances of a session (`liveActivities`, `savedState.instanceId`), keyed by process and number.
 * Each `liveActivities` list is the whole truth for its process: what it lists is live (a `closed` one it lists again
 * reopens), a live one of that process it leaves out is `closed` (at the list's time: after a link was down, when the
 * server learned it, not when it finished); a `truncated` list closes nothing, other processes' instances are never
 * touched. A process that ends or is replaced turns its live instances `process_ended`, for good. Changes are
 * announced (`savedStateInstance`) only when something changed. Closed ones leave once closed longer than the window,
 * and beyond MAX_SAVED_STATE_INSTANCES the longest closed go; live ones always stay. Once the session stopped
 * (`freeze`), the window is measured from the stop, so what was kept then stays as it was.
 */
export class SavedStateInstances {
  /** Insertion order: oldest first. */
  private readonly instances = new Map<string, SavedStateInstance>();
  /** The stop time once frozen: the window's end from then on. */
  private frozenAt: number | null = null;

  constructor(private readonly options: SavedStateInstancesOptions) {}

  /** The session stopped: keep the instances as they are now (the window no longer moves). Idempotent. */
  freeze(): void {
    if (this.frozenAt !== null) return;
    this.prune();
    this.frozenAt = this.options.now();
  }

  /** Live first-seen order kept; copies, pruned to the window. */
  list(): SavedStateInstance[] {
    this.prune();
    return [...this.instances.values()].map((instance) => ({ ...instance }));
  }

  /** A `liveActivities` list of process `pid`, at laptop time `at`. */
  reconcile(pid: number, at: number, activities: readonly LiveActivity[], truncated: boolean): void {
    const listed = new Set<number>();
    for (const { id, activity, prevId } of activities) {
      listed.add(id);
      const known = this.instances.get(keyOf(pid, id));
      if (!known) {
        this.add({ pid, id, activity, prevId, firstSeen: at, state: 'live', closedAt: null });
        continue;
      }
      if (known.state === 'process_ended') continue;
      const changes: Partial<SavedStateInstance> = {};
      if (known.state === 'closed') Object.assign(changes, { state: 'live', closedAt: null });
      // A report may have made it from its own class name; the list is the SDK's word.
      if (known.activity !== activity) changes.activity = activity;
      if (known.prevId === null && prevId !== null) changes.prevId = prevId;
      this.update(known, changes);
    }
    if (!truncated) {
      for (const instance of this.instances.values()) {
        if (instance.pid === pid && instance.state === 'live' && !listed.has(instance.id)) {
          this.update(instance, { state: 'closed', closedAt: at });
        }
      }
    }
    this.prune();
  }

  /**
   * A saved-state report of instance `id` of process `pid` at `at`: an instance not listed yet is taken as live until
   * the next list says otherwise; a closed or ended one stays so.
   */
  noteReport(pid: number, id: number, activity: string, at: number): void {
    if (!this.instances.has(keyOf(pid, id))) {
      this.add({ pid, id, activity, prevId: null, firstSeen: at, state: 'live', closedAt: null });
    }
    this.prune();
  }

  /** Process `pid` is gone or was replaced: its live instances ended with it. Idempotent. */
  endProcess(pid: number, at: number): void {
    this.endWhere((instance) => instance.pid === pid, at);
  }

  /** The live link is now process `pid`: live instances of any other process ended. Idempotent. */
  endOtherProcesses(pid: number, at: number): void {
    this.endWhere((instance) => instance.pid !== pid, at);
  }

  private endWhere(ended: (instance: SavedStateInstance) => boolean, at: number): void {
    for (const instance of this.instances.values()) {
      if (instance.state === 'live' && ended(instance)) {
        this.update(instance, { state: 'process_ended', closedAt: at });
      }
    }
    this.prune();
  }

  private add(instance: SavedStateInstance): void {
    this.instances.set(keyOf(instance.pid, instance.id), instance);
    this.options.emit({ type: 'savedStateInstance', instance: { ...instance } });
  }

  private update(instance: SavedStateInstance, changes: Partial<SavedStateInstance>): void {
    const changed = (Object.keys(changes) as (keyof SavedStateInstance)[]).some(
      (field) => instance[field] !== changes[field],
    );
    if (!changed) return;
    Object.assign(instance, changes);
    this.options.emit({ type: 'savedStateInstance', instance: { ...instance } });
  }

  /** The window and the cap (the dashboard applies the same rules: no message for a removal). */
  private prune(): void {
    const kept = new Set(
      pruneSavedStateInstances(
        [...this.instances.values()],
        this.frozenAt ?? this.options.now(),
        this.options.windowMs,
      ),
    );
    for (const [key, instance] of this.instances) if (!kept.has(instance)) this.instances.delete(key);
  }
}

import { PublicError } from '../errors.ts';

export const NO_SESSION_MARKERS_MESSAGE =
  'Start a session first: markers belong to a running profiling session';
/** Markers per session; a label can be marked again (the latest time wins), so a loop of runs needs few. */
export const MAX_RUN_MARKERS = 200;
export const MARKER_LABEL = /^[\w.:-]{1,40}$/;

export interface RunMarker {
  label: string;
  /** Server clock, epoch ms: the clock logcat entries and crashes are timed on (device clock + measured offset). */
  ts: number;
}

/**
 * Named points in time of one profiling session (`mark`), for search_logcat / get_crashes `sinceMarker` and
 * `untilMarker`. Marking a label again moves it to the new time. They end with the session.
 */
export class RunMarkers {
  private readonly markers = new Map<string, number>();

  /** Records `label` at `ts`; returns the time it replaced, if the label was already marked. */
  mark(label: string, ts: number): { marker: RunMarker; replacedTs: number | null } {
    if (!MARKER_LABEL.test(label)) throw new PublicError('A marker label is 1-40 letters, digits, _ . : -');
    const replacedTs = this.markers.get(label) ?? null;
    if (replacedTs === null && this.markers.size >= MAX_RUN_MARKERS) {
      throw new PublicError(
        `A session keeps at most ${MAX_RUN_MARKERS} markers: mark an existing label again`,
      );
    }
    // Re-inserted so the map stays in time order.
    this.markers.delete(label);
    this.markers.set(label, ts);
    return { marker: { label, ts }, replacedTs };
  }

  /** Oldest first. */
  list(): RunMarker[] {
    return [...this.markers].map(([label, ts]) => ({ label, ts }));
  }
}

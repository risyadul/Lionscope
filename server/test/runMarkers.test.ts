import { describe, expect, it } from 'vitest';
import { PublicError } from '../src/errors.ts';
import { MAX_RUN_MARKERS, RunMarkers } from '../src/session/runMarkers.ts';

describe('RunMarkers', () => {
  it('moves a label marked again to its new time, keeping the list in time order', () => {
    const markers = new RunMarkers();
    expect(markers.mark('run-1', 100)).toEqual({ marker: { label: 'run-1', ts: 100 }, replacedTs: null });
    markers.mark('run-2', 200);
    expect(markers.mark('run-1', 300).replacedTs).toBe(100);
    expect(markers.list()).toEqual([
      { label: 'run-2', ts: 200 },
      { label: 'run-1', ts: 300 },
    ]);
  });

  it(`refuses bad labels and a new label past ${MAX_RUN_MARKERS}, but still moves existing ones`, () => {
    const markers = new RunMarkers();
    expect(() => markers.mark('run 1', 1)).toThrow(PublicError);
    for (let i = 0; i < MAX_RUN_MARKERS; i++) markers.mark(`run-${i}`, i);
    expect(() => markers.mark('one-more', 1000)).toThrow(`at most ${MAX_RUN_MARKERS} markers`);
    expect(markers.mark('run-0', 1000).replacedTs).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { applyServerMessage, createInitialState } from '../src/lib/store.ts';
import { parseServerMessage } from '../src/lib/connection.ts';
import { inspectorSnapshot } from './inspectorFixtures.ts';

describe('inspection state', () => {
  it('keeps the latest snapshot and the selection made on it', () => {
    const snapshot = inspectorSnapshot();
    let state = applyServerMessage(createInitialState(), { type: 'inspection', snapshot });
    expect(state.inspection).toBe(snapshot);
    const selection = { snapshotId: snapshot.id, nodeId: 2, ts: 1, origin: 'user' as const };
    state = applyServerMessage(state, { type: 'inspectorSelection', selection });
    expect(state.inspectorSelection).toEqual(selection);
    state = applyServerMessage(state, { type: 'inspectorSelection', selection: null });
    expect(state.inspectorSelection).toBeNull();
  });

  it('drops a selection that belongs to an older snapshot', () => {
    let state = applyServerMessage(createInitialState(), {
      type: 'inspection',
      snapshot: inspectorSnapshot(),
    });
    state = applyServerMessage(state, {
      type: 'inspectorSelection',
      selection: { snapshotId: 'snap-1', nodeId: 2, ts: 1, origin: 'user' as const },
    });
    const same = applyServerMessage(state, { type: 'inspection', snapshot: inspectorSnapshot() });
    expect(same.inspectorSelection).not.toBeNull();
    const next = applyServerMessage(state, {
      type: 'inspection',
      snapshot: inspectorSnapshot({ id: 'snap-2' }),
    });
    expect(next.inspection?.id).toBe('snap-2');
    expect(next.inspectorSelection).toBeNull();
  });

  it('accepts the inspector messages from the socket', () => {
    expect(parseServerMessage('{"type":"inspectorSelection","selection":null}')).toEqual({
      type: 'inspectorSelection',
      selection: null,
    });
    expect(
      parseServerMessage(JSON.stringify({ type: 'inspection', snapshot: inspectorSnapshot() }))?.type,
    ).toBe('inspection');
  });
});

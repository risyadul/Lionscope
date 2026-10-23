import { describe, expect, it } from 'vitest';
import { applyServerMessage, createInitialState, MAX_VIEW_EDIT_ANSWERS } from '../src/lib/store.ts';
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

describe('live view edit answers', () => {
  it('keeps the latest answers in order, counts every one and stays bounded', () => {
    let state = createInitialState();
    expect(state.viewEditAnswers).toEqual([]);
    state = applyServerMessage(state, { type: 'viewEdit', requestId: 1, ok: true, liveEdits: 1 });
    state = applyServerMessage(state, {
      type: 'viewEdit',
      requestId: 2,
      ok: false,
      error: 'rate_limited',
      message: 'Too many edits.',
    });
    expect(state.viewEditSeq).toBe(2);
    expect(state.viewEditAnswers).toEqual([
      { requestId: 1, ok: true, liveEdits: 1 },
      { requestId: 2, ok: false, error: 'rate_limited', message: 'Too many edits.' },
    ]);
    for (let i = 3; i < 3 + MAX_VIEW_EDIT_ANSWERS; i++) {
      state = applyServerMessage(state, { type: 'viewEdit', requestId: i, ok: true });
    }
    expect(state.viewEditSeq).toBe(2 + MAX_VIEW_EDIT_ANSWERS);
    expect(state.viewEditAnswers).toHaveLength(MAX_VIEW_EDIT_ANSWERS);
    expect(state.viewEditAnswers.at(-1)?.requestId).toBe(2 + MAX_VIEW_EDIT_ANSWERS);
  });

  it('leaves the snapshot and the selection alone', () => {
    const snapshot = inspectorSnapshot();
    const before = applyServerMessage(createInitialState(), { type: 'inspection', snapshot });
    const after = applyServerMessage(before, { type: 'viewEdit', requestId: 1, ok: true });
    expect(after.inspection).toBe(before.inspection);
    expect(after.inspectorSelection).toBe(before.inspectorSelection);
  });

  it('accepts viewEdit from the socket', () => {
    expect(parseServerMessage('{"type":"viewEdit","requestId":4,"ok":true,"liveEdits":2}')).toEqual({
      type: 'viewEdit',
      requestId: 4,
      ok: true,
      liveEdits: 2,
    });
  });
});

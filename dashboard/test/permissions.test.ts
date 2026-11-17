import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { applyServerMessage, createInitialState } from '../src/lib/store.ts';

describe('permission state', () => {
  it('discovers supported settings from hello and accepts live consent changes', () => {
    const state = applyServerMessage(createInitialState(), {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.13.0',
      bufferWindowMs: 600000,
      storageConsent: 'read_write',
      permissions: { ...DEFAULT_PERMISSIONS },
    });
    expect(state.permissions).toEqual(DEFAULT_PERMISSIONS);
    const next = applyServerMessage(state, {
      type: 'permissions',
      permissions: { ...DEFAULT_PERMISSIONS, storageWrite: false },
    });
    expect(next.storageConsent).toBe('read');
    const off = applyServerMessage(next, {
      type: 'permissions',
      permissions: { ...DEFAULT_PERMISSIONS, storageRead: false, storageWrite: false },
    });
    expect(off.storageConsent).toBe('off');
    expect(off.session).toBe(state.session);
    expect(off.storageAnswers).toEqual([]);
  });
  it('leaves settings unavailable for older servers', () => {
    expect(
      applyServerMessage(createInitialState(), {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: 'older',
        bufferWindowMs: 600000,
      }).permissions,
    ).toBeNull();
  });
});

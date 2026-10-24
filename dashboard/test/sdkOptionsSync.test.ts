import { describe, expect, it } from 'vitest';
import type { SdkOptions } from '@lionscope/protocol/wire';
import {
  changedFields,
  IDLE_SYNC,
  isSyncPending,
  OPTIONS_SYNC_TIMEOUT_MS,
  requestOptions,
  settleOptions,
  shownOptions,
  type OptionsSync,
} from '../src/lib/sdkOptionsSync.ts';

const SERVER: SdkOptions = {
  stallThresholdMs: 150,
  strictMode: false,
  inflateTracking: true,
  rxTracking: true,
};
const at = (sessionSeq: number, errorSeq = 0, now = 1000) => ({ sessionSeq, errorSeq, now });

describe('changedFields', () => {
  it('keeps only fields that differ', () => {
    expect(changedFields({ stallThresholdMs: 150 }, SERVER)).toBeNull();
    expect(changedFields({ stallThresholdMs: 500, strictMode: false }, SERVER)).toEqual({
      stallThresholdMs: 500,
    });
    expect(changedFields({}, SERVER)).toBeNull();
  });

  it('reads rxTracking missing from an older server as on', () => {
    expect(changedFields({ rxTracking: false }, SERVER)).toEqual({ rxTracking: false });
    expect(changedFields({ rxTracking: true }, SERVER)).toBeNull();
    const legacy = { stallThresholdMs: 150, strictMode: false, inflateTracking: true } as SdkOptions;
    expect(changedFields({ rxTracking: true }, legacy)).toBeNull();
    expect(changedFields({ rxTracking: false }, legacy)).toEqual({ rxTracking: false });
  });

  it('settles an rxTracking change once the server reports it', () => {
    const sent = requestOptions(IDLE_SYNC, { rxTracking: false }, SERVER, at(1));
    expect(sent.send).toEqual({ rxTracking: false });
    expect(shownOptions(sent.sync, SERVER).rxTracking).toBe(false);
    expect(settleOptions(sent.sync, { ...SERVER, rxTracking: false }, at(2)).sync).toBe(IDLE_SYNC);
  });
});

describe('requestOptions', () => {
  it('skips a change that equals what is shown', () => {
    expect(requestOptions(IDLE_SYNC, { stallThresholdMs: 150 }, SERVER, at(1))).toEqual({
      sync: IDLE_SYNC,
      send: null,
    });
  });

  it('sends the first change and queues the rest, merged, behind it', () => {
    const first = requestOptions(IDLE_SYNC, { stallThresholdMs: 500 }, SERVER, at(1));
    expect(first.send).toEqual({ stallThresholdMs: 500 });
    const second = requestOptions(first.sync, { stallThresholdMs: 250 }, SERVER, at(1, 0, 1100));
    const third = requestOptions(second.sync, { strictMode: true }, SERVER, at(1, 0, 1200));
    expect([second.send, third.send]).toEqual([null, null]);
    expect(third.sync.queued).toEqual({ stallThresholdMs: 250, strictMode: true });
    expect(shownOptions(third.sync, SERVER)).toEqual({ ...SERVER, stallThresholdMs: 250, strictMode: true });
    expect(third.sync.since).toBe(1200);
    // Re-requesting what is already shown (pending) is a no-op too.
    expect(requestOptions(third.sync, { strictMode: true }, SERVER, at(1)).sync).toBe(third.sync);
  });
});

describe('settleOptions', () => {
  const sent = requestOptions(IDLE_SYNC, { stallThresholdMs: 500 }, SERVER, at(1)).sync;
  const queued = requestOptions(sent, { strictMode: true }, SERVER, at(1, 0, 1100)).sync;

  it('waits while nothing answered', () => {
    expect(settleOptions(sent, SERVER, at(1, 0, 1500)).sync).toBe(sent);
    expect(settleOptions(IDLE_SYNC, SERVER, at(5)).sync).toBe(IDLE_SYNC);
  });

  it('the answer releases the queued patch, minus what the server already has', () => {
    const step = settleOptions(queued, { ...SERVER, stallThresholdMs: 500 }, at(2, 0, 1300));
    expect(step.send).toEqual({ strictMode: true });
    expect(step.sync.inFlight).toEqual({ sessionSeq: 2, errorSeq: 0 });
    expect(step.sync.queued).toBeNull();
    expect(isSyncPending(step.sync)).toBe(true);
    // Its own answer matches everything requested: done.
    expect(
      settleOptions(step.sync, { ...SERVER, stallThresholdMs: 500, strictMode: true }, at(3, 0, 1400)).sync,
    ).toBe(IDLE_SYNC);
  });

  it('an unrelated session that does not match keeps the requested values shown', () => {
    const answered = settleOptions(sent, SERVER, at(2, 0, 1300)).sync;
    expect(answered.inFlight).toBeNull();
    expect(shownOptions(answered, SERVER).stallThresholdMs).toBe(500);
    expect(settleOptions(answered, { ...SERVER, stallThresholdMs: 500 }, at(3, 0, 1400)).sync).toBe(
      IDLE_SYNC,
    );
  });

  it('a queued patch the server already reflects is not sent', () => {
    const step = settleOptions(queued, { ...SERVER, strictMode: true }, at(2, 0, 1300));
    expect(step.send).toBeNull();
    expect(step.sync.inFlight).toBeNull();
  });

  it('an error or the timeout hands control back to the server', () => {
    expect(settleOptions(queued, SERVER, at(1, 1, 1300)).sync).toBe(IDLE_SYNC);
    const late = 1100 + OPTIONS_SYNC_TIMEOUT_MS;
    expect(settleOptions(queued, SERVER, at(1, 0, late - 1)).sync).toBe(queued);
    expect(settleOptions(queued, SERVER, at(1, 0, late)).sync).toBe(IDLE_SYNC);
  });

  it('never sends more than one request per answer under rapid changes', () => {
    let sync: OptionsSync = IDLE_SYNC;
    let sends = 0;
    let seq = 1;
    for (let i = 0; i < 40; i++) {
      const value = [100, 150, 250, 500, 1000][i % 5]!;
      const step = requestOptions(sync, { stallThresholdMs: value }, SERVER, at(seq, 0, 1000 + i));
      sync = step.sync;
      if (step.send) sends++;
    }
    expect(sends).toBe(1);
    seq++;
    const released = settleOptions(sync, SERVER, at(seq, 0, 1100));
    expect(released.send).toEqual({ stallThresholdMs: 1000 });
  });
});

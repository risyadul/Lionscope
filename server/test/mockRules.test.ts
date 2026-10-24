import { MAX_MOCK_BODY_BYTES, MAX_MOCK_SET_BODY_BYTES, MAX_NETWORK_MOCKS } from '@lionscope/protocol';
import type { NetworkMocksState, ServerMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_MOCKS,
  MOCK_PUSH_DEBOUNCE_MS,
  MockRules,
  NO_SESSION_MOCKS_MESSAGE,
} from '../src/session/mockRules.ts';
import { mockInput } from './helpers/networkFixtures.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const T0 = 1_800_000_000_000;

function setup() {
  let clock = T0;
  const messages: ServerMessage[] = [];
  const mocks = new MockRules({ now: () => clock, emit: (message) => messages.push(message) });
  const states = () =>
    messages.flatMap((message): NetworkMocksState[] =>
      message.type === 'networkMocks' ? [message.mocks] : [],
    );
  return {
    mocks,
    states,
    tick: () => {
      clock += 1000;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MockRules', () => {
  it('validates, normalises and numbers rules, announcing every change with a new rev', () => {
    const { mocks, states } = setup();
    expect(mocks.state).toEqual(EMPTY_MOCKS);
    // (The schema takes lower-case schemes only; the host and a default port are normalised.)
    const rule = mocks.set(mockInput({ url: 'https://API.Example.com:443/v1/Items' }), 'user');
    expect(rule).toEqual({
      ...mockInput(),
      url: 'https://api.example.com/v1/Items',
      id: 'm1',
      origin: 'user',
      updatedAt: T0,
    });
    expect(states()).toEqual([{ rules: [rule], rev: 1, appliedRev: null }]);
    expect(() => mocks.set({ ...mockInput(), status: 700 }, 'user')).toThrow(/^Invalid mock rule: status/);
    expect(() => mocks.set(mockInput({ url: 'ftp://api.example.com/' }), 'user')).toThrow(
      'must start with http://, https:// or *://',
    );
    expect(() => mocks.set(mockInput({ url: '*://api.example.com/' }), 'user')).toThrow(
      'an exact or prefix pattern needs http:// or https://',
    );
    expect(() => mocks.set({ ...mockInput(), extra: true }, 'user')).toThrow('Invalid mock rule');
    expect(() => mocks.set(mockInput({ body: 'x'.repeat(MAX_MOCK_BODY_BYTES + 1) }), 'user')).toThrow(
      'body too large',
    );
    expect(mocks.state.rev).toBe(1);
  });

  it('orders rules by precedence, replaces by id and removes them', () => {
    const { mocks, tick } = setup();
    const glob = mocks.set(mockInput({ match: 'glob', url: 'https://*.example.com/*' }), 'user');
    tick();
    const anyMethod = mocks.set(mockInput({ method: null }), 'agent');
    tick();
    const specific = mocks.set(mockInput(), 'user');
    tick();
    const exact = mocks.set(
      mockInput({ match: 'exact', url: 'https://api.example.com/v1/items/42' }),
      'user',
    );
    tick();
    const longer = mocks.set(mockInput({ url: 'https://api.example.com/v1/items/4' }), 'user');
    expect(mocks.state.rules.map((rule) => rule.id)).toEqual([
      exact.id,
      longer.id,
      specific.id,
      anyMethod.id,
      glob.id,
    ]);
    expect([glob, anyMethod, specific, exact, longer].map((rule) => rule.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);

    tick();
    // Replacing keeps the id; between otherwise equal rules the newer one wins.
    const replaced = mocks.set({ ...mockInput({ status: 503 }), id: anyMethod.id }, 'user');
    expect(replaced).toMatchObject({
      id: 'm2',
      method: 'GET',
      status: 503,
      origin: 'user',
      updatedAt: T0 + 5000,
    });
    expect(mocks.state.rules.map((rule) => rule.id)).toEqual(['m4', 'm5', 'm2', 'm3', 'm1']);
    expect(() => mocks.set({ ...mockInput(), id: 'm9' }, 'user')).toThrow('No mock rule m9');

    expect(mocks.remove('m9')).toBe(false);
    expect(mocks.remove('m4')).toBe(true);
    expect(mocks.state.rules).toHaveLength(4);
    expect(mocks.state.rev).toBe(7);
    mocks.clear();
    expect(mocks.state).toEqual({ rules: [], rev: 8, appliedRev: null });
    expect(mocks.set(mockInput(), 'user').id).toBe('m6');
  });

  it(`refuses more than ${MAX_NETWORK_MOCKS} rules or ${MAX_MOCK_SET_BODY_BYTES / 1024 / 1024} MB of bodies`, () => {
    const { mocks } = setup();
    const body = 'é'.repeat(MAX_MOCK_BODY_BYTES / 2); // the full 256 KB in UTF-8
    for (let i = 0; i < MAX_MOCK_SET_BODY_BYTES / MAX_MOCK_BODY_BYTES; i += 1) {
      mocks.set(mockInput({ url: `https://api.example.com/${i}`, body }), 'user');
    }
    expect(() => mocks.set(mockInput({ body: 'x' }), 'user')).toThrow('exceed 2 MB');
    // Replacing a rule counts its new body instead of its old one.
    expect(mocks.set({ ...mockInput({ body: 'x' }), id: 'm1' }, 'user').body).toBe('x');
    for (let i = mocks.state.rules.length; i < MAX_NETWORK_MOCKS; i += 1) mocks.set(mockInput(), 'user');
    expect(() => mocks.set(mockInput(), 'user')).toThrow(`At most ${MAX_NETWORK_MOCKS} mock rules`);
  });

  it('pushes the enabled rules to a live v7 link and follows its mocksApplied', () => {
    vi.useFakeTimers();
    const settle = () => vi.advanceTimersByTime(MOCK_PUSH_DEBOUNCE_MS);
    const { mocks, states } = setup();
    const disabled = mocks.set(mockInput({ enabled: false }), 'user');
    // A link that goes live gets no empty set: a fresh SDK already runs it.
    const link = new FakeLink(7);
    mocks.linkUp(link);
    expect(link.mockSets).toEqual([]);
    expect(states().at(-1)).toMatchObject({ rev: 1, appliedRev: 1 });

    const enabled = mocks.set(mockInput({ url: 'https://api.example.com/v2' }), 'user');
    expect(link.mockSets).toEqual([]);
    settle();
    expect(link.mockSets).toEqual([{ rev: 2, rules: [enabled] }]);
    expect(mocks.state.appliedRev).toBe(1);
    mocks.applied(5); // not a rev we sent
    mocks.applied(2);
    expect(states().at(-1)).toMatchObject({ rev: 2, appliedRev: 2 });
    mocks.applied(1); // a late confirmation of an older set
    expect(mocks.state.appliedRev).toBe(2);
    mocks.remove(enabled.id);
    settle();
    expect(link.mockSets.at(-1)).toEqual({ rev: 3, rules: [] });

    // A reconnecting SDK gets the current set at once; no live link: no applied rev.
    mocks.set({ ...mockInput(), id: disabled.id }, 'user');
    mocks.linkDown();
    expect(mocks.state.appliedRev).toBeNull();
    expect(mocks.linked).toBe(false);
    const next = new FakeLink(7);
    mocks.linkUp(next);
    expect(next.mockSets).toEqual([{ rev: 4, rules: mocks.state.rules }]);
    expect(mocks.state.appliedRev).toBeNull();

    // Below v7 nothing is sent.
    const old = new FakeLink(5);
    mocks.linkUp(old);
    mocks.set(mockInput(), 'user');
    settle();
    expect(old.mockSets).toEqual([]);
    expect(mocks.state.appliedRev).toBeNull();
  });

  it(`pushes a burst of changes once, ${MOCK_PUSH_DEBOUNCE_MS} ms after the last, with the latest set`, () => {
    vi.useFakeTimers();
    const { mocks } = setup();
    const link = new FakeLink(7);
    mocks.linkUp(link);
    for (let i = 0; i < 5; i += 1) {
      mocks.set(mockInput({ url: `https://api.example.com/${i}` }), 'user');
      vi.advanceTimersByTime(MOCK_PUSH_DEBOUNCE_MS - 1);
    }
    expect(link.mockSets).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(link.mockSets).toEqual([{ rev: 5, rules: mocks.state.rules }]);
    expect(mocks.state.rules).toHaveLength(5);

    // A change still waiting when the link goes down (or the rules end) is never sent.
    mocks.clear();
    mocks.linkDown();
    vi.advanceTimersByTime(MOCK_PUSH_DEBOUNCE_MS);
    mocks.linkUp(link);
    expect(link.mockSets).toHaveLength(1); // no rules: nothing to send to a fresh link
    mocks.set(mockInput(), 'user');
    mocks.end();
    vi.advanceTimersByTime(MOCK_PUSH_DEBOUNCE_MS);
    expect(link.mockSets).toHaveLength(1);
  });

  it('keeps updatedAt (and so the order of tied rules) when a change only switches a rule on or off', () => {
    const { mocks, tick } = setup();
    const first = mocks.set(mockInput(), 'user');
    tick();
    const second = mocks.set(mockInput(), 'user');
    expect(mocks.state.rules.map((rule) => rule.id)).toEqual([second.id, first.id]);
    tick();
    const off = mocks.set({ ...mockInput({ enabled: false }), id: second.id }, 'agent');
    expect(off).toMatchObject({ enabled: false, origin: 'agent', updatedAt: second.updatedAt });
    expect(mocks.state.rules.map((rule) => rule.id)).toEqual([second.id, first.id]);
    expect(mocks.state.rev).toBe(3);
    tick();
    // Any other change is an edit: it moves the rule ahead of its ties.
    const edited = mocks.set({ ...mockInput({ enabled: false, delayMs: 10 }), id: first.id }, 'user');
    expect(edited.updatedAt).toBe(T0 + 3000);
    expect(mocks.state.rules.map((rule) => rule.id)).toEqual([first.id, second.id]);
  });

  it('ends with an empty set and refuses changes afterwards', () => {
    const { mocks, states } = setup();
    mocks.linkUp(new FakeLink(7));
    mocks.set(mockInput(), 'user');
    mocks.end();
    expect(states().at(-1)).toEqual({ rules: [], rev: 2, appliedRev: null });
    expect(() => mocks.set(mockInput(), 'user')).toThrow(NO_SESSION_MOCKS_MESSAGE);
    expect(mocks.remove('m1')).toBe(false);
  });
});

import { MAX_MOCK_BODY_BYTES, MAX_MOCK_SET_BODY_BYTES, MAX_NETWORK_MOCKS } from '@lionscope/protocol';
import type { NetworkMocksState, ServerMessage } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { EMPTY_MOCKS, MockRules, NO_SESSION_MOCKS_MESSAGE } from '../src/session/mockRules.ts';
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
    const { mocks, states } = setup();
    const disabled = mocks.set(mockInput({ enabled: false }), 'user');
    // A link that goes live gets no empty set: a fresh SDK already runs it.
    const link = new FakeLink(7);
    mocks.linkUp(link);
    expect(link.mockSets).toEqual([]);
    expect(states().at(-1)).toMatchObject({ rev: 1, appliedRev: 1 });

    const enabled = mocks.set(mockInput({ url: 'https://api.example.com/v2' }), 'user');
    expect(link.mockSets).toEqual([{ rev: 2, rules: [enabled] }]);
    expect(mocks.state.appliedRev).toBe(1);
    mocks.applied(5); // not a rev we sent
    mocks.applied(2);
    expect(states().at(-1)).toMatchObject({ rev: 2, appliedRev: 2 });
    mocks.applied(1); // a late confirmation of an older set
    expect(mocks.state.appliedRev).toBe(2);
    mocks.remove(enabled.id);
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
    expect(old.mockSets).toEqual([]);
    expect(mocks.state.appliedRev).toBeNull();
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

import type { NetworkMockInput, NetworkMockRule } from '@lionscope/protocol';

/** A valid dashboard / agent mock rule: GET https://api.example.com/v1/items… answered with `[]`. */
export function mockInput(overrides: Partial<NetworkMockInput> = {}): NetworkMockInput {
  return {
    method: 'GET',
    match: 'prefix',
    url: 'https://api.example.com/v1/items',
    action: 'respond',
    status: 200,
    headers: [['Content-Type', 'application/json']],
    body: '[]',
    delayMs: 0,
    enabled: true,
    ...overrides,
  };
}

/** The same rule as the server keeps it. */
export function mockRule(overrides: Partial<NetworkMockRule> = {}): NetworkMockRule {
  return { ...mockInput(), id: 'm1', origin: 'user', updatedAt: 1, ...overrides };
}

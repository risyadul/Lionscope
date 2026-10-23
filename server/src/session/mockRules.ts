import {
  DEVICE_PROTOCOL_V7,
  MAX_MOCK_SET_BODY_BYTES,
  MAX_NETWORK_MOCKS,
  networkMockInputSchema,
} from '@lionscope/protocol';
import { normalizeMockUrl, orderMocks } from '@lionscope/protocol/insights';
import type { NetworkMockRule, NetworkMocksState, ServerMessage } from '@lionscope/protocol';
import type { SdkLink } from '../device/sdkLink.ts';
import { PublicError } from '../errors.ts';

/** No session, no rules. */
export const EMPTY_MOCKS: NetworkMocksState = { rules: [], rev: 0, appliedRev: null };
export const NO_SESSION_MOCKS_MESSAGE = 'Start a session first: mocks belong to a profiling session';

export type MockOrigin = NetworkMockRule['origin'];

export interface MockRulesOptions {
  now: () => number;
  emit: (message: ServerMessage) => void;
}

const bodyBytes = (rules: readonly NetworkMockRule[]): number =>
  rules.reduce((sum, rule) => sum + Buffer.byteLength(rule.body), 0);

/**
 * The mock rules of one profiling session: validated, normalised (scheme and host lower case, default port
 * dropped), ordered by precedence (orderMocks) and versioned (`rev`, one step per change). The enabled ones are
 * pushed to the session's live SDK link when it speaks v7: on every change, and when a link goes live (only if
 * there are any); `appliedRev` follows its `mocksApplied`. Every change is announced as `networkMocks`. They end with
 * the session.
 */
export class MockRules {
  private rules: NetworkMockRule[] = [];
  private rev = 0;
  private appliedRev: number | null = null;
  private nextId = 1;
  /** The session's live SDK link, while it is at protocol ≥ 7. */
  private link: SdkLink | null = null;
  private ended = false;

  constructor(private readonly options: MockRulesOptions) {}

  get state(): NetworkMocksState {
    return { rules: [...this.rules], rev: this.rev, appliedRev: this.appliedRev };
  }

  /** A v7 SDK link is live: rules reach the app. */
  get linked(): boolean {
    return this.link !== null;
  }

  /**
   * Create a rule, or replace the one with `input.id` (validated like a dashboard `setNetworkMock`); throws a
   * PublicError for an invalid rule, an unknown id, or over MAX_NETWORK_MOCKS / MAX_MOCK_SET_BODY_BYTES.
   */
  set(input: unknown, origin: MockOrigin): NetworkMockRule {
    if (this.ended) throw new PublicError(NO_SESSION_MOCKS_MESSAGE);
    const parsed = networkMockInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      );
      throw new PublicError(`Invalid mock rule: ${issues.join('; ')}`);
    }
    const { id, ...fields } = parsed.data;
    const existing = id === undefined ? undefined : this.rules.find((rule) => rule.id === id);
    if (id !== undefined && !existing) throw new PublicError(`No mock rule ${id}`);
    if (!existing && this.rules.length >= MAX_NETWORK_MOCKS) {
      throw new PublicError(`At most ${MAX_NETWORK_MOCKS} mock rules: remove one first`);
    }
    const others = this.rules.filter((rule) => rule !== existing);
    if (bodyBytes(others) + Buffer.byteLength(fields.body) > MAX_MOCK_SET_BODY_BYTES) {
      throw new PublicError(
        `The mock bodies would exceed ${MAX_MOCK_SET_BODY_BYTES / 1024 / 1024} MB in all`,
      );
    }
    const rule: NetworkMockRule = {
      ...fields,
      url: normalizeMockUrl(fields.url),
      id: existing?.id ?? `m${this.nextId++}`,
      origin,
      updatedAt: this.options.now(),
    };
    this.change([...others, rule]);
    return rule;
  }

  /** Remove one rule; false when there is none with that id. */
  remove(id: string): boolean {
    if (this.ended || !this.rules.some((rule) => rule.id === id)) return false;
    this.change(this.rules.filter((rule) => rule.id !== id));
    return true;
  }

  /** Remove every rule (a change even when there were none: the SDK gets an empty set). */
  clear(): void {
    if (this.ended) return;
    this.change([]);
  }

  /** The session's SDK link went live (verified): a v7 one gets the rules at once, when there are any. */
  linkUp(link: SdkLink): void {
    if (this.ended) return;
    if (link.protocolVersion < DEVICE_PROTOCOL_V7) return this.linkDown();
    this.link = link;
    const enabled = this.enabledRules();
    // A fresh SDK has no rules: with none to send, it already runs this rev.
    this.appliedRev = enabled.length > 0 ? null : this.rev;
    if (enabled.length > 0) link.sendMocks(this.rev, enabled);
    this.announce();
  }

  /** The session has no live SDK link (anymore). */
  linkDown(): void {
    if (this.link === null && this.appliedRev === null) return;
    this.link = null;
    this.appliedRev = null;
    if (!this.ended) this.announce();
  }

  /** The live link's SDK confirmed rule set `rev` (`mocksApplied`). */
  applied(rev: number): void {
    if (this.ended || this.link === null || rev > this.rev) return;
    if (this.appliedRev !== null && rev <= this.appliedRev) return;
    this.appliedRev = rev;
    this.announce();
  }

  /** The session stopped: the rules are gone (announced as an empty set). */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.link = null;
    this.appliedRev = null;
    if (this.rules.length > 0) {
      this.rules = [];
      this.rev += 1;
    }
    this.announce();
  }

  private change(rules: NetworkMockRule[]): void {
    this.rules = orderMocks(rules);
    this.rev += 1;
    this.link?.sendMocks(this.rev, this.enabledRules());
    this.announce();
  }

  private enabledRules(): NetworkMockRule[] {
    return this.rules.filter((rule) => rule.enabled);
  }

  private announce(): void {
    this.options.emit({ type: 'networkMocks', mocks: this.state });
  }
}

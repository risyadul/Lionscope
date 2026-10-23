import { useState } from 'react';
import type { NetworkMockRule, NetworkMocksState } from '@lionscope/protocol/wire';
import type { MockRulesController } from '../../hooks/useMockRules.ts';
import { formatBlockMs, formatInteger } from '../../lib/format.ts';
import { draftFromRule, EMPTY_DRAFT, matchLabel, ruleAnswer } from '../../lib/network.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';

type Props = {
  mocks: NetworkMocksState | null;
  control: MockRulesController;
};

function ruleSummary(rule: NetworkMockRule): string {
  return `${rule.method ?? 'Any method'} ${matchLabel(rule.match).toLowerCase()} ${rule.url}`;
}

function MockRow({ rule, control }: { rule: NetworkMockRule; control: MockRulesController }) {
  const isBlocked = control.blocker !== null;
  return (
    <li className="net-mock" data-enabled={rule.enabled || undefined}>
      <button
        type="button"
        role="switch"
        className="switch net-mock-switch"
        aria-checked={rule.enabled}
        aria-label={`Enabled: ${ruleSummary(rule)}`}
        disabled={isBlocked}
        title={control.blocker ?? (rule.enabled ? 'Turn this rule off' : 'Turn this rule on')}
        onClick={() => control.setEnabled(rule, !rule.enabled)}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </button>
      <div className="net-mock-main">
        <p className="net-mock-match">
          <span className="net-method mono">{rule.method ?? 'Any'}</span>
          <span className="net-badge">{matchLabel(rule.match)}</span>
          {rule.origin === 'agent' && (
            <span className="net-badge" data-kind="agent" title="Set by an AI agent (set_network_mock)">
              AI
            </span>
          )}
          <span className="net-mock-id mono">{rule.id}</span>
        </p>
        <p className="net-mock-url mono">{rule.url}</p>
        <p className="net-mock-answer">
          <span className="mono">→ {ruleAnswer(rule)}</span>
          {rule.delayMs > 0 && <span className="mono"> · after {formatBlockMs(rule.delayMs)}</span>}
        </p>
      </div>
      <div className="net-mock-actions">
        <button
          type="button"
          className="btn net-mock-action"
          disabled={isBlocked}
          onClick={() => control.openEditor(draftFromRule(rule))}
          aria-label={`Edit ${rule.id}`}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn--icon net-mock-action"
          disabled={isBlocked}
          onClick={() => control.remove(rule.id)}
          aria-label={`Delete ${rule.id}`}
          title="Delete this rule"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <path
              d="M2 3h7M4.4 3V1.8h2.2V3M3 3l.5 6.5h4L8 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </li>
  );
}

/** The session's mock rules, in precedence order: the first enabled match answers. */
export function MocksList({ mocks, control }: Props) {
  const [isConfirming, setIsConfirming] = useState(false);
  const rules = mocks?.rules ?? [];
  const enabled = rules.filter((rule) => rule.enabled).length;
  const isBlocked = control.blocker !== null;

  return (
    <section className="net-mocks" aria-labelledby="net-mocks-title">
      <div className="net-mocks-head">
        <h3 id="net-mocks-title" className="overline">
          Mock rules
        </h3>
        <span className="net-mocks-meta mono">
          {rules.length === 0 ? 'none' : `${formatInteger(enabled)} of ${formatInteger(rules.length)} on`}
        </span>
        <span className="net-mocks-buttons">
          <button
            type="button"
            className="btn net-mock-action"
            disabled={isBlocked}
            title={control.blocker ?? undefined}
            onClick={() => control.openEditor(EMPTY_DRAFT)}
          >
            New mock
          </button>
          {rules.length > 0 && (
            <button
              type="button"
              className="btn net-mock-action"
              disabled={isBlocked}
              onClick={() => setIsConfirming(true)}
            >
              Clear all
            </button>
          )}
        </span>
      </div>
      {control.blocker !== null && <p className="net-note">{control.blocker}</p>}
      {rules.length === 0 ? (
        <div className="net-empty">
          <p className="net-empty-title">No mock rules</p>
          <p>
            A rule answers matching requests in the app instead of the network: a canned response, a timeout
            or a connection error. Pick a request and press <strong>Mock this response</strong>, or add one.
          </p>
          <p className="net-empty-note">
            Rules last until the session stops; AI agents with device control can set them too.
          </p>
        </div>
      ) : (
        <>
          <ol className="net-mock-list">
            {rules.map((rule) => (
              <MockRow key={rule.id} rule={rule} control={control} />
            ))}
          </ol>
          <p className="net-mocks-foot">
            In precedence order: exact before prefix before glob, then the longest URL. The first enabled
            match answers; disabled rules are not sent to the app.
          </p>
        </>
      )}
      {isConfirming && (
        <ConfirmDialog
          title="Clear every mock rule?"
          confirmLabel="Clear all"
          onCancel={() => setIsConfirming(false)}
          onConfirm={() => {
            setIsConfirming(false);
            control.clearAll();
          }}
        >
          <p>
            {formatInteger(rules.length)} {rules.length === 1 ? 'rule' : 'rules'} will be removed, including
            those set by AI agents. The app goes back to the real network.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

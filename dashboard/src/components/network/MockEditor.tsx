import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { MockAction, MockMatch, NetworkMockInput } from '@lionscope/protocol/wire';
import { MAX_MOCK_BODY_BYTES, MAX_MOCK_DELAY_MS } from '@lionscope/protocol/wire';
import type { MockEditorState } from '../../hooks/useMockRules.ts';
import {
  ACTION_LABELS,
  formatBytes,
  HTTP_METHODS,
  utf8Bytes,
  validateDraft,
  type MockDraft,
  type MockField,
} from '../../lib/network.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';
import '../ui/confirmDialog.css';

const MATCH_OPTIONS: readonly SegmentedOption<MockMatch>[] = [
  { value: 'exact', label: 'Exact' },
  { value: 'prefix', label: 'Prefix' },
  { value: 'glob', label: 'Glob' },
];

const MATCH_HELP: Record<MockMatch, string> = {
  exact: 'The request URL without its query must be exactly this.',
  prefix: 'Any request URL that starts with this; the query is ignored.',
  glob: '* stands for any run of characters, / included (up to 8 of them).',
};

const ACTION_OPTIONS: readonly SegmentedOption<MockAction>[] = (
  ['respond', 'timeout', 'connection_error'] as const
).map((value) => ({ value, label: ACTION_LABELS[value] }));

const ACTION_HELP: Record<MockAction, string> = {
  respond: 'The app gets this response; the network is never asked.',
  timeout: 'The call fails with a SocketTimeoutException, as if the server never answered.',
  connection_error: 'The call fails with a ConnectException, as if the host were unreachable.',
};

const ANY_METHOD = '*';

type Props = {
  editor: MockEditorState;
  onSave: (input: NetworkMockInput) => void;
  onCancel: () => void;
};

function parsesAsJson(text: string): boolean {
  if (text.trim() === '') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The mock rule editor (a modal dialog, like ConfirmDialog: focus stays inside, Escape cancels, focus returns to
 * the opener). Errors show after the first Save and follow every edit from then on; the server's refusal shows at
 * the bottom.
 */
export function MockEditor({ editor, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<MockDraft>(editor.draft);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    urlRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const check = useMemo(() => validateDraft(draft), [draft]);
  const errors = isSubmitted ? check.errors : {};
  const bodyBytes = useMemo(() => utf8Bytes(draft.body), [draft.body]);
  const isJson = useMemo(() => parsesAsJson(draft.body), [draft.body]);
  const isRespond = draft.action === 'respond';
  // A captured method the menu doesn't list stays selectable.
  const methods: readonly string[] =
    draft.method !== null && !(HTTP_METHODS as readonly string[]).includes(draft.method)
      ? [...HTTP_METHODS, draft.method]
      : HTTP_METHODS;

  const change = (patch: Partial<MockDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitted(true);
    if (check.input === null || editor.isSaving) return;
    onSave(check.input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      // Handled here: one Escape closes the dialog only.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(ref.current?.querySelectorAll<HTMLElement>(
        'input, select, textarea, button:not(:disabled), [tabindex="0"]',
      ) ?? []),
    ].filter((el) => !(el as HTMLInputElement).disabled);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const fieldError = (field: MockField) =>
    errors[field] ? (
      <p id={`${id}-${field}-error`} className="mock-field-error">
        {errors[field]}
      </p>
    ) : null;
  const invalid = (field: MockField) =>
    errors[field] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-${field}-error` } : {};

  return createPortal(
    <div className="confirm-backdrop">
      <form
        ref={ref}
        className="mock-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        noValidate
        onSubmit={submit}
        onKeyDown={handleKeyDown}
      >
        <h2 id={`${id}-title`} className="confirm-title">
          {draft.id === undefined ? 'New mock' : `Edit mock ${draft.id}`}
        </h2>
        {editor.note && <p className="mock-note">{editor.note}</p>}

        <div className="mock-row">
          <div className="mock-field mock-field--method">
            <label className="mock-label" htmlFor={`${id}-method`}>
              Method
            </label>
            <select
              id={`${id}-method`}
              className="mock-input"
              value={draft.method ?? ANY_METHOD}
              onChange={(e) => change({ method: e.target.value === ANY_METHOD ? null : e.target.value })}
              {...invalid('method')}
            >
              <option value={ANY_METHOD}>Any</option>
              {methods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
            {fieldError('method')}
          </div>
          <div className="mock-field">
            <span className="mock-label" aria-hidden="true">
              Match
            </span>
            <Segmented
              options={MATCH_OPTIONS}
              value={draft.match}
              onChange={(match) => change({ match })}
              label="Match"
              className="mock-segmented"
            />
          </div>
        </div>

        <div className="mock-field">
          <label className="mock-label" htmlFor={`${id}-url`}>
            URL
          </label>
          <input
            id={`${id}-url`}
            ref={urlRef}
            className="mock-input mono"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={draft.url}
            onChange={(e) => change({ url: e.target.value })}
            {...invalid('url')}
          />
          {fieldError('url') ?? (
            <p className="mock-help">
              {MATCH_HELP[draft.match]}
              {draft.url.includes('?') && ' With a ? in it, the query is compared too.'}
            </p>
          )}
        </div>

        <div className="mock-field">
          <span className="mock-label" aria-hidden="true">
            Answer
          </span>
          <Segmented
            options={ACTION_OPTIONS}
            value={draft.action}
            onChange={(action) => change({ action })}
            label="Answer"
            className="mock-segmented"
          />
          <p className="mock-help">{ACTION_HELP[draft.action]}</p>
        </div>

        {isRespond && (
          <>
            <div className="mock-field mock-field--status">
              <label className="mock-label" htmlFor={`${id}-status`}>
                Status
              </label>
              <input
                id={`${id}-status`}
                className="mock-input mono"
                type="number"
                min={100}
                max={599}
                value={draft.status}
                onChange={(e) => change({ status: e.target.value })}
                {...invalid('status')}
              />
              {fieldError('status')}
            </div>
            <div className="mock-field">
              <label className="mock-label" htmlFor={`${id}-headers`}>
                Headers
              </label>
              <textarea
                id={`${id}-headers`}
                className="mock-input mock-textarea mono"
                rows={3}
                spellCheck={false}
                placeholder="Content-Type: application/json"
                value={draft.headers}
                onChange={(e) => change({ headers: e.target.value })}
                {...invalid('headers')}
              />
              {fieldError('headers') ?? <p className="mock-help">One per line, as Name: value.</p>}
            </div>
            <div className="mock-field">
              <div className="mock-label-row">
                <label className="mock-label" htmlFor={`${id}-body`}>
                  Body
                </label>
                <span className="mock-bytes mono" data-over={bodyBytes > MAX_MOCK_BODY_BYTES || undefined}>
                  {formatBytes(bodyBytes)} of {formatBytes(MAX_MOCK_BODY_BYTES)}
                </span>
                {isJson && (
                  <button
                    type="button"
                    className="btn mock-format"
                    onClick={() => change({ body: JSON.stringify(JSON.parse(draft.body), null, 2) })}
                  >
                    Format JSON
                  </button>
                )}
              </div>
              <textarea
                id={`${id}-body`}
                className="mock-input mock-textarea mock-body mono"
                rows={8}
                spellCheck={false}
                value={draft.body}
                onChange={(e) => change({ body: e.target.value })}
                {...invalid('body')}
              />
              {fieldError('body')}
            </div>
          </>
        )}

        <div className="mock-row">
          <div className="mock-field mock-field--delay">
            <label className="mock-label" htmlFor={`${id}-delay`}>
              Delay (ms)
            </label>
            <input
              id={`${id}-delay`}
              className="mock-input mono"
              type="number"
              min={0}
              max={MAX_MOCK_DELAY_MS}
              step={50}
              value={draft.delayMs}
              onChange={(e) => change({ delayMs: e.target.value })}
              {...invalid('delayMs')}
            />
            {fieldError('delayMs') ?? <p className="mock-help">Waits before answering, up to 30 s.</p>}
          </div>
          <button
            type="button"
            role="switch"
            className="switch mock-enabled"
            aria-checked={draft.enabled}
            onClick={() => change({ enabled: !draft.enabled })}
          >
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            Enabled
          </button>
        </div>

        {editor.error && (
          <p className="mock-error" role="alert">
            {editor.error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={editor.isSaving}>
            {editor.isSaving ? 'Saving…' : 'Save mock'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

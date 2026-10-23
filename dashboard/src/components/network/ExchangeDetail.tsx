import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  HttpBody,
  HttpExchange,
  HttpFailure,
  HttpHeader,
  NetworkMockRule,
} from '@lionscope/protocol/wire';
import { HTTP_REDACTED } from '@lionscope/protocol/wire';
import { statusClassOf, urlParts } from '@lionscope/protocol/insights';
import type { HttpDetailView } from '../../hooks/useHttpDetail.ts';
import { formatBlockMs, formatClock } from '../../lib/format.ts';
import {
  bodyNote,
  formatBodyText,
  formatBytes,
  headerValue,
  matchLabel,
  mediaType,
  ruleAnswer,
  truncatedNote,
} from '../../lib/network.ts';
import { CopyButton } from '../stalls/CopyButton.tsx';

type DetailTab = 'overview' | 'headers' | 'request' | 'response' | 'timing';

const TABS: readonly { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'headers', label: 'Headers' },
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
  { id: 'timing', label: 'Timing' },
];

const FAILURE_LABELS: Record<HttpFailure['kind'], string> = {
  timeout: 'Timed out',
  connection: 'Connection failed',
  canceled: 'Canceled',
  io: 'I/O error',
  lost: 'Lost: the app’s link closed before the response',
};

type Props = {
  exchange: HttpExchange;
  detail: HttpDetailView;
  /** The rule that answered it (when it was mocked and the rule still exists). */
  rule: NetworkMockRule | null;
  /** Laptop clock, for how long a pending call has been waiting. */
  now: number;
  onClose: () => void;
  onMockThis: () => void;
  /** Why "Mock this response" is unavailable; null when it is. */
  mockBlocker: string | null;
};

function stateText(exchange: HttpExchange): string {
  if (exchange.state === 'pending') return 'Pending: waiting for the response';
  if (exchange.state === 'complete') return 'Complete';
  const failure = exchange.error;
  if (failure === null) return 'Failed';
  return `Failed · ${FAILURE_LABELS[failure.kind]}`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Headers({ title, headers }: { title: string; headers: readonly HttpHeader[] | null }) {
  return (
    <section className="net-headers" aria-label={title}>
      <h4 className="overline">{title}</h4>
      {headers === null ? (
        <p className="net-note">No response yet.</p>
      ) : headers.length === 0 ? (
        <p className="net-note">No headers.</p>
      ) : (
        <dl className="net-header-list mono">
          {headers.map(([name, value], i) => (
            <div key={i} className="net-header">
              <dt>{name}</dt>
              {value === HTTP_REDACTED ? (
                <dd data-redacted title="Hidden by Lionscope: a sensitive header">
                  {HTTP_REDACTED}
                </dd>
              ) : (
                <dd>{value}</dd>
              )}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function BodyView({
  body,
  encoding,
  label,
}: {
  body: HttpBody | null;
  encoding: string | null;
  label: string;
}) {
  const note = bodyNote(body, encoding);
  const text = body?.text ?? null;
  if (note !== null || text === null || body === null) {
    return <p className="net-note">{note ?? 'No body.'}</p>;
  }
  const shown = formatBodyText(text, body.contentType);
  const cut = truncatedNote(body);
  return (
    <div className="net-body">
      <div className="net-body-head">
        <span className="net-body-meta mono">
          {[mediaType(body.contentType), formatBytes(body.size), shown.isJson ? 'JSON' : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <CopyButton text={() => text} label="Copy body" ariaLabel={`Copy ${label}`} />
      </div>
      {cut && <p className="net-note net-note--warn">{cut}</p>}
      <pre className="net-body-text mono" data-json={shown.isJson || undefined}>
        {shown.text}
      </pre>
    </div>
  );
}

function Pending({ detail }: { detail: HttpDetailView }) {
  return (
    <p className="net-note" role="status">
      {detail.status === 'gone'
        ? 'The server no longer keeps this request’s headers and bodies.'
        : 'Loading headers and bodies…'}
    </p>
  );
}

function Timing({ exchange, now }: { exchange: HttpExchange; now: number }) {
  if (exchange.durationMs === null) {
    return (
      <p className="net-note">
        Still waiting: started {formatBlockMs(Math.max(0, now - exchange.ts))} ago, at{' '}
        <span className="mono">{formatClock(exchange.ts)}</span>.
      </p>
    );
  }
  const total = exchange.durationMs;
  const waiting = exchange.headersMs === null ? null : Math.min(exchange.headersMs, total);
  const download = waiting === null ? null : Math.max(0, total - waiting);
  return (
    <div className="net-timing">
      {waiting !== null && download !== null && (
        <div className="net-timing-bar" aria-hidden="true">
          <span data-part="waiting" style={{ flexGrow: Math.max(waiting, total * 0.01) }} />
          <span data-part="download" style={{ flexGrow: Math.max(download, total * 0.01) }} />
        </div>
      )}
      <dl className="net-facts">
        {waiting !== null && (
          <Fact label="Waiting">
            <span className="net-key" data-part="waiting" aria-hidden="true" />
            <span className="mono">{formatBlockMs(waiting)}</span> to the response headers
          </Fact>
        )}
        {download !== null && (
          <Fact label="Download">
            <span className="net-key" data-part="download" aria-hidden="true" />
            <span className="mono">{formatBlockMs(download)}</span> to the end of the body
          </Fact>
        )}
        <Fact label="Total">
          <span className="mono">{formatBlockMs(total)}</span>
        </Fact>
        <Fact label="Started">
          <span className="mono">{formatClock(exchange.ts)}</span>
        </Fact>
      </dl>
    </div>
  );
}

/** The selected request: overview, headers, both bodies and timing, with "Mock this response". */
export function ExchangeDetail({ exchange, detail, rule, now, onClose, onMockThis, mockBlocker }: Props) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const id = useId();
  const { host, path } = urlParts(exchange.url);
  const statusClass = statusClassOf(exchange);
  const full = detail.detail;

  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    let index: number;
    if (event.key === 'ArrowRight') index = (at + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') index = (at - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = TABS.length - 1;
    else return;
    const next = TABS[index];
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  const panel = (() => {
    switch (tab) {
      case 'overview':
        return (
          <dl className="net-facts">
            <Fact label="Method">
              <span className="mono">{exchange.method}</span>
            </Fact>
            <Fact label="URL">
              <span className="net-full-url mono">{exchange.url}</span>
              <CopyButton text={() => exchange.url} label="Copy URL" />
            </Fact>
            <Fact label="Status">
              <span className="net-status mono" data-class={statusClass}>
                {exchange.status ?? '—'}
              </span>
            </Fact>
            <Fact label="State">
              {stateText(exchange)}
              {exchange.error?.message && <span className="net-error mono">{exchange.error.message}</span>}
            </Fact>
            {exchange.mockId !== null && (
              <Fact label="Mocked by">
                <span className="net-badge" data-kind="mock">
                  Mocked
                </span>{' '}
                {rule === null ? (
                  <>
                    rule <span className="mono">{exchange.mockId}</span> (since removed)
                  </>
                ) : (
                  <>
                    rule <span className="mono">{rule.id}</span>: {rule.method ?? 'Any'} ·{' '}
                    {matchLabel(rule.match)}
                    {' · '}
                    <span className="mono">{rule.url}</span> → {ruleAnswer(rule)}
                  </>
                )}
              </Fact>
            )}
            <Fact label="Protocol">
              <span className="mono">{full?.protocol ?? '—'}</span>
            </Fact>
            <Fact label="Request">
              <span className="mono">{formatBytes(exchange.requestSize)}</span>
              {full?.requestBody?.contentType && ` · ${mediaType(full.requestBody.contentType)}`}
            </Fact>
            <Fact label="Response">
              <span className="mono">{formatBytes(exchange.responseSize)}</span>
              {exchange.responseType && ` · ${mediaType(exchange.responseType)}`}
            </Fact>
            <Fact label="Screen">{exchange.screen ?? '—'}</Fact>
            <Fact label="Started">
              <span className="mono">{formatClock(exchange.ts)}</span>
            </Fact>
          </dl>
        );
      case 'headers':
        return full === null ? (
          <Pending detail={detail} />
        ) : (
          <>
            <Headers title="Request headers" headers={full.requestHeaders} />
            <Headers
              title="Response headers"
              headers={exchange.state === 'pending' ? null : full.responseHeaders}
            />
          </>
        );
      case 'request':
        return full === null ? (
          <Pending detail={detail} />
        ) : (
          <BodyView body={full.requestBody} encoding={null} label="request body" />
        );
      case 'response':
        if (exchange.state === 'pending') return <p className="net-note">No response yet.</p>;
        return full === null ? (
          <Pending detail={detail} />
        ) : (
          <BodyView
            body={full.responseBody}
            encoding={headerValue(full.responseHeaders, 'Content-Encoding')}
            label="response body"
          />
        );
      case 'timing':
        return <Timing exchange={exchange} now={now} />;
    }
  })();

  return (
    <article className="net-detail" aria-label="Selected request">
      <header className="net-detail-head">
        <p className="net-detail-title">
          <span className="net-method mono">{exchange.method}</span>
          <span className="net-status mono" data-class={statusClass}>
            {exchange.status ?? (exchange.state === 'pending' ? '…' : 'failed')}
          </span>
          <span className="net-detail-path mono" title={exchange.url}>
            {path}
          </span>
          {exchange.mockId !== null && (
            <span className="net-badge" data-kind="mock">
              Mocked
            </span>
          )}
        </p>
        <p className="net-detail-host">{host}</p>
        <div className="net-detail-actions">
          <button
            type="button"
            className="btn net-mock-this"
            onClick={onMockThis}
            disabled={mockBlocker !== null}
            title={mockBlocker ?? 'Answer this URL with this response from now on'}
          >
            Mock this response
          </button>
          <button
            type="button"
            className="btn btn--icon net-detail-close"
            onClick={onClose}
            aria-label="Close the request details"
            title="Close (Esc)"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="m2 2 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <div className="net-detail-tabs" role="tablist" aria-label="Request details" onKeyDown={handleTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`${id}-tab-${t.id}`}
            type="button"
            role="tab"
            className="net-detail-tab"
            data-tab={t.id}
            aria-selected={tab === t.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        className="net-detail-body"
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab}`}
        tabIndex={0}
      >
        {panel}
      </div>
    </article>
  );
}

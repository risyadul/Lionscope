import { useMemo, useState } from 'react';
import type { HttpExchange, NetworkMocksState } from '@lionscope/protocol/wire';
import type { HttpDetailView } from '../../hooks/useHttpDetail.ts';
import type { MockRulesController } from '../../hooks/useMockRules.ts';
import { formatInteger } from '../../lib/format.ts';
import {
  draftFromExchange,
  HTTP_METHODS,
  listExchanges,
  NO_LIST_FILTER,
  type ListFilter,
  type StatusFilter,
} from '../../lib/network.ts';
import type { NetworkEmpty } from '../../lib/viewState.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';
import { Select } from '../ui/Select.tsx';
import { ExchangeDetail } from './ExchangeDetail.tsx';
import { MocksList } from './MocksList.tsx';
import { RequestList } from './RequestList.tsx';
import './network.css';

export type NetworkView = 'requests' | 'mocks';

/** Where the interceptor goes (the README has the Retrofit and Ktor variants). */
export const INTERCEPTOR_SNIPPET = `OkHttpClient.Builder()
    .addInterceptor(Lionscope.okHttpInterceptor()) // last among the app's interceptors
    .build()`;

const STATUS_OPTIONS: readonly SegmentedOption<StatusFilter>[] = [
  { value: 'all', label: 'All' },
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
  {
    value: 'failed',
    label: 'Failed',
    title: 'Calls that failed before a response: timeouts, refused connections…',
  },
];

const ANY_METHOD = '*';

type Props = {
  exchanges: readonly HttpExchange[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Where pending calls end (now while live). */
  openEnd: number;
  empty: NetworkEmpty | null;
  view: NetworkView;
  onViewChange: (view: NetworkView) => void;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  detail: HttpDetailView;
  mocks: NetworkMocksState | null;
  mockControl: MockRulesController;
};

function EmptyPanel({ empty }: { empty: NetworkEmpty }) {
  switch (empty.kind) {
    case 'window':
      return (
        <div className="net-empty">
          <p className="net-empty-title">Nothing in this window</p>
          <p>Widen the time window, or go back to Live if the timeline is paused.</p>
        </div>
      );
    case 'no-session':
      return (
        <div className="net-empty">
          <p className="net-empty-title">Start a session to capture requests</p>
          <p>The app’s OkHttp calls show up here while a session runs, with headers, bodies and timing.</p>
        </div>
      );
    case 'needs-sdk':
      return (
        <div className="net-empty">
          <p className="net-empty-title">Network capture needs the SDK</p>
          <p>
            It needs Lionscope SDK 0.9.0
            {empty.sdkVersion ? ` (the app runs v${empty.sdkVersion})` : ''} and{' '}
            <code>Lionscope.okHttpInterceptor()</code> in the app’s OkHttpClient.
          </p>
          <pre className="net-snippet mono">{INTERCEPTOR_SNIPPET}</pre>
        </div>
      );
    case 'disconnected':
      return (
        <div className="net-empty">
          <p className="net-empty-title">SDK disconnected</p>
          <p>SDK v{empty.sdkVersion} dropped off. It reconnects by itself while the app is running.</p>
        </div>
      );
    case 'link-failed':
      return (
        <div className="net-empty" data-tone="critical">
          <p className="net-empty-title">SDK link failed</p>
          <p>
            The server couldn’t map the SDK port on the device (<code>adb reverse</code>), so the app can’t
            report here. It retries when the device reconnects.
          </p>
          <p className="net-empty-detail mono">{empty.message}</p>
        </div>
      );
    case 'old-server':
      return (
        <div className="net-empty">
          <p className="net-empty-title">This server can’t record requests</p>
          <p>Update Lionscope to 0.9.0: network capture needs a matching server and SDK.</p>
        </div>
      );
    case 'unverified':
      return (
        <div className="net-empty" data-tone="critical">
          <p className="net-empty-title">Network capture is off</p>
          <p>
            Lionscope couldn’t hand the app its link key over adb, so the SDK doesn’t trust this link and
            keeps capture and mocks off. Restart the session; if it persists, check that the app has SDK
            0.9.0’s <code>LinkKeyReceiver</code>.
          </p>
        </div>
      );
    case 'waiting':
      return (
        <div className="net-empty">
          <p className="net-empty-title">No requests yet</p>
          <p>
            Calls appear as the app makes them. Only OkHttp clients built with{' '}
            <code>Lionscope.okHttpInterceptor()</code> are captured (Retrofit, and Ktor’s OkHttp engine):
          </p>
          <pre className="net-snippet mono">{INTERCEPTOR_SNIPPET}</pre>
        </div>
      );
  }
}

/** The Network tab: the requests in the visible window with one request's detail, or the session's mock rules. */
export function NetworkPanel({
  exchanges,
  fromTs,
  toTs,
  openEnd,
  empty,
  view,
  onViewChange,
  selectedId,
  onSelect,
  detail,
  mocks,
  mockControl,
}: Props) {
  const [filter, setFilter] = useState<ListFilter>(NO_LIST_FILTER);
  const [isFollowing, setIsFollowing] = useState(true);
  // While reading back, the list keeps the window's left edge it had: rows don't slide away under the pointer.
  const [frozenFromTs, setFrozenFromTs] = useState<number | null>(null);
  const listFromTs = isFollowing || frozenFromTs === null ? fromTs : Math.min(frozenFromTs, fromTs);

  const rows = useMemo(
    () => listExchanges(exchanges, listFromTs, toTs, openEnd, filter),
    [exchanges, listFromTs, toTs, openEnd, filter],
  );
  const inWindow = useMemo(
    () => listExchanges(exchanges, listFromTs, toTs, openEnd, NO_LIST_FILTER).length,
    [exchanges, listFromTs, toTs, openEnd],
  );
  // The newest row when following stopped: later ones are "unseen".
  const [seenId, setSeenId] = useState<number | null>(null);
  const unseen = isFollowing || seenId === null ? 0 : rows.filter((row) => row.id > seenId).length;
  const methods = useMemo(() => {
    const seen = new Set<string>(HTTP_METHODS);
    for (const exchange of exchanges) seen.add(exchange.method);
    return [...seen];
  }, [exchanges]);
  const selected = useMemo(
    () => (selectedId === null ? null : (exchanges.find((e) => e.id === selectedId) ?? null)),
    [exchanges, selectedId],
  );
  const rule = selected?.mockId == null ? null : (mocks?.rules.find((r) => r.id === selected.mockId) ?? null);
  const ruleCount = mocks?.rules.length ?? 0;

  const changeFollow = (next: boolean) => {
    setIsFollowing(next);
    setFrozenFromTs(next ? null : fromTs);
    setSeenId(next ? null : (rows[rows.length - 1]?.id ?? null));
  };
  const changeFilter = (patch: Partial<ListFilter>) => {
    setFilter((current) => ({ ...current, ...patch }));
    changeFollow(true);
  };
  const mockThis = () => {
    if (selected === null) return;
    const { draft, note } = draftFromExchange(selected, detail.detail);
    mockControl.openEditor(draft, note);
  };

  const viewOptions: readonly SegmentedOption<NetworkView>[] = [
    { value: 'requests', label: 'Requests' },
    { value: 'mocks', label: ruleCount > 0 ? `Mocks ${formatInteger(ruleCount)}` : 'Mocks' },
  ];
  const hasList = empty === null;

  return (
    <section className="net" aria-labelledby="net-title">
      <header className="net-head">
        <h2 id="net-title" className="sr-only">
          Network
        </h2>
        <Segmented
          options={viewOptions}
          value={view}
          onChange={onViewChange}
          label="Show"
          className="net-view"
        />
        {view === 'requests' && hasList && (
          <span className="net-count mono">
            {rows.length === inWindow
              ? `${formatInteger(rows.length)} ${rows.length === 1 ? 'request' : 'requests'}`
              : `${formatInteger(rows.length)} of ${formatInteger(inWindow)}`}
          </span>
        )}
      </header>

      {view === 'mocks' ? (
        <div className="net-scroll">
          <MocksList mocks={mocks} control={mockControl} />
        </div>
      ) : !hasList ? (
        <div className="net-scroll">
          <EmptyPanel empty={empty} />
        </div>
      ) : (
        <>
          <div className="net-toolbar">
            <label className="net-search">
              <span className="sr-only">Filter by method, URL or status</span>
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <circle cx="5.5" cy="5.5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="m8.6 8.6 3.4 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={filter.query}
                placeholder="URL or status"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => changeFilter({ query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && filter.query !== '') {
                    e.preventDefault();
                    changeFilter({ query: '' });
                  }
                }}
              />
            </label>
            <label className="net-method-filter">
              <span className="sr-only">Method</span>
              <Select
                className="net-select"
                value={filter.method ?? ANY_METHOD}
                onChange={(e) =>
                  changeFilter({ method: e.target.value === ANY_METHOD ? null : e.target.value })
                }
              >
                <option value={ANY_METHOD}>All methods</option>
                {methods.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </label>
            <button
              type="button"
              className="net-toggle"
              aria-pressed={filter.mockedOnly}
              title="Only requests answered by a mock rule"
              onClick={() => changeFilter({ mockedOnly: !filter.mockedOnly })}
            >
              <span className="net-toggle-dot" aria-hidden="true" />
              Mocked
            </button>
            <Segmented
              options={STATUS_OPTIONS}
              value={filter.status}
              onChange={(status) => changeFilter({ status })}
              label="Status"
              className="net-status-filter"
            />
          </div>
          {rows.length === 0 ? (
            <div className="net-scroll">
              <p className="net-note net-note--pad">Nothing matches: clear the search or pick All.</p>
            </div>
          ) : (
            <RequestList
              rows={rows}
              selectedId={selectedId}
              onSelect={onSelect}
              isFollowing={isFollowing}
              onFollowChange={changeFollow}
              unseen={unseen}
            />
          )}
          {selected !== null && (
            <ExchangeDetail
              exchange={selected}
              detail={detail}
              rule={rule}
              now={openEnd}
              onClose={() => onSelect(null)}
              onMockThis={mockThis}
              mockBlocker={mockControl.blocker}
            />
          )}
        </>
      )}
    </section>
  );
}

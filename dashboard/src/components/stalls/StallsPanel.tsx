import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SdkOptions, StallSample, StrictModeSample } from '@lionscope/protocol/wire';
import { formatBlockMs } from '../../lib/format.ts';
import {
  aggregateOffenders,
  buildFeed,
  countDebuggerStalls,
  culpritLabel,
  findFeedItem,
  type FeedFilter,
} from '../../lib/stalls.ts';
import type { StallsEmpty } from '../../lib/viewState.ts';
import { SDK_GRADLE_SNIPPET } from '../topbar/SdkStatus.tsx';
import { OffendersTable } from './OffendersTable.tsx';
import { StallControls } from './StallControls.tsx';
import { StallDetail } from './StallDetail.tsx';
import { StallFeed } from './StallFeed.tsx';
import './stallMarks.css';
import './stalls.css';

type Props = {
  stalls: readonly StallSample[];
  strictMode: readonly StrictModeSample[];
  /** Visible window, epoch ms. */
  fromTs: number;
  toTs: number;
  /** Set when there is nothing in the window. */
  empty: StallsEmpty | null;
  options: SdkOptions;
  optionsBlocker: string | null;
  isOptionsPending: boolean;
  onOptionsChange: (patch: Partial<SdkOptions>) => void;
  inflateBlocker: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
};

function EmptyPanel({ empty }: { empty: StallsEmpty }) {
  switch (empty.kind) {
    case 'waiting':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">No stalls yet</p>
          <p>
            Main thread blocks ≥ {formatBlockMs(empty.thresholdMs)} will appear here, with the app line that
            caused them.
          </p>
          <p className="stalls-empty-note">
            Turn StrictMode on to also catch disk and network work on the main thread.
          </p>
        </div>
      );
    case 'window':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">Nothing in this window</p>
          <p>Widen the time window, or go back to Live if the timeline is paused.</p>
        </div>
      );
    case 'old-sdk':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">This SDK can’t detect stalls</p>
          <p>
            The app runs Lionscope SDK{empty.sdkVersion ? ` v${empty.sdkVersion}` : ''}. Update the app’s
            Lionscope SDK to 0.2.0 for stall detection and StrictMode, then rebuild and reinstall the debug
            app.
          </p>
        </div>
      );
    case 'old-server':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">This server can’t record stalls</p>
          <p>Update Lionscope to 0.2.0: stall detection needs a matching server and SDK.</p>
        </div>
      );
    case 'link-failed':
      return (
        <div className="stalls-empty" data-tone="critical">
          <p className="stalls-empty-title">SDK link failed</p>
          <p>
            The server couldn’t map the SDK port on the device (<code>adb reverse</code>), so the app’s
            watchdog can’t report here. It retries when the device reconnects.
          </p>
          <p className="stalls-empty-detail mono">{empty.message}</p>
        </div>
      );
    case 'disconnected':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">SDK disconnected</p>
          <p>SDK v{empty.sdkVersion} dropped off. It reconnects by itself while the app is running.</p>
        </div>
      );
    case 'no-session':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">No stalls recorded</p>
          <p>
            Start a session on an app with the Lionscope SDK: main-thread blocks show up here as they happen.
          </p>
        </div>
      );
    case 'no-sdk':
      return (
        <div className="stalls-empty">
          <p className="stalls-empty-title">Stall detection needs the SDK</p>
          <p>
            A watchdog inside the debug app catches main-thread blocks and the line that caused them. Add the
            Lionscope SDK (0.2.0 or newer), rebuild and reinstall the debug app; it connects to this session
            on launch.
          </p>
          <pre className="stalls-snippet mono">{SDK_GRADLE_SNIPPET}</pre>
        </div>
      );
  }
}

/** The Stalls tab: SDK controls, the worst culprit lines, every event, and one event's stack. */
export function StallsPanel({
  stalls,
  strictMode,
  fromTs,
  toTs,
  empty,
  options,
  optionsBlocker,
  isOptionsPending,
  onOptionsChange,
  inflateBlocker,
  selectedKey,
  onSelect,
}: Props) {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [culpritKey, setCulpritKey] = useState<string | null>(null);

  const offenders = useMemo(() => aggregateOffenders(stalls, fromTs, toTs), [stalls, fromTs, toTs]);
  const debuggerCount = useMemo(() => countDebuggerStalls(stalls, fromTs, toTs), [stalls, fromTs, toTs]);
  // A culprit filter whose line left the window stops filtering.
  const activeOffender = offenders.find((offender) => offender.key === culpritKey) ?? null;
  const feed = useMemo(
    () => buildFeed(stalls, strictMode, { fromTs, toTs, filter, culprit: activeOffender?.key ?? null }),
    [stalls, strictMode, fromTs, toTs, filter, activeOffender],
  );
  const selected = useMemo(
    () => (selectedKey === null ? null : findFeedItem(stalls, strictMode, selectedKey)),
    [stalls, strictMode, selectedKey],
  );
  const selectedIndex = selected === null ? -1 : feed.findIndex((item) => item.key === selected.key);

  // Closing the detail (Back, Escape, a selection that left the buffer) hands focus back to the event's
  // row, else to the list; unless the user has already moved focus somewhere else on the page.
  const bodyRef = useRef<HTMLDivElement>(null);
  const openKey = useRef<string | null>(null);
  const shownKey = selected?.key ?? null;
  useLayoutEffect(() => {
    const closedKey = openKey.current;
    openKey.current = shownKey;
    if (shownKey !== null || closedKey === null) return;
    const body = bodyRef.current;
    const active = document.activeElement;
    if (!body || (active !== null && active !== document.body && !body.contains(active))) return;
    const row = [...body.querySelectorAll<HTMLElement>('.feed-row')].find(
      (el) => el.dataset.key === closedKey,
    );
    (row ?? body.querySelector<HTMLElement>('.feed-list') ?? body).focus();
  }, [shownKey]);

  const step = (direction: -1 | 1) => {
    const next = feed[selectedIndex + direction];
    if (next) onSelect(next.key);
  };

  return (
    <section className="stalls" aria-labelledby="stalls-title">
      <header className="stalls-head">
        <h2 id="stalls-title" className="sr-only">
          Stalls
        </h2>
        <StallControls
          options={options}
          blocker={optionsBlocker}
          isPending={isOptionsPending}
          onChange={onOptionsChange}
          inflateBlocker={inflateBlocker}
        />
      </header>
      <div ref={bodyRef} className="stalls-body" tabIndex={-1}>
        {selected !== null ? (
          <StallDetail
            item={selected}
            position={selectedIndex < 0 ? null : { index: selectedIndex, total: feed.length }}
            onBack={() => onSelect(null)}
            onStep={step}
          />
        ) : empty !== null ? (
          <EmptyPanel empty={empty} />
        ) : (
          <>
            <OffendersTable
              offenders={offenders}
              debuggerCount={debuggerCount}
              activeKey={activeOffender?.key ?? null}
              onToggle={(key) => setCulpritKey((current) => (current === key ? null : key))}
            />
            <StallFeed
              items={feed}
              filter={filter}
              onFilterChange={setFilter}
              culprit={activeOffender === null ? null : culpritLabel(activeOffender.frame)}
              onClearCulprit={() => setCulpritKey(null)}
              onSelect={onSelect}
            />
          </>
        )}
      </div>
    </section>
  );
}

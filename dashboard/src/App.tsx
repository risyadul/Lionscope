import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  MemorySample,
  ScreenSpan,
  TimelineEvent,
} from '@lionscope/protocol/wire';
import { isValidPackageName, isValidSerial } from '@lionscope/protocol/wire';
import { useDashboardState, useServices } from './app/services.ts';
import { LogcatPanel } from './components/logcat/LogcatPanel.tsx';
import { ScreenPanel } from './components/screens/ScreenPanel.tsx';
import { SidePanel, type SideTab } from './components/side/SidePanel.tsx';
import { StatStrip } from './components/stats/StatStrip.tsx';
import { WindowControls } from './components/stats/WindowControls.tsx';
import { ConnectionBanner, ErrorBanner } from './components/states/Banners.tsx';
import { EmptyState } from './components/states/EmptyState.tsx';
import { Timeline } from './components/timeline/Timeline.tsx';
import { TopBar } from './components/topbar/TopBar.tsx';
import { useEscape } from './hooks/useEscape.ts';
import { useNow } from './hooks/useNow.ts';
import { resolveSerial, serialUnavailableReason } from './lib/devices.ts';
import { aggregateScreens } from './lib/screenStats.ts';
import { aggregateFrames, computeStats } from './lib/stats.ts';
import { isProtocolMismatch } from './lib/store.ts';
import {
  hasSeries,
  isSessionActive,
  screensEmptyState,
  timelineNotice,
  timelineState,
} from './lib/viewState.ts';
import './styles/app.css';

const DEFAULT_WINDOW_MS = 5 * 60_000;
/** Opening the app picker refreshes the package list at most this often per device. */
export const APPS_REFRESH_THROTTLE_MS = 5000;

/** The series the timeline draws, captured whole when paused so nothing moves underneath. */
interface PausedView {
  at: number;
  cpu: readonly CpuSample[];
  memory: readonly MemorySample[];
  frames: readonly FrameSample[];
  events: readonly TimelineEvent[];
  screens: readonly ScreenSpan[];
  breakdown: readonly FrameBreakdownSample[];
}

/** Marks a start/stop request until the server answers with `session` or `error`. */
interface PendingRequest {
  sessionSeq: number;
  errorSeq: number;
}

function startHintFor(
  isOpen: boolean,
  serial: string | null,
  deviceReason: string | null,
  packageName: string | null,
): string | null {
  if (!isOpen) return 'Offline — waiting for the server';
  if (serial === null) return 'Connect a device first';
  if (deviceReason !== null) return deviceReason;
  if (packageName === null || !isValidPackageName(packageName)) return 'Pick an app to profile';
  return null;
}

export function App() {
  const { store, send, probeTs, cursorX } = useServices();
  const state = useDashboardState();
  const [chosenSerial, setChosenSerial] = useState<string | null>(null);
  const [chosenPackage, setChosenPackage] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  const [paused, setPaused] = useState<PausedView | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [selectedScreen, setSelectedScreen] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('logcat');
  // Same request, read synchronously: two clicks in one task both run before React re-renders.
  const inFlight = useRef<PendingRequest | null>(null);
  const lastAppsRequest = useRef<{ serial: string; at: number } | null>(null);
  // The 1-minute window moves ~15 px/s, so it ticks faster to stay smooth.
  const now = useNow(windowMs <= 60_000 ? 250 : 1000);

  const isOpen = state.connection.status === 'open';
  const isActive = isSessionActive(state);
  const serial = resolveSerial(state.devices, chosenSerial, state.session.serial, isActive);
  const deviceReason = serial === null || isActive ? null : serialUnavailableReason(state.devices, serial);
  const packageName = isActive ? state.session.packageName : (chosenPackage ?? state.session.packageName);
  const apps = state.apps !== null && state.apps.serial === serial ? state.apps.apps : null;
  const isPending =
    isOpen &&
    pending !== null &&
    pending.sessionSeq === state.sessionSeq &&
    pending.errorSeq === state.errorSeq;
  const canRequestApps = isOpen && serial !== null && deviceReason === null && isValidSerial(serial);

  const sendListApps = useCallback(
    (target: string) => {
      lastAppsRequest.current = { serial: target, at: Date.now() };
      send({ type: 'listApps', serial: target });
    },
    [send],
  );

  // Keep the package list in sync with the selected device (and refetch after reconnecting).
  useEffect(() => {
    if (canRequestApps && serial !== null) sendListApps(serial);
  }, [canRequestApps, serial, sendListApps]);

  const refreshAppsOnOpen = () => {
    if (!canRequestApps || serial === null) return;
    const last = lastAppsRequest.current;
    if (last && last.serial === serial && Date.now() - last.at < APPS_REFRESH_THROTTLE_MS) return;
    sendListApps(serial);
  };

  const startHint = startHintFor(isOpen, serial, deviceReason, packageName);
  const canStart = startHint === null && !isActive && !isPending;

  const isRequestInFlight = () =>
    inFlight.current !== null &&
    inFlight.current.sessionSeq === state.sessionSeq &&
    inFlight.current.errorSeq === state.errorSeq;

  const markPending = () => {
    const request = { sessionSeq: state.sessionSeq, errorSeq: state.errorSeq };
    inFlight.current = request;
    setPending(request);
  };

  const start = () => {
    if (!canStart || isRequestInFlight() || serial === null || packageName === null) return;
    if (send({ type: 'startSession', serial, packageName })) {
      // Pin the device: if it later drops, Start explains why instead of switching phones.
      setChosenSerial(serial);
      markPending();
    }
  };

  const stop = () => {
    if (isPending || isRequestInFlight() || !isOpen) return;
    if (send({ type: 'stopSession' })) markPending();
  };

  const changeSerial = (next: string) => {
    setChosenSerial(next);
    setChosenPackage(null);
  };

  const dismissError = useCallback((id: number) => store.dispatch({ kind: 'dismissError', id }), [store]);

  const pause = () =>
    setPaused({
      at: Date.now(),
      cpu: state.cpu,
      memory: state.memory,
      frames: state.frames,
      events: state.events,
      screens: state.screens,
      breakdown: state.breakdown,
    });

  // Selecting a screen never takes the side panel away from logcat; "View in Screens" does.
  const clearScreen = useCallback(() => setSelectedScreen(null), []);
  const viewScreens = useCallback(() => setSideTab('screens'), []);
  useEscape(selectedScreen !== null, clearScreen);

  const isSdkConnected = isActive && state.session.sdk?.connected === true;
  const frameAggregate = useMemo(() => aggregateFrames(state.frames), [state.frames]);
  const stats = useMemo(
    () =>
      computeStats(
        { cpu: state.cpu, memory: state.memory, frames: state.frames },
        now,
        frameAggregate,
        isSdkConnected,
      ),
    [state.cpu, state.memory, state.frames, now, frameAggregate, isSdkConnected],
  );

  // The window follows the clock only while a session is live; once stopped, errored or
  // disconnected it stays on the last sample so the recording doesn't scroll away.
  const isLive = isActive && isOpen;
  const endTs = paused?.at ?? (isLive || state.latestTs === 0 ? now : state.latestTs);
  const series = paused ?? state;
  const screenRows = useMemo(
    () => aggregateScreens(series.breakdown, endTs - windowMs, endTs),
    [series.breakdown, endTs, windowMs],
  );
  const showScreens = isSdkConnected || series.screens.length > 0;
  const showBreakdown = isSdkConnected || series.breakdown.length > 0;
  const screensEmpty = screensEmptyState({
    hasRows: screenRows.length > 0,
    hasAnyBreakdown: series.breakdown.length > 0,
    isSdkConnected,
    sdk: isActive ? state.session.sdk : undefined,
    sdkLinkError: state.sdkLinkError,
  });

  const view = timelineState(state);
  const showData = hasSeries(state);
  const notice = showData ? timelineNotice(view) : null;
  const overlay =
    view.kind !== 'ready' && !showData ? (
      <div className="timeline-overlay">
        <EmptyState state={view} />
      </div>
    ) : null;

  return (
    <div className="app">
      <TopBar
        connection={state.connection.status}
        serverVersion={state.server?.serverVersion ?? null}
        devices={state.devices}
        serial={serial}
        onSerialChange={changeSerial}
        onRefreshDevices={() => send({ type: 'refreshDevices' })}
        apps={apps}
        packageName={packageName}
        onPackageChange={setChosenPackage}
        onRequestApps={refreshAppsOnOpen}
        session={state.session}
        sdkLinkError={state.sdkLinkError}
        isSessionActive={isActive}
        canStart={canStart}
        startHint={startHint}
        isPending={isPending}
        onStart={start}
        onStop={stop}
        now={now}
      />
      <div className="banners">
        <ConnectionBanner
          connection={state.connection}
          hasConnected={state.server !== null}
          now={now}
          protocolMismatch={isProtocolMismatch(state)}
        />
        <ErrorBanner error={state.lastError} onDismiss={dismissError} />
      </div>
      <main className="workspace">
        <div className="instrument">
          <StatStrip stats={stats} />
          <Timeline
            cpu={series.cpu}
            memory={series.memory}
            frames={series.frames}
            events={series.events}
            screens={series.screens}
            breakdown={series.breakdown}
            showScreens={showScreens}
            showBreakdown={showBreakdown}
            isSdkConnected={isSdkConnected}
            selectedScreen={selectedScreen}
            onSelectScreen={setSelectedScreen}
            onViewScreens={sideTab === 'screens' ? undefined : viewScreens}
            endTs={endTs}
            windowMs={windowMs}
            probeTs={probeTs}
            cursorX={cursorX}
            toolbar={
              <WindowControls
                windowMs={windowMs}
                onWindowChange={setWindowMs}
                isPaused={paused !== null}
                pausedAt={paused?.at ?? null}
                onPause={pause}
                onResume={() => setPaused(null)}
                cursorX={cursorX}
              />
            }
            overlay={overlay}
            notice={notice && <p className="timeline-notice">{notice}</p>}
          />
        </div>
        <SidePanel
          tab={sideTab}
          onTabChange={setSideTab}
          screenCount={screenRows.length}
          logcat={<LogcatPanel logs={state.logs} pid={state.session.pid} probeTs={probeTs} isTitleHidden />}
          screens={
            <ScreenPanel
              rows={screenRows}
              empty={screensEmpty}
              selected={selectedScreen}
              onSelect={setSelectedScreen}
            />
          }
        />
      </main>
    </div>
  );
}

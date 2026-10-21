import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  MemorySample,
  ScreenSpan,
  SdkOptions,
  StallSample,
  StrictModeSample,
  TimelineEvent,
} from '@lionscope/protocol/wire';
import {
  DEFAULT_SDK_OPTIONS,
  isValidPackageName,
  isValidSerial,
  STALL_THRESHOLDS_MS,
} from '@lionscope/protocol/wire';
import { useDashboardState, useServices } from './app/services.ts';
import { LogcatPanel } from './components/logcat/LogcatPanel.tsx';
import { ScreenPanel } from './components/screens/ScreenPanel.tsx';
import { SidePanel, type SideTab } from './components/side/SidePanel.tsx';
import { StallsPanel } from './components/stalls/StallsPanel.tsx';
import { StatStrip } from './components/stats/StatStrip.tsx';
import { WindowControls } from './components/stats/WindowControls.tsx';
import { ConnectionBanner, ErrorBanner } from './components/states/Banners.tsx';
import { EmptyState } from './components/states/EmptyState.tsx';
import { Timeline } from './components/timeline/Timeline.tsx';
import { TopBar } from './components/topbar/TopBar.tsx';
import { useEscape } from './hooks/useEscape.ts';
import { useNow } from './hooks/useNow.ts';
import { useSdkOptions } from './hooks/useSdkOptions.ts';
import { resolveSerial, serialUnavailableReason } from './lib/devices.ts';
import { aggregateScreens, withStallCounts } from './lib/screenStats.ts';
import { countEventsInWindow, findFeedItem, stallsByScreen } from './lib/stalls.ts';
import { aggregateFrames, computeStats } from './lib/stats.ts';
import { isProtocolMismatch } from './lib/store.ts';
import {
  hasSeries,
  isSessionActive,
  isStallCapable,
  screensEmptyState,
  sdkOptionsBlocker,
  stallsEmptyState,
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
  stalls: readonly StallSample[];
  strictMode: readonly StrictModeSample[];
}

/** Marks a start/stop request until the server answers with `session` or `error`. */
interface PendingRequest {
  sessionSeq: number;
  errorSeq: number;
}

const OFFLINE_OPTIONS_HINT = 'Offline — waiting for the server.';

function isStallThreshold(value: number): boolean {
  return (STALL_THRESHOLDS_MS as readonly number[]).includes(value);
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
  const [selectedStall, setSelectedStall] = useState<string | null>(null);
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
      stalls: state.stalls,
      strictMode: state.strictMode,
    });

  // Selecting a screen never takes the side panel away from logcat; "View in Screens" does.
  const viewScreens = useCallback(() => setSideTab('screens'), []);
  const viewStalls = useCallback(() => setSideTab('stalls'), []);
  const selectStall = useCallback((key: string) => {
    setSelectedStall(key);
    setSideTab('stalls');
  }, []);

  const sdk = state.session.sdk;
  const sdkOptions = sdk?.options ?? DEFAULT_SDK_OPTIONS;
  const optionsControl = useSdkOptions({
    send,
    options: sdkOptions,
    sessionSeq: state.sessionSeq,
    errorSeq: state.errorSeq,
    isOpen,
  });
  const optionsBlocker = isOpen ? sdkOptionsBlocker(isActive, sdk) : OFFLINE_OPTIONS_HINT;
  const changeOptions = (patch: Partial<SdkOptions>) => {
    if (optionsBlocker !== null) return;
    if (patch.stallThresholdMs !== undefined && !isStallThreshold(patch.stallThresholdMs)) return;
    optionsControl.change(patch);
  };

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
  const startTs = endTs - windowMs;
  const screenRows = useMemo(
    () =>
      withStallCounts(
        aggregateScreens(series.breakdown, startTs, endTs),
        stallsByScreen(series.stalls, startTs, endTs),
      ),
    [series.breakdown, series.stalls, startTs, endTs],
  );
  const hasStallData = series.stalls.length > 0 || series.strictMode.length > 0;
  const isStallDetailOpen =
    sideTab === 'stalls' &&
    selectedStall !== null &&
    findFeedItem(series.stalls, series.strictMode, selectedStall) !== null;
  // One Escape, one thing: an open stall detail closes first; otherwise the screen selection clears.
  const handleEscape = () => {
    if (isStallDetailOpen) setSelectedStall(null);
    else setSelectedScreen(null);
  };
  useEscape(isStallDetailOpen || selectedScreen !== null, handleEscape);
  const showMainThread = (isActive && isStallCapable(sdk)) || hasStallData;
  const stallTabCount = countEventsInWindow(series.stalls, series.strictMode, startTs, endTs);
  const stallsEmpty = stallsEmptyState({
    hasItems: stallTabCount > 0,
    hasAnyData: hasStallData,
    isSessionActive: isActive,
    sdk,
    sdkLinkError: state.sdkLinkError,
    thresholdMs: sdkOptions.stallThresholdMs,
  });
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
            stalls={series.stalls}
            strictMode={series.strictMode}
            showScreens={showScreens}
            showBreakdown={showBreakdown}
            showMainThread={showMainThread}
            stallThresholdMs={sdkOptions.stallThresholdMs}
            isStrictModeOn={isActive && sdkOptions.strictMode}
            selectedStall={selectedStall}
            onSelectStall={selectStall}
            onViewStalls={sideTab === 'stalls' ? undefined : viewStalls}
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
          stallCount={stallTabCount}
          logcat={<LogcatPanel logs={state.logs} pid={state.session.pid} probeTs={probeTs} isTitleHidden />}
          screens={
            <ScreenPanel
              rows={screenRows}
              empty={screensEmpty}
              selected={selectedScreen}
              onSelect={setSelectedScreen}
              showStalls={showMainThread}
            />
          }
          stalls={
            <StallsPanel
              stalls={series.stalls}
              strictMode={series.strictMode}
              fromTs={startTs}
              toTs={endTs}
              empty={stallsEmpty}
              options={optionsControl.shown}
              optionsBlocker={optionsBlocker}
              isOptionsPending={optionsControl.isPending}
              onOptionsChange={changeOptions}
              selectedKey={selectedStall}
              onSelect={setSelectedStall}
            />
          }
        />
      </main>
    </div>
  );
}

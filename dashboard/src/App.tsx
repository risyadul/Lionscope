import { useCallback, useMemo, useRef, useState } from 'react';
import type { SdkOptions } from '@lionscope/protocol/wire';
import { DEFAULT_SDK_OPTIONS, isValidSerial, STALL_THRESHOLDS_MS } from '@lionscope/protocol/wire';
import { useDashboardState, useServices } from './app/services.ts';
import { DeviceColumn, DeviceToggle } from './components/device/DeviceColumn.tsx';
import { DevicePanel } from './components/device/DevicePanel.tsx';
import { LogcatDrawer } from './components/layout/LogcatDrawer.tsx';
import { LogcatPanel } from './components/logcat/LogcatPanel.tsx';
import { ScreenPanel } from './components/screens/ScreenPanel.tsx';
import { SidePanel, type SideTab } from './components/side/SidePanel.tsx';
import { LayoutsPanel } from './components/layouts/LayoutsPanel.tsx';
import { StallsPanel } from './components/stalls/StallsPanel.tsx';
import { StatStrip } from './components/stats/StatStrip.tsx';
import { WindowControls } from './components/stats/WindowControls.tsx';
import { ConnectionBanner, ErrorBanner, SoftwareRendererBanner } from './components/states/Banners.tsx';
import { INFLATE_UPDATE_HINT } from './components/stalls/StallControls.tsx';
import { EmptyState } from './components/states/EmptyState.tsx';
import { Timeline } from './components/timeline/Timeline.tsx';
import { EmulatorActions } from './components/topbar/EmulatorActions.tsx';
import { TopBar } from './components/topbar/TopBar.tsx';
import { useAppList } from './hooks/useAppList.ts';
import { useDeviceColumn } from './hooks/useDeviceColumn.ts';
import { useDeviceTarget } from './hooks/useDeviceTarget.ts';
import { useEmulatorActions } from './hooks/useEmulatorActions.ts';
import { useEscape } from './hooks/useEscape.ts';
import { useNow } from './hooks/useNow.ts';
import { useSdkOptions } from './hooks/useSdkOptions.ts';
import { serialUnavailableReason } from './lib/devices.ts';
import { emulatorLabel, isSoftwareRendered } from './lib/emulators.ts';
import { inflatesInWindow, inflateByScreen, latestViewTrees } from './lib/layouts.ts';
import { aggregateScreens, withLayoutStats, withStallCounts } from './lib/screenStats.ts';
import { countEventsInWindow, findFeedItem, stallsByScreen } from './lib/stalls.ts';
import { aggregateFrames, computeStats } from './lib/stats.ts';
import { isProtocolMismatch } from './lib/store.ts';
import {
  captureView,
  hasSeries,
  isLayoutCapable,
  isSessionActive,
  isStallCapable,
  layoutsEmptyState,
  screensEmptyState,
  sdkOptionsBlocker,
  stallsEmptyState,
  startHint as startHintFor,
  timelineNotice,
  timelineState,
  type PausedView,
} from './lib/viewState.ts';
import './styles/app.css';

const DEFAULT_WINDOW_MS = 5 * 60_000;

/** Marks a start/stop request until the server answers with `session` or `error`. */
interface PendingRequest {
  sessionSeq: number;
  errorSeq: number;
}

const OFFLINE_OPTIONS_HINT = 'Offline — waiting for the server.';

function isStallThreshold(value: number): boolean {
  return (STALL_THRESHOLDS_MS as readonly number[]).includes(value);
}

export function App() {
  const { store, send, probeTs, cursorX } = useServices();
  const state = useDashboardState();
  const [chosenPackage, setChosenPackage] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  const [paused, setPaused] = useState<PausedView | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [selectedScreen, setSelectedScreen] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('screens');
  const [selectedStall, setSelectedStall] = useState<string | null>(null);
  // Same request, read synchronously: two clicks in one task both run before React re-renders.
  const inFlight = useRef<PendingRequest | null>(null);
  // The 1-minute window moves ~15 px/s, so it ticks faster to stay smooth.
  const now = useNow(windowMs <= 60_000 ? 250 : 1000);
  const chartsRef = useRef<HTMLDivElement>(null);
  const deviceColumn = useDeviceColumn();

  const isOpen = state.connection.status === 'open';
  const isActive = isSessionActive(state);
  const selection = useDeviceTarget({
    devices: state.devices,
    emulators: state.emulators,
    sessionSerial: state.session.serial,
    isSessionActive: isActive,
  });
  const { serial, emulator } = selection.target;
  const emulatorActions = useEmulatorActions({ send, emulators: state.emulators, errorSeq: state.errorSeq });
  // Shutting it down stops this session first (the server does; the confirmation says so).
  const isInSession = isActive && emulator !== null && emulator.serial === state.session.serial;
  const deviceReason = serial === null || isActive ? null : serialUnavailableReason(state.devices, serial);
  const packageName = isActive ? state.session.packageName : (chosenPackage ?? state.session.packageName);
  const apps = state.apps !== null && state.apps.serial === serial ? state.apps.apps : null;
  const isPending =
    isOpen &&
    pending !== null &&
    pending.sessionSeq === state.sessionSeq &&
    pending.errorSeq === state.errorSeq;
  const canRequestApps = isOpen && serial !== null && deviceReason === null && isValidSerial(serial);

  const refreshAppsOnOpen = useAppList(send, serial, canRequestApps);

  const startHint = startHintFor({ isOpen, serial, emulator, deviceReason, packageName });
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
      selection.chooseSerial(serial);
      markPending();
    }
  };

  const stop = () => {
    if (isPending || isRequestInFlight() || !isOpen) return;
    if (send({ type: 'stopSession' })) markPending();
  };

  const changeSerial = (next: string) => {
    selection.chooseSerial(next);
    setChosenPackage(null);
  };

  const changeAvd = (avdName: string) => {
    selection.chooseAvd(avdName);
    setChosenPackage(null);
  };

  const dismissError = useCallback((id: number) => store.dispatch({ kind: 'dismissError', id }), [store]);

  const pause = () => setPaused(captureView(state, Date.now()));

  // Selecting a screen never switches the side panel's tab; "View in Screens" does.
  const viewScreens = useCallback(() => setSideTab('screens'), []);
  const viewStalls = useCallback(() => setSideTab('stalls'), []);
  const viewLayouts = useCallback(() => setSideTab('layouts'), []);
  const selectStall = useCallback((key: string) => {
    setSelectedStall(key);
    setSideTab('stalls');
  }, []);

  const sdk = state.session.sdk;
  // Servers older than 0.4.0 send options without `inflateTracking`: read as on.
  const serverOptions = sdk?.options;
  const sdkOptions = useMemo<SdkOptions>(
    () => (serverOptions === undefined ? DEFAULT_SDK_OPTIONS : { ...DEFAULT_SDK_OPTIONS, ...serverOptions }),
    [serverOptions],
  );
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
      withLayoutStats(
        withStallCounts(
          aggregateScreens(series.breakdown, startTs, endTs),
          stallsByScreen(series.stalls, startTs, endTs),
        ),
        inflateByScreen(series.inflates, startTs, endTs),
        latestViewTrees(series.viewTrees, endTs),
      ),
    [series.breakdown, series.stalls, series.inflates, series.viewTrees, startTs, endTs],
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
  const hasInflateData = series.inflates.length > 0;
  const showMainThread = (isActive && isStallCapable(sdk)) || hasStallData || hasInflateData;
  const showLayouts = (isActive && isLayoutCapable(sdk)) || hasInflateData || series.viewTrees.length > 0;
  const layoutTabCount = useMemo(
    () =>
      new Set(inflatesInWindow(series.inflates, startTs, endTs, false).map((s) => s.layout ?? s.label)).size,
    [series.inflates, startTs, endTs],
  );
  const layoutsEmpty = layoutsEmptyState({
    hasItems: inflatesInWindow(series.inflates, startTs, endTs).length > 0,
    hasAnyData: hasInflateData,
    isSessionActive: isActive,
    sdk,
    sdkLinkError: state.sdkLinkError,
    isTrackingOn: sdkOptions.inflateTracking,
  });
  const inflateBlocker = optionsBlocker === null && !isLayoutCapable(sdk) ? INFLATE_UPDATE_HINT : null;
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
        emulators={state.emulators}
        serial={serial}
        emulator={emulator}
        onSerialChange={changeSerial}
        onAvdChange={changeAvd}
        emulatorActions={
          <EmulatorActions
            emulator={emulator}
            pending={emulatorActions.pending}
            isOffline={!isOpen}
            isInSession={isInSession}
            onBoot={emulatorActions.boot}
            onShutdown={emulatorActions.shutdown}
          />
        }
        deviceToggle={
          deviceColumn.mode === 'overlay' && (
            <DeviceToggle isOpen={deviceColumn.isOpen} onOpenChange={deviceColumn.setOpen} />
          )
        }
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
        <SoftwareRendererBanner
          deviceLabel={emulator !== null && isSoftwareRendered(emulator) ? emulatorLabel(emulator) : null}
        />
      </div>
      <main className="workspace" data-device={deviceColumn.mode}>
        <DeviceColumn
          mode={deviceColumn.mode}
          isOpen={deviceColumn.isOpen}
          onOpenChange={deviceColumn.setOpen}
          subtitle={emulator !== null ? emulatorLabel(emulator) : serial}
        >
          <DevicePanel
            target={selection.target}
            device={serial === null ? null : (state.devices?.find((d) => d.serial === serial) ?? null)}
            hasDeviceList={state.devices !== null}
            isOnline={isOpen}
            isVisible={deviceColumn.isVisible}
            pending={emulatorActions.pending}
            isInSession={isInSession}
            onBoot={emulatorActions.boot}
            onShutdown={emulatorActions.shutdown}
          />
        </DeviceColumn>
        <div className="instrument">
          <StatStrip stats={stats} />
          {/* What the timeline and the logcat drawer share: the drawer's height is bounded by this box. */}
          <div ref={chartsRef} className="instrument-charts">
            <Timeline
              cpu={series.cpu}
              memory={series.memory}
              frames={series.frames}
              events={series.events}
              screens={series.screens}
              breakdown={series.breakdown}
              stalls={series.stalls}
              strictMode={series.strictMode}
              inflates={series.inflates}
              showScreens={showScreens}
              showBreakdown={showBreakdown}
              showMainThread={showMainThread}
              stallThresholdMs={sdkOptions.stallThresholdMs}
              isStrictModeOn={isActive && sdkOptions.strictMode}
              selectedStall={selectedStall}
              onSelectStall={selectStall}
              onViewStalls={sideTab === 'stalls' ? undefined : viewStalls}
              onViewLayouts={sideTab === 'layouts' ? undefined : viewLayouts}
              isInflateTrackingOn={isActive && sdkOptions.inflateTracking && isLayoutCapable(sdk)}
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
            <LogcatDrawer columnRef={chartsRef}>
              <LogcatPanel logs={state.logs} pid={state.session.pid} probeTs={probeTs} />
            </LogcatDrawer>
          </div>
        </div>
        <SidePanel
          tab={sideTab}
          onTabChange={setSideTab}
          screenCount={screenRows.length}
          stallCount={stallTabCount}
          layoutCount={layoutTabCount}
          screens={
            <ScreenPanel
              rows={screenRows}
              empty={screensEmpty}
              selected={selectedScreen}
              onSelect={setSelectedScreen}
              showStalls={showMainThread}
              showLayouts={showLayouts}
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
              inflateBlocker={inflateBlocker}
              selectedKey={selectedStall}
              onSelect={setSelectedStall}
            />
          }
          layouts={
            <LayoutsPanel
              inflates={series.inflates}
              fromTs={startTs}
              toTs={endTs}
              empty={layoutsEmpty}
              isTrackingOff={isActive && isLayoutCapable(sdk) && !sdkOptions.inflateTracking}
              onEnableTracking={
                optionsBlocker === null && isLayoutCapable(sdk)
                  ? () => changeOptions({ inflateTracking: true })
                  : undefined
              }
            />
          }
        />
      </main>
    </div>
  );
}

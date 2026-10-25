import { Activity, memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SdkOptions } from '@lionscope/protocol/wire';
import { DEFAULT_SDK_OPTIONS, isValidSerial, STALL_THRESHOLDS_MS } from '@lionscope/protocol/wire';
import { exchangesInWindow } from '@lionscope/protocol/insights';
import { useDashboardState, useServices } from './app/services.ts';
import { AgentPanel } from './components/device/AgentPanel.tsx';
import { DeviceColumn, DeviceToggle } from './components/device/DeviceColumn.tsx';
import { DevicePanel } from './components/device/DevicePanel.tsx';
import { LogcatDrawer } from './components/layout/LogcatDrawer.tsx';
import { LogcatPanel } from './components/logcat/LogcatPanel.tsx';
import { ScreenPanel } from './components/screens/ScreenPanel.tsx';
import { SidePanel, type SideTab } from './components/side/SidePanel.tsx';
import { InspectorContext } from './components/inspector/InspectorContext.tsx';
import { LocationContext } from './components/location/LocationContext.tsx';
import { useDeviceLocations } from './hooks/useDeviceLocations.ts';
import { InspectorPanel } from './components/inspector/InspectorPanel.tsx';
import { LayoutsPanel } from './components/layouts/LayoutsPanel.tsx';
import { MockEditor } from './components/network/MockEditor.tsx';
import { NetworkPanel, type NetworkView } from './components/network/NetworkPanel.tsx';
import { StallsPanel } from './components/stalls/StallsPanel.tsx';
import { StatStrip } from './components/stats/StatStrip.tsx';
import { WindowControls } from './components/stats/WindowControls.tsx';
import { ConnectionBanner, ErrorBanner, SoftwareRendererBanner } from './components/states/Banners.tsx';
import { INFLATE_UPDATE_HINT, RX_UPDATE_HINT } from './components/stalls/StallControls.tsx';
import { EmptyState } from './components/states/EmptyState.tsx';
import { Timeline } from './components/timeline/Timeline.tsx';
import { EmulatorActions } from './components/topbar/EmulatorActions.tsx';
import { MocksIndicator } from './components/topbar/MocksIndicator.tsx';
import { TopBar } from './components/topbar/TopBar.tsx';
import { ViewSwitch } from './components/topbar/ViewSwitch.tsx';
import { useAppList } from './hooks/useAppList.ts';
import { useDeviceColumn } from './hooks/useDeviceColumn.ts';
import { useDeviceTarget } from './hooks/useDeviceTarget.ts';
import { useEmulatorActions } from './hooks/useEmulatorActions.ts';
import { useEscape } from './hooks/useEscape.ts';
import { useHttpDetail } from './hooks/useHttpDetail.ts';
import { useInspector } from './hooks/useInspector.ts';
import { useInspectorFocus } from './hooks/useInspectorFocus.ts';
import { useMockRules } from './hooks/useMockRules.ts';
import { useNow } from './hooks/useNow.ts';
import { useSdkOptions } from './hooks/useSdkOptions.ts';
import { useViewMode } from './hooks/useViewMode.ts';
import type { ViewMode } from './lib/viewMode.ts';
import { serialUnavailableReason } from './lib/devices.ts';
import { emulatorLabel, isSoftwareRendered } from './lib/emulators.ts';
import { inflatesInWindow, inflateByScreen, latestViewTrees } from './lib/layouts.ts';
import { mocksIndicator } from './lib/network.ts';
import { aggregateScreens, withLayoutStats, withStallCounts } from './lib/screenStats.ts';
import { countEventsInWindow, findFeedItem, stallsByScreen } from './lib/stalls.ts';
import { aggregateFrames, computeStats } from './lib/stats.ts';
import { isProtocolMismatch } from './lib/store.ts';
import {
  captureView,
  hasSeries,
  isLayoutCapable,
  isNetworkCapable,
  isRxCapable,
  isSessionActive,
  isStallCapable,
  layoutsEmptyState,
  networkEmptyState,
  networkLinkState,
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

/**
 * Holds its children's last render while `isFrozen`: inside a hidden `<Activity>` the charts would otherwise
 * still re-render (at low priority) on every clock tick with nothing on screen. Thawing renders the latest.
 */
const Frozen = memo(
  function Frozen({ children }: { isFrozen: boolean; children: ReactNode }) {
    return children;
  },
  (_prev, next) => next.isFrozen,
);

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
  const [selectedHttp, setSelectedHttp] = useState<number | null>(null);
  const [networkView, setNetworkView] = useState<NetworkView>('requests');
  // Same request, read synchronously: two clicks in one task both run before React re-renders.
  const inFlight = useRef<PendingRequest | null>(null);
  // The 1-minute window moves ~15 px/s, so it ticks faster to stay smooth.
  const now = useNow(windowMs <= 60_000 ? 250 : 1000);
  const chartsRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useViewMode();
  const deviceColumn = useDeviceColumn(viewMode !== 'profile');

  const isOpen = state.connection.status === 'open';
  const isActive = isSessionActive(state);
  const selection = useDeviceTarget({
    devices: state.devices,
    emulators: state.emulators,
    sessionSerial: state.session.serial,
    isSessionActive: isActive,
  });
  const { serial, emulator } = selection.target;
  const inspectorSerial = emulator !== null ? emulator.serial : serial;
  const inspector = useInspector({
    state,
    send,
    serial: inspectorSerial,
    canInspect: isOpen && inspectorSerial !== null && isValidSerial(inspectorSerial),
  });
  useInspectorFocus({
    send,
    isInspectorShown: viewMode === 'inspect' || (viewMode === 'profile' && sideTab === 'inspector'),
    serial: inspector.canInspect ? inspectorSerial : null,
    isOpen,
  });
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
  const { isActive: isInspecting, toggle: toggleInspect, exit: exitInspect } = inspector;
  // Pressing Inspect also brings its tree forward (from the Device view, the Inspector view);
  // Esc leaves inspect mode before anything else.
  // The Device view is for watching the live screen: leaving for it ends inspect mode.
  const changeView = useCallback(
    (next: ViewMode) => {
      if (next === 'device') exitInspect();
      setViewMode(next);
    },
    [exitInspect, setViewMode],
  );
  const toggleInspector = useCallback(() => {
    if (!isInspecting) {
      setSideTab('inspector');
      if (viewMode === 'device') setViewMode('inspect');
    }
    toggleInspect();
  }, [isInspecting, toggleInspect, viewMode, setViewMode]);
  useEscape(isInspecting, exitInspect);
  const inspectorValue = useMemo(
    () => ({ ...inspector, toggle: toggleInspector }),
    [inspector, toggleInspector],
  );
  const selectStall = useCallback((key: string) => {
    setSelectedStall(key);
    setSideTab('stalls');
  }, []);
  // A click on the Network lane opens the call in the Network tab; the top bar's mocks pill opens its rules.
  const selectHttp = useCallback((id: number) => {
    setSelectedHttp(id);
    setNetworkView('requests');
    setSideTab('network');
  }, []);
  const viewNetwork = useCallback(() => setSideTab('network'), []);
  const openMocks = useCallback(() => {
    changeView('profile');
    setSideTab('network');
    setNetworkView('mocks');
  }, [changeView]);

  const sdk = state.session.sdk;
  // Servers older than 0.4.0 send options without `inflateTracking`, older than 0.9.0 without `rxTracking`:
  // the defaults read both as on.
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
  const selectedExchange = useMemo(
    () => (selectedHttp === null ? null : (series.http.find((e) => e.id === selectedHttp) ?? null)),
    [series.http, selectedHttp],
  );
  const isNetworkDetailOpen =
    viewMode === 'profile' &&
    sideTab === 'network' &&
    networkView === 'requests' &&
    selectedExchange !== null;
  // One Escape, one thing: an open stall or request detail closes first; otherwise the screen selection clears.
  const handleEscape = () => {
    if (isStallDetailOpen) setSelectedStall(null);
    else if (isNetworkDetailOpen) setSelectedHttp(null);
    else setSelectedScreen(null);
  };
  useEscape(isStallDetailOpen || isNetworkDetailOpen || selectedScreen !== null, handleEscape);
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
  const rxBlocker = optionsBlocker === null && !isRxCapable(sdk) ? RX_UPDATE_HINT : null;
  const stallTabCount = countEventsInWindow(series.stalls, series.strictMode, startTs, endTs);
  const stallsEmpty = stallsEmptyState({
    hasItems: stallTabCount > 0,
    hasAnyData: hasStallData,
    isSessionActive: isActive,
    sdk,
    sdkLinkError: state.sdkLinkError,
    thresholdMs: sdkOptions.stallThresholdMs,
  });
  const httpDetail = useHttpDetail({ send, summary: selectedExchange, answer: state.httpDetail, isOpen });
  const mockRules = useMockRules({
    send,
    mocks: state.networkMocks,
    mockError: state.mockError,
    isOpen,
    isSessionActive: isActive,
  });
  const mocksState = mocksIndicator(state.networkMocks, isActive, networkLinkState(sdk));
  const networkTabCount = useMemo(
    () => exchangesInWindow(series.http, startTs, endTs, endTs).length,
    [series.http, startTs, endTs],
  );
  const showNetwork = (isActive && isNetworkCapable(sdk)) || series.http.length > 0;
  const networkEmpty = networkEmptyState({
    hasItems: networkTabCount > 0,
    hasAnyData: series.http.length > 0,
    isSessionActive: isActive,
    sdk,
    sdkLinkError: state.sdkLinkError,
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

  const locations = useDeviceLocations({
    send,
    locations: state.locations,
    locationError: state.locationError,
    isOpen,
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
    <InspectorContext.Provider value={inspectorValue}>
      <LocationContext.Provider value={locations}>
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
            viewSwitch={<ViewSwitch value={viewMode} onChange={changeView} />}
            mocksIndicator={mocksState && <MocksIndicator indicator={mocksState} onOpen={openMocks} />}
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
          <main className="workspace" data-device={deviceColumn.mode} data-view={viewMode}>
            <DeviceColumn
              mode={deviceColumn.mode}
              isOpen={deviceColumn.isOpen}
              onOpenChange={deviceColumn.setOpen}
              subtitle={emulator !== null ? emulatorLabel(emulator) : serial}
              isPinned={deviceColumn.isPinned}
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
            {/* The Inspector and Device views hide the charts: effects torn down (no plots), renders frozen (no
              work per clock tick), state kept (logcat filters, Clear, the CPU mode are there when you come back). */}
            <Activity mode={viewMode === 'profile' ? 'visible' : 'hidden'}>
              <Frozen isFrozen={viewMode !== 'profile'}>
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
                      http={series.http}
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
                      showNetwork={showNetwork}
                      selectedHttp={selectedHttp}
                      onSelectHttp={selectHttp}
                      onViewNetwork={sideTab === 'network' ? undefined : viewNetwork}
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
              </Frozen>
            </Activity>
            {viewMode === 'device' && <AgentPanel />}
            <Activity mode={viewMode === 'device' ? 'hidden' : 'visible'}>
              <Frozen isFrozen={viewMode === 'device'}>
                <SidePanel
                  tab={sideTab}
                  lockedTab={viewMode === 'inspect' ? 'inspector' : undefined}
                  onTabChange={setSideTab}
                  screenCount={screenRows.length}
                  stallCount={stallTabCount}
                  layoutCount={layoutTabCount}
                  networkCount={networkTabCount}
                  inspectorCount={inspector.snapshot?.nodes.length ?? 0}
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
                      rxBlocker={rxBlocker}
                      selectedKey={selectedStall}
                      onSelect={setSelectedStall}
                    />
                  }
                  inspector={<InspectorPanel />}
                  network={
                    // Off screen (another tab, the Inspector view) it holds its last render: no work per clock tick.
                    <Frozen isFrozen={viewMode !== 'profile' || sideTab !== 'network'}>
                      <NetworkPanel
                        exchanges={series.http}
                        fromTs={startTs}
                        toTs={endTs}
                        openEnd={endTs}
                        empty={networkEmpty}
                        view={networkView}
                        onViewChange={setNetworkView}
                        selectedId={selectedExchange === null ? null : selectedHttp}
                        onSelect={setSelectedHttp}
                        detail={httpDetail}
                        mocks={state.networkMocks}
                        mockControl={mockRules}
                      />
                    </Frozen>
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
              </Frozen>
            </Activity>
          </main>
          {mockRules.editor && (
            <MockEditor
              key={mockRules.editor.openId}
              editor={mockRules.editor}
              onSave={mockRules.save}
              onCancel={mockRules.closeEditor}
            />
          )}
        </div>
      </LocationContext.Provider>
    </InspectorContext.Provider>
  );
}

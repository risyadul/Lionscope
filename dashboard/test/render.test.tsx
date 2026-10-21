import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, ServerMessage } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ErrorBoundary } from '../src/app/ErrorBoundary.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState, type DashboardStore } from '../src/lib/store.ts';
import { cpu, frame, log, session, T0 } from './fixtures.ts';
import { plots, resetPlots } from './uplotMock.ts';

// uPlot draws on <canvas>, which jsdom doesn't implement; the mock records what it would draw.
vi.mock('uplot', () => import('./uplotMock.ts'));

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => resetPlots());
afterEach(() => cleanup());

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const EMULATOR: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: 1,
  serverVersion: '0.1.0',
  bufferWindowMs: 600_000,
};
const apps: ServerMessage = {
  type: 'apps',
  serial: 'emulator-5554',
  apps: [
    { packageName: 'com.example.shop', pid: 4821, thirdParty: true },
    { packageName: 'com.android.settings', pid: null, thirdParty: false },
  ],
};

function setup(messages: ServerMessage[], open = true) {
  const store: DashboardStore = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const sent: ClientMessage[] = [];
  const services: DashboardServices = {
    store,
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    probeTs: createSignal<number | null>(null),
    cursorX: createSignal<number | null>(null),
  };
  if (open) store.dispatch({ kind: 'connection', connection: OPEN });
  for (const msg of messages) store.dispatch({ kind: 'server', msg });
  store.flush();
  render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  const push = (...msgs: ServerMessage[]) =>
    act(() => {
      for (const msg of msgs) store.dispatch({ kind: 'server', msg });
      store.flush();
    });
  const setConnection = (connection: ConnectionState) =>
    act(() => {
      store.dispatch({ kind: 'connection', connection });
      store.flush();
    });
  return { store, sent, push, setConnection };
}

const startButton = () => screen.getByRole('button', { name: /Start|Starting/ }) as HTMLButtonElement;
const appInput = () => screen.getByRole('combobox', { name: 'App' }) as HTMLInputElement;
/** The CPU lane is the first chart created. */
const cpuPlot = () => {
  const plot = plots.find((p) => !p.destroyed);
  if (!plot) throw new Error('no live chart');
  return plot;
};

function pickShopApp() {
  fireEvent.click(appInput());
  fireEvent.keyDown(appInput(), { key: 'Enter' });
}

describe('App empty states', () => {
  it('shows the server state while disconnected', () => {
    setup([], false);
    expect(screen.getByText('Can’t reach the Lionscope server')).toBeTruthy();
    expect(screen.getByText('Connecting to the Lionscope server…')).toBeTruthy();
  });

  it('explains how to connect a device when none is attached', () => {
    setup([hello, { type: 'devices', devices: [] }]);
    expect(screen.getByText('No device connected')).toBeTruthy();
    expect(screen.getByText(/USB debugging/)).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  it('says adb is unavailable instead of USB advice, and keeps the error banner', () => {
    setup([
      hello,
      { type: 'devices', devices: [] },
      { type: 'error', code: 'adb_unavailable', message: 'adb is not available.' },
    ]);
    expect(screen.getByText('Lionscope can’t run adb')).toBeTruthy();
    expect(screen.queryByText('No device connected')).toBeNull();
    expect(screen.getAllByText('adb is not available.').length).toBe(2);
  });

  it('lists why devices are not ready', () => {
    setup([
      hello,
      { type: 'devices', devices: [{ serial: 'R58M123ABC', state: 'unauthorized', model: 'SM_S918B' }] },
    ]);
    expect(screen.getByText('No device is ready to profile')).toBeTruthy();
    expect(screen.getAllByText(/accept the USB debugging prompt/).length).toBeGreaterThan(0);
  });

  it('shows the waiting state for a session whose process has not started', () => {
    setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ status: 'waiting_for_process', pid: null }) },
    ]);
    expect(screen.getByText('Waiting for the app to start')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy();
  });
});

describe('App session flow', () => {
  it('requests the package list once (throttled), picks an app and starts a session', () => {
    const { sent } = setup([hello, { type: 'devices', devices: [EMULATOR] }, apps]);
    expect(screen.getByText('Pick an app to profile')).toBeTruthy();
    const listAppsCount = () => sent.filter((m) => m.type === 'listApps').length;
    expect(listAppsCount()).toBe(1);

    pickShopApp();
    expect(appInput().value).toBe('com.example.shop');
    // Re-opening right away doesn't hammer adb with another package listing.
    fireEvent.click(appInput());
    fireEvent.keyDown(appInput(), { key: 'Escape' });
    expect(listAppsCount()).toBe(1);

    fireEvent.click(startButton());
    expect(sent).toContainEqual({
      type: 'startSession',
      serial: 'emulator-5554',
      packageName: 'com.example.shop',
    });
  });

  it('a double-click on Start sends one request and waits for the session reply', () => {
    const { sent, push } = setup([hello, { type: 'devices', devices: [EMULATOR] }, apps]);
    pickShopApp();
    // Both clicks land before React re-renders (same task), as a fast double-click can.
    const button = startButton();
    act(() => {
      button.click();
      button.click();
    });
    expect(sent.filter((m) => m.type === 'startSession')).toHaveLength(1);
    expect(startButton().textContent).toContain('Starting…');
    expect(startButton().disabled).toBe(true);

    push({ type: 'session', session: session({ status: 'waiting_for_process', pid: null }) });
    const stop = screen.getByRole('button', { name: /Stop/ }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    act(() => {
      stop.click();
      stop.click();
    });
    expect(sent.filter((m) => m.type === 'stopSession')).toHaveLength(1);
  });

  it('a server error also ends the pending state', () => {
    const { push } = setup([hello, { type: 'devices', devices: [EMULATOR] }, apps]);
    pickShopApp();
    fireEvent.click(startButton());
    expect(startButton().disabled).toBe(true);
    push({ type: 'error', message: 'package not installed' });
    expect(startButton().disabled).toBe(false);
  });

  it('keeps a chosen device that goes offline and explains why Start is disabled', () => {
    const second: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };
    const { push } = setup([hello, { type: 'devices', devices: [EMULATOR, second] }]);
    const select = screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'R58M123ABC' } });
    expect(select.value).toBe('R58M123ABC');

    push({ type: 'devices', devices: [EMULATOR, { ...second, state: 'unauthorized' }] });
    expect(select.value).toBe('R58M123ABC');
    expect(startButton().disabled).toBe(true);
    expect(startButton().title).toMatch(/unauthorized/);

    push({ type: 'devices', devices: [EMULATOR] });
    expect(select.value).toBe('R58M123ABC');
    expect(startButton().title).toMatch(/disconnected/);
  });

  it('disables Stop and the app picker while offline', () => {
    const { setConnection } = setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session() },
    ]);
    setConnection({ status: 'reconnecting', attempt: 1, retryAt: Date.now() + 5000, closeReason: null });
    expect((screen.getByRole('button', { name: /Stop/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(appInput().placeholder).toBe('Offline — waiting for the server');
    expect(screen.getByText('Disconnected from the server.')).toBeTruthy();
  });

  it('explains a rate-limit close; a refused upgrade reads as a plain disconnect', () => {
    const { setConnection } = setup([hello]);
    setConnection({
      status: 'reconnecting',
      attempt: 1,
      retryAt: Date.now() + 30_000,
      closeReason: 'rate-limited',
    });
    expect(screen.getByText('Rate-limited by the server.')).toBeTruthy();
    setConnection({ status: 'reconnecting', attempt: 2, retryAt: Date.now() + 500, closeReason: null });
    expect(screen.getByText('Disconnected from the server.')).toBeTruthy();
    expect(screen.getByText(/more than 8 open dashboards/)).toBeTruthy();
  });

  it('keeps the live region stable: elapsed time and countdown are not announced', () => {
    const { setConnection } = setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ startedAt: Date.now() - 5000 }) },
    ]);
    const status = screen.getAllByRole('status').find((el) => el.textContent?.includes('Recording'));
    expect(status?.textContent).toBe('Recording PID 1234');
    setConnection({ status: 'reconnecting', attempt: 1, retryAt: Date.now() + 5000, closeReason: null });
    expect(screen.getByRole('alert').textContent).toBe('Disconnected from the server.');
  });
});

describe('App timeline', () => {
  it('renders live readouts and log lines while running', () => {
    const now = Date.now();
    const { push } = setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ startedAt: now - 5000 }) },
      { type: 'cpu', sample: cpu(now - 500, 23.4) },
      { type: 'logs', entries: [log(now - 400, { tag: 'RxJava', message: 'onError: timeout', level: 'E' })] },
    ]);
    expect(screen.getByText('23.4')).toBeTruthy();
    expect(screen.getByText('onError: timeout')).toBeTruthy();
    expect(screen.queryByText('Pick an app to profile')).toBeNull();

    push({ type: 'error', message: 'adb exited', code: 'ADB_EXIT' });
    expect(screen.getByRole('alert').textContent).toContain('adb exited');
  });

  it('keeps a stopped recording inside the visible window instead of scrolling it away', () => {
    setup([hello, { type: 'devices', devices: [EMULATOR] }, { type: 'cpu', sample: cpu(T0, 5) }]);
    expect(screen.getByText('Session stopped — showing the last recording.')).toBeTruthy();
    const [min, max] = cpuPlot().xRange();
    expect(max).toBe(T0 / 1000);
    expect(min).toBeLessThan(T0 / 1000);
  });

  it('pause freezes the drawn series while data keeps arriving; Live resumes', () => {
    const now = Date.now();
    const { push } = setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ startedAt: now - 5000 }) },
      { type: 'cpu', sample: cpu(now - 2000) },
    ]);
    const xs = () => (cpuPlot().data as number[][])[0]?.length;
    expect(xs()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    const frozen = cpuPlot().xRange();
    push({ type: 'cpu', sample: cpu(now - 1000) });
    expect(xs()).toBe(1);
    expect(cpuPlot().xRange()).toEqual(frozen);

    fireEvent.click(screen.getByRole('button', { name: /Live/ }));
    expect(xs()).toBe(2);
  });
});

describe('App frame semantics', () => {
  it('shows "no UI frames" with the gfxinfo caveat instead of a 0 FPS drop', () => {
    const now = Date.now();
    setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ startedAt: now - 5000 }) },
      {
        type: 'frames',
        sample: frame(now - 300, { frameCount: 0, jankCount: 0, slowCount: 0, fps: 0, durationsMs: [] }),
      },
    ]);
    const fpsTile = screen.getByText('FPS', { selector: 'dt' }).closest('.readout') as HTMLElement;
    expect(within(fpsTile).getByText('no UI frames')).toBeTruthy();
    expect(fpsTile.title).toMatch(/SurfaceView, video, maps in SurfaceView mode and Flutter/);
    const legend = screen.getByRole('list', { name: 'Rendering values' });
    expect(within(legend).getByText('no UI frames')).toBeTruthy();
    expect(screen.getByRole('note', { name: /gfxinfo only sees frames/ })).toBeTruthy();
  });

  it('adds a slow sub-line to the jank tile and marks an assumed budget', () => {
    const now = Date.now();
    setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'session', session: session({ startedAt: now - 5000 }) },
      {
        type: 'frames',
        sample: frame(now - 300, { jankCount: 2, slowCount: 6, frameIntervalSource: 'default' }),
      },
    ]);
    expect(screen.getByText('slow 6')).toBeTruthy();
    expect(screen.getByText('budget 16.7 ms')).toBeTruthy();
    expect(screen.getByText('assumed — no vsync data yet')).toBeTruthy();
  });
});

describe('ErrorBoundary', () => {
  it('contains a render crash and recovers with Try again', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Bomb() {
      if (shouldThrow) throw new Error('kaboom');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('kaboom')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeTruthy();
    errors.mockRestore();
  });
});

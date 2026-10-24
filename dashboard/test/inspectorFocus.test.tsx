import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { fallbackHint, fallbackLabel } from '../src/lib/inspector.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';
import { inspectorSnapshot } from './inspectorFixtures.ts';
import { resetPlots } from './uplotMock.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  resetPlots();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const LOST: ConnectionState = { status: 'reconnecting', attempt: 1, retryAt: null, closeReason: null };
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };
const PHONE: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };
const BASE: ServerMessage[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, serverVersion: '0.5.2', bufferWindowMs: 600_000 },
  { type: 'devices', devices: [EMU_DEVICE] },
  { type: 'emulators', emulators: [emulator()] },
];

function setup() {
  const store = createStore((flush) => {
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
  store.dispatch({ kind: 'connection', connection: OPEN });
  for (const msg of BASE) store.dispatch({ kind: 'server', msg });
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
  const focuses = () => sent.flatMap((m) => (m.type === 'inspectorFocus' ? [m.serial] : []));
  return { push, setConnection, focuses };
}

const option = (name: string) => screen.getByRole('radio', { name });
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('inspectorFocus', () => {
  it('sends nothing while the Inspector is not on screen', () => {
    const { focuses } = setup();
    expect(focuses()).toEqual([]);
  });

  it('follows the Inspector view', () => {
    const { focuses } = setup();
    fireEvent.click(option('Inspector'));
    expect(focuses()).toEqual(['emulator-5554']);
    fireEvent.click(option('Device'));
    expect(focuses()).toEqual(['emulator-5554', null]);
  });

  it('follows the Profiler side tab without duplicates', () => {
    const { focuses } = setup();
    fireEvent.click(tab('Inspector'));
    expect(focuses()).toEqual(['emulator-5554']);
    fireEvent.click(option('Inspector'));
    fireEvent.click(option('Profiler'));
    expect(focuses()).toEqual(['emulator-5554']);
    fireEvent.click(tab('Screens'));
    expect(focuses()).toEqual(['emulator-5554', null]);
  });

  it('clears while the document is hidden and returns with it', () => {
    const { focuses } = setup();
    fireEvent.click(option('Inspector'));
    setVisibility('hidden');
    expect(focuses()).toEqual(['emulator-5554', null]);
    setVisibility('visible');
    expect(focuses()).toEqual(['emulator-5554', null, 'emulator-5554']);
  });

  it('moves to another device when the serial changes', async () => {
    const { focuses, push } = setup();
    fireEvent.click(option('Inspector'));
    await push({ type: 'devices', devices: [EMU_DEVICE, PHONE] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'R58M123ABC' } });
    expect(focuses()).toEqual(['emulator-5554', 'R58M123ABC']);
  });

  it('sends the current focus again after a reconnect', () => {
    const { focuses, setConnection } = setup();
    fireEvent.click(option('Inspector'));
    setConnection(LOST);
    expect(focuses()).toEqual(['emulator-5554']);
    setConnection(OPEN);
    expect(focuses()).toEqual(['emulator-5554', 'emulator-5554']);
  });

  it('does not announce an unfocused state after a reconnect', () => {
    const { focuses, setConnection } = setup();
    setConnection(LOST);
    setConnection(OPEN);
    expect(focuses()).toEqual([]);
  });
});

describe('fallback reasons of 0.5.2', () => {
  it.each([
    ['sdk_linking', 'SDK connecting', 'inspect again'],
    ['sdk_needs_session', 'SDK needs a session', 'update to 0.5.2, or Start a session'],
    ['sdk_link_busy', 'SDK link busy', 'another Lionscope server holds the SDK link'],
  ])('%s has a label and a hint', (reason, label, hint) => {
    expect(fallbackLabel(reason)).toBe(label);
    expect(fallbackHint(reason)).toContain(hint);
  });

  it('shows the label in the badge and the hint as its tooltip', async () => {
    const { push } = setup();
    fireEvent.click(option('Inspector'));
    await push({
      type: 'inspection',
      snapshot: inspectorSnapshot({ source: 'uiautomator', fallbackReason: 'sdk_needs_session' }),
    });
    const badge = screen.getByText(/uiautomator — SDK needs a session/);
    expect(badge.getAttribute('title')).toContain('Start a session');
    // Visible text too: a tooltip never reaches touch or keyboard users.
    expect(document.querySelector('.inspector .inspect-hint')?.textContent).toContain('Start a session');
    expect(document.querySelector('.attrs .inspect-hint')).toBeNull();
  });

  it('repeats the hint in the attributes of a view from uiautomator', async () => {
    const { push } = setup();
    fireEvent.click(option('Inspector'));
    await push(
      {
        type: 'inspection',
        snapshot: inspectorSnapshot({ source: 'uiautomator', fallbackReason: 'sdk_link_busy' }),
      },
      {
        type: 'inspectorSelection',
        selection: { snapshotId: 'snap-1', nodeId: 2, ts: 1, origin: 'user' },
      },
    );
    expect(document.querySelector('.attrs .inspect-hint')?.textContent).toBe(
      'another Lionscope server holds the SDK link',
    );
  });

  it('does not tell the user a session is needed before the first inspect', () => {
    setup();
    fireEvent.click(option('Inspector'));
    expect(screen.getByText(/without a session/)).toBeTruthy();
  });
});

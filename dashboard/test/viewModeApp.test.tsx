import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { DEVICE_OVERLAY_QUERY } from '../src/hooks/useDeviceColumn.ts';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { AGENT_DEVICE_COMMAND } from '../src/components/device/AgentPanel.tsx';
import { LAYOUT_KEYS } from '../src/lib/layoutPrefs.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';
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
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };
const BASE: ServerMessage[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, serverVersion: '0.5.1', bufferWindowMs: 600_000 },
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
  return { sent };
}

const option = (name: string) => screen.getByRole('radio', { name });
/** Present and not hidden by a hidden `<Activity>` (which keeps it mounted with `display: none`). */
const isShown = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  return el !== null && el.style.display !== 'none';
};
const sideTabs = () => screen.queryAllByRole('tab').filter((tab) => tab.closest('[style*="none"]') === null);
const workspace = () => document.querySelector<HTMLElement>('.workspace')!;

describe('View switch', () => {
  it('starts in the Profiler view with the charts and every side tab', () => {
    setup();
    expect(option('Profiler').getAttribute('aria-checked')).toBe('true');
    expect(workspace().dataset.view).toBe('profile');
    expect(isShown('.instrument')).toBe(true);
    expect(sideTabs().map((tab) => tab.textContent)).toEqual(['Screens', 'Stalls', 'Layouts', 'Saved State']);
    expect(window.location.search).toBe('');
  });

  it('opens Network and Storage as dedicated bookmarked workspaces with the mirror initially shown', () => {
    setup();
    for (const [label, id] of [
      ['Network', 'network'],
      ['Storage', 'storage'],
    ]) {
      fireEvent.click(option(label!));
      expect(workspace().dataset.view).toBe(id);
      expect(window.location.search).toBe(`?view=${id}`);
      expect(isShown('.instrument')).toBe(false);
      expect(screen.queryByRole('tab', { name: /Screens|Stalls|Layouts|Saved State/ })).toBeNull();
      expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(false);
    }
    fireEvent.click(option('Profiler'));
    expect(isShown('.instrument')).toBe(true);
    expect(sideTabs().map((tab) => tab.textContent)).toEqual(['Screens', 'Stalls', 'Layouts', 'Saved State']);
  });

  it('keeps independent hide/show choices for Network and Storage while switching workspaces', () => {
    setup();
    fireEvent.click(option('Network'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the device column' }));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(option('Storage'));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the device column' }));
    fireEvent.click(option('Network'));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Device' }));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(false);
    fireEvent.click(option('Storage'));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(true);
  });

  it.each(['network', 'storage'])('shows the mirror when opening a fresh %s bookmark', (view) => {
    window.history.replaceState(null, '', `/?view=${view}`);
    setup();
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(false);
  });

  it('shows the initial Storage drawer on narrow windows and lets the user close and reopen it', () => {
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
      matches: query === DEVICE_OVERLAY_QUERY,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => false,
    }));
    window.history.replaceState(null, '', '/?view=storage');
    setup();
    expect(document.querySelector('.device-col')?.getAttribute('data-mode')).toBe('overlay');
    fireEvent.click(screen.getByRole('button', { name: 'Close the device screen' }));
    expect(document.querySelector('.device-col')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Screen' }));
    expect(document.querySelector('.device-col')?.getAttribute('data-mode')).toBe('overlay');
  });

  it('dismisses the navigation drawer with Escape and returns focus to the menu button', () => {
    setup();
    const menu = screen.getByRole('button', { name: '☰ Workspaces' });
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(option('Profiler'));
    fireEvent.keyDown(option('Profiler'), { key: 'Escape' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it('Inspector view: no charts, only the Inspector panel under a heading, and the URL says so', () => {
    setup();
    fireEvent.click(option('Layout Inspector'));
    expect(workspace().dataset.view).toBe('inspect');
    expect(isShown('.instrument')).toBe(false);
    expect(sideTabs()).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Layout Inspector' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inspect the screen' })).toBeTruthy();
    expect(window.location.search).toBe('?view=inspect');
    expect(window.localStorage.getItem(LAYOUT_KEYS.viewMode)).toBe('inspect');
  });

  it('Device view: the device and the agent panel only', () => {
    setup();
    fireEvent.click(option('Device'));
    expect(isShown('.instrument')).toBe(false);
    expect(isShown('.side')).toBe(false);
    expect(screen.getByRole('heading', { name: 'Let an agent operate this device' })).toBeTruthy();
    expect(screen.getByText(AGENT_DEVICE_COMMAND)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Use with AI agents' }).getAttribute('href')).toBe(
      'https://github.com/risyadul/Lionscope/blob/main/docs/agents.md',
    );
    expect(window.location.search).toBe('?view=device');
  });

  it('back to the Profiler removes the parameter and brings the charts back', () => {
    setup();
    fireEvent.click(option('Device'));
    fireEvent.click(option('Profiler'));
    expect(isShown('.instrument')).toBe(true);
    expect(window.location.search).toBe('');
  });

  it('opens in the mode the URL names, over the remembered one', () => {
    window.localStorage.setItem(LAYOUT_KEYS.viewMode, 'device');
    window.history.replaceState(null, '', '/?view=inspect');
    setup();
    expect(option('Layout Inspector').getAttribute('aria-checked')).toBe('true');
  });

  it('opens in the remembered mode when the URL names none, and puts it in the address', () => {
    window.localStorage.setItem(LAYOUT_KEYS.viewMode, 'device');
    setup();
    expect(option('Device').getAttribute('aria-checked')).toBe('true');
    expect(window.location.search).toBe('?view=device');
  });

  it('remembers a mode the page was opened in from the address', () => {
    window.history.replaceState(null, '', '/?view=inspect');
    setup();
    expect(window.localStorage.getItem(LAYOUT_KEYS.viewMode)).toBe('inspect');
  });

  it('keeps the charts’ own state across a switch (hidden, not unmounted)', () => {
    setup();
    const singleCore = () => screen.getByRole('button', { name: /1 core/ });
    fireEvent.click(singleCore());
    expect(singleCore().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(option('Layout Inspector'));
    fireEvent.click(option('Profiler'));
    expect(singleCore().getAttribute('aria-pressed')).toBe('true');
  });

  it('switching to the Device view ends inspect mode (live screen again)', () => {
    const { sent } = setup();
    fireEvent.click(option('Layout Inspector'));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getByRole('button', { name: 'Inspect' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(option('Device'));
    expect(screen.getByRole('button', { name: 'Inspect' }).getAttribute('aria-pressed')).toBe('false');
    expect(sent.filter((m) => m.type === 'inspect')).toHaveLength(1);
  });

  it('arrow keys move the selection (radio group)', () => {
    setup();
    fireEvent.keyDown(option('Profiler'), { key: 'ArrowRight' });
    expect(option('Layout Inspector').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(option('Layout Inspector'));
    fireEvent.keyDown(option('Layout Inspector'), { key: 'End' });
    expect(option('Device').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(option('Device'), { key: 'ArrowRight' });
    expect(option('Profiler').getAttribute('aria-checked')).toBe('true');
  });

  it('pins the device column open in the Inspector and Device views, even when collapsed in the Profiler', () => {
    window.localStorage.setItem(LAYOUT_KEYS.deviceCollapsed, 'true');
    setup();
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(option('Layout Inspector'));
    const column = document.querySelector('.device-col')!;
    expect(column.hasAttribute('data-collapsed')).toBe(false);
    expect(document.querySelector('.device-collapse')).toBeNull();
    fireEvent.click(option('Profiler'));
    expect(document.querySelector('.device-col')?.hasAttribute('data-collapsed')).toBe(true);
  });

  it('pressing Inspect in the Device view switches to the Inspector view and asks for a snapshot', () => {
    const { sent } = setup();
    fireEvent.click(option('Device'));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    });
    expect(option('Layout Inspector').getAttribute('aria-checked')).toBe('true');
    expect(sent.filter((m) => m.type === 'inspect')).toEqual([{ type: 'inspect', serial: 'emulator-5554' }]);
  });
});

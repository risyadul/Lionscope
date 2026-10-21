import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, EmulatorInfo, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { DEVICE_OVERLAY_QUERY } from '../src/hooks/useDeviceColumn.ts';
import { EMULATOR_REQUEST_TIMEOUT_MS } from '../src/hooks/useEmulatorActions.ts';
import { LAYOUT_KEYS } from '../src/lib/layoutPrefs.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { session } from './fixtures.ts';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';

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
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.3.0',
  bufferWindowMs: 600_000,
};
const PHONE: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };
const OFF = emulator({ state: 'off', serial: null });

const devices = (...list: DeviceInfo[]): ServerMessage => ({ type: 'devices', devices: list });
const emulators = (...list: EmulatorInfo[]): ServerMessage => ({ type: 'emulators', emulators: list });

function setup(messages: ServerMessage[]) {
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
  for (const msg of messages) store.dispatch({ kind: 'server', msg });
  store.flush();
  const view = render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  const push = (...msgs: ServerMessage[]) =>
    act(() => {
      for (const msg of msgs) store.dispatch({ kind: 'server', msg });
      store.flush();
    });
  return { sent, push, view };
}

const picker = () => screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement;
const deviceColumn = () => screen.getByRole('complementary', { name: 'Device' });

describe('Device picker with AVDs', () => {
  it('lists AVDs that are off next to connected devices and names emulators by their AVD', () => {
    setup([hello, devices(PHONE), emulators(OFF)]);
    const groups = within(picker()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['Connected', 'Emulators']);
    expect(within(groups[1]!).getByRole('option').textContent).toBe('Pixel 9a · off');
    // Without AVDs the list stays flat, as before.
    cleanup();
    setup([hello, devices(EMU_DEVICE), emulators(emulator())]);
    expect(within(picker()).queryAllByRole('group')).toHaveLength(0);
    expect(within(picker()).getByRole('option').textContent).toBe('Pixel 9a · emulator-5554');
  });

  it('boots an AVD that is off with the chosen mode, shows progress, then follows it to its serial', () => {
    const { sent, push } = setup([hello, devices(PHONE), emulators(OFF)]);
    fireEvent.change(picker(), { target: { value: 'avd/Pixel_9a' } });
    expect(picker().value).toBe('avd/Pixel_9a');
    expect(within(deviceColumn()).getByText('Pixel 9a is off')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start/ }).getAttribute('title')).toBe(
      'Boot the emulator first',
    );

    const boot = screen.getByRole('button', { name: /^Boot/ });
    fireEvent.click(boot);
    const menu = screen.getByRole('menu', { name: 'Boot Pixel 9a' });
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[1]!);
    expect(sent).toContainEqual({ type: 'bootEmulator', avdName: 'Pixel_9a', mode: 'cold' });
    expect(screen.queryByRole('menu')).toBeNull();
    // Pending until the server answers.
    expect(screen.getByText('Booting…')).toBeTruthy();
    expect(within(deviceColumn()).getByText('Booting Pixel 9a…')).toBeTruthy();

    push(emulators({ ...OFF, state: 'booting', serial: 'emulator-5554', managed: true }));
    expect(screen.getByText('Booting…')).toBeTruthy();

    push(devices(PHONE, EMU_DEVICE), emulators(emulator({ managed: true })));
    expect(picker().value).toBe('emulator-5554');
    expect(sent).toContainEqual({ type: 'listApps', serial: 'emulator-5554' });
    expect(FakeScreenSocket.latest().url).toContain('serial=emulator-5554');
  });

  it('quick boot is the first choice; Escape closes the menu and returns focus', () => {
    const { sent } = setup([hello, devices(), emulators(OFF)]);
    fireEvent.change(picker(), { target: { value: 'avd/Pixel_9a' } });
    const boot = screen.getByRole('button', { name: /^Boot/ });
    fireEvent.keyDown(boot, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(boot);
    fireEvent.click(boot);
    fireEvent.click(screen.getByRole('menuitem', { name: /Quick boot/ }));
    expect(sent).toContainEqual({ type: 'bootEmulator', avdName: 'Pixel_9a', mode: 'quick' });
  });

  it('offers Shut down only for emulators Lionscope booted, and not while profiling them', () => {
    const { sent, push } = setup([hello, devices(EMU_DEVICE), emulators(emulator({ managed: false }))]);
    expect(screen.queryByRole('button', { name: 'Shut down' })).toBeNull();

    push(emulators(emulator({ managed: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Shut down' }));
    expect(sent).toContainEqual({ type: 'shutdownEmulator', avdName: 'Pixel_9a' });
    expect(screen.getByText('Shutting down…')).toBeTruthy();

    // An error answers the request: the button comes back.
    push({ type: 'error', message: 'refused' });
    expect(screen.getByRole('button', { name: 'Shut down' })).toBeTruthy();
    push({ type: 'session', session: session() });
    expect((screen.getByRole('button', { name: 'Shut down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the AVD selected through shutdown', () => {
    const { push } = setup([hello, devices(EMU_DEVICE), emulators(emulator({ managed: true }))]);
    fireEvent.change(picker(), { target: { value: 'emulator-5554' } });
    push(devices(), emulators(OFF));
    expect(picker().value).toBe('avd/Pixel_9a');
    expect(screen.getByRole('button', { name: /^Boot/ })).toBeTruthy();
  });
});

describe('Device picker while adb lists a booting / shutting-down emulator', () => {
  const OFFLINE_EMU: DeviceInfo = { ...EMU_DEVICE, state: 'offline' };

  it('keeps the emulator selected by its serial while it boots, then profiles it', () => {
    const { push, sent } = setup([hello, devices(PHONE), emulators(OFF)]);
    fireEvent.change(picker(), { target: { value: 'avd/Pixel_9a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Boot/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Quick boot/ }));
    // Focus doesn't drop to the page when the menu button gives way to "Booting…".
    expect(document.activeElement).toBe(picker());

    const booting = emulator({ state: 'booting', managed: true });
    push(devices(PHONE, OFFLINE_EMU), emulators(booting));
    expect(picker().value).toBe('emulator-5554');
    expect(picker().selectedOptions[0]?.textContent).toBe('Pixel 9a · emulator-5554 — booting…');
    expect(screen.getByText('Booting…')).toBeTruthy();
    push(devices(PHONE, EMU_DEVICE));
    expect(picker().value).toBe('emulator-5554');
    expect(screen.getByRole('button', { name: /Start/ }).getAttribute('title')).toBe(
      'Wait for the emulator to boot',
    );
    expect(sent.some((m) => m.type === 'listApps' && m.serial === 'emulator-5554')).toBe(false);

    push(emulators(emulator({ managed: true })));
    expect(picker().value).toBe('emulator-5554');
    expect(sent).toContainEqual({ type: 'listApps', serial: 'emulator-5554' });
  });

  it('keeps it selected by its serial while it shuts down, then by its AVD once off', () => {
    const { push } = setup([hello, devices(EMU_DEVICE), emulators(emulator({ managed: true }))]);
    fireEvent.change(picker(), { target: { value: 'emulator-5554' } });
    fireEvent.click(screen.getByRole('button', { name: 'Shut down' }));
    push(emulators(emulator({ state: 'shutting_down', managed: true })));
    expect(picker().value).toBe('emulator-5554');
    expect(picker().selectedOptions[0]?.textContent).toBe('Pixel 9a · emulator-5554 — shutting down…');
    expect(screen.getByRole('button', { name: /Start/ }).getAttribute('title')).toBe(
      'The emulator is shutting down',
    );
    push(devices(OFFLINE_EMU));
    expect(picker().value).toBe('emulator-5554');
    push(devices(), emulators(OFF));
    expect(picker().value).toBe('avd/Pixel_9a');
  });

  it('a boot stays pending through unrelated emulator updates until its AVD changes state', () => {
    const tablet = emulator({ avdName: 'Pixel_Tablet', displayName: null, state: 'off', serial: null });
    const { push } = setup([hello, devices(), emulators(OFF, tablet)]);
    fireEvent.change(picker(), { target: { value: 'avd/Pixel_9a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Boot/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cold boot/ }));
    push(emulators(OFF, { ...tablet, renderer: 'host' }));
    expect(screen.getByText('Booting…')).toBeTruthy();
    push(emulators(OFF, tablet), { type: 'error', message: 'emulator binary not found' });
    expect(screen.getByRole('button', { name: /^Boot/ })).toBeTruthy();
  });

  it('a request the server never answers stops showing as pending', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([hello, devices(), emulators(OFF)]);
    fireEvent.change(picker(), { target: { value: 'avd/Pixel_9a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Boot/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Quick boot/ }));
    expect(screen.getByText('Booting…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(EMULATOR_REQUEST_TIMEOUT_MS);
    });
    expect(screen.getByRole('button', { name: /^Boot/ })).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('Software renderer banner', () => {
  it('warns while the selected emulator renders with SwiftShader', () => {
    const { push } = setup([hello, devices(EMU_DEVICE), emulators(emulator({ renderer: 'software' }))]);
    expect(screen.getByText('Pixel 9a renders in software (SwiftShader).')).toBeTruthy();
    expect(screen.getByText(/-gpu host/)).toBeTruthy();
    push(emulators(emulator({ renderer: 'host' })));
    expect(screen.queryByText(/renders in software/)).toBeNull();
  });

  it('stays quiet for physical devices', () => {
    setup([hello, devices(PHONE), emulators(emulator({ serial: null, state: 'off', renderer: 'software' }))]);
    expect(screen.queryByText(/renders in software/)).toBeNull();
  });
});

describe('Layout', () => {
  it('collapses the device column to a rail and remembers it', () => {
    setup([hello, devices(EMU_DEVICE), emulators(emulator())]);
    expect(FakeScreenSocket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the device column' }));
    expect(FakeScreenSocket.latest().readyState).toBe(3);
    expect(window.localStorage.getItem(LAYOUT_KEYS.deviceCollapsed)).toBe('true');
    cleanup();
    setup([hello, devices(EMU_DEVICE), emulators(emulator())]);
    const rail = screen.getByRole('button', { name: 'Device' });
    expect(rail.getAttribute('aria-expanded')).toBe('false');
    expect(FakeScreenSocket.instances).toHaveLength(1);
    fireEvent.click(rail);
    expect(screen.getByRole('button', { name: 'Collapse the device column' })).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(2);
  });

  it('moves logcat under the timeline', () => {
    setup([hello, devices(PHONE)]);
    expect(screen.queryByRole('tab', { name: 'Logcat' })).toBeNull();
    const logcat = screen.getByRole('region', { name: 'Logcat' });
    expect(logcat.closest('.instrument')).not.toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize logcat' }).closest('.instrument')).not.toBeNull();
  });

  it('on narrow screens opens the device column as a drawer from the top bar', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === DEVICE_OVERLAY_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setup([hello, devices(PHONE)]);
    expect(screen.queryByRole('complementary', { name: 'Device' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Screen' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(deviceColumn()).getByText('Mirroring physical devices arrives in 0.3.1')).toBeTruthy();
    expect(document.activeElement).toBe(deviceColumn());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Device' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmulatorInfo } from '@lionscope/protocol/wire';
import { DevicePanel } from '../src/components/device/DevicePanel.tsx';
import { EmulatorActions } from '../src/components/topbar/EmulatorActions.tsx';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  installCanvasStubs();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Shutdown = (avdName: string, confirmUnmanaged: boolean) => void;

function renderActions(info: EmulatorInfo, { isInSession = false, isOffline = false } = {}) {
  const onShutdown = vi.fn<Shutdown>();
  render(
    <EmulatorActions
      emulator={info}
      pending={null}
      isOffline={isOffline}
      isInSession={isInSession}
      onBoot={() => {}}
      onShutdown={onShutdown}
    />,
  );
  return onShutdown;
}

function renderPanel(info: EmulatorInfo, { isInSession = false } = {}) {
  const onShutdown = vi.fn<Shutdown>();
  render(
    <DevicePanel
      target={{ serial: info.serial, emulator: info }}
      isOnline
      isVisible
      pending={null}
      isInSession={isInSession}
      onBoot={() => {}}
      onShutdown={onShutdown}
    />,
  );
  return onShutdown;
}

const shutDownButton = () => screen.getByRole('button', { name: 'Shut down' });
const dialog = () => screen.getByRole('alertdialog');

describe('Shut down in the top bar', () => {
  it('is offered for every running emulator, managed or not, and only while it runs', () => {
    renderActions(emulator({ managed: true }));
    expect(shutDownButton().getAttribute('title')).toBe('Shut down Pixel 9a (booted by Lionscope)');
    cleanup();
    renderActions(emulator({ managed: false }));
    expect(shutDownButton().getAttribute('title')).toBe('Shut down Pixel 9a (not started by Lionscope)');
    cleanup();
    renderActions(emulator({ managed: false }), { isOffline: true });
    expect((shutDownButton() as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderActions(emulator({ state: 'booting' }));
    expect(screen.queryByRole('button', { name: 'Shut down' })).toBeNull();
  });

  it('shuts down an emulator Lionscope booted without asking', () => {
    const onShutdown = renderActions(emulator({ managed: true }));
    fireEvent.click(shutDownButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onShutdown).toHaveBeenCalledWith('Pixel_9a', false);
  });

  it('asks before shutting down one it didn’t boot: focus starts on Cancel and stays in the dialog', () => {
    const onShutdown = renderActions(emulator({ managed: false }));
    fireEvent.click(shutDownButton());
    expect(onShutdown).not.toHaveBeenCalled();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(within(dialog()).getByRole('heading').textContent).toBe('Shut down Pixel 9a?');
    expect(dialog().textContent).toContain(
      'Pixel 9a wasn’t started by Lionscope (for example Android Studio). Apps running in it are closed.',
    );
    expect(dialog().textContent).not.toContain('profiling session');
    const cancel = within(dialog()).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog()).getByRole('button', { name: 'Shut down' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(confirm);
    expect(onShutdown).toHaveBeenCalledWith('Pixel_9a', true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape and Cancel close the dialog without shutting down, and focus returns to the button', () => {
    const onShutdown = renderActions(emulator({ managed: false }));
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    shutDownButton().focus();
    fireEvent.click(shutDownButton());
    fireEvent.keyDown(within(dialog()).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(shutDownButton());
    // One Escape closes one thing: the device drawer behind the dialog stays open.
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outside);

    fireEvent.click(shutDownButton());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(shutDownButton());
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('is not disabled during a session on the emulator: it asks, saying the session stops', () => {
    const onShutdown = renderActions(emulator({ managed: true }), { isInSession: true });
    expect((shutDownButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(shutDownButton());
    expect(dialog().textContent).toContain('The profiling session on Pixel 9a stops.');
    expect(dialog().textContent).not.toContain('wasn’t started by Lionscope');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Shut down' }));
    expect(onShutdown).toHaveBeenCalledWith('Pixel_9a', false);

    cleanup();
    const unmanaged = renderActions(emulator({ managed: false }), { isInSession: true });
    fireEvent.click(shutDownButton());
    expect(dialog().textContent).toContain('wasn’t started by Lionscope');
    expect(dialog().textContent).toContain('The profiling session on Pixel 9a stops.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Shut down' }));
    expect(unmanaged).toHaveBeenCalledWith('Pixel_9a', true);
  });
});

describe('Shut down in the Device column', () => {
  it('sits in the screen toolbar with its own label, tooltip and icon, apart from the power key', () => {
    renderPanel(emulator({ managed: true }));
    const toolbar = screen.getByRole('group', { name: 'Pixel 9a controls' });
    const shutdown = within(toolbar).getByRole('button', { name: 'Shut down emulator' });
    const power = within(toolbar).getByRole('button', { name: 'Power' });
    expect(shutdown.getAttribute('title')).toBe('Shut down emulator');
    expect(power.getAttribute('title')).toBe('Power button (screen on/off)');
    expect(shutdown.innerHTML).not.toBe(power.innerHTML);
    // Usable before the stream is live (the power key is not).
    expect((shutdown as HTMLButtonElement).disabled).toBe(false);
    expect((power as HTMLButtonElement).disabled).toBe(true);
    expect(toolbar.lastElementChild).toBe(shutdown);
  });

  it('shuts down one Lionscope booted at once, and asks for one it didn’t (or during a session)', () => {
    const onShutdown = renderPanel(emulator({ managed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Shut down emulator' }));
    expect(onShutdown).toHaveBeenCalledWith('Pixel_9a', false);

    cleanup();
    const unmanaged = renderPanel(emulator({ managed: false }), { isInSession: true });
    fireEvent.click(screen.getByRole('button', { name: 'Shut down emulator' }));
    expect(dialog().textContent).toContain('wasn’t started by Lionscope');
    expect(dialog().textContent).toContain('The profiling session on Pixel 9a stops.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Shut down' }));
    expect(unmanaged).toHaveBeenCalledWith('Pixel_9a', true);
  });

  it('is offered for a running emulator it can’t mirror too', () => {
    const onShutdown = renderPanel(emulator({ managed: true, canMirror: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Shut down emulator' }));
    expect(onShutdown).toHaveBeenCalledWith('Pixel_9a', false);
  });
});

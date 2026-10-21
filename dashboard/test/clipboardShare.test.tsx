import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePanel } from '../src/components/device/DevicePanel.tsx';
import { resetClipboardReadAccess } from '../src/lib/clipboard.ts';
import { LAYOUT_KEYS } from '../src/lib/layoutPrefs.ts';
import { binaryMessage, emulator, FakeScreenSocket, installCanvasStubs, SCREEN_INFO } from './screenFakes.ts';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let desktop: string;
let readText: ReturnType<typeof vi.fn<() => Promise<string>>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
  resetClipboardReadAccess();
  desktop = 'from desktop';
  readText = vi.fn(async () => desktop);
  writeText = vi.fn(async (text: string) => {
    desktop = text;
  });
  Object.defineProperty(navigator, 'clipboard', { value: { readText, writeText }, configurable: true });
  Object.defineProperty(navigator, 'permissions', {
    value: { query: vi.fn(async () => ({ state: 'granted' })) },
    configurable: true,
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(navigator, 'permissions');
});

const RUNNING = emulator();

function renderPanel() {
  return render(
    <DevicePanel
      target={{ serial: 'emulator-5554', emulator: RUNNING }}
      isOnline
      isVisible
      pending={null}
      onBoot={() => {}}
    />,
  );
}

/** Lets the clipboard promises (permission query, read / write) settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function goLive() {
  const socket = FakeScreenSocket.latest();
  act(() => {
    socket.open();
    socket.receiveJson(SCREEN_INFO);
    socket.receive(binaryMessage('frame'));
  });
  await settle();
  return socket;
}

const toggle = () => screen.getByRole('button', { name: 'Share clipboard' });
const canvas = () => screen.getByLabelText('Pixel 9a screen');
const of = (socket: FakeScreenSocket, type: string) =>
  socket.allMessages().filter((m) => (m as { type: string }).type === type);

describe('Share clipboard toggle', () => {
  it('is on by default, says so on every open socket, and is remembered when switched off', async () => {
    const view = renderPanel();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('title')).toBe('Share clipboard with the emulator');
    const socket = await goLive();
    expect(of(socket, 'clipboardSync')).toEqual([{ type: 'clipboardSync', enabled: true }]);

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(of(socket, 'clipboardSync')).toEqual([
      { type: 'clipboardSync', enabled: true },
      { type: 'clipboardSync', enabled: false },
    ]);
    expect(window.localStorage.getItem(LAYOUT_KEYS.clipboardShare)).toBe('false');

    view.unmount();
    renderPanel();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    const next = await goLive();
    expect(of(next, 'clipboardSync')).toEqual([{ type: 'clipboardSync', enabled: false }]);
  });
});

describe('Desktop → Android', () => {
  it('pushes the desktop clipboard when the screen is focused or pressed, only when it changed', async () => {
    renderPanel();
    const socket = await goLive();
    act(() => canvas().focus());
    await settle();
    expect(of(socket, 'clipboard')).toEqual([{ type: 'clipboard', text: 'from desktop' }]);

    fireEvent.pointerDown(canvas(), {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    await settle();
    expect(of(socket, 'clipboard')).toHaveLength(1);

    desktop = 'copied later';
    fireEvent.pointerUp(canvas(), { pointerId: 1, pointerType: 'mouse' });
    act(() => {
      window.dispatchEvent(new FocusEvent('focus'));
    });
    await settle();
    expect(of(socket, 'clipboard')).toEqual([
      { type: 'clipboard', text: 'from desktop' },
      { type: 'clipboard', text: 'copied later' },
    ]);
  });

  it('stops asking after a denial, and never blocks input', async () => {
    readText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    renderPanel();
    const socket = await goLive();
    act(() => canvas().focus());
    await settle();
    fireEvent.pointerDown(canvas(), {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    await settle();
    expect(readText).toHaveBeenCalledOnce();
    expect(of(socket, 'clipboard')).toHaveLength(0);
    expect(of(socket, 'touch')).toHaveLength(1);
  });

  it('reads nothing while sharing is off', async () => {
    window.localStorage.setItem(LAYOUT_KEYS.clipboardShare, 'false');
    renderPanel();
    const socket = await goLive();
    act(() => canvas().focus());
    await settle();
    expect(readText).not.toHaveBeenCalled();
    expect(of(socket, 'clipboard')).toHaveLength(0);
    // Cmd/Ctrl+V is an explicit action: it pastes either way.
    fireEvent.paste(canvas(), { clipboardData: { getData: () => 'pasted' } });
    expect(of(socket, 'paste')).toEqual([{ type: 'paste', text: 'pasted' }]);
  });
});

describe('Android → desktop', () => {
  it('copies what Android copied, confirms it, and doesn’t echo it back', async () => {
    renderPanel();
    const socket = await goLive();
    act(() => socket.receiveJson({ type: 'clipboard', text: 'from android' }));
    await settle();
    expect(writeText).toHaveBeenCalledWith('from android');
    expect(screen.getByText('Copied from the emulator')).toBeTruthy();

    act(() => canvas().focus());
    await settle();
    expect(of(socket, 'clipboard')).toHaveLength(0);
  });

  it('offers a Copy button when the browser refuses, without the text in the page', async () => {
    writeText.mockRejectedValueOnce(new DOMException('Document is not focused', 'NotAllowedError'));
    renderPanel();
    const socket = await goLive();
    act(() => socket.receiveJson({ type: 'clipboard', text: 'secret token' }));
    await settle();
    expect(screen.getByText('Copied in the emulator')).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret token');
    expect(document.body.innerHTML).not.toContain('secret token');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(writeText).toHaveBeenLastCalledWith('secret token');
    expect(screen.getByText('Copied from the emulator')).toBeTruthy();
  });

  it('says so when even the Copy button can’t write', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    renderPanel();
    const socket = await goLive();
    act(() => socket.receiveJson({ type: 'clipboard', text: 'x' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(screen.getByText('Copying isn’t allowed here')).toBeTruthy();
  });

  it('ignores Android copies while sharing is off', async () => {
    renderPanel();
    const socket = await goLive();
    fireEvent.click(toggle());
    act(() => socket.receiveJson({ type: 'clipboard', text: 'from android' }));
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText('Copied from the emulator')).toBeNull();
  });
});

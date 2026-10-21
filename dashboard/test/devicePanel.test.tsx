import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootMode } from '@lionscope/protocol/wire';
import { DevicePanel, PHYSICAL_MIRROR_NOTE } from '../src/components/device/DevicePanel.tsx';
import { PASTE_CHUNK_INTERVAL_MS, PASTE_TRUNCATED_NOTE } from '../src/components/device/useScreenInput.ts';
import { LAYOUT_KEYS } from '../src/lib/layoutPrefs.ts';
import type { DeviceTarget, PendingEmulatorAction } from '../src/lib/emulators.ts';
import {
  binaryMessage,
  emulator,
  FakeScreenSocket,
  installCanvasStubs,
  SCREEN_INFO,
  type CanvasStubs,
} from './screenFakes.ts';

let canvas: CanvasStubs;
let frames: FrameRequestCallback[];

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  canvas = installCanvasStubs();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const RUNNING = emulator();

function renderPanel(
  target: DeviceTarget,
  { isVisible = true, pending = null }: { isVisible?: boolean; pending?: PendingEmulatorAction | null } = {},
) {
  const onBoot = vi.fn<(avdName: string, mode: BootMode) => void>();
  const view = render(
    <DevicePanel target={target} isOnline isVisible={isVisible} pending={pending} onBoot={onBoot} />,
  );
  return { ...view, onBoot };
}

function runFrames() {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(0);
}

/** Opens the socket and delivers info plus one decoded frame. */
async function goLive() {
  const socket = FakeScreenSocket.latest();
  act(() => {
    socket.open();
    socket.receiveJson(SCREEN_INFO);
    socket.receive(binaryMessage('frame'));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return socket;
}

const screenCanvas = () => screen.getByLabelText('Pixel 9a screen');
/** Canvas client point for frame coordinates (box: 270 × 606 at 10, 20; same aspect as the frame). */
const at = (x: number, y: number) => ({ clientX: 10 + x * 270, clientY: 20 + y * 606 });

describe('DevicePanel states', () => {
  it('asks for a device when none is selected', () => {
    renderPanel({ serial: null, emulator: null });
    expect(screen.getByText('No device selected')).toBeTruthy();
  });

  it('says physical devices are mirrored from 0.3.1 on', () => {
    renderPanel({ serial: 'R58M123ABC', emulator: null });
    expect(screen.getByText(PHYSICAL_MIRROR_NOTE)).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });

  it('offers Quick and Cold boot for an AVD that is off', () => {
    const { onBoot } = renderPanel({ serial: null, emulator: emulator({ state: 'off', serial: null }) });
    expect(screen.getByText('Pixel 9a is off')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cold boot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quick boot' }));
    expect(onBoot.mock.calls).toEqual([
      ['Pixel_9a', 'cold'],
      ['Pixel_9a', 'quick'],
    ]);
  });

  it('shows booting while a boot request is in flight, and shutting down from the server state', () => {
    const off = emulator({ state: 'off', serial: null });
    const view = renderPanel(
      { serial: null, emulator: off },
      { pending: { avdName: 'Pixel_9a', action: 'boot' } },
    );
    expect(screen.getByText('Booting Pixel 9a…')).toBeTruthy();
    view.rerender(
      <DevicePanel
        target={{ serial: 'emulator-5554', emulator: emulator({ state: 'shutting_down' }) }}
        isOnline
        isVisible
        pending={null}
        onBoot={view.onBoot}
      />,
    );
    expect(screen.getByText('Shutting down Pixel 9a…')).toBeTruthy();
  });

  it('explains an emulator without a gRPC endpoint, and waits for adb', () => {
    const view = renderPanel({ serial: 'emulator-5554', emulator: emulator({ canMirror: false }) });
    expect(screen.getByText('Can’t mirror Pixel 9a')).toBeTruthy();
    view.unmount();
    renderPanel({ serial: null, emulator: emulator({ serial: null }) });
    expect(screen.getByText('Waiting for adb to see Pixel 9a…')).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });

  it('says it is offline without the server', () => {
    render(
      <DevicePanel
        target={{ serial: 'emulator-5554', emulator: RUNNING }}
        isOnline={false}
        isVisible
        pending={null}
        onBoot={() => {}}
      />,
    );
    expect(screen.getByText('Offline — waiting for the server')).toBeTruthy();
  });
});

describe('ScreenView stream', () => {
  it('streams only while visible, at 540 px by default, and draws decoded frames', async () => {
    const view = renderPanel({ serial: 'emulator-5554', emulator: RUNNING }, { isVisible: false });
    expect(FakeScreenSocket.instances).toHaveLength(0);
    view.rerender(
      <DevicePanel
        target={{ serial: 'emulator-5554', emulator: RUNNING }}
        isOnline
        isVisible
        pending={null}
        onBoot={view.onBoot}
      />,
    );
    const socket = FakeScreenSocket.latest();
    expect(socket.url).toMatch(/\/ws\/screen\?serial=emulator-5554&size=540$/);
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);

    await goLive();
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(canvas.closed).toHaveBeenCalledOnce();
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();

    view.rerender(
      <DevicePanel
        target={{ serial: 'emulator-5554', emulator: RUNNING }}
        isOnline
        isVisible={false}
        pending={null}
        onBoot={view.onBoot}
      />,
    );
    expect(socket.readyState).toBe(3);
  });

  it('sends toolbar and navigation buttons and the frame size', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    for (const name of ['Back', 'Home', 'Recents', 'Power', 'Rotate left', 'Rotate right', 'Screenshot']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    fireEvent.click(screen.getByRole('radio', { name: '720' }));
    expect(socket.messages()).toEqual([
      { type: 'nav', button: 'back' },
      { type: 'nav', button: 'home' },
      { type: 'nav', button: 'recents' },
      { type: 'nav', button: 'power' },
      { type: 'rotate', direction: 'left' },
      { type: 'rotate', direction: 'right' },
      { type: 'screenshot' },
      { type: 'setSize', size: 720 },
    ]);
  });

  it('downloads a screenshot as <avd>-<timestamp>.png', async () => {
    // jsdom has no blob URLs.
    const createUrl = vi.fn(() => 'blob:screenshot');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    act(() => socket.receive(binaryMessage('screenshot')));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/^Pixel_9a-\d{8}-\d{6}\.png$/);
    expect(canvas.drawImage).toHaveBeenCalledOnce();
  });

  it('shows errors a retry can’t fix inline', () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    act(() => {
      const socket = FakeScreenSocket.latest();
      socket.open();
      socket.receiveJson({ type: 'screenError', code: 'auth', message: 'bad token' });
    });
    expect(screen.getByText(/rejected Lionscope’s gRPC token/)).toBeTruthy();
  });

  it('maps the not_emulator error to the 0.3.1 note', () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    act(() => {
      FakeScreenSocket.latest().receiveJson({ type: 'screenError', code: 'not_emulator', message: 'x' });
    });
    expect(screen.getByText('Mirroring physical devices arrives in 0.3.1.')).toBeTruthy();
  });
});

describe('ScreenView input', () => {
  it('sends a tap: down, one coalesced move per frame, lift — in normalized frame coordinates', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'mouse', button: 0, ...at(0.5, 0.5) });
    fireEvent.pointerMove(target, { pointerId: 1, pointerType: 'mouse', ...at(0.6, 0.5) });
    fireEvent.pointerMove(target, { pointerId: 1, pointerType: 'mouse', ...at(0.7, 0.5) });
    expect(socket.messages()).toHaveLength(1);
    act(runFrames);
    fireEvent.pointerMove(target, { pointerId: 1, pointerType: 'mouse', ...at(0.8, 0.25) });
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'mouse', ...at(0.8, 0.25) });
    const touches = socket.messages().map((m) => (m as { touches: unknown[] }).touches);
    expect(touches).toEqual([
      [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }],
      [{ id: 0, x: expect.closeTo(0.7) as number, y: 0.5, pressure: 1 }],
      [{ id: 0, x: expect.closeTo(0.8) as number, y: 0.25, pressure: 1 }],
      [{ id: 0, x: expect.closeTo(0.8) as number, y: 0.25, pressure: 0 }],
    ]);
    expect(document.activeElement).toBe(target);
  });

  it('Alt+drag pinches with a second finger mirrored around the centre and shows the hint', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      altKey: true,
      ...at(0.25, 0.25),
    });
    expect(socket.messages()[0]).toEqual({
      type: 'touch',
      touches: [
        { id: 0, x: 0.25, y: 0.25, pressure: 1 },
        { id: 1, x: 0.75, y: 0.75, pressure: 1 },
      ],
    });
    expect(document.querySelectorAll('.pinch-dot')).toHaveLength(2);
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'mouse', ...at(0.25, 0.25) });
    expect(socket.messages()[1]).toMatchObject({
      touches: [
        { id: 0, pressure: 0 },
        { id: 1, pressure: 0 },
      ],
    });
    expect(document.querySelector('.pinch-hint')).toBeNull();
  });

  it('gives concurrent touch pointers their own ids and ignores taps in the letterbox', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, { pointerId: 7, pointerType: 'touch', ...at(0.2, 0.2) });
    fireEvent.pointerDown(target, { pointerId: 9, pointerType: 'touch', ...at(0.8, 0.8) });
    fireEvent.pointerUp(target, { pointerId: 7, pointerType: 'touch', ...at(0.2, 0.2) });
    fireEvent.pointerDown(target, { pointerId: 11, pointerType: 'touch', ...at(0.4, 0.4) });
    const ids = socket.messages().map((m) => (m as { touches: { id: number }[] }).touches.map((t) => t.id));
    expect(ids).toEqual([[0], [1], [0], [0]]);
    // Right-click and points outside the frame never start a gesture.
    fireEvent.pointerDown(target, { pointerId: 2, pointerType: 'mouse', button: 2, ...at(0.5, 0.5) });
    fireEvent.pointerDown(target, { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 });
    expect(socket.messages()).toHaveLength(4);
  });

  it('lifts every finger when the screen loses focus', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch', ...at(0.5, 0.5) });
    fireEvent.blur(target);
    expect(socket.messages()[1]).toMatchObject({ touches: [{ id: 0, pressure: 0 }] });
  });

  it('scrolls with the wheel, one message per frame, 120 per notch', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.wheel(target, { deltaY: -50, deltaMode: 0, ...at(0.5, 0.5) });
    fireEvent.wheel(target, { deltaY: -50, deltaMode: 0, ...at(0.5, 0.5) });
    fireEvent.wheel(target, { deltaY: -50, deltaMode: 0, ctrlKey: true, ...at(0.5, 0.5) });
    act(runFrames);
    expect(socket.messages()).toEqual([{ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 }]);
  });

  it('types, sends named keys, maps Escape to Back and keeps browser shortcuts', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.keyDown(target, { key: 'h' });
    fireEvent.keyUp(target, { key: 'h' });
    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.keyUp(target, { key: 'Enter' });
    const escape = fireEvent.keyDown(target, { key: 'Escape' });
    const reload = fireEvent.keyDown(target, { key: 'r', metaKey: true });
    fireEvent.keyDown(target, { key: 'Tab' });
    expect(escape).toBe(false);
    expect(reload).toBe(true);
    expect(socket.messages()).toEqual([
      { type: 'text', text: 'h' },
      { type: 'key', key: 'Enter', eventType: 'keydown' },
      { type: 'key', key: 'Enter', eventType: 'keyup' },
      { type: 'nav', button: 'back' },
    ]);
  });

  it('pastes clipboard text as text messages', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    fireEvent.paste(screenCanvas(), { clipboardData: { getData: () => 'hello' } });
    expect(socket.messages()).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('sizes the glass from the stage content box so the whole bezel stays visible', async () => {
    class StageResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        const entry = { contentRect: { width: 346, height: 700 } } as ResizeObserverEntry;
        this.callback([entry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StageResizeObserver);
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    await goLive();
    const glass = screenCanvas().parentElement as HTMLElement;
    // 700 px minus 2 × (7 px bezel + 4 px ring margin) of height, 540:1212 aspect.
    expect(glass.style.height).toBe('678px');
    expect(glass.style.width).toBe('302px');
  });

  it('names the screen and tells how to use it', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    await goLive();
    const target = screenCanvas();
    expect(target.getAttribute('tabindex')).toBe('0');
    const hint = document.getElementById(target.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('Click to interact');
    expect(hint?.textContent).toContain('Esc = Back');
  });
});

describe('ScreenView review fixes', () => {
  const touchIds = (socket: FakeScreenSocket) =>
    socket
      .messages()
      .filter((m) => (m as { type: string }).type === 'touch')
      .map((m) => (m as { touches: { id: number; pressure: number }[] }).touches);

  it('is an application with a device-screen role description', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    await goLive();
    const target = screenCanvas();
    expect(target.getAttribute('role')).toBe('application');
    expect(target.getAttribute('aria-roledescription')).toBe('device screen');
  });

  it('a size picked while connecting is sent once the socket opens, and remembered', async () => {
    const view = renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    fireEvent.click(screen.getByRole('radio', { name: '720' }));
    const socket = FakeScreenSocket.latest();
    expect(socket.sent).toEqual([]);
    act(() => socket.open());
    expect(socket.messages()).toEqual([{ type: 'setSize', size: 720 }]);
    expect(window.localStorage.getItem(LAYOUT_KEYS.screenSize)).toBe('720');

    view.unmount();
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    expect(FakeScreenSocket.latest().url).toContain('size=720');
    expect(screen.getByRole('radio', { name: '720' }).getAttribute('aria-checked')).toBe('true');
  });

  it('pointercancel and lostpointercapture release their touch ids', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch', ...at(0.5, 0.5) });
    fireEvent.pointerCancel(target, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerDown(target, { pointerId: 2, pointerType: 'touch', ...at(0.5, 0.5) });
    fireEvent.lostPointerCapture(target, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerDown(target, { pointerId: 3, pointerType: 'touch', ...at(0.5, 0.5) });
    expect(touchIds(socket)).toEqual([
      [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }],
      [{ id: 0, x: 0.5, y: 0.5, pressure: 0 }],
      [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }],
      [{ id: 0, x: 0.5, y: 0.5, pressure: 0 }],
      [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }],
    ]);
  });

  it('a repeated down for the same pointer lifts the old gesture instead of leaking its id', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    for (let i = 0; i < 12; i++) {
      fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'mouse', button: 0, ...at(0.5, 0.5) });
    }
    const downs = touchIds(socket).filter((t) => t[0]?.pressure === 1);
    expect(downs).toHaveLength(12);
    expect(downs.every((t) => t[0]?.id === 0)).toBe(true);
  });

  it('when the stream drops mid-drag, the gesture ends and its ids are free after reconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const first = await goLive();
    const target = screenCanvas();
    fireEvent.pointerDown(target, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      altKey: true,
      ...at(0.3, 0.3),
    });
    expect(document.querySelector('.pinch-hint')).not.toBeNull();
    act(() => first.drop());
    expect(screen.getByText(/reconnecting/)).toBeTruthy();
    expect(document.querySelector('.pinch-hint')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const second = await goLive();
    expect(second).not.toBe(first);
    fireEvent.pointerMove(target, { pointerId: 1, pointerType: 'mouse', ...at(0.4, 0.4) });
    fireEvent.pointerDown(target, { pointerId: 2, pointerType: 'mouse', button: 0, ...at(0.6, 0.6) });
    expect(touchIds(second)).toEqual([
      [{ id: 0, x: expect.closeTo(0.6) as number, y: expect.closeTo(0.6) as number, pressure: 1 }],
    ]);
  });

  it('releases held named keys on blur, types AltGr characters and keeps Alt keyup from the menu bar', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    const target = screenCanvas();
    fireEvent.keyDown(target, { key: 'ArrowLeft' });
    fireEvent.keyDown(target, { key: 'Backspace' });
    fireEvent.keyUp(target, { key: 'Backspace' });
    fireEvent.blur(target);
    fireEvent.keyDown(target, { key: '@', ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(fireEvent.keyUp(target, { key: 'Alt' })).toBe(false);
    expect(socket.messages()).toEqual([
      { type: 'key', key: 'ArrowLeft', eventType: 'keydown' },
      { type: 'key', key: 'Backspace', eventType: 'keydown' },
      { type: 'key', key: 'Backspace', eventType: 'keyup' },
      { type: 'key', key: 'ArrowLeft', eventType: 'keyup' },
      { type: 'text', text: '@' },
    ]);
  });

  it('paces a large paste, cut to 4 KB with a visible note', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    const socket = await goLive();
    fireEvent.paste(screenCanvas(), { clipboardData: { getData: () => 'x'.repeat(5000) } });
    expect(screen.getByText(PASTE_TRUNCATED_NOTE)).toBeTruthy();
    expect(socket.messages()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(PASTE_CHUNK_INTERVAL_MS);
    });
    expect(socket.messages()).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(PASTE_CHUNK_INTERVAL_MS * 20);
    });
    const texts = socket.messages().map((m) => (m as { text: string }).text);
    expect(texts).toHaveLength(16);
    expect(texts.join('')).toHaveLength(4096);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(PASTE_TRUNCATED_NOTE)).toBeNull();
  });

  it('offers Try again after an error a retry can’t fix', async () => {
    renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    act(() => {
      const socket = FakeScreenSocket.latest();
      socket.open();
      socket.receiveJson({ type: 'screenError', code: 'unavailable', message: 'no grpc' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(FakeScreenSocket.instances).toHaveLength(2);
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
  });

  it('a re-opened panel starts as connecting, not as the old live stream', async () => {
    const view = renderPanel({ serial: 'emulator-5554', emulator: RUNNING });
    await goLive();
    const rerender = (isVisible: boolean) =>
      view.rerender(
        <DevicePanel
          target={{ serial: 'emulator-5554', emulator: RUNNING }}
          isOnline
          isVisible={isVisible}
          pending={null}
          onBoot={view.onBoot}
        />,
      );
    rerender(false);
    rerender(true);
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

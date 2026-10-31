import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, ScreenServerMessage } from '@lionscope/protocol/wire';
import { DevicePanel } from '../src/components/device/DevicePanel.tsx';
import {
  DECODER_FAILED_MESSAGE,
  INSECURE_VIDEO_MESSAGE,
  UNSUPPORTED_VIDEO_MESSAGE,
} from '../src/lib/videoDecoder.ts';
import {
  CONFIG_PAYLOAD,
  DELTA_PAYLOAD,
  DEVICE_SCREEN_INFO,
  FakeScreenSocket,
  FakeVideoDecoder,
  FakeVideoFrame,
  IDR_PAYLOAD,
  binaryMessage,
  installCanvasStubs,
  installWebCodecs,
  videoMessage,
  type CanvasStubs,
} from './screenFakes.ts';

const PHONE: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };

let canvas: CanvasStubs;

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
  installWebCodecs();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderPhone(device: DeviceInfo | null = PHONE, hasDeviceList = true) {
  return render(
    <DevicePanel
      target={{ serial: 'R58M123ABC', emulator: null }}
      device={device}
      hasDeviceList={hasDeviceList}
      isOnline
      isVisible
      pending={null}
      onBoot={() => {}}
    />,
  );
}

/** Lets `isConfigSupported` settle inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Opens the socket and sends screenInfo, config and a key frame back to back, as the server does. */
async function connect(info: ScreenServerMessage = DEVICE_SCREEN_INFO) {
  const socket = FakeScreenSocket.latest();
  act(() => {
    socket.open();
    socket.receiveJson(info);
    socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
    socket.receive(videoMessage({ key: true }, 1000, IDR_PAYLOAD));
  });
  await flush();
  return { socket, decoder: FakeVideoDecoder.latest() };
}

/** `connect`, then the key frame decodes: the first picture puts the stream live. */
async function goLive(info: ScreenServerMessage = DEVICE_SCREEN_INFO) {
  const connected = await connect(info);
  act(() => {
    connected.decoder.emit();
  });
  return connected;
}

const phoneScreen = () => screen.getByLabelText('SM S918B screen');

describe('physical device states', () => {
  it('explains a device adb doesn’t list, an unauthorized one and an offline one, without a socket', () => {
    const view = renderPhone(null);
    expect(screen.getByText('Device not connected')).toBeTruthy();
    expect(screen.getByText(/R58M123ABC is disconnected/)).toBeTruthy();
    view.unmount();
    const unauthorized = renderPhone({ ...PHONE, state: 'unauthorized' });
    expect(screen.getByText('Can’t mirror SM S918B')).toBeTruthy();
    expect(screen.getByText(/accept the USB debugging prompt/)).toBeTruthy();
    unauthorized.unmount();
    renderPhone({ ...PHONE, state: 'offline' });
    expect(screen.getByText(/offline — reconnect the cable/)).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });

  it('says Connecting… before the first device list instead of "disconnected"', () => {
    renderPhone(null, false);
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.queryByText(/disconnected/)).toBeNull();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });

  it('on an insecure page (no WebCodecs there) points to localhost instead of other browsers', () => {
    vi.stubGlobal('VideoDecoder', undefined);
    vi.stubGlobal('isSecureContext', false);
    renderPhone();
    expect(screen.getByText(`${INSECURE_VIDEO_MESSAGE}.`)).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });

  it('says which browsers work when this one has no WebCodecs, and opens no socket', () => {
    vi.stubGlobal('VideoDecoder', undefined);
    renderPhone();
    expect(screen.getByText('Can’t show SM S918B')).toBeTruthy();
    expect(screen.getByText(`${UNSUPPORTED_VIDEO_MESSAGE}.`)).toBeTruthy();
    expect(FakeScreenSocket.instances).toHaveLength(0);
  });
});

describe('physical device stream', () => {
  it('opens the same screen socket and draws decoded H.264 frames at their size', async () => {
    renderPhone();
    expect(FakeScreenSocket.latest().url).toMatch(/\/ws\/screen\?serial=R58M123ABC&size=540$/);
    const { decoder } = await connect();
    expect(decoder.configs.map((c) => c.codec)).toEqual(['avc1.640028']);
    // The key frame sent right after the config is decoded, not dropped while the codec was checked.
    expect(decoder.chunks.map((c) => c.type)).toEqual(['key']);
    // SPS / PPS alone show nothing: still connecting, input off, until a frame is decoded.
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);

    const frame = new FakeVideoFrame(540, 1200);
    act(() => {
      decoder.emit(frame);
    });
    expect(canvas.drawImage).toHaveBeenCalledWith(frame, 0, 0);
    expect(frame.closed).toBe(true);
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
    const target = phoneScreen() as HTMLCanvasElement;
    expect([target.width, target.height]).toEqual([540, 1200]);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no frame rate cap: scrcpy paces a phone itself', () => {
    renderPhone();
    expect(screen.queryByRole('combobox', { name: 'Frame rate cap' })).toBeNull();
  });

  it('counts decoded frames for the fps readout', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    renderPhone();
    const { decoder } = await goLive();
    act(() => {
      for (let i = 0; i < 30; i++) decoder.emit();
      vi.advanceTimersByTime(500);
    });
    // 30 plus the first frame that put the stream live.
    expect(screen.getByTitle('Frames per second').textContent).toBe('31 fps');
  });

  it('a new screenInfo (rotation) resets the decoder until the next key frame', async () => {
    renderPhone();
    const { socket, decoder } = await goLive();
    act(() => {
      socket.receiveJson({ ...DEVICE_SCREEN_INFO, rotation: 90, frameWidth: 1200, frameHeight: 540 });
      socket.receive(videoMessage({}, 2000, DELTA_PAYLOAD));
      socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
      socket.receive(videoMessage({}, 3000, DELTA_PAYLOAD));
      socket.receive(videoMessage({ key: true }, 4000, IDR_PAYLOAD));
    });
    // Once for the screenInfo, once for the session's config.
    expect(decoder.resets).toBe(2);
    expect(decoder.configs).toHaveLength(3);
    expect(decoder.chunks.map((c) => `${c.type}@${c.timestamp}`)).toEqual(['key@1000', 'key@4000']);
    expect(phoneScreen().closest('.device-bezel')?.getAttribute('data-orientation')).toBe('landscape');
  });

  it('sends the same input as for emulators: touch, keys, nav, rotate and screenshot', async () => {
    renderPhone();
    const { socket } = await goLive();
    vi.spyOn(phoneScreen(), 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 270,
      height: 600,
    } as DOMRect);
    fireEvent.pointerDown(phoneScreen(), { pointerId: 1, pointerType: 'touch', clientX: 135, clientY: 300 });
    fireEvent.pointerUp(phoneScreen(), { pointerId: 1, pointerType: 'touch', clientX: 135, clientY: 300 });
    fireEvent.keyDown(phoneScreen(), { key: 'a' });
    for (const name of ['Back', 'Home', 'Recents', 'Power', 'Rotate left', 'Screenshot']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(socket.messages()).toEqual([
      { type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] },
      { type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 0 }] },
      { type: 'text', text: 'a' },
      { type: 'nav', button: 'back' },
      { type: 'nav', button: 'home' },
      { type: 'nav', button: 'recents' },
      { type: 'nav', button: 'power' },
      { type: 'rotate', direction: 'left' },
      { type: 'screenshot' },
    ]);
    expect(screen.getByRole('button', { name: 'Rotate left' }).title).toMatch(/best effort/);
  });

  it('downloads a screenshot named after the model', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    renderPhone();
    const { socket } = await goLive();
    act(() => socket.receive(binaryMessage('screenshot')));
    expect(clicked[0]).toMatch(/^SM_S918B-\d{8}-\d{6}\.png$/);
  });
});

describe('physical device key frames', () => {
  it('asks the device for a key frame when the decoder falls behind, throttled', async () => {
    renderPhone();
    const { socket, decoder } = await goLive();
    decoder.decodeQueueSize = 10;
    act(() => {
      socket.receive(videoMessage({}, 2000, DELTA_PAYLOAD));
      socket.receive(videoMessage({}, 3000, DELTA_PAYLOAD));
    });
    expect(socket.messages().filter((m) => (m as { type: string }).type === 'keyFrame')).toEqual([
      { type: 'keyFrame' },
    ]);
  });

  it('a repeated screenInfo (the server’s answer to a request) sends no key frame request of its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderPhone();
    const { socket } = await goLive();
    for (let i = 0; i < 3; i++) {
      act(() => {
        socket.receiveJson(DEVICE_SCREEN_INFO);
        socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
        socket.receive(videoMessage({ key: true }, 5000 + i, IDR_PAYLOAD));
        vi.advanceTimersByTime(1000);
      });
    }
    expect(socket.messages().filter((m) => (m as { type: string }).type === 'keyFrame')).toEqual([]);
  });
});

describe('physical device errors', () => {
  it('mirror_failed shows the server’s reason and offers Try again', () => {
    renderPhone();
    act(() => {
      const socket = FakeScreenSocket.latest();
      socket.open();
      socket.receiveJson({ type: 'screenError', code: 'mirror_failed', message: 'scrcpy exited (code 1)' });
    });
    expect(screen.getByText('Couldn’t start mirroring: scrcpy exited (code 1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(FakeScreenSocket.instances).toHaveLength(2);
  });

  it('input_denied keeps the live video and shows a dismissible banner with the HyperOS fix', async () => {
    renderPhone();
    const { socket, decoder } = await goLive();
    act(() =>
      socket.receiveJson({ type: 'screenError', code: 'input_denied', message: 'INJECT_EVENTS denied' }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('SM S918B refuses input');
    expect(alert.textContent).toContain('USB debugging (Security settings)');
    expect(alert.textContent).toContain('Mirroring works');
    expect(alert.textContent).toContain('INJECT_EVENTS denied');
    expect(socket.readyState).toBe(1);
    expect(screen.queryByText(/reconnecting/)).toBeNull();
    act(() => {
      decoder.emit();
    });
    expect(canvas.drawImage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // The live region stays, empty, for the next announcement.
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('a decoder that keeps failing stops with a Try again that starts a fresh stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderPhone();
    const { socket } = await goLive();
    for (let i = 0; i < 4; i++) {
      act(() => {
        FakeVideoDecoder.latest().fail();
        vi.advanceTimersByTime(5000);
      });
    }
    expect(screen.getByText(DECODER_FAILED_MESSAGE)).toBeTruthy();
    expect(socket.readyState).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(FakeScreenSocket.instances).toHaveLength(2);
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
  });

  it('an H.264 profile the browser can’t decode stops the stream with the browser message', async () => {
    FakeVideoDecoder.support = false;
    renderPhone();
    const socket = FakeScreenSocket.latest();
    act(() => {
      socket.open();
      socket.receiveJson(DEVICE_SCREEN_INFO);
      socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
    });
    await flush();
    expect(screen.getByText(UNSUPPORTED_VIDEO_MESSAGE)).toBeTruthy();
    expect(socket.readyState).toBe(3);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

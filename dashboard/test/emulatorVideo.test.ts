import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, EmulatorInfo } from '@lionscope/protocol/wire';
import type { ScreenInfo } from '../src/lib/screenSocket.ts';
import { DevicePanel } from '../src/components/device/DevicePanel.tsx';
import { DECODER_FAILED_MESSAGE, UNSUPPORTED_VIDEO_MESSAGE } from '../src/lib/videoDecoder.ts';
import {
  binaryMessage,
  CONFIG_PAYLOAD,
  DELTA_PAYLOAD,
  DEVICE_SCREEN_INFO,
  emulator,
  FakeScreenSocket,
  FakeVideoDecoder,
  FakeVideoFrame,
  IDR_PAYLOAD,
  installCanvasStubs,
  installWebCodecs,
  SCREEN_INFO,
  videoMessage,
  type CanvasStubs,
} from './screenFakes.ts';

const EMULATOR: EmulatorInfo = emulator();
const PHONE: DeviceInfo = { serial: 'R58M123ABC', state: 'device', model: 'SM_S918B' };

const EMULATOR_H264_INFO: ScreenInfo = {
  ...DEVICE_SCREEN_INFO,
  serial: 'emulator-5554',
  displayHeight: 2424,
  frameHeight: 1212,
};

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

function renderEmulator(isVisible = true) {
  return render(
    createElement(DevicePanel, {
      target: { serial: 'emulator-5554', emulator: EMULATOR },
      isOnline: true,
      isVisible,
      pending: null,
      onBoot: () => {},
    }),
  );
}

function renderPhone() {
  return render(
    createElement(DevicePanel, {
      target: { serial: 'R58M123ABC', emulator: null },
      device: PHONE,
      hasDeviceList: true,
      isOnline: true,
      isVisible: true,
      pending: null,
      onBoot: () => {},
    }),
  );
}

/** Lets `isConfigSupported` and `createImageBitmap` settle inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function connectEmulatorH264() {
  const socket = FakeScreenSocket.latest();
  act(() => {
    socket.open();
    socket.receiveJson(EMULATOR_H264_INFO);
    socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
    socket.receive(videoMessage({ key: true }, 1000, IDR_PAYLOAD));
  });
  await flush();
  return { socket, decoder: FakeVideoDecoder.latest() };
}

const emulatorScreen = () => screen.getByLabelText('Pixel 9a screen') as HTMLCanvasElement;

describe('emulator H.264 mirroring', () => {
  it('omits codec param when WebCodecs is available and goes live only on the first decoded frame', async () => {
    renderEmulator();
    const socket = FakeScreenSocket.latest();
    expect(socket.url).toMatch(/\/ws\/screen\?serial=emulator-5554&size=540&fps=30$/);

    const { decoder } = await connectEmulatorH264();
    expect(decoder.configs.map((c) => c.codec)).toEqual(['avc1.640028']);
    expect(decoder.chunks.map((c) => c.type)).toEqual(['key']);
    expect(screen.getByText('Connecting to the screen…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);

    const frame = new FakeVideoFrame(540, 1212);
    act(() => {
      decoder.emit(frame);
    });
    expect(canvas.drawImage).toHaveBeenCalledWith(frame, 0, 0);
    expect(frame.closed).toBe(true);
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
    expect([emulatorScreen().width, emulatorScreen().height]).toEqual([540, 1212]);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('supports setFpsCap, setSize, keyFrame, and FPS readout on emulator H.264 streams', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    renderEmulator();
    const { socket, decoder } = await connectEmulatorH264();
    act(() => {
      decoder.emit();
      for (let i = 0; i < 14; i++) decoder.emit();
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTitle('Frames per second').textContent).toBe('15 fps');

    fireEvent.click(screen.getByRole('radio', { name: '720' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Frame rate cap' }), { target: { value: '60' } });

    decoder.decodeQueueSize = 10;
    act(() => {
      socket.receive(videoMessage({}, 2000, DELTA_PAYLOAD));
    });

    expect(socket.messages()).toEqual([
      { type: 'setSize', size: 720 },
      { type: 'setFpsCap', fps: 60 },
      { type: 'keyFrame' },
    ]);

    act(() => {
      socket.receiveJson({ ...EMULATOR_H264_INFO, rotation: 90, frameWidth: 1212, frameHeight: 540 });
      socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
      socket.receive(videoMessage({ key: true }, 3000, IDR_PAYLOAD));
    });
    expect(decoder.resets).toBe(2);
    expect(emulatorScreen().closest('.device-bezel')?.getAttribute('data-orientation')).toBe('landscape');
  });

  it('requests codec=png upfront when WebCodecs is unavailable on an emulator', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    renderEmulator();
    const socket = FakeScreenSocket.latest();
    expect(socket.url).toMatch(/\/ws\/screen\?serial=emulator-5554&size=540&fps=30&codec=png$/);
    expect(screen.queryByText(UNSUPPORTED_VIDEO_MESSAGE)).toBeNull();

    act(() => {
      socket.open();
      socket.receiveJson(SCREEN_INFO);
      socket.receive(binaryMessage('frame'));
    });
    await flush();
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
  });

  it('falls back to codec=png and reconnects cleanly when isConfigSupported rejects the H.264 profile', async () => {
    FakeVideoDecoder.support = false;
    const view = renderEmulator();
    const first = FakeScreenSocket.latest();
    expect(first.url).toMatch(/\/ws\/screen\?serial=emulator-5554&size=540&fps=30$/);

    act(() => {
      first.open();
      first.receiveJson(EMULATOR_H264_INFO);
      first.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
    });
    await flush();

    expect(first.readyState).toBe(3);
    expect(screen.queryByText(UNSUPPORTED_VIDEO_MESSAGE)).toBeNull();
    expect(FakeScreenSocket.instances).toHaveLength(2);

    const fallback = FakeScreenSocket.latest();
    expect(fallback.url).toMatch(/\/ws\/screen\?serial=emulator-5554&size=540&fps=30&codec=png$/);

    act(() => {
      fallback.open();
      fallback.receiveJson(SCREEN_INFO);
      fallback.receive(binaryMessage('frame'));
    });
    await flush();

    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);

    // Re-enabling the stream remembers the PNG preference for this emulator.
    view.rerender(
      createElement(DevicePanel, {
        target: { serial: 'emulator-5554', emulator: EMULATOR },
        isOnline: true,
        isVisible: false,
        pending: null,
        onBoot: () => {},
      }),
    );
    view.rerender(
      createElement(DevicePanel, {
        target: { serial: 'emulator-5554', emulator: EMULATOR },
        isOnline: true,
        isVisible: true,
        pending: null,
        onBoot: () => {},
      }),
    );
    expect(FakeScreenSocket.instances).toHaveLength(3);
    expect(FakeScreenSocket.latest().url).toMatch(/&codec=png$/);
  });

  it('falls back to codec=png when VideoDecoder emits NotSupportedError at runtime', async () => {
    renderEmulator();
    const { socket: first, decoder } = await connectEmulatorH264();

    act(() => {
      decoder.error(new DOMException('no hardware decoder', 'NotSupportedError'));
    });

    expect(first.readyState).toBe(3);
    expect(screen.queryByText(UNSUPPORTED_VIDEO_MESSAGE)).toBeNull();
    expect(FakeScreenSocket.instances).toHaveLength(2);
    const fallback = FakeScreenSocket.latest();
    expect(fallback.url).toMatch(/&codec=png$/);

    act(() => {
      fallback.open();
      fallback.receiveJson(SCREEN_INFO);
      fallback.receive(binaryMessage('frame'));
    });
    await flush();
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
  });

  it('keeps physical-device terminal videoError behavior unchanged when unsupported', async () => {
    FakeVideoDecoder.support = false;
    renderPhone();
    const socket = FakeScreenSocket.latest();
    expect(socket.url).toMatch(/\/ws\/screen\?serial=R58M123ABC&size=540$/);

    act(() => {
      socket.open();
      socket.receiveJson(DEVICE_SCREEN_INFO);
      socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
    });
    await flush();

    expect(socket.readyState).toBe(3);
    expect(FakeScreenSocket.instances).toHaveLength(1);
    expect(screen.getByText(UNSUPPORTED_VIDEO_MESSAGE)).toBeTruthy();
  });

  it('falls back to codec=png on repeated decoder failures (onFailed) for an emulator H.264 stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderEmulator();
    const { socket: first } = await connectEmulatorH264();
    for (let i = 0; i < 3; i++) {
      act(() => {
        FakeVideoDecoder.latest().fail();
        vi.advanceTimersByTime(5000);
      });
    }
    expect(first.readyState).toBe(3);
    expect(screen.queryByText(DECODER_FAILED_MESSAGE)).toBeNull();
    expect(FakeScreenSocket.instances).toHaveLength(2);
    const fallback = FakeScreenSocket.latest();
    expect(fallback.url).toMatch(/&codec=png$/);

    act(() => {
      fallback.open();
      fallback.receiveJson(SCREEN_INFO);
      fallback.receive(binaryMessage('frame'));
    });
    vi.useRealTimers();
    await flush();
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(screen.queryByText('Connecting to the screen…')).toBeNull();
  });

  it('keeps physical-device retryable videoError on repeated decoder failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderPhone();
    const socket = FakeScreenSocket.latest();
    act(() => {
      socket.open();
      socket.receiveJson(DEVICE_SCREEN_INFO);
      socket.receive(videoMessage({ config: true }, 0, CONFIG_PAYLOAD));
      socket.receive(videoMessage({ key: true }, 1000, IDR_PAYLOAD));
    });
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      act(() => {
        FakeVideoDecoder.latest().fail();
        vi.advanceTimersByTime(5000);
      });
    }
    expect(screen.getByText(DECODER_FAILED_MESSAGE)).toBeTruthy();
    expect(socket.readyState).toBe(3);
    expect(FakeScreenSocket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(FakeScreenSocket.instances).toHaveLength(2);
  });

  it('disposes the active video pipeline cleanly when onInfo switches from h264 to png on the same socket', async () => {
    renderEmulator();
    const { socket, decoder } = await connectEmulatorH264();
    expect(decoder.state).toBe('configured');

    act(() => {
      socket.receiveJson(SCREEN_INFO);
      socket.receive(binaryMessage('frame'));
    });
    await flush();

    expect(decoder.state).toBe('closed');
    expect(FakeScreenSocket.instances).toHaveLength(1);
    expect(canvas.drawImage).toHaveBeenCalledOnce();
    expect(screen.queryByText(DECODER_FAILED_MESSAGE)).toBeNull();
  });
});

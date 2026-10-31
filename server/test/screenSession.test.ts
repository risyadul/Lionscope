import { SCREEN_BINARY_KIND } from '@lionscope/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmulatorRpcError } from '../src/emulator/emulatorClient.ts';
import {
  WHEEL_BATCH_MS,
  WHEEL_FINGER_ID,
  WHEEL_HOLD_MS,
  WHEEL_STEP_MS,
} from '../src/emulator/screenInput.ts';
import type { ScreenFrame } from '../src/emulator/emulatorClient.ts';
import {
  AUTH_MESSAGE,
  DRAIN_POLL_MS,
  ENDED_MESSAGE,
  INPUT_RETRY_MS,
  LIFT_GRACE_MS,
  MAX_SCREEN_BUFFERED_BYTES,
  SCREENSHOT_SKIP_BUFFERED_BYTES,
  ScreenSession,
  SETTLE_ATTEMPTS,
} from '../src/emulator/screenSession.ts';
import { FakeEmulatorClient, FakeScreenSocket, frame } from './helpers/fakeEmulatorClient.ts';

const SERIAL = 'emulator-5554';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(size: 360 | 540 | 720 = 540, fpsCap?: number) {
  const client = new FakeEmulatorClient();
  const socket = new FakeScreenSocket();
  const session = new ScreenSession(socket, client, SERIAL, size, fpsCap);
  await session.start();
  return { client, socket, session };
}

/** The default cap's frame interval (30 fps). */
const INTERVAL_30 = 1000 / 30;

describe('ScreenSession frames', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams into the preset box and sends screenInfo before the first frame', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started(540);
    expect(client.stream?.box).toEqual({ width: 540, height: 1212 });
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    vi.advanceTimersByTime(INTERVAL_30);
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'b'));
    expect(socket.kinds).toEqual([
      'screenInfo',
      `${SCREEN_BINARY_KIND.frame}:a`,
      `${SCREEN_BINARY_KIND.frame}:b`,
    ]);
    expect(socket.texts[0]).toEqual({
      type: 'screenInfo',
      serial: SERIAL,
      codec: 'png',
      displayWidth: 1080,
      displayHeight: 2424,
      rotation: 0,
      frameWidth: 540,
      frameHeight: 1212,
    });
  });

  it('ignores keyFrame requests (PNG frames need none)', async () => {
    const { client, socket, session } = await started();
    const sent = socket.sent.length;
    session.handle({ type: 'keyFrame' });
    expect(socket.sent).toHaveLength(sent);
    expect(client.inputs).toHaveLength(0);
  });

  it('holds the newest frame while the socket has unsent data, never queueing the ones it replaced', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started();
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    socket.bufferedAmount = 1;
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'replaced'));
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'c'));
    vi.advanceTimersByTime(10 * INTERVAL_30);
    expect(socket.binaries.map(([, payload]) => payload)).toEqual(['a']);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(DRAIN_POLL_MS);
    expect(socket.binaries.map(([, payload]) => payload)).toEqual(['a', 'c']);
  });

  it('sends screenInfo again before the first frame after a change, even when the change itself was replaced', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started();
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    socket.bufferedAmount = 1;
    stream?.handlers.onFrame(frame(1212, 540, 90, 'replaced'));
    client.stream?.handlers.onFrame(frame(1212, 540, 90, 'b'));
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(INTERVAL_30);
    expect(socket.kinds).toEqual(['screenInfo', '1:a', 'screenInfo', '1:b']);
    expect(socket.texts[1]).toMatchObject({ rotation: 90, frameWidth: 1212, frameHeight: 540 });
  });

  it('restarts the stream with a landscape box after a quarter turn, but not after a half turn', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started(540);
    const portrait = client.stream;
    // Letterboxed into the portrait box: still shown, then the stream restarts.
    portrait?.handlers.onFrame(frame(540, 241, 90, 'small'));
    expect(portrait?.cancelled).toBe(true);
    expect(client.stream?.box).toEqual({ width: 1212, height: 540 });
    expect(socket.binaries.map(([, payload]) => payload)).toEqual(['small']);
    client.stream?.handlers.onFrame(frame(1212, 540, 270, 'wide'));
    expect(client.streams).toHaveLength(2);
    client.stream?.handlers.onFrame(frame(540, 241, 0, 'back'));
    expect(client.streams).toHaveLength(3);
    expect(client.stream?.box).toEqual({ width: 540, height: 1212 });
  });

  it('restarts the stream on setSize, keeping the orientation', async () => {
    const { client, session } = await started(540);
    client.stream?.handlers.onFrame(frame(540, 241, 90));
    session.handle({ type: 'setSize', size: 540 });
    expect(client.streams).toHaveLength(2);
    session.handle({ type: 'setSize', size: 360 });
    expect(client.streams).toHaveLength(3);
    expect(client.stream?.box).toEqual({ width: 808, height: 360 });
    expect(client.streams[1]?.cancelled).toBe(true);
  });

  it('ends with screenError ended (or auth) when the stream ends', async () => {
    const { client, socket, session } = await started();
    client.stream?.handlers.onEnd(null);
    expect(socket.texts).toEqual([{ type: 'screenError', code: 'ended', message: ENDED_MESSAGE }]);
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'ended' });
    expect(session.isClosed).toBe(true);
    expect(client.closed).toBe(true);
    client.stream?.handlers.onFrame(frame(540, 1212));
    expect(socket.binaries).toEqual([]);

    const denied = await started();
    denied.client.stream?.handlers.onEnd(new EmulatorRpcError(16, 'streamScreenshot failed: no'));
    expect(denied.socket.texts).toEqual([{ type: 'screenError', code: 'auth', message: AUTH_MESSAGE }]);
  });

  it('fails right away when the display size cannot be read', async () => {
    const client = new FakeEmulatorClient();
    client.display = new EmulatorRpcError(16, 'getDisplayConfigurations failed');
    const socket = new FakeScreenSocket();
    await new ScreenSession(socket, client, SERIAL, 540).start();
    expect(socket.texts).toEqual([{ type: 'screenError', code: 'auth', message: AUTH_MESSAGE }]);
    expect(client.streams).toEqual([]);

    const other = new FakeEmulatorClient();
    other.display = new Error('connection refused');
    const otherSocket = new FakeScreenSocket();
    await new ScreenSession(otherSocket, other, SERIAL, 540).start();
    expect(otherSocket.texts[0]).toMatchObject({ code: 'ended' });
  });
});

describe('ScreenSession fps cap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const payloads = (socket: FakeScreenSocket) => socket.binaries.map(([, payload]) => payload);

  /** The emulator streaming a frame every `everyMs` (a scroll) while the stream is not paused, for `forMs`. */
  function animate(client: FakeEmulatorClient, forMs: number, everyMs = 4): number {
    let sent = 0;
    for (let t = 0; t < forMs; t += everyMs) {
      const stream = client.stream;
      if (stream && !stream.paused) {
        stream.handlers.onFrame(frame(540, 1212, 0, `f${t}`));
        sent += 1;
      }
      vi.advanceTimersByTime(everyMs);
    }
    return sent;
  }

  it('defaults to 30 fps: pauses the stream on every frame and resumes it once the interval has passed', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started();
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    expect(payloads(socket)).toEqual(['a']);
    expect(stream?.paused).toBe(true);
    vi.advanceTimersByTime(INTERVAL_30 - 2);
    expect(stream?.paused).toBe(true);
    vi.advanceTimersByTime(2);
    expect(stream?.paused).toBe(false);
    // Idle: nothing is scheduled until the next change.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streams at most the cap while the screen keeps changing, and the emulator is asked for no more', async () => {
    vi.useFakeTimers();
    const capped = await started(540);
    const offered = animate(capped.client, 1000);
    expect(capped.socket.binaries.length).toBeGreaterThanOrEqual(29);
    expect(capped.socket.binaries.length).toBeLessThanOrEqual(31);
    // A paused stream gets no frames: the emulator encoded only those that went out.
    expect(offered).toBe(capped.socket.binaries.length);

    const fast = await started(540, 60);
    animate(fast.client, 1000);
    expect(fast.socket.binaries.length).toBeGreaterThanOrEqual(59);
    expect(fast.socket.binaries.length).toBeLessThanOrEqual(61);
  });

  it('applies setFpsCap to the running stream, also to a frame already waiting', async () => {
    vi.useFakeTimers();
    const { client, socket, session } = await started();
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'b'));
    session.handle({ type: 'setFpsCap', fps: 60 });
    vi.advanceTimersByTime(Math.ceil(1000 / 60));
    expect(payloads(socket)).toEqual(['a', 'b']);
    // Same stream: the cap needs no restart.
    expect(client.streams).toHaveLength(1);

    // Down to 15 right after 'b' went out: the stream stays paused past 30 fps's interval, 'c' waits for 15's.
    session.handle({ type: 'setFpsCap', fps: 15 });
    stream?.handlers.onFrame(frame(540, 1212, 0, 'c'));
    vi.advanceTimersByTime(50);
    expect(stream?.paused).toBe(true);
    expect(payloads(socket)).toEqual(['a', 'b']);
    vi.advanceTimersByTime(20);
    expect(payloads(socket)).toEqual(['a', 'b', 'c']);
    const before = socket.binaries.length;
    animate(client, 1000);
    expect(socket.binaries.length - before).toBeLessThanOrEqual(16);
  });

  it('paces a custom cap (45) like a preset: at most the cap, nothing encoded beyond it', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started(540, 45);
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    expect(stream?.paused).toBe(true);
    // 1000 / 45 = 22.2 ms; Date.now() counts whole milliseconds, so it is due at 22.
    vi.advanceTimersByTime(21);
    expect(stream?.paused).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stream?.paused).toBe(false);
    const before = socket.binaries.length;
    const offered = animate(client, 1000);
    const sent = socket.binaries.length - before;
    expect(sent).toBeGreaterThanOrEqual(44);
    expect(sent).toBeLessThanOrEqual(46);
    expect(offered).toBe(sent);
    for (const fps of [5, 60]) {
      const edge = await started(540, fps);
      animate(edge.client, 1000);
      expect(edge.socket.binaries.length).toBeGreaterThanOrEqual(fps - 1);
      expect(edge.socket.binaries.length).toBeLessThanOrEqual(fps + 1);
    }
  });

  it('switches preset -> custom -> preset on the running stream', async () => {
    vi.useFakeTimers();
    const { client, socket, session } = await started();
    const rate = () => {
      const before = socket.binaries.length;
      animate(client, 1000);
      return socket.binaries.length - before;
    };
    expect(rate()).toBeGreaterThanOrEqual(29);
    session.handle({ type: 'setFpsCap', fps: 45 });
    const custom = rate();
    expect(custom).toBeGreaterThanOrEqual(44);
    expect(custom).toBeLessThanOrEqual(46);
    session.handle({ type: 'setFpsCap', fps: 60 });
    expect(rate()).toBeGreaterThanOrEqual(59);
    session.handle({ type: 'setFpsCap', fps: 45 });
    expect(rate()).toBeLessThanOrEqual(46);
    session.handle({ type: 'setFpsCap', fps: 15 });
    expect(rate()).toBeLessThanOrEqual(16);
    expect(client.streams).toHaveLength(1);
  });

  it('holds a custom cap back on unsent socket data and still sends the settled frame', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started(540, 45);
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'scroll-1'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'scroll-2'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'settled'));
    socket.bufferedAmount = 100_000;
    vi.advanceTimersByTime(20 * (1000 / 45));
    expect(payloads(socket)).toEqual(['scroll-1']);
    expect(stream?.paused).toBe(true);
    expect(stream?.resumes).toBe(0);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(DRAIN_POLL_MS);
    expect(payloads(socket)).toEqual(['scroll-1', 'settled']);
    vi.advanceTimersByTime(1000 / 45);
    expect(stream?.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the stream paused while the socket has unsent data, and resumes it once drained', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started();
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    socket.bufferedAmount = 100_000;
    vi.advanceTimersByTime(20 * INTERVAL_30);
    expect(stream?.paused).toBe(true);
    expect(stream?.resumes).toBe(0);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(DRAIN_POLL_MS);
    expect(stream?.paused).toBe(false);
    expect(stream?.resumes).toBe(1);
  });

  it('always sends the last frame of a change (the settled screen), never stopping on a frame in between', async () => {
    vi.useFakeTimers();
    const { client, socket } = await started();
    const stream = client.stream;
    // Frames read ahead come in a burst before the stream pauses: only the newest of them is kept.
    stream?.handlers.onFrame(frame(540, 1212, 0, 'scroll-1'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'scroll-2'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'settled'));
    expect(payloads(socket)).toEqual(['scroll-1']);
    vi.advanceTimersByTime(INTERVAL_30);
    expect(payloads(socket)).toEqual(['scroll-1', 'settled']);
    vi.advanceTimersByTime(INTERVAL_30);
    expect(stream?.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the cap across a stream restart', async () => {
    vi.useFakeTimers();
    const { client, socket, session } = await started();
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    session.handle({ type: 'setSize', size: 720 });
    const restarted = client.stream;
    expect(client.streams).toHaveLength(2);
    // The new stream waits for the cap like the old one would have.
    expect(restarted?.paused).toBe(true);
    vi.advanceTimersByTime(INTERVAL_30);
    expect(restarted?.paused).toBe(false);
    restarted?.handlers.onFrame(frame(720, 1616, 0, 'b'));
    expect(payloads(socket)).toEqual(['a', 'b']);
    // A late frame from the cancelled stream is ignored.
    client.streams[0]?.handlers.onFrame(frame(540, 1212, 0, 'late'));
    vi.advanceTimersByTime(INTERVAL_30);
    expect(payloads(socket)).toEqual(['a', 'b']);
  });

  it('clears its timer and drops a waiting frame when it closes', async () => {
    vi.useFakeTimers();
    const { client, socket, session } = await started();
    const stream = client.stream;
    stream?.handlers.onFrame(frame(540, 1212, 0, 'a'));
    stream?.handlers.onFrame(frame(540, 1212, 0, 'waiting'));
    expect(vi.getTimerCount()).toBe(1);
    session.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(stream?.cancelled).toBe(true);
    vi.advanceTimersByTime(10 * INTERVAL_30);
    expect(payloads(socket)).toEqual(['a']);
    expect(stream?.resumes).toBe(0);
  });
});

describe('ScreenSession input', () => {
  it('maps touches with the rotation of the frame on screen, over one input stream', async () => {
    const { client, session } = await started();
    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] });
    client.stream?.handlers.onFrame(frame(1212, 540, 90));
    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.25, y: 0.75, pressure: 0 }] });
    expect(client.inputs).toHaveLength(1);
    expect(client.events).toEqual([
      { touch_event: { touches: [{ x: 540, y: 1212, identifier: 0, pressure: 1024 }], display: 0 } },
      { touch_event: { touches: [{ x: 810, y: 1818, identifier: 0, pressure: 0 }], display: 0 } },
    ]);
  });

  it('forwards key, text and navigation input', async () => {
    const { client, session } = await started();
    session.handle({ type: 'key', key: 'a', eventType: 'keypress' });
    session.handle({ type: 'text', text: 'hi' });
    session.handle({ type: 'nav', button: 'home' });
    expect(client.events).toEqual([
      { key_event: { eventType: 'keypress', key: 'a' } },
      { key_event: { text: 'hi' } },
      { key_event: { eventType: 'keypress', key: 'GoHome' } },
    ]);
  });

  it('ignores touches and wheel before the display size is known', async () => {
    const client = new FakeEmulatorClient();
    const session = new ScreenSession(new FakeScreenSocket(), client, SERIAL, 540);
    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] });
    session.handle({ type: 'wheel', x: 0, y: 0, dx: 0, dy: 120 });
    expect(client.inputs).toEqual([]);
  });

  it('reopens the input stream after it ended, and closes on a refused token', async () => {
    const { client, socket, session } = await started();
    session.handle({ type: 'text', text: 'a' });
    client.inputs[0]?.onEnd(null);
    session.handle({ type: 'text', text: 'b' });
    expect(client.inputs).toHaveLength(2);
    expect(socket.closedWith).toBeNull();
    client.inputs[1]?.onEnd(new EmulatorRpcError(16, 'streamInputEvent failed'));
    expect(socket.texts.at(-1)).toMatchObject({ type: 'screenError', code: 'auth' });
    session.handle({ type: 'text', text: 'c' });
    expect(client.inputs).toHaveLength(2);
  });

  it('lifts fingers still down when it closes, and ends the input stream', async () => {
    const { client, session } = await started();
    session.handle({
      type: 'touch',
      touches: [
        { id: 2, x: 0.5, y: 0.5, pressure: 1 },
        { id: 5, x: 0.5, y: 0.5, pressure: 0.5 },
      ],
    });
    session.handle({ type: 'touch', touches: [{ id: 5, x: 0.5, y: 0.5, pressure: 0 }] });
    session.close();
    session.close();
    expect(client.events.at(-1)).toEqual({
      touch_event: { touches: [{ x: 0, y: 0, identifier: 2, pressure: 0 }], display: 0 },
    });
    expect(client.inputs[0]?.ended).toBe(true);
    expect(client.stream?.cancelled).toBe(true);
    session.handle({ type: 'text', text: 'late' });
    expect(client.events.at(-1)).not.toEqual({ key_event: { text: 'late' } });
  });

  it('rotates a quarter turn from the current physical rotation, one request at a time', async () => {
    const { client, session } = await started();
    client.rotationZ = -90;
    session.handle({ type: 'rotate', direction: 'right' });
    session.handle({ type: 'rotate', direction: 'right' });
    await tick();
    expect(client.rotations).toEqual([180]);
    session.handle({ type: 'rotate', direction: 'left' });
    await tick();
    expect(client.rotations).toEqual([180, -90]);
    client.setRotationZ = () => Promise.reject(new Error('no sensors'));
    session.handle({ type: 'rotate', direction: 'left' });
    await tick();
    expect(client.rotations).toEqual([180, -90]);
  });

  it('answers screenshot with one full-resolution PNG (kind 2), even while frames are being dropped', async () => {
    const { client, socket, session } = await started();
    socket.bufferedAmount = 10;
    session.handle({ type: 'screenshot' });
    session.handle({ type: 'screenshot' });
    await tick();
    expect(socket.binaries).toEqual([[SCREEN_BINARY_KIND.screenshot, 'full']]);
    client.screenshot = new Error('busy');
    session.handle({ type: 'screenshot' });
    await tick();
    expect(socket.binaries).toHaveLength(1);
  });
});

describe('ScreenSession priming', () => {
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };

  async function primed() {
    const client = new FakeEmulatorClient();
    client.scaledScreenshots = 'answer';
    const socket = new FakeScreenSocket();
    const session = new ScreenSession(socket, client, SERIAL, 540);
    await session.start();
    return { client, socket, session };
  }

  it('fetches the current screen when a stream starts, also while frames are being dropped', async () => {
    const client = new FakeEmulatorClient();
    client.scaledScreenshots = 'answer';
    const socket = new FakeScreenSocket();
    socket.bufferedAmount = 5;
    await new ScreenSession(socket, client, SERIAL, 540).start();
    await waitFor(() => socket.binaries.length === 1);
    expect(client.screenshotBoxes).toEqual([{ width: 540, height: 1212 }]);
    expect(socket.kinds).toEqual(['screenInfo', '1:prime 540x1212']);
  });

  it('fetches again after setSize, with the new box', async () => {
    const { client, socket, session } = await primed();
    await waitFor(() => socket.binaries.length === 1);
    session.handle({ type: 'setSize', size: 720 });
    await waitFor(() => socket.binaries.length === 2);
    expect(client.screenshotBoxes.at(-1)).toEqual({ width: 720, height: 1616 });
    expect(socket.texts.at(-1)).toMatchObject({ frameWidth: 720, frameHeight: 1616 });
  });

  it('does not send a fetched frame once the stream sent a newer one', async () => {
    const client = new FakeEmulatorClient();
    let answer: (value: ScreenFrame) => void = () => undefined;
    client.getScreenshot = () => new Promise((resolve) => (answer = resolve));
    const socket = new FakeScreenSocket();
    await new ScreenSession(socket, client, SERIAL, 540).start();
    client.stream?.handlers.onFrame(frame(540, 1212, 0, 'stream'));
    answer(frame(540, 1212, 0, 'stale'));
    await tick();
    expect(socket.binaries.map(([, payload]) => payload)).toEqual(['stream']);
  });

  it('after a rotation waits for the new orientation, then sends it in the right box', async () => {
    const { client, socket, session } = await primed();
    await waitFor(() => socket.binaries.length === 1);
    session.handle({ type: 'rotate', direction: 'left' });
    // The emulator reports the new skin rotation a little later.
    setTimeout(() => (client.skinRotation = 270), 60);
    await waitFor(() => socket.texts.at(-1)?.rotation === 270);
    expect(client.rotations).toEqual([90]);
    expect(socket.texts.at(-1)).toMatchObject({ frameWidth: 1212, frameHeight: 540 });
    expect(socket.binaries.at(-1)).toEqual([1, 'prime 1212x540']);
    expect(client.stream?.box).toEqual({ width: 1212, height: 540 });
    // A stream frame in the old orientation does not cancel the wait.
    session.handle({ type: 'rotate', direction: 'left' });
    client.stream?.handlers.onFrame(frame(1212, 540, 270, 'old'));
    setTimeout(() => (client.skinRotation = 180), 30);
    await waitFor(() => socket.texts.at(-1)?.rotation === 180);
    expect(socket.binaries.at(-1)).toEqual([1, 'prime 540x1212']);
  });

  it('gives up waiting after SETTLE_ATTEMPTS and shows what the emulator reports', async () => {
    const { client, socket, session } = await primed();
    await waitFor(() => socket.binaries.length === 1);
    session.handle({ type: 'rotate', direction: 'right' });
    await waitFor(() => client.screenshotBoxes.length >= SETTLE_ATTEMPTS + 1);
    await waitFor(() => socket.binaries.length === 2);
    expect(socket.texts.at(-1)).toMatchObject({ rotation: 0 });
  });

  it('logs and stops when the screen cannot be fetched', async () => {
    const client = new FakeEmulatorClient();
    client.scaledScreenshots = new Error('UNAVAILABLE');
    const socket = new FakeScreenSocket();
    await new ScreenSession(socket, client, SERIAL, 540).start();
    await tick();
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });
});

describe('ScreenSession wheel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const touches = (client: FakeEmulatorClient) =>
    client.events.flatMap((event) => ('touch_event' in event ? event.touch_event.touches : []));

  it('turns wheel input within the batch window into one drag that lifts after holding still', async () => {
    vi.useFakeTimers();
    const { client, session } = await started();
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 60 });
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 60 });
    expect(client.events).toEqual([]);
    vi.advanceTimersByTime(WHEEL_BATCH_MS);
    expect(touches(client)).toEqual([{ x: 540, y: 1212, identifier: WHEEL_FINGER_ID, pressure: 1024 }]);
    vi.advanceTimersByTime(4 * WHEEL_STEP_MS);
    // 420 dpi: 0.12 × 1080 + 21 px slop = 150.6 px.
    expect(touches(client).map((touch) => [touch.y, touch.pressure])).toEqual([
      [1212, 1024],
      [1250, 1024],
      [1287, 1024],
      [1325, 1024],
      [1363, 1024],
    ]);
    vi.advanceTimersByTime(WHEEL_HOLD_MS);
    expect(touches(client).at(-1)).toEqual({ x: 540, y: 1363, identifier: WHEEL_FINGER_ID, pressure: 0 });
    expect(4 * WHEEL_STEP_MS + WHEEL_HOLD_MS).toBeLessThan(150);
  });

  it('queues wheel input during a drag, and drops it while the user is touching', async () => {
    vi.useFakeTimers();
    const { client, session } = await started();
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
    vi.advanceTimersByTime(WHEEL_BATCH_MS + WHEEL_STEP_MS);
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -120 });
    vi.advanceTimersByTime(WHEEL_BATCH_MS);
    const downs = () =>
      touches(client).filter((touch, index, all) => touch.pressure > 0 && all[index - 1]?.pressure !== 1024);
    expect(downs()).toHaveLength(1);
    // The queued drag runs once the first one has lifted.
    vi.advanceTimersByTime(2 * (4 * WHEEL_STEP_MS + WHEEL_HOLD_MS));
    expect(downs()).toHaveLength(2);
    expect(touches(client).at(-1)).toMatchObject({ y: 1061, pressure: 0 });

    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] });
    const before = client.events.length;
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
    vi.advanceTimersByTime(1000);
    expect(client.events.length).toBe(before);
  });

  it('lifts the wheel finger when the socket closes mid-drag, and stops the drag', async () => {
    vi.useFakeTimers();
    const { client, session } = await started();
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
    await vi.advanceTimersByTimeAsync(WHEEL_BATCH_MS + WHEEL_STEP_MS);
    session.close();
    const count = client.events.length;
    expect(touches(client).at(-1)).toMatchObject({ identifier: WHEEL_FINGER_ID, pressure: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.events.length).toBe(count);
    expect(client.closed).toBe(true);
  });

  it('ignores wheel input that does not move', async () => {
    vi.useFakeTimers();
    const { client, session } = await started();
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 0 });
    vi.advanceTimersByTime(1000);
    expect(client.events).toEqual([]);
  });
});

describe('ScreenSession release', () => {
  it('lifts fingers on a new input stream when the old one had ended', async () => {
    const { client, session } = await started();
    session.handle({ type: 'touch', touches: [{ id: 3, x: 0.5, y: 0.5, pressure: 1 }] });
    client.inputs[0]?.onEnd(null);
    client.stream?.handlers.onEnd(null);
    expect(client.inputs).toHaveLength(2);
    expect(client.inputs[1]?.events).toEqual([
      { touch_event: { touches: [{ x: 0, y: 0, identifier: 3, pressure: 0 }], display: 0 } },
    ]);
    expect(client.inputs[1]?.ended).toBe(true);
    expect(session.isClosed).toBe(true);
    // The client closes only once the lift's stream has ended: closing it at once would cancel that stream.
    expect(client.closed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.closed).toBe(true);
    expect(client.inputs[1]?.cancelled).toBe(false);
    expect(client.inputs[1]?.events).toHaveLength(1);
  });

  it('closes the client after LIFT_GRACE_MS when the emulator never confirms the lift', async () => {
    vi.useFakeTimers();
    try {
      const { client, session } = await started();
      client.answersEnd = false;
      session.handle({ type: 'touch', touches: [{ id: 1, x: 0.5, y: 0.5, pressure: 1 }] });
      await vi.advanceTimersByTimeAsync(1);
      session.close();
      await vi.advanceTimersByTimeAsync(LIFT_GRACE_MS - 1);
      expect(client.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.closed).toBe(true);
      expect(client.events.at(-1)).toMatchObject({
        touch_event: { touches: [{ identifier: 1, pressure: 0 }] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the client at once when no finger is down', async () => {
    const { client, session } = await started();
    session.handle({ type: 'text', text: 'a' });
    session.close();
    expect(client.closed).toBe(true);
  });

  it('marks only moves of fingers already down as droppable', async () => {
    vi.useFakeTimers();
    try {
      const { client, session } = await started();
      const at = (id: number, pressure: number) => ({ id, x: 0.5, y: 0.5, pressure });
      session.handle({ type: 'touch', touches: [at(0, 1)] });
      session.handle({ type: 'touch', touches: [at(0, 1)] });
      session.handle({ type: 'touch', touches: [at(0, 1), at(1, 1)] });
      session.handle({ type: 'touch', touches: [at(0, 1), at(1, 1)] });
      session.handle({ type: 'touch', touches: [at(0, 0), at(1, 0)] });
      session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
      await vi.advanceTimersByTimeAsync(WHEEL_BATCH_MS + 4 * WHEEL_STEP_MS + WHEEL_HOLD_MS);
      expect(client.inputs[0]?.droppable).toEqual([
        false,
        true,
        false,
        true,
        false,
        false,
        true,
        true,
        true,
        true,
        false,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ScreenSession limits', () => {
  it('skips screenshots for a socket far behind, and drops a socket that stops reading', async () => {
    const { client, socket, session } = await started();
    socket.bufferedAmount = SCREENSHOT_SKIP_BUFFERED_BYTES + 1;
    session.handle({ type: 'screenshot' });
    await tick();
    expect(socket.binaries).toEqual([]);

    // Frames that must go out (a fetched frame) still queue, up to the limit.
    client.scaledScreenshots = 'answer';
    socket.bufferedAmount = MAX_SCREEN_BUFFERED_BYTES + 1;
    session.handle({ type: 'setSize', size: 360 });
    await tick();
    expect(socket.terminated).toBe(true);
    expect(session.isClosed).toBe(true);
    expect(socket.sent).toEqual([]);
  });

  it('waits a moment before reopening an input stream that failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { client, session } = await started();
      session.handle({ type: 'text', text: 'a' });
      client.inputs[0]?.onEnd(new EmulatorRpcError(14, 'streamInputEvent failed: UNAVAILABLE'));
      session.handle({ type: 'text', text: 'dropped' });
      expect(client.inputs).toHaveLength(1);
      vi.advanceTimersByTime(INPUT_RETRY_MS);
      session.handle({ type: 'text', text: 'b' });
      expect(client.inputs).toHaveLength(2);
      expect(client.inputs[1]?.events).toEqual([{ key_event: { text: 'b' } }]);
      // A clean end (the emulator closed it) reopens right away.
      client.inputs[1]?.onEnd(null);
      session.handle({ type: 'text', text: 'c' });
      expect(client.inputs).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ScreenSession clipboard', () => {
  it('sends Android copies as clipboard messages, and closes the clipboard stream with the session', async () => {
    const { client, socket, session } = await started();
    session.handle({ type: 'clipboardSync', enabled: true });
    client.clipboardStream?.handlers.onText('initial');
    client.clipboardStream?.handlers.onText('copied');
    expect(socket.texts).toContainEqual({ type: 'clipboard', text: 'copied' });
    expect(socket.texts).not.toContainEqual({ type: 'clipboard', text: 'initial' });
    session.handle({ type: 'paste', text: 'pasted' });
    await tick();
    expect(client.clipboardSets).toEqual(['pasted']);
    expect(client.events.at(-1)).toEqual({ key_event: { eventType: 'keypress', key: 'Paste' } });
    session.close();
    expect(client.clipboardStream?.cancelled).toBe(true);
  });

  it('ends the socket with auth when the clipboard stream is refused', async () => {
    const { client, socket, session } = await started();
    session.handle({ type: 'clipboardSync', enabled: true });
    client.clipboardStream?.handlers.onEnd(new EmulatorRpcError(16, 'streamClipboard failed: no token'));
    expect(socket.texts.at(-1)).toMatchObject({ type: 'screenError', code: 'auth' });
    expect(session.isClosed).toBe(true);
  });
});

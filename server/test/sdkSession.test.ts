import { DEFAULT_SDK_OPTIONS } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISCONNECTED_SDK,
  droppedFramesMessage,
  MAX_FRAME_AGE_MS,
  MAX_HELD_MESSAGES,
  SDK_CLOCK_MESSAGE,
  SDK_FRAMES_IDLE_MS,
} from '../src/device/sdkBridge.ts';
import { log } from '../src/log.ts';
import { ProfilingSession } from '../src/session/profilingSession.ts';
import { FakeAdb, FakeDevice } from './helpers/fakes.ts';
import {
  deviceNow,
  FakeLink,
  HELLO,
  HOME,
  OFFSET_MS,
  PKG,
  PROMO,
  sdkFrame,
  setupSdkSession as setup,
  START,
} from './helpers/sdkSession.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProfilingSession SDK link', () => {
  it('is ready only once the device probe is done; refreshPid is a no-op before', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command === 'getconf CLK_TCK' ? { output: '100\n', delayMs: 500 } : original(command);
    const adb = new FakeAdb(
      () => '',
      (command) => device.handle(command),
    );
    const ready: number[] = [];
    const session = new ProfilingSession({
      adb,
      serial: 'emulator-5554',
      packageName: PKG,
      emit: () => undefined,
      onReady: () => ready.push(Date.now()),
    });
    const started = session.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.isReady).toBe(false);
    expect(await session.refreshPid()).toEqual([]);
    expect(device.commands.some((command) => command.startsWith('pidof'))).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await started;
    expect(session.isReady).toBe(true);
    expect(ready).toHaveLength(1);
    session.stop();
    expect(session.isReady).toBe(false);
  });

  it('coalesces concurrent PID refreshes into one pidof and returns every PID', async () => {
    const { device, session, pidofs } = await setup();
    const original = device.handle.bind(device);
    device.handle = (command) => (command.startsWith('pidof') ? '1105 2210\n' : original(command));
    const before = pidofs();
    const results = await Promise.all([session.refreshPid(), session.refreshPid(), session.refreshPid()]);
    expect(results).toEqual([
      [1105, 2210],
      [1105, 2210],
      [1105, 2210],
    ]);
    expect(pidofs()).toBe(before + 1);
    await session.refreshPid();
    expect(pidofs()).toBe(before + 2);
    session.stop();
  });

  it('reports SDK status: disconnected until a link is verified, then connected (broadcast)', async () => {
    const { session, ofType } = await setup();
    expect(session.state.sdk).toEqual(DISCONNECTED_SDK);
    const link = new FakeLink();
    session.attachSdk(HELLO, link);
    expect(session.state.sdk).toEqual(DISCONNECTED_SDK); // pending until its PID checks out
    await vi.advanceTimersByTimeAsync(0);
    const expected = {
      connected: true,
      sdkVersion: '0.1.0',
      processName: PKG,
      apiLevel: 35,
      framesActive: false,
      protocolVersion: 1,
      options: DEFAULT_SDK_OPTIONS,
    };
    expect(session.state.sdk).toEqual(expected);
    expect(ofType('session').at(-1)?.session.sdk).toEqual(expected);
    session.stop();
  });

  it('refuses a link whose PID is not the app (spoofed package name), discarding its messages', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, ofType, gfxinfoPolls, sendFrames } = await setup();
    const link = new FakeLink();
    const handler = session.attachSdk({ ...HELLO, pid: 6666 }, link);
    // Pending: nothing it sends counts, and gfxinfo keeps polling.
    handler.onMessage({ type: 'screen', ts: deviceNow(), screen: HOME });
    sendFrames(handler, 30);
    expect(session.state.sdk?.framesActive).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.closedWith).toBe('no_session');
    expect(ofType('screen')).toEqual([]);
    expect(session.state.sdk?.connected).toBe(false);
    const polls = gfxinfoPolls();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gfxinfoPolls()).toBeGreaterThan(polls);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('pid 6666 is not a process'))).toBe(true);
    session.stop();
  });

  it('refuses a link when the PID check fails, and ignores a check finishing after close', async () => {
    const { device, session, connect } = await setup();
    const original = device.handle.bind(device);
    device.handle = (command) => (command.startsWith('pidof') ? 'hang' : original(command));
    const link = new FakeLink();
    const handler = session.attachSdk(HELLO, link);
    handler.onClose(); // gone before the check finished
    await vi.advanceTimersByTimeAsync(3100); // pidof times out
    expect(link.closedWith).toBeNull();

    const failing = new FakeLink();
    session.attachSdk(HELLO, failing);
    await vi.advanceTimersByTimeAsync(3100);
    expect(failing.closedWith).toBe('no_session');
    device.handle = original;
    await vi.advanceTimersByTimeAsync(3100); // let the CPU loop's hanging pidof time out too
    expect((await connect()).link.closedWith).toBeNull();
    expect(session.state.sdk?.connected).toBe(true);
    session.stop();
  });

  it('records screen spans on the laptop clock, within the session and without repeats', async () => {
    const { session, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    const { handler } = await connect();
    const at = deviceNow() - 200;
    handler.onMessage({ type: 'screen', ts: deviceNow() - 60_000, screen: PROMO }); // before the session
    handler.onMessage({ type: 'screen', ts: at, screen: HOME });
    handler.onMessage({ type: 'screen', ts: at + 50, screen: { ...HOME } }); // same screen again
    handler.onMessage({ type: 'screen', ts: at + 100, screen: null });
    handler.onMessage({ type: 'screen', ts: deviceNow() + 60_000, screen: PROMO }); // future: clamped to now
    const now = Date.now();
    expect(ofType('screen').map((message) => message.span)).toEqual([
      { start: START, end: null, screen: PROMO },
      { start: now - 200, end: null, screen: HOME },
      { start: now - 100, end: null, screen: null },
      { start: now, end: null, screen: PROMO },
    ]);
    expect(session.snapshot().screens?.map((span) => span.end)).toEqual([now - 200, now - 100, now, null]);
    session.stop();
  });

  it('turns SDK frames into sdk samples and breakdowns, pausing gfxinfo while they flow', async () => {
    const { session, ofType, gfxinfoPolls, connect, sendFrames } = await setup();
    await vi.advanceTimersByTimeAsync(1100);
    expect(ofType('frames').every((message) => message.sample.source === 'gfxinfo')).toBe(true);
    expect(ofType('frames').length).toBeGreaterThan(0);

    const { handler } = await connect();
    handler.onMessage({ type: 'screen', ts: deviceNow() - 900, screen: HOME });
    sendFrames(handler, 60);
    expect(session.state.sdk?.framesActive).toBe(true);
    expect(ofType('session').at(-1)?.session.sdk?.framesActive).toBe(true);
    const polls = gfxinfoPolls();
    const gfxSamples = ofType('frames').length;

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      sendFrames(handler, 60);
    }
    expect(gfxinfoPolls()).toBe(polls);
    const sdk = ofType('frames')
      .slice(gfxSamples)
      .map((message) => message.sample);
    expect(sdk.length).toBeGreaterThanOrEqual(3);
    expect(sdk.every((sample) => sample.source === 'sdk' && sample.frameIntervalSource === 'reported')).toBe(
      true,
    );
    expect(sdk.reduce((sum, sample) => sum + sample.frameCount, 0)).toBeGreaterThanOrEqual(120);
    const breakdown = ofType('breakdown').map((message) => message.sample);
    expect(breakdown.length).toBeGreaterThanOrEqual(3);
    expect(breakdown[0]).toMatchObject({ screen: 'home', jankCount: 0, frameIntervalMs: 8.33 });
    expect(breakdown[0]?.meanStageMs).toMatchObject({ draw: 2, gpu: 3 });
    expect(session.snapshot().breakdown?.length).toBe(breakdown.length);

    // No SDK frames for 3 s: gfxinfo polling resumes (its first dump only primes).
    await vi.advanceTimersByTimeAsync(SDK_FRAMES_IDLE_MS + 500);
    expect(session.state.sdk?.framesActive).toBe(false);
    expect(session.state.sdk?.connected).toBe(true);
    expect(gfxinfoPolls()).toBeGreaterThan(polls);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ofType('frames').at(-1)?.sample.source).toBe('gfxinfo');
    session.stop();
  });

  it('hands frames over from gfxinfo to the SDK and back with strictly increasing timestamps', async () => {
    const { session, ofType, connect, sendFrames } = await setup();
    await vi.advanceTimersByTimeAsync(1100);
    const lastGfxinfo = ofType('frames').at(-1)?.sample.ts ?? 0;
    const { handler } = await connect();
    // The batch reaches back before the last gfxinfo sample: those frames were already counted.
    sendFrames(handler, 60);
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      sendFrames(handler, 60);
    }
    await vi.advanceTimersByTimeAsync(SDK_FRAMES_IDLE_MS + 2000);
    const samples = ofType('frames').map((message) => message.sample);
    const firstSdk = samples.find((sample) => sample.source === 'sdk');
    expect(firstSdk?.ts).toBeGreaterThan(lastGfxinfo);
    expect(samples.at(-1)?.source).toBe('gfxinfo');
    const ts = samples.map((sample) => sample.ts);
    expect(ts.every((value, i) => i === 0 || value > (ts[i - 1] ?? 0))).toBe(true);
    expect(session.snapshot().frames.map((sample) => sample.ts)).toEqual(ts);
    session.stop();
  });

  it('drops frames outside the clock window (once-throttled notice) and clamps future ones to now', async () => {
    const { session, ofType, connect } = await setup();
    const { handler } = await connect();
    const batch = (ts: number[]) =>
      handler.onMessage({
        type: 'frames',
        window: 'w',
        intervalMs: 16.6,
        frames: ts.map((t) => sdkFrame(t, 5)),
      });
    // 5 ms frames: one completed just over 10 s ago, one starting just over 2 s ahead.
    batch([deviceNow() - MAX_FRAME_AGE_MS - 6, deviceNow() + 2001]);
    expect(session.state.sdk?.framesActive).toBe(false);
    batch([deviceNow() - 3_600_000]);
    expect(ofType('error')).toEqual([{ type: 'error', code: 'collector_error', message: SDK_CLOCK_MESSAGE }]);

    batch([deviceNow() + 1500]); // slightly ahead: counted, as of now
    expect(session.state.sdk?.framesActive).toBe(true);
    handler.onClose();
    expect(
      ofType('frames')
        .filter((message) => message.sample.source === 'sdk')
        .at(-1)?.sample,
    ).toMatchObject({
      frameCount: 1,
    });
    session.stop();
  });

  it('judges frame age by completion: a slow cold-start frame is no clock problem', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, ofType, connect } = await setup();
    const { handler } = await connect();
    const frames = (list: [number, number][]) =>
      handler.onMessage({
        type: 'frames',
        window: 'w',
        intervalMs: 16.6,
        frames: list.map(([ago, totalMs]) => sdkFrame(deviceNow() - ago, totalMs)),
      });
    // Started 12 s ago on a loaded device and took 11 s: completed 1 s ago.
    frames([[12_000, 11_000]]);
    expect(ofType('error')).toEqual([]);
    expect(session.state.sdk?.framesActive).toBe(true);
    handler.onClose();
    const sdk = ofType('frames').filter((message) => message.sample.source === 'sdk');
    expect(sdk.at(-1)?.sample).toMatchObject({ frameCount: 1, maxMs: 11_000 });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('SDK frames'))).toBe(false);

    // Completed 11 s ago: really outside the window. The server log says by how much.
    const again = await connect();
    again.handler.onMessage({
      type: 'frames',
      window: 'w',
      intervalMs: 16.6,
      frames: [sdkFrame(deviceNow() - 15_000, 4000)],
    });
    expect(ofType('error').map((message) => message.message)).toEqual([SDK_CLOCK_MESSAGE]);
    const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('SDK frames'));
    expect(line).toContain('dropped 1 SDK frames: up to 1000 ms behind the accepted window');
    expect(line).toContain(`clock offset ${OFFSET_MS} ms`);
    session.stop();
  });

  it('drops frames over a minute one by one (a held breakpoint), keeping the link and the rest', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, ofType, connect } = await setup();
    const { link, handler } = await connect();
    const send = () =>
      handler.onMessage({
        type: 'frames',
        window: 'w',
        intervalMs: 16.6,
        frames: [sdkFrame(deviceNow() - 200, 5), sdkFrame(deviceNow() - 100, 90_000)],
      });
    send();
    send();
    handler.onClose();
    expect(link.closedWith).toBeNull();
    const sdk = ofType('frames').filter((message) => message.sample.source === 'sdk');
    expect(sdk.reduce((sum, message) => sum + message.sample.frameCount, 0)).toBe(1); // the 5 ms frame (deduped)
    expect(ofType('error')).toEqual([]); // no client notice: not a clock problem either
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes('over 60000 ms'));
    expect(lines).toHaveLength(1);
    session.stop();
  });

  it('logs how far ahead a future frame is', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, connect } = await setup();
    const { handler } = await connect();
    handler.onMessage({
      type: 'frames',
      window: 'w',
      intervalMs: 16.6,
      frames: [sdkFrame(deviceNow() + 2500, 5)],
    });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('up to 500 ms ahead of'))).toBe(true);
    session.stop();
  });

  it('on link close: flushes frames, closes the open span and resumes gfxinfo', async () => {
    const { session, ofType, gfxinfoPolls, connect, sendFrames } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    const { handler } = await connect();
    await vi.advanceTimersByTimeAsync(250); // half of the batch is newer than the last gfxinfo sample
    handler.onMessage({ type: 'screen', ts: deviceNow() - 300, screen: HOME });
    sendFrames(handler, 60);
    const polls = gfxinfoPolls();
    await vi.advanceTimersByTimeAsync(100);
    handler.onClose();

    const now = Date.now();
    expect(ofType('breakdown').length).toBeGreaterThanOrEqual(1); // flushed although not settled yet
    expect(ofType('screen').at(-1)?.span).toEqual({ start: now - 400, end: now, screen: HOME });
    expect(session.state.sdk).toMatchObject({ connected: false, framesActive: false, sdkVersion: '0.1.0' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(gfxinfoPolls()).toBeGreaterThan(polls);

    handler.onMessage({ type: 'screen', ts: deviceNow(), screen: PROMO }); // ignored after close
    expect(ofType('screen').at(-1)?.span.screen).toEqual(HOME);
    session.stop();
  });

  it('a newer link replaces the live one only once verified', async () => {
    const { device, session, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    const first = await connect();
    first.handler.onMessage({ type: 'screen', ts: deviceNow(), screen: HOME });

    // A spoofing newcomer does not displace the verified link.
    const spoof = new FakeLink();
    session.attachSdk({ ...HELLO, pid: 7777, sdkVersion: '9.9.9' }, spoof);
    await vi.advanceTimersByTimeAsync(0);
    expect(spoof.closedWith).toBe('no_session');
    expect(first.link.closedWith).toBeNull();

    // The app restarted: its new process connects and takes over after the check.
    device.pid = 2222;
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command.startsWith('pidof') ? { output: '2222\n', delayMs: 200 } : original(command);
    const secondLink = new FakeLink();
    const second = session.attachSdk({ ...HELLO, pid: 2222, sdkVersion: '0.2.0' }, secondLink);
    second.onMessage({ type: 'screen', ts: deviceNow(), screen: PROMO }); // pending: held back
    expect(first.link.closedWith).toBeNull();
    expect(ofType('screen').map((message) => message.span.screen)).toEqual([HOME]);
    await vi.advanceTimersByTimeAsync(250);
    expect(first.link.closedWith).toBe('none');
    // Verified: what it sent meanwhile is replayed.
    expect(ofType('screen').map((message) => message.span.screen)).toEqual([HOME, PROMO]);
    expect(session.state.sdk).toMatchObject({ connected: true, sdkVersion: '0.2.0' });
    expect(session.state.pid).toBe(2222);

    first.handler.onMessage({ type: 'screen', ts: deviceNow(), screen: null });
    first.handler.onClose();
    expect(ofType('screen').map((message) => message.span.screen)).toEqual([HOME, PROMO]);
    expect(session.state.sdk?.connected).toBe(true);
    second.onMessage({ type: 'screen', ts: deviceNow(), screen: HOME });
    expect(ofType('screen').map((message) => message.span.screen)).toEqual([HOME, PROMO, HOME]);
    session.stop();
  });

  it(`holds at most ${MAX_HELD_MESSAGES} messages of a pending link`, async () => {
    const { session, ofType } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    const handler = session.attachSdk(HELLO, new FakeLink());
    const screens = [HOME, PROMO];
    for (let i = 0; i < MAX_HELD_MESSAGES + 5; i += 1) {
      handler.onMessage({ type: 'screen', ts: deviceNow() - 500 + i, screen: screens[i % 2] ?? null });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('screen')).toHaveLength(MAX_HELD_MESSAGES);
    session.stop();
  });

  it('sums dropped frames over the session and reports them once (throttled)', async () => {
    const { session, ofType, connect } = await setup();
    const { handler } = await connect();
    const batch = (droppedFrames?: number) =>
      handler.onMessage({
        type: 'frames',
        window: 'w',
        intervalMs: 8.333,
        frames: [],
        ...(droppedFrames === undefined ? {} : { droppedFrames }),
      });
    batch();
    batch(0);
    expect(ofType('error')).toEqual([]);
    batch(2);
    batch(5);
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: droppedFramesMessage(2) },
    ]);
    expect(droppedFramesMessage(7)).toBe(
      'SDK reported 7 dropped frames (device busy); frame counts may read low',
    );
    // After the throttle window the notice repeats with the running total.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    batch(1);
    expect(ofType('error').at(-1)?.message).toBe(droppedFramesMessage(8));
    session.stop();
  });

  it('reports dropped SDK messages once (throttled)', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { session, ofType, connect } = await setup();
    const { handler } = await connect();
    handler.onMessage({ type: 'heartbeat', ts: deviceNow(), droppedMessages: 0 });
    expect(ofType('error')).toEqual([]);
    handler.onMessage({ type: 'heartbeat', ts: deviceNow(), droppedMessages: 12 });
    handler.onMessage({ type: 'heartbeat', ts: deviceNow(), droppedMessages: 40 });
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: 'SDK dropped 12 messages (device link too slow)' },
    ]);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('SDK dropped'))).toHaveLength(1);
    session.stop();
  });

  it('stopping the session closes every link (bye no_session) and the open span', async () => {
    const { session, messages, ofType, connect } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    const { link, handler } = await connect();
    handler.onMessage({ type: 'screen', ts: deviceNow(), screen: HOME });
    const pending = new FakeLink();
    session.attachSdk(HELLO, pending);
    await vi.advanceTimersByTimeAsync(400);
    const pendingAtStop = new FakeLink();
    session.attachSdk(HELLO, pendingAtStop);
    const now = Date.now();
    session.stop();
    expect(link.closedWith).toBe('none'); // replaced by the verified `pending` link
    expect(pending.closedWith).toBe('no_session');
    expect(pendingAtStop.closedWith).toBe('no_session');
    expect(ofType('screen').at(-1)?.span).toEqual({ start: now - 400, end: now, screen: HOME });
    expect(messages.at(-1)).toEqual({ type: 'session', session: session.state });
    expect(session.state.sdk).toMatchObject({ connected: false, framesActive: false });
    const count = messages.length;
    handler.onMessage({ type: 'screen', ts: deviceNow(), screen: PROMO });
    handler.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages).toHaveLength(count);
  });
});

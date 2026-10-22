import { Socket } from 'node:net';
import { MAX_SCREEN_CLIPBOARD_BYTES, SCREEN_BINARY_KIND, SCREEN_VIDEO_FLAG } from '@lionscope/protocol';
import type { ScreenClientMessage, ScreenSize } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREEN_BUFFERED_BYTES, SCREENSHOT_SKIP_BUFFERED_BYTES } from '../src/emulator/screenSession.ts';
import {
  DEVICE_ENDED_MESSAGE,
  DeviceScreenSession,
  INPUT_DENIED_MESSAGE,
  INPUT_STALLED_MESSAGE,
  STREAM_START_TIMEOUT_MS,
  VIDEO_BACKLOG_BYTES,
} from '../src/scrcpy/deviceScreenSession.ts';
import {
  backOrScreenOn,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  KEY_ACTION,
  MOTION_ACTION,
  resetVideo,
  rotateDevice,
  setClipboard,
} from '../src/scrcpy/protocol.ts';
import { resolveScrcpyJar } from '../src/scrcpy/scrcpyServer.ts';
import { FakeScreenSocket } from './helpers/fakeEmulatorClient.ts';
import {
  codecId,
  FakeScrcpyAdb,
  FakeScrcpyDevice,
  mediaPacket,
  PHYSICAL_SERIAL,
  PNG_BYTES,
  sessionPacket,
  videoMeta,
} from './helpers/fakeScrcpy.ts';

const JAR = resolveScrcpyJar();
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** `video` messages as [flags, pts, payload]. */
function videoMessages(socket: FakeScreenSocket): [number, number, string][] {
  return socket.sent
    .filter((data): data is Buffer => typeof data !== 'string' && data[0] === SCREEN_BINARY_KIND.video)
    .map((data) => [data[1] ?? -1, data.readDoubleBE(2), data.subarray(10).toString()]);
}

/** A device clipboard message. */
function deviceClipboard(text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

describe('DeviceScreenSession', () => {
  let device: FakeScrcpyDevice;
  let adb: FakeScrcpyAdb;
  let socket: FakeScreenSocket;
  const sessions: DeviceScreenSession[] = [];

  const create = (size: ScreenSize = 540) => {
    const session = new DeviceScreenSession({
      socket,
      adb,
      serial: PHYSICAL_SERIAL,
      size,
      jarPath: JAR,
    });
    sessions.push(session);
    return session;
  };
  const started = async (size: ScreenSize = 540) => {
    const session = create(size);
    await session.start();
    // The session asks for a fresh key frame as soon as it is connected.
    await device.waitFor(() => videoMessages(socket).length === 2 && device.controlBytes.length === 1);
    expect(device.controlBytes).toEqual(resetVideo());
    return session;
  };
  /** Control bytes the session writes for `action`. */
  const controlFor = async (action: () => void, expectedBytes: number) => {
    const before = device.controlBytes.length;
    action();
    await device.waitFor(() => device.controlBytes.length >= before + expectedBytes);
    await tick(5);
    return device.controlBytes.subarray(before);
  };

  beforeEach(async () => {
    device = new FakeScrcpyDevice();
    await device.start();
    adb = new FakeScrcpyAdb(device);
    socket = new FakeScreenSocket();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await device.stop();
  });

  it('sends screenInfo for each session packet and forwards packets as video messages', async () => {
    const session = await started();
    expect(adb.servers[0]?.args).toContain('max_size=1200');
    expect(socket.texts).toEqual([
      {
        type: 'screenInfo',
        serial: PHYSICAL_SERIAL,
        codec: 'h264',
        displayWidth: 1080,
        displayHeight: 2400,
        rotation: 0,
        frameWidth: 540,
        frameHeight: 1200,
      },
    ]);
    expect(videoMessages(socket)).toEqual([
      [SCREEN_VIDEO_FLAG.config, 0, 'config'],
      [SCREEN_VIDEO_FLAG.key, 1000, 'key'],
    ]);
    // The device turns: a new session packet, so a new screenInfo (rotation from the video vs display shape).
    device.video?.write(
      Buffer.concat([sessionPacket(1200, 540), mediaPacket({ pts: 2000, data: Buffer.from('d') })]),
    );
    await device.waitFor(() => videoMessages(socket).length === 3);
    expect(socket.texts.at(-1)).toMatchObject({ rotation: 90, frameWidth: 1200, frameHeight: 540 });
    expect(videoMessages(socket).at(-1)).toEqual([0, 2000, 'd']);
    expect(session.isClosed).toBe(false);
  });

  it('drops video while the socket is behind until the next key frame, asking for one, never config', async () => {
    await started();
    socket.bufferedAmount = VIDEO_BACKLOG_BYTES + 1;
    const reset = await controlFor(
      () => device.video?.write(mediaPacket({ pts: 2, data: Buffer.from('d1') })),
      1,
    );
    expect(reset).toEqual(resetVideo());
    device.video?.write(mediaPacket({ pts: 3, data: Buffer.from('d2') }));
    device.video?.write(mediaPacket({ config: true, data: Buffer.from('c2') }));
    await device.waitFor(() => videoMessages(socket).length === 3);
    socket.bufferedAmount = 0;
    device.video?.write(
      Buffer.concat([
        mediaPacket({ pts: 4, data: Buffer.from('d3') }),
        mediaPacket({ key: true, pts: 5, data: Buffer.from('k2') }),
        mediaPacket({ pts: 6, data: Buffer.from('d4') }),
      ]),
    );
    await device.waitFor(() => videoMessages(socket).length === 5);
    expect(
      videoMessages(socket)
        .slice(2)
        .map(([, , payload]) => payload),
    ).toEqual(['c2', 'k2', 'd4']);
    // The one at start, then one per KEY_FRAME_REQUEST_MS.
    expect(device.controlBytes).toEqual(Buffer.concat([resetVideo(), resetVideo()]));
  });

  it('asks for a key frame when the dashboard requests one, at most once per KEY_FRAME_REQUEST_MS', async () => {
    const session = await started();
    const reset = await controlFor(() => session.handle({ type: 'keyFrame' }), 1);
    expect(reset).toEqual(resetVideo());
    session.handle({ type: 'keyFrame' });
    await tick();
    expect(device.controlBytes).toEqual(Buffer.concat([resetVideo(), resetVideo()]));
  });

  it('never sends RESET_VIDEO before the capture runs (scrcpy 5.0.1 would crash), but sends it then', async () => {
    device.greeting = Buffer.concat([videoMeta(), codecId()]);
    const session = create();
    await session.start();
    session.handle({ type: 'keyFrame' });
    await tick(50);
    expect(device.controlBytes).toHaveLength(0);
    device.video?.write(sessionPacket(540, 1200));
    await device.waitFor(() => device.controlBytes.length === 1);
    await tick();
    expect(device.controlBytes).toEqual(resetVideo());
    // The session packet that answers the reset asks for nothing more.
    device.video?.write(sessionPacket(540, 1200));
    await tick(50);
    expect(device.controlBytes).toEqual(resetVideo());
  });

  it('terminates a socket that is hopelessly behind', async () => {
    const session = await started();
    socket.bufferedAmount = MAX_SCREEN_BUFFERED_BYTES + 1;
    device.video?.write(mediaPacket({ config: true, data: Buffer.from('c') }));
    await device.waitFor(() => socket.terminated);
    expect(session.isClosed).toBe(true);
  });

  it('injects touches in the current video frame, multi-touch, with lifts on close', async () => {
    const session = await started();
    const at = (x: number, y: number) => ({ x, y, width: 540, height: 1200 });
    const touch = (
      touches: { id: number; x: number; y: number; pressure: number }[],
    ): ScreenClientMessage => ({
      type: 'touch',
      touches,
    });
    const downs = await controlFor(
      () =>
        session.handle(
          touch([
            { id: 0, x: 0.5, y: 0.5, pressure: 1 },
            { id: 1, x: 1, y: 0, pressure: 0.5 },
          ]),
        ),
      64,
    );
    expect(downs).toEqual(
      Buffer.concat([
        injectTouch({ action: MOTION_ACTION.down, pointerId: 0n, position: at(270, 600), pressure: 1 }),
        injectTouch({ action: MOTION_ACTION.down, pointerId: 1n, position: at(539, 0), pressure: 0.5 }),
      ]),
    );
    const moveUp = await controlFor(
      () =>
        session.handle(
          touch([
            { id: 0, x: 0.25, y: 0.75, pressure: 1 },
            { id: 1, x: 1, y: 0, pressure: 0 },
            { id: 5, x: 0, y: 0, pressure: 0 },
          ]),
        ),
      64,
    );
    expect(moveUp).toEqual(
      Buffer.concat([
        injectTouch({ action: MOTION_ACTION.move, pointerId: 0n, position: at(135, 900), pressure: 1 }),
        injectTouch({ action: MOTION_ACTION.up, pointerId: 1n, position: at(539, 0), pressure: 0 }),
      ]),
    );
    const before = device.controlBytes.length;
    await session.close();
    await device.waitFor(() => device.controlBytes.length === before + 32);
    expect(device.controlBytes.subarray(before)).toEqual(
      injectTouch({ action: MOTION_ACTION.up, pointerId: 0n, position: at(135, 900), pressure: 0 }),
    );
    expect(adb.liveServers).toEqual([]);
  });

  it('turns wheel, key, text, nav and rotate messages into scrcpy messages', async () => {
    const session = await started();
    const cases: [ScreenClientMessage, Buffer][] = [
      [
        { type: 'wheel', x: 0.5, y: 0.25, dx: 60, dy: -240 },
        injectScroll({ position: { x: 270, y: 300, width: 540, height: 1200 }, hscroll: 0.5, vscroll: -2 }),
      ],
      [{ type: 'key', key: 'Enter', eventType: 'keydown' }, injectKeycode(KEY_ACTION.down, 66)],
      [{ type: 'key', key: 'Enter', eventType: 'keyup' }, injectKeycode(KEY_ACTION.up, 66)],
      [
        { type: 'key', key: 'A', eventType: 'keypress' },
        Buffer.concat([
          injectKeycode(KEY_ACTION.down, 29, 0, 0x41),
          injectKeycode(KEY_ACTION.up, 29, 0, 0x41),
        ]),
      ],
      [{ type: 'text', text: 'héllo' }, injectText('héllo')],
      [
        { type: 'nav', button: 'back' },
        Buffer.concat([backOrScreenOn(KEY_ACTION.down), backOrScreenOn(KEY_ACTION.up)]),
      ],
      [
        { type: 'nav', button: 'home' },
        Buffer.concat([injectKeycode(KEY_ACTION.down, 3), injectKeycode(KEY_ACTION.up, 3)]),
      ],
      [
        { type: 'nav', button: 'recents' },
        Buffer.concat([injectKeycode(KEY_ACTION.down, 187), injectKeycode(KEY_ACTION.up, 187)]),
      ],
      [{ type: 'rotate', direction: 'left' }, rotateDevice()],
    ];
    for (const [message, expected] of cases) {
      expect(await controlFor(() => session.handle(message), expected.length)).toEqual(expected);
    }
    // Keys without an Android equivalent are ignored.
    session.handle({ type: 'key', key: 'F13', eventType: 'keydown' });
    expect(await controlFor(() => session.handle({ type: 'nav', button: 'power' }), 28)).toEqual(
      Buffer.concat([injectKeycode(KEY_ACTION.down, 26), injectKeycode(KEY_ACTION.up, 26)]),
    );
  });

  it('shares the clipboard only while sync is on, without echoes; paste works either way', async () => {
    const session = await started();
    session.handle({ type: 'clipboard', text: 'ignored while off' });
    const paste = await controlFor(() => session.handle({ type: 'paste', text: 'pasted' }), 20);
    expect(paste).toEqual(setClipboard(0n, 'pasted', true));
    device.control?.write(deviceClipboard('copied while off'));
    await tick();
    expect(socket.texts.filter((message) => message.type === 'clipboard')).toEqual([]);

    session.handle({ type: 'clipboardSync', enabled: true });
    const copy = await controlFor(() => session.handle({ type: 'clipboard', text: 'from desktop' }), 26);
    expect(copy).toEqual(setClipboard(0n, 'from desktop', false));
    const big = 'é'.repeat(MAX_SCREEN_CLIPBOARD_BYTES);
    device.control?.write(
      Buffer.concat([
        deviceClipboard('from desktop'),
        deviceClipboard(''),
        deviceClipboard('copied on android'),
        deviceClipboard(big),
      ]),
    );
    await device.waitFor(() => socket.texts.filter((message) => message.type === 'clipboard').length === 2);
    const clipboards = socket.texts.filter((message) => message.type === 'clipboard');
    expect(clipboards[0]).toEqual({ type: 'clipboard', text: 'copied on android' });
    expect(Buffer.byteLength(String(clipboards[1]?.text))).toBe(MAX_SCREEN_CLIPBOARD_BYTES);
    session.handle({ type: 'clipboardSync', enabled: false });
    device.control?.write(deviceClipboard('after sync off'));
    await tick();
    expect(socket.texts.filter((message) => message.type === 'clipboard')).toHaveLength(2);
  });

  it('ignores control data it cannot read, but keeps mirroring', async () => {
    const session = await started();
    session.handle({ type: 'clipboardSync', enabled: true });
    device.control?.write(Buffer.from([9, 9, 9]));
    await tick();
    device.control?.write(deviceClipboard('lost'));
    await tick();
    expect(socket.texts.filter((message) => message.type === 'clipboard')).toEqual([]);
    expect(session.isClosed).toBe(false);
  });

  it('reports refused input once, without closing the socket', async () => {
    const session = await started();
    const stderr = adb.servers[0]?.child.stderr;
    stderr?.write('[server] ERROR: Injecting input events requires the caller (or the source of the ');
    stderr?.write('instrumentation, if any) to have the INJECT_EVENTS permission.\n');
    stderr?.write('[server] ERROR: ... INJECT_EVENTS permission.\n');
    await device.waitFor(() => socket.texts.some((message) => message.type === 'screenError'));
    await tick();
    expect(socket.texts.filter((message) => message.type === 'screenError')).toEqual([
      { type: 'screenError', code: 'input_denied', message: INPUT_DENIED_MESSAGE },
    ]);
    expect(socket.closedWith).toBeNull();
    expect(session.isClosed).toBe(false);
  });

  it('ends with `ended` when a streaming device stops', async () => {
    const session = await started();
    device.video?.destroy();
    await device.waitFor(() => session.isClosed);
    expect(socket.texts.at(-1)).toEqual({
      type: 'screenError',
      code: 'ended',
      message: DEVICE_ENDED_MESSAGE,
    });
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'ended' });
    await device.waitFor(() => adb.liveServers.length === 0);
  });

  it('fails with the server stderr when it stops before sending video', async () => {
    device.greeting = Buffer.concat([videoMeta(), codecId(), sessionPacket(540, 1200)]);
    const session = create();
    await session.start();
    await device.waitFor(() => socket.texts.length === 1);
    adb.servers[0]?.child.stderr.write('[server] ERROR: Encoding error: boom\n');
    await tick();
    adb.servers[0]?.child.exit(1);
    await device.waitFor(() => session.isClosed);
    expect(socket.texts.at(-1)).toEqual({
      type: 'screenError',
      code: 'mirror_failed',
      message: 'scrcpy stopped: Encoding error: boom',
    });
  });

  it('fails when the server does not stream H.264 or its stream is malformed', async () => {
    device.greeting = Buffer.concat([videoMeta(), codecId(1)]);
    const first = create();
    await first.start();
    await device.waitFor(() => first.isClosed);
    expect(socket.texts.at(-1)).toMatchObject({
      code: 'mirror_failed',
      message: 'The device sent no H.264 video',
    });

    socket = new FakeScreenSocket();
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0xffff_ffff, 8);
    device.greeting = Buffer.concat([videoMeta(), codecId(), sessionPacket(540, 1200), header]);
    const second = create();
    await second.start();
    await device.waitFor(() => second.isClosed);
    expect(socket.texts.at(-1)).toMatchObject({
      code: 'mirror_failed',
      message: 'The mirroring stream from the device could not be read',
    });
  });

  it('refuses a crafted video size and stops the server; later input is harmless', async () => {
    device.greeting = Buffer.concat([videoMeta(), codecId(), sessionPacket(70_000, 1200)]);
    const session = create();
    await session.start();
    await device.waitFor(() => session.isClosed);
    expect(socket.texts.at(-1)).toEqual({
      type: 'screenError',
      code: 'mirror_failed',
      message: 'The mirroring stream from the device could not be read',
    });
    expect(() =>
      session.handle({ type: 'touch', touches: [{ id: 0, x: 1, y: 1, pressure: 1 }] }),
    ).not.toThrow();
    await device.waitFor(() => adb.liveServers.length === 0);
  });

  it('still stops the server when lifting fingers on close throws', async () => {
    const session = await started();
    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] });
    await device.waitFor(() => device.controlBytes.length === 33);
    const write = vi.spyOn(Socket.prototype, 'write').mockImplementationOnce(() => {
      throw new RangeError('boom');
    });
    await expect(session.close()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalled();
    expect(adb.liveServers).toEqual([]);
  });

  it('ends the session when the device stops reading its input', async () => {
    const session = await started();
    device.control?.pause();
    const text = 'a'.repeat(200_000);
    for (let i = 0; i < 40 && !session.isClosed; i += 1) session.handle({ type: 'paste', text });
    expect(session.isClosed).toBe(true);
    expect(socket.texts.at(-1)).toEqual({
      type: 'screenError',
      code: 'ended',
      message: INPUT_STALLED_MESSAGE,
    });
    await device.waitFor(() => adb.liveServers.length === 0, 5000);
  });

  it('fails when no capture starts in time', async () => {
    const timers: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      if (ms === STREAM_START_TIMEOUT_MS) {
        timers.push(callback);
        return realSetTimeout(() => undefined, 0);
      }
      return realSetTimeout(callback, ms);
    }) as typeof setTimeout);
    device.greeting = Buffer.concat([videoMeta(), codecId()]);
    const session = create();
    await session.start();
    await device.waitFor(() => timers.length === 1);
    timers[0]?.();
    expect(session.isClosed).toBe(true);
    expect(socket.texts.at(-1)).toMatchObject({ code: 'mirror_failed', message: 'The device sent no video' });
  });

  it('fails when the display size or the server cannot be had', async () => {
    adb.wmSize = 'nothing useful';
    const first = create();
    await first.start();
    expect(socket.texts.at(-1)).toMatchObject({
      code: 'mirror_failed',
      message: 'Could not read the display size of the device',
    });
    socket = new FakeScreenSocket();
    adb.fail = (args) => (args[3] === 'wm size' ? new Error('device offline') : null);
    await create().start();
    expect(socket.texts.at(-1)).toMatchObject({ code: 'mirror_failed' });
    socket = new FakeScreenSocket();
    adb.wmSize = 'Physical size: 1080x2400\n';
    adb.fail = (args) => (args[2] === 'push' ? new Error('read-only') : null);
    await create().start();
    expect(socket.texts.at(-1)).toMatchObject({
      code: 'mirror_failed',
      message: 'Could not copy the mirroring server (scrcpy) to the device',
    });
  });

  it('restarts the server with the new max_size on setSize, lifting fingers first', async () => {
    const session = await started();
    session.handle({ type: 'touch', touches: [{ id: 2, x: 0, y: 0, pressure: 1 }] });
    await device.waitFor(() => device.controlBytes.length === 33);
    session.handle({ type: 'setSize', size: 540 });
    device.greeting = Buffer.concat([
      videoMeta(),
      codecId(),
      sessionPacket(360, 800),
      mediaPacket({ config: true, data: Buffer.from('c') }),
    ]);
    session.handle({ type: 'setSize', size: 360 });
    await device.waitFor(() => adb.servers.length === 2 && socket.texts.length === 2);
    // The new server is asked for a key frame too.
    await device.waitFor(() => device.controlBytes.length === 66);
    expect(device.controlBytes.subarray(65)).toEqual(resetVideo());
    expect(device.controlBytes.subarray(33, 65)).toEqual(
      injectTouch({
        action: MOTION_ACTION.up,
        pointerId: 2n,
        position: { x: 0, y: 0, width: 540, height: 1200 },
        pressure: 0,
      }),
    );
    expect(adb.servers[0]?.child.exited).toBe(true);
    expect(adb.servers[1]?.args).toContain('max_size=800');
    expect(socket.texts.at(-1)).toMatchObject({ frameWidth: 360, frameHeight: 800 });
    await device.waitFor(() => videoMessages(socket).length === 3);
  });

  it('answers screenshot with the screencap PNG, one at a time', async () => {
    const session = await started();
    session.handle({ type: 'screenshot' });
    session.handle({ type: 'screenshot' });
    await device.waitFor(() => socket.binaries.some(([kind]) => kind === SCREEN_BINARY_KIND.screenshot));
    await tick();
    const shots = socket.sent.filter(
      (data): data is Buffer => typeof data !== 'string' && data[0] === SCREEN_BINARY_KIND.screenshot,
    );
    expect(shots.map((data) => data.subarray(1))).toEqual([PNG_BYTES]);
    expect(adb.execCalls.some((args) => args.includes('screencap'))).toBe(false);

    adb.screencap = Buffer.from('error: no display');
    session.handle({ type: 'screenshot' });
    await tick(50);
    socket.bufferedAmount = SCREENSHOT_SKIP_BUFFERED_BYTES + 1;
    session.handle({ type: 'screenshot' });
    await tick(50);
    expect(
      socket.sent.filter((data) => typeof data !== 'string' && data[0] === SCREEN_BINARY_KIND.screenshot),
    ).toHaveLength(1);
  });

  it('ignores input before the first frame size, and everything after close', async () => {
    device.greeting = Buffer.concat([videoMeta(), codecId()]);
    const session = create();
    await session.start();
    session.handle({ type: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, pressure: 1 }] });
    session.handle({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
    await tick();
    expect(device.controlBytes).toHaveLength(0);
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await closing;
    session.handle({ type: 'nav', button: 'home' });
    session.fail('ended', 'late');
    expect(socket.texts).toEqual([]);
  });

  it('closes during start without leaving a server behind', async () => {
    device.refuseAll = true;
    const session = create();
    const starting = session.start();
    await device.waitFor(() => adb.servers.length === 1);
    await session.close();
    await starting;
    expect(adb.liveServers).toEqual([]);
    expect(socket.texts).toEqual([]);
  });
});

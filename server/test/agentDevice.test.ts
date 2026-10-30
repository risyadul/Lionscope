import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { describeArgs } from '../src/adb/adb.ts';
import { AGENT_KEYCODES, inputTextArgument, parseResolvedActivity } from '../src/agent/deviceTools.ts';
import { decodePng, fitShortEdge, pngSize, scalePng, screenStats } from '../src/agent/png.ts';
import type { DecodedPng } from '../src/agent/png.ts';
import { callTool } from '../src/agent/registry.ts';
import { fakeAgent, PKG } from './helpers/agentFixtures.ts';
import { FakeAdb, FakeChild } from './helpers/fakes.ts';

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** An RGBA PNG of `pixels`, row y filtered with filter type y % 5 (exercises every filter). */
function rgbaPng(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const row = Buffer.alloc(stride + 1);
    row[0] = filter;
    for (let x = 0; x < stride; x++) {
      const value = pixels[y * stride + x] ?? 0;
      const a = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const c = y > 0 && x >= 4 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      row[x + 1] = (value - predicted) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Deterministic noisy RGBA pixels (opaque). */
function noise(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 255 : (i * 37 + (i >> 5) * 11) & 0xff;
  return pixels;
}

describe('PNG scaling', () => {
  it('decodes every filter type exactly', () => {
    const pixels = noise(7, 10);
    expect(decodePng(rgbaPng(7, 10, pixels))).toEqual({ width: 7, height: 10, channels: 4, pixels });
  });

  it('fits the short edge, never upscaling', () => {
    expect(fitShortEdge({ width: 1080, height: 2424 }, 720)).toEqual({ width: 720, height: 1616 });
    expect(fitShortEdge({ width: 2424, height: 1080 }, 720)).toEqual({ width: 1616, height: 720 });
    expect(fitShortEdge({ width: 600, height: 900 }, 720)).toEqual({ width: 600, height: 900 });
  });

  it('box-averages down to an RGB PNG of the fitted size', () => {
    // Left half black, right half white: halving keeps the edge crisp.
    const width = 8;
    const height = 4;
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const white = i % width >= width / 2 ? 255 : 0;
      pixels.fill(white, i * 4, i * 4 + 3);
      pixels[i * 4 + 3] = 255;
    }
    const { png, size } = scalePng(rgbaPng(width, height, pixels), 2);
    expect(size).toEqual({ width: 4, height: 2 });
    expect(pngSize(png)).toEqual(size);
    const decoded = decodePng(png);
    expect(decoded?.channels).toBe(3);
    expect([...(decoded?.pixels ?? [])]).toEqual([
      0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
  });

  it('passes small screenshots through untouched', () => {
    const png = rgbaPng(4, 4, noise(4, 4));
    expect(scalePng(png, 720).png).toBe(png);
  });
});

describe('screen stats', () => {
  /** An opaque RGBA image, colour by pixel. */
  function image(width: number, height: number, color: (x: number, y: number) => number[]): DecodedPng {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) pixels.set([...color(x, y), 255], (y * width + x) * 4);
    }
    return { width, height, channels: 4, pixels };
  }

  it('calls a black screen with a strip of status bar icons blank', () => {
    // Half of the top 1% white (icons in the status bar), the rest black.
    const stats = screenStats(
      image(1080, 2400, (x, y) => (y < 24 && x % 8 < 4 ? [255, 255, 255] : [0, 0, 0])),
    );
    expect(stats).toEqual({ meanLuminance: 0.005, nonBlackRatio: 0.005, dominantRatio: 0.995, blank: true });
  });

  it('counts video black and noise as black and as one colour', () => {
    const stats = screenStats(image(400, 800, (x, y) => [16 + ((x + y) % 3), 16, 17]));
    expect(stats).toMatchObject({ nonBlackRatio: 0, dominantRatio: 1, blank: true });
    expect(stats.meanLuminance).toBeCloseTo(16.5 / 255, 2);
  });

  it('counts black and video black as one colour, also across a 4-bit boundary', () => {
    // Grey noise 14..17 (straddles 15 / 16), black bars at 0 around a video area at 16, #121212 under a #000 bar.
    const noisy = screenStats(image(1080, 2400, (x, y) => Array(3).fill(14 + ((x * 7 + y * 13) % 4))));
    expect(noisy).toMatchObject({ nonBlackRatio: 0, dominantRatio: 1, blank: true });
    const letterbox = screenStats(image(1080, 2400, (_x, y) => Array(3).fill(y < 800 || y >= 1600 ? 0 : 16)));
    expect(letterbox).toMatchObject({ dominantRatio: 1, blank: true });
    const dark = screenStats(image(1080, 2400, (_x, y) => Array(3).fill(y < 80 ? 0 : 0x12)));
    expect(dark).toMatchObject({ dominantRatio: 1, blank: true });
  });

  it('is not fooled by patterns in phase with its sampling grid', () => {
    // At 1080×2400 a fixed grid would sample every 4th pixel at one phase.
    const checkerboard = screenStats(image(1080, 2400, (x, y) => Array(3).fill((x + y) % 2 === 0 ? 255 : 0)));
    expect(checkerboard.nonBlackRatio).toBeCloseTo(0.5, 1);
    expect(checkerboard.blank).toBe(false);
    const stripes = screenStats(image(1080, 2400, (_x, y) => Array(3).fill(y % 4 === 2 ? 255 : 0)));
    expect(stripes.nonBlackRatio).toBeCloseTo(0.25, 1);
    expect(stripes.blank).toBe(false);
  });

  it('decides blank on the dominantRatio it reports', () => {
    // 100×100 is sampled whole: 9796 of 10000 pixels black reads 0.98, and blank must agree.
    const stats = screenStats(image(100, 100, (x, y) => (y * 100 + x < 9796 ? [0, 0, 0] : [255, 255, 255])));
    expect(stats).toMatchObject({ dominantRatio: 0.98, blank: true });
  });

  it('does not call a split or busy screen blank, but does a white one', () => {
    expect(screenStats(image(400, 800, (x) => (x < 200 ? [0, 0, 0] : [255, 255, 255])))).toEqual({
      meanLuminance: 0.5,
      nonBlackRatio: 0.5,
      dominantRatio: 0.5,
      blank: false,
    });
    expect(screenStats(image(400, 800, () => [255, 255, 255]))).toMatchObject({
      meanLuminance: 1,
      blank: true,
    });
    // A white page with 3% text pixels.
    const text = screenStats(
      image(400, 800, (x, y) => (y % 10 === 0 && x % 10 < 3 ? [0, 0, 0] : [250, 250, 250])),
    );
    expect(text).toMatchObject({ dominantRatio: 0.97, blank: false });
    expect(screenStats(decodePng(rgbaPng(64, 64, noise(64, 64))) as DecodedPng).blank).toBe(false);
  });
});

describe('device tools', () => {
  /**
   * adb whose `exec-out screencap -p` answers with a 1080×2400 PNG and whose `wm size` / `dumpsys input` report
   * `display` (rotate it to turn the device); other shell commands go to `shellReply` and are recorded.
   */
  function deviceAgent(
    shellReply: (command: string) => string = () => '',
    screenshot = rgbaPng(1080, 2400, Buffer.alloc(1080 * 2400 * 4, 200)),
  ) {
    const display = { orientation: 0 };
    const adb = new FakeAdb((args) => {
      const command = String(args.at(-1));
      if (command.startsWith('wm size;')) {
        return `Physical size: 1080x2400\n__LIONSCOPE_ROTATION__\n  Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=${display.orientation}, logicalFrame=[0, 0, 1080, 2400]\n`;
      }
      return shellReply(command);
    });
    adb.spawn = () => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write(screenshot);
        child.exit(0);
      });
      return child;
    };
    return { agent: fakeAgent({}, { adb }), adb, display };
  }
  /** Shell commands other than the display-size probes. */
  const shellCommands = (adb: FakeAdb) =>
    adb.execCalls.map((args) => args.join(' ')).filter((command) => !command.includes('shell wm size;'));

  it('screenshots at 720 px and maps taps and swipes back to device pixels', async () => {
    const { agent, adb } = deviceAgent();
    const shot = await callTool(agent.ctx, 'screenshot', {}, true);
    expect(shot).toMatchObject({
      ok: true,
      result: {
        serial: 'emulator-5554',
        width: 720,
        height: 1600,
        deviceWidth: 1080,
        deviceHeight: 2400,
        meanLuminance: 0.784,
        nonBlackRatio: 1,
        dominantRatio: 1,
        blank: true,
      },
      image: { mimeType: 'image/png' },
    });
    expect(await callTool(agent.ctx, 'tap', { x: 360, y: 800 }, true)).toMatchObject({ ok: true });
    await callTool(agent.ctx, 'swipe', { x1: 360, y1: 1400, x2: 360, y2: 400, durationMs: 250 }, true);
    expect(shellCommands(adb)).toEqual([
      '-s emulator-5554 shell input tap 540 1200',
      '-s emulator-5554 shell input swipe 540 2100 540 600 250',
    ]);
    expect(await callTool(agent.ctx, 'tap', { x: 900, y: 10 }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('outside'),
    });
  });

  it('returns the image without stats when the capture cannot be decoded', async () => {
    /** A 2×2 PNG with the given IHDR bit depth / color type and one raw row filter byte per row. */
    const png = (bitDepth: number, colorType: number, filter: number) => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(2, 0);
      ihdr.writeUInt32BE(2, 4);
      ihdr[8] = bitDepth;
      ihdr[9] = colorType;
      const row = Buffer.alloc(1 + 2 * 4 * (bitDepth / 8));
      row[0] = filter;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    };
    const noStats = { meanLuminance: null, nonBlackRatio: null, dominantRatio: null, blank: null };
    // 16-bit samples (decodePng doesn't handle them), and a damaged one (filter type 7 does not exist).
    for (const capture of [png(16, 6, 0), png(8, 6, 7)]) {
      const { agent } = deviceAgent(() => '', capture);
      const shot = await callTool(agent.ctx, 'screenshot', {}, true);
      expect(shot).toMatchObject({ ok: true, result: { width: 2, height: 2, ...noStats } });
      expect(shot.ok && shot.image?.data).toBe(capture.toString('base64'));
    }
  });

  it('refuses a screenshot taken before the screen rotated, and maps onto the rotated screen', async () => {
    const { agent, adb, display } = deviceAgent();
    await callTool(agent.ctx, 'screenshot', {}, true);
    display.orientation = 1;
    expect(await callTool(agent.ctx, 'tap', { x: 10, y: 10 }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('rotated'),
    });
    // Portrait coordinates on a landscape screen don't fit either.
    expect(await callTool(agent.ctx, 'tap', { x: 1, y: 1, width: 720, height: 1600 }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not match the screen'),
    });
    await callTool(agent.ctx, 'tap', { x: 800, y: 360, width: 1600, height: 720 }, true);
    expect(shellCommands(adb).at(-1)).toBe('-s emulator-5554 shell input tap 1200 540');
  });

  it('needs a screenshot or an explicit coordinate space for a tap', async () => {
    const { agent, adb } = deviceAgent();
    expect(await callTool(agent.ctx, 'tap', { x: 1, y: 1 }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('screenshot first'),
    });
    await callTool(agent.ctx, 'tap', { x: 50, y: 50, width: 450, height: 1000 }, true);
    expect(shellCommands(adb)).toEqual(['-s emulator-5554 shell input tap 120 120']);
  });

  it('types quoted text and presses only navigation keys', async () => {
    const { agent, adb } = deviceAgent();
    await callTool(agent.ctx, 'type_text', { text: "it's 5 $HOME" }, true);
    await callTool(agent.ctx, 'press_key', { key: 'back' }, true);
    // type_text also reads the field back with a UI dump.
    expect(shellCommands(adb).filter((command) => command.includes(' shell input '))).toEqual([
      `-s emulator-5554 shell input text 'it'\\''s%s5%s$HOME'`,
      '-s emulator-5554 shell input keyevent 4',
    ]);
    expect(inputTextArgument('a b')).toBe("'a%sb'");
    expect(Object.keys(AGENT_KEYCODES)).not.toEqual(expect.arrayContaining(['power']));
    expect(Object.values(AGENT_KEYCODES)).not.toContain(26); // KEYCODE_POWER
    for (const args of [{ key: 'power' }, { key: 'sleep' }]) {
      expect(await callTool(agent.ctx, 'press_key', args, true)).toMatchObject({ code: 'invalid_arguments' });
    }
    for (const text of ['naïve', '100%sure']) {
      expect(await callTool(agent.ctx, 'type_text', { text }, true)).toMatchObject({
        code: 'invalid_arguments',
      });
    }
  });

  it('never puts typed text into an error or a log line', async () => {
    const { agent, adb } = deviceAgent();
    adb.execHandler = () => {
      throw new Error("adb -s emulator-5554 shell input text 'hunter2' failed: device offline");
    };
    const outcome = await callTool(agent.ctx, 'type_text', { text: 'hunter2' }, true);
    expect(outcome).toEqual({ ok: false, code: 'failed', error: 'Typing on emulator-5554 failed' });
    expect(describeArgs(['-s', 'emulator-5554', 'shell', "input text 'hunter2'"])).toBe(
      '-s emulator-5554 shell input text <redacted>',
    );
  });

  it('force-stops a package without starting it, and refuses a malformed package name', async () => {
    const { agent, adb } = deviceAgent((command) =>
      command.startsWith('pm path') && command.includes(PKG) ? 'package:/data/app/base.apk\n' : '',
    );
    expect(await callTool(agent.ctx, 'stop_app', { packageName: PKG }, true)).toMatchObject({
      ok: true,
      result: { serial: 'emulator-5554', packageName: PKG, stopped: true },
    });
    expect(shellCommands(adb)).toEqual([
      `-s emulator-5554 shell pm path ${PKG} || true`,
      `-s emulator-5554 shell am force-stop ${PKG}`,
    ]);
    expect(await callTool(agent.ctx, 'stop_app', { packageName: 'com.example.typo' }, true)).toMatchObject({
      ok: false,
      error: 'com.example.typo is not installed on emulator-5554',
    });
    expect(shellCommands(adb).filter((command) => command.includes('force-stop'))).toHaveLength(1);
    const { agent: erroring } = deviceAgent((command) =>
      command.startsWith('pm path') ? 'Error: could not find package: com.example.shop\n' : '',
    );
    expect(await callTool(erroring.ctx, 'stop_app', { packageName: PKG }, true)).toMatchObject({ ok: false });
    expect(
      await callTool(agent.ctx, 'stop_app', { packageName: 'com.example.shop; reboot' }, true),
    ).toMatchObject({
      ok: false,
    });
    expect(await callTool(agent.ctx, 'stop_app', { packageName: PKG }, false)).toMatchObject({ ok: false });
    expect(shellCommands(adb)).toHaveLength(3);
  });

  it('launches the resolved launcher activity, cold on request, and reports a missing launcher', async () => {
    const { agent, adb } = deviceAgent((command) => {
      if (command.startsWith('cmd package resolve-activity')) {
        return command.endsWith(PKG)
          ? 'priority=0 preferredOrder=0\ncom.example.shop/.MainActivity\n'
          : 'No activity found\n';
      }
      if (command.startsWith('am start'))
        return 'Starting: Intent { cmp=com.example.shop/.MainActivity }\nStatus: ok\nTotalTime: 812\n';
      return '';
    });
    expect(await callTool(agent.ctx, 'launch_app', { packageName: PKG, cold: true }, true)).toMatchObject({
      ok: true,
      result: { activity: 'com.example.shop/.MainActivity', launchMs: 812, cold: true },
    });
    expect(shellCommands(adb)).toEqual([
      `-s emulator-5554 shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${PKG}`,
      `-s emulator-5554 shell am force-stop ${PKG}`,
      `-s emulator-5554 shell am start -W -n 'com.example.shop/.MainActivity'`,
    ]);
    expect(
      await callTool(agent.ctx, 'launch_app', { packageName: 'com.example.missing' }, true),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('no launcher activity'),
    });
    expect(parseResolvedActivity('com.evil.app/.Main', PKG)).toBeNull();
    expect(parseResolvedActivity("com.example.shop/.Main'; reboot", PKG)).toBeNull();
  });

  it('refuses devices that are not ready', async () => {
    const { agent } = deviceAgent();
    expect(await callTool(agent.ctx, 'press_key', { key: 'home', serial: 'R58M123ABC' }, true)).toMatchObject(
      {
        ok: false,
        error: 'Device R58M123ABC is unauthorized',
      },
    );
  });

  it('boots and shuts down emulators; a repeated shutdown changes nothing unless forced', async () => {
    const { agent } = deviceAgent();
    const calls: unknown[] = [];
    let state: 'running' | 'shutting_down' | 'off' = 'running';
    agent.ctx.emulators.getEmulators = () => [
      {
        avdName: 'Pixel_9',
        displayName: null,
        state,
        serial: null,
        managed: true,
        canMirror: false,
        renderer: 'host',
      },
    ];
    agent.ctx.emulators.boot = async (...args) => void calls.push(['boot', ...args]);
    agent.ctx.emulators.shutdown = async (...args) => {
      calls.push(['shutdown', ...args]);
      state = 'shutting_down';
    };
    await callTool(agent.ctx, 'boot_emulator', { avdName: 'Pixel_9' }, true);
    expect(await callTool(agent.ctx, 'shutdown_emulator', { avdName: 'Pixel_9' }, true)).toMatchObject({
      result: { changed: true },
    });
    expect(await callTool(agent.ctx, 'shutdown_emulator', { avdName: 'Pixel_9' }, true)).toMatchObject({
      result: { changed: false, emulator: { state: 'shutting_down' } },
    });
    await callTool(agent.ctx, 'shutdown_emulator', { avdName: 'Pixel_9', force: true }, true);
    state = 'off';
    expect(
      await callTool(agent.ctx, 'shutdown_emulator', { avdName: 'Pixel_9', force: true }, true),
    ).toMatchObject({
      result: { changed: false },
    });
    expect(calls).toEqual([
      ['boot', 'Pixel_9', 'quick'],
      ['shutdown', 'Pixel_9', false],
      ['shutdown', 'Pixel_9', false],
    ]);
    expect(await callTool(agent.ctx, 'boot_emulator', { avdName: '-wipe-data' }, true)).toMatchObject({
      code: 'invalid_arguments',
    });
  });

  it('answers busy when two device actions already run on the device', async () => {
    const { agent } = deviceAgent();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    agent.ctx.emulators.boot = () => held;
    const first = callTool(agent.ctx, 'boot_emulator', { avdName: 'Pixel_9' }, true);
    const second = callTool(agent.ctx, 'boot_emulator', { avdName: 'Pixel_9' }, true);
    expect(await callTool(agent.ctx, 'boot_emulator', { avdName: 'Pixel_9' }, true)).toMatchObject({
      ok: false,
      code: 'busy',
    });
    release();
    await Promise.all([first, second]);
    expect(agent.ctx.deviceCalls.size).toBe(0);
  });
});

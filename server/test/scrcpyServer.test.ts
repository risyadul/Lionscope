import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { androidKey, META_SHIFT, NAV_KEYCODES } from '../src/scrcpy/keycodes.ts';
import {
  DEVICE_JAR_PATH,
  maxSizeFor,
  MAX_ERROR_SUMMARY_CHARS,
  MirrorStartError,
  parseWmSize,
  randomScid,
  readVerifiedJar,
  cleanupScrcpyLeftovers,
  LIST_LEFTOVERS_COMMAND,
  parseScrcpyForwards,
  parseScrcpyProcesses,
  resolveScrcpyJar,
  ScrcpyServer,
  scrcpyServerArgs,
  SCRCPY_JAR_NAME,
  SCRCPY_JAR_SHA256,
  STOP_GRACE_MS,
  summarizeStderr,
} from '../src/scrcpy/scrcpyServer.ts';
import { FakeAdb } from './helpers/fakes.ts';
import { FakeScrcpyAdb, FakeScrcpyDevice, PHYSICAL_SERIAL } from './helpers/fakeScrcpy.ts';

const JAR = resolveScrcpyJar();

describe('scrcpy jar', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lionscope-jar-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves to server/vendor from source and next to the bundle in the npm package', () => {
    expect(JAR.endsWith(path.join('server', 'vendor', SCRCPY_JAR_NAME))).toBe(true);
    const bundle = pathToFileURL(path.join(dir, 'dist', 'lionscope.mjs')).href;
    expect(resolveScrcpyJar(bundle, true)).toBe(path.join(dir, 'dist', SCRCPY_JAR_NAME));
  });

  it('accepts the vendored jar, whose built-in checksum matches the vendored .sha256 line', async () => {
    const jar = await readVerifiedJar(JAR);
    expect(jar).toEqual(readFileSync(JAR));
    expect(readFileSync(`${JAR}.sha256`, 'utf8')).toBe(`${SCRCPY_JAR_SHA256}  ${SCRCPY_JAR_NAME}\n`);
  });

  it('refuses a changed or missing jar, whatever file sits next to it', async () => {
    const fake = path.join(dir, SCRCPY_JAR_NAME);
    writeFileSync(fake, 'not the jar');
    const digest = createHash('sha256').update('not the jar').digest('hex');
    writeFileSync(`${fake}.sha256`, `${digest}  ${SCRCPY_JAR_NAME}\n`);
    await expect(readVerifiedJar(fake)).rejects.toThrow(/does not match its SHA-256/);
    await expect(readVerifiedJar(fake, digest)).resolves.toEqual(Buffer.from('not the jar'));
    await expect(readVerifiedJar(path.join(dir, 'missing'))).rejects.toThrow(/is missing/);
  });
});

describe('scrcpy server options', () => {
  it('builds the shell arguments from presets only', () => {
    expect(scrcpyServerArgs('0a1b2c3d', 1200)).toEqual([
      `CLASSPATH=${DEVICE_JAR_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      '5.0.1',
      'scid=0a1b2c3d',
      'log_level=info',
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'video_codec=h264',
      'max_size=1200',
      'max_fps=60',
      'video_codec_options=i-frame-interval:int=2',
      'clipboard_autosync=true',
      'stay_awake=true',
      'cleanup=true',
    ]);
    for (const [scid, maxSize] of [
      ['0a1b2c3d;reboot', 1200],
      ['ABCDEF01', 1200],
      ['0a1b2c3d', 1.5],
      ['0a1b2c3d', -1],
      ['0a1b2c3d', 70_000],
    ] as const) {
      expect(() => scrcpyServerArgs(scid, maxSize)).toThrow();
    }
  });

  it('generates 31-bit hex scids', () => {
    for (let i = 0; i < 50; i += 1) {
      const scid = randomScid();
      expect(scid).toMatch(/^[0-7][0-9a-f]{7}$/);
    }
  });

  it('reads wm size, preferring the override size', () => {
    expect(parseWmSize('Physical size: 1220x2712\n')).toEqual({ width: 1220, height: 2712 });
    expect(parseWmSize('Physical size: 1440x3200\r\nOverride size: 1080x2400\r\n')).toEqual({
      width: 1080,
      height: 2400,
    });
    expect(parseWmSize('')).toBeNull();
    expect(parseWmSize('Physical size: 0x2400\n')).toBeNull();
  });

  it('turns the short-edge preset into max_size, never above the display', () => {
    expect(maxSizeFor({ width: 1220, height: 2712 }, 540)).toBe(1200);
    expect(maxSizeFor({ width: 1080, height: 2400 }, 360)).toBe(800);
    expect(maxSizeFor({ width: 2400, height: 1080 }, 720)).toBe(1600);
    expect(maxSizeFor({ width: 720, height: 1280 }, 720)).toBe(1280);
    expect(maxSizeFor({ width: 480, height: 800 }, 720)).toBe(800);
  });

  it('summarizes stderr: ERROR lines, sanitised and capped, else the last line', () => {
    expect(
      summarizeStderr(
        '[server] INFO: Device: x\n[server] ERROR: Could not open video\njava.lang.Exception: boom\n\tat x.y\n' +
          '[server] ERROR: Encoder\u0007 failed​\n',
      ),
    ).toBe('Could not open video: java.lang.Exception: boom Encoder failed');
    // The exception after an ERROR line (as in the live NullPointerException) is part of the summary.
    expect(
      summarizeStderr(
        '[server] ERROR: Exception on thread Thread[control-recv,5,main]\n' +
          "java.lang.NullPointerException: Attempt to invoke virtual method 'void x.reset(int)'\n\tat a.b(C.java:1)\n",
      ),
    ).toBe(
      "Exception on thread Thread[control-recv,5,main]: java.lang.NullPointerException: Attempt to invoke virtual method 'void x.reset(int)'",
    );
    expect(summarizeStderr('Aborted\n\n')).toBe('Aborted');
    expect(summarizeStderr('\n')).toBeNull();
    const long = summarizeStderr(`[server] ERROR: ${'x'.repeat(1000)}`) ?? '';
    expect(long).toHaveLength(MAX_ERROR_SUMMARY_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('scrcpy keycodes', () => {
  it('maps the named W3C keys, letters and digits', () => {
    expect(
      [
        'Enter',
        'Backspace',
        'Delete',
        'Tab',
        'Escape',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ].map((key) => androidKey(key)?.keycode),
    ).toEqual([66, 67, 112, 61, 111, 19, 20, 21, 22]);
    expect(
      ['Home', 'End', 'PageUp', 'PageDown', 'Insert', ' '].map((key) => androidKey(key)?.keycode),
    ).toEqual([122, 123, 92, 93, 124, 62]);
    expect(androidKey('a')).toEqual({ keycode: 29, metaState: 0 });
    expect(androidKey('z')).toEqual({ keycode: 54, metaState: 0 });
    expect(androidKey('Q')).toEqual({ keycode: 45, metaState: META_SHIFT });
    expect(androidKey('0')).toEqual({ keycode: 7, metaState: 0 });
    expect(androidKey('9')).toEqual({ keycode: 16, metaState: 0 });
    expect(androidKey('GoHome')?.keycode).toBe(3);
    for (const key of ['F13', 'é', 'aa', '', 'constructor', 'toString']) expect(androidKey(key)).toBeNull();
  });

  it('maps the navigation buttons', () => {
    expect(NAV_KEYCODES).toEqual({ home: 3, recents: 187, power: 26 });
  });
});

describe('ScrcpyServer', () => {
  let device: FakeScrcpyDevice;
  let adb: FakeScrcpyAdb;
  const servers: ScrcpyServer[] = [];

  const create = (options: Partial<ConstructorParameters<typeof ScrcpyServer>[0]> = {}) => {
    const server = new ScrcpyServer({
      adb,
      serial: PHYSICAL_SERIAL,
      maxSize: 1200,
      jarPath: JAR,
      ...options,
    });
    servers.push(server);
    return server;
  };
  const forwards = () =>
    adb.execCalls.filter((args) => args[2] === 'forward').map((args) => args.slice(3).join(' '));

  beforeEach(async () => {
    device = new FakeScrcpyDevice();
    await device.start();
    adb = new FakeScrcpyAdb(device);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await device.stop();
  });

  it('pushes, forwards, starts the server and connects video (after retries) then control', async () => {
    device.refuse = 2;
    const server = create();
    const connection = await server.start();
    // The verified bytes went out from a private copy, removed afterwards.
    const pushed = adb.pushes[0]?.args ?? [];
    expect(pushed).toEqual([
      '-s',
      PHYSICAL_SERIAL,
      'push',
      expect.stringContaining('lionscope-scrcpy-'),
      DEVICE_JAR_PATH,
    ]);
    expect(adb.pushed).toEqual([readFileSync(JAR)]);
    expect(existsSync(String(pushed[3]))).toBe(false);
    expect(forwards()).toEqual([`tcp:0 localabstract:scrcpy_${server.scid}`, `--remove tcp:${device.port}`]);
    expect(adb.servers[0]?.args).toEqual([
      '-s',
      PHYSICAL_SERIAL,
      'shell',
      ...scrcpyServerArgs(server.scid, 1200),
    ]);
    // Two refused attempts, video, control.
    await device.waitFor(() => device.connections === 4);
    // The greeting after the dummy byte arrives through `leftover` and the paused video socket.
    const received: Buffer[] = [connection.leftover];
    connection.video.on('data', (chunk: Buffer) => received.push(chunk));
    connection.video.resume();
    await device.waitFor(() => Buffer.concat(received).length === device.greeting.length);
    expect(Buffer.concat(received)).toEqual(device.greeting);
    connection.control.write(Buffer.from([11]));
    await device.waitFor(() => device.controlBytes.length === 1);
  });

  it('stops by closing the sockets; a server that exits by itself is not killed', async () => {
    const server = create();
    await server.start();
    await server.stop();
    expect(adb.servers[0]?.child.exited).toBe(true);
    expect(adb.servers[0]?.child.killed).toBe(false);
    expect(adb.pkills).toEqual([]);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('kills a connected server that does not exit, also on the device by its scid', async () => {
    adb.exitsWithSockets = false;
    const server = create();
    await server.start();
    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
    expect(adb.servers[0]?.child.killed).toBe(true);
    expect(adb.pkills).toEqual([`pkill -f 'scid=[${server.scid[0]}]${server.scid.slice(1)}'`]);
  });

  it('treats a failed adb process like an exit, and survives failing cleanup commands', async () => {
    device.refuseAll = true;
    adb.fail = (args) =>
      args[3] === '--remove' || args[3]?.startsWith('pkill') ? new Error('device gone') : null;
    const exits: number[] = [];
    const server = create({ onExit: () => exits.push(1) });
    const starting = server.start();
    await device.waitFor(() => adb.servers.length === 1);
    adb.servers[0]?.child.emit('error', new Error('spawn EPIPE'));
    await expect(starting).rejects.toThrow('scrcpy did not start on the device');
    expect(exits).toEqual([1]);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('reports the server stderr when it exits before connecting', async () => {
    device.refuseAll = true;
    const exits: number[] = [];
    const server = create({ onExit: () => exits.push(1) });
    const starting = server.start();
    await device.waitFor(() => adb.servers.length === 1);
    const child = adb.servers[0]?.child;
    child?.stderr.write('[server] ERROR: Could not create the encoder\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    child?.exit(1);
    await expect(starting).rejects.toThrow('scrcpy could not start: Could not create the encoder');
    expect(exits).toEqual([1]);
    expect(server.errorSummary).toBe('Could not create the encoder');
    await server.stop();
    expect(forwards().at(-1)).toBe(`--remove tcp:${device.port}`);
    expect(adb.pkills).toEqual([]);
  });

  it('cleans up a stop() during start: forward removed, process killed on the device', async () => {
    device.refuseAll = true;
    const server = create();
    const starting = server.start();
    await device.waitFor(() => device.connections >= 2);
    await server.stop();
    await expect(starting).rejects.toThrow(MirrorStartError);
    expect(adb.servers[0]?.child.killed).toBe(true);
    expect(adb.pkills).toHaveLength(1);
    expect(forwards().at(-1)).toBe(`--remove tcp:${device.port}`);
  });

  it('aborts a push in flight on stop()', async () => {
    adb.pushHangs = true;
    const server = create();
    const starting = server.start();
    await device.waitFor(() => adb.pushes.length === 1);
    const stopped = Date.now();
    await server.stop();
    await expect(starting).rejects.toThrow('Could not copy the mirroring server');
    expect(Date.now() - stopped).toBeLessThan(1000);
    expect(adb.pushes[0]?.child.killed).toBe(true);
    expect(adb.servers).toEqual([]);
  });

  it('never spawns after a stop() that came first', async () => {
    const server = create();
    await server.stop();
    await expect(server.start()).rejects.toThrow('mirroring stopped');
    expect(adb.execCalls).toEqual([]);
    expect(server.isStopped).toBe(true);
  });

  it('fails with a dashboard-safe message when push or forward fail', async () => {
    adb.fail = (args) => (args[2] === 'push' ? new Error(`adb push ${JAR} failed`) : null);
    await expect(create().start()).rejects.toThrow(
      'Could not copy the mirroring server (scrcpy) to the device',
    );
    adb.fail = (args) => (args[2] === 'forward' && args[3] === 'tcp:0' ? new Error('no') : null);
    await expect(create().start()).rejects.toThrow('adb forward failed');
    adb.fail = () => null;
    adb.execHandler = (args) => (args[2] === 'forward' && args[3] === 'tcp:0' ? 'error: closed\n' : '');
    await expect(create().start()).rejects.toThrow('adb forward failed');
    expect(adb.servers).toHaveLength(0);
  });

  it('serialises starts on one device: the next push waits until the previous server is connected', async () => {
    const first = create();
    const second = create();
    const firstStart = first.start();
    const secondStart = second.start();
    secondStart.catch(() => undefined);
    await firstStart;
    const index = (match: (args: readonly string[]) => boolean) =>
      adb.calls.flatMap((args, i) => (match(args) ? [i] : []));
    const pushes = index((args) => args[2] === 'push');
    const removes = index((args) => args[3] === '--remove');
    expect(pushes[0]).toBeLessThan(removes[0] ?? -1);
    expect(pushes[1] ?? Infinity).toBeGreaterThan(removes[0] ?? Infinity);
    await second.stop();
    await expect(secondStart).rejects.toThrow();
  });
});

describe('cleanupScrcpyLeftovers', () => {
  const OURS = (pid: number, ppid: number, scid: string) =>
    `${pid} ${ppid} app_process / com.genymobile.scrcpy.Server 5.0.1 scid=${scid} tunnel_forward=true `;

  it('parses our processes and scrcpy forwards only', () => {
    expect(
      parseScrcpyProcesses(`${OURS(10, 9, '0000abcd')}\n42 1 sh -c something\n${OURS(11, 1, '0000beef')}\n`),
    ).toEqual([
      { pid: 10, ppid: 9, scid: '0000abcd' },
      { pid: 11, ppid: 1, scid: '0000beef' },
    ]);
    expect(
      parseScrcpyForwards(
        'A1 tcp:5000 localabstract:scrcpy_0000abcd\nA1 tcp:5001 tcp:8700\nB2 tcp:5002 localabstract:scrcpy_xyz\n',
      ),
    ).toEqual([{ serial: 'A1', local: 'tcp:5000', scid: '0000abcd' }]);
  });

  it('kills our servers that kept their forward or lost their parent, and removes those forwards only', async () => {
    const adb = new FakeAdb((args) => {
      if (args[0] === 'forward') {
        return [
          `${PHYSICAL_SERIAL} tcp:5000 localabstract:scrcpy_0000abcd`,
          `${PHYSICAL_SERIAL} tcp:5001 localabstract:scrcpy_00000ff1`,
          'OTHER0001 tcp:5002 localabstract:scrcpy_0000abcd',
          '',
        ].join('\n');
      }
      if (args[3] === LIST_LEFTOVERS_COMMAND) {
        return [OURS(10, 9, '0000abcd'), OURS(11, 1, '0000beef'), OURS(12, 9, '0000cafe')].join('\n');
      }
      return '';
    });
    await cleanupScrcpyLeftovers(adb, [PHYSICAL_SERIAL]);
    expect(adb.execCalls.slice(2)).toEqual([
      ['-s', PHYSICAL_SERIAL, 'forward', '--remove', 'tcp:5000'],
      ['-s', PHYSICAL_SERIAL, 'shell', 'kill 10 11'],
    ]);
  });

  it('does nothing without devices or leftovers, and survives adb failures', async () => {
    const quiet = new FakeAdb(() => '');
    await cleanupScrcpyLeftovers(quiet, []);
    expect(quiet.execCalls).toEqual([]);
    await cleanupScrcpyLeftovers(quiet, [PHYSICAL_SERIAL]);
    expect(quiet.execCalls).toHaveLength(2);
    const failing = new FakeAdb(() => {
      throw new Error('device offline');
    });
    await expect(cleanupScrcpyLeftovers(failing, [PHYSICAL_SERIAL])).resolves.toBeUndefined();
  });
});

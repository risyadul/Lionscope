import type { ServerMessage } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.ts';
import { ProfilingSession } from '../src/session/profilingSession.ts';
import type { CollectorIntervals } from '../src/session/profilingSession.ts';
import { MAX_LOG_ENTRIES } from '../src/store/sessionStore.ts';
import { FakeAdb, FakeDevice, fixture, framestats } from './helpers/fakes.ts';

const PKG = 'com.google.android.apps.nexuslauncher';
const START = 1_800_000_000_000;

function setup(device = new FakeDevice(), intervals?: Partial<CollectorIntervals>) {
  const adb = new FakeAdb(
    () => '',
    (command) => device.handle(command),
  );
  const messages: ServerMessage[] = [];
  const session = new ProfilingSession({
    adb,
    serial: 'emulator-5554',
    packageName: PKG,
    emit: (message) => messages.push(message),
    intervals,
  });
  const ofType = <T extends ServerMessage['type']>(type: T) =>
    messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  return { adb, device, session, messages, ofType };
}

/** A `logcat -b crash -v epoch` line of AndroidRuntime from process (and thread) `pid`. */
function crashLine(deviceMs: number, pid: number, message: string): string {
  const ms = String(deviceMs % 1000).padStart(3, '0');
  return `   ${Math.floor(deviceMs / 1000)}.${ms}  ${pid}  ${pid} E AndroidRuntime: ${message}\n`;
}

/** A logcat -v epoch line at device epoch ms `deviceMs`. */
function logLine(deviceMs: number, message: string, tag = 'Tag'): string {
  const ms = String(deviceMs % 1000).padStart(3, '0');
  return `   ${Math.floor(deviceMs / 1000)}.${ms}  1105  1105 I ${tag}: ${message}\n`;
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProfilingSession', () => {
  it('rejects unsafe identifiers before anything reaches adb', () => {
    const adb = new FakeAdb(() => '');
    const emit = () => undefined;
    expect(() => new ProfilingSession({ adb, serial: 'a;b', packageName: PKG, emit })).toThrow('serial');
    expect(() => new ProfilingSession({ adb, serial: 'emu-1', packageName: 'x;reboot', emit })).toThrow(
      'package',
    );
  });

  it('probes the device, finds the PID and starts collectors on separate shells', async () => {
    const { adb, session, ofType } = setup();
    await session.start();
    expect(session.state).toMatchObject({
      status: 'running',
      pid: 1105,
      serial: 'emulator-5554',
      packageName: PKG,
    });
    expect(ofType('session').at(-1)?.session.status).toBe('running');
    expect(ofType('event')).toEqual([]); // already running when we attached: no start marker
    expect(adb.liveLogcats.map((entry) => entry.args)).toEqual([
      ['-s', 'emulator-5554', 'logcat', '-v', 'epoch', '--pid=1105', '-T', '200'],
    ]);

    await vi.advanceTimersByTimeAsync(3100);
    expect(adb.shells).toHaveLength(3);
    const [cpuShell, framesShell, memoryShell] = adb.shells;
    expect(cpuShell?.commands.slice(0, 5)).toEqual([
      'getconf CLK_TCK',
      'cat /sys/devices/system/cpu/possible',
      'date +%s%3N',
      `pidof ${PKG}`,
      'cat /proc/uptime /proc/1105/stat',
    ]);
    // Frames are addressed by PID, with the device uptime read in the same shell call.
    expect(
      framesShell?.commands.every((c) => c === 'cat /proc/uptime; dumpsys gfxinfo 1105 framestats reset'),
    ).toBe(true);
    expect(framesShell?.commands.length).toBeGreaterThanOrEqual(6); // every 500 ms
    expect(memoryShell?.commands.every((c) => c === 'dumpsys meminfo --local 1105')).toBe(true);
    session.stop();
  });

  it('emits CPU samples from tick deltas (50 ticks/s at 100 Hz on 4 possible CPUs = 12.5%)', async () => {
    const { session, ofType } = setup();
    await session.start();
    await vi.advanceTimersByTimeAsync(3100);
    const cpu = ofType('cpu').map((message) => message.sample);
    expect(cpu.length).toBeGreaterThanOrEqual(3);
    expect(cpu[0]).toMatchObject({ percent: 12.5, percentSingleCore: 50, threads: 42 });
    expect(session.snapshot().cpu).toHaveLength(cpu.length);
    session.stop();
  });

  it('emits memory samples and frame samples with fps from device time, dropping the first poll', async () => {
    const { device, session, ofType } = setup();
    device.framesPerPoll = 3;
    await session.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(ofType('memory')[0]?.sample).toMatchObject({
      totalPssKb: 102638,
      javaHeapKb: 6752,
      systemKb: 59502,
    });
    const frames = ofType('frames').map((message) => message.sample);
    expect(frames).toHaveLength(2); // polls at 0 (primes), 500 ms and 1000 ms
    // 3 frames per 0.5 s of device uptime.
    expect(frames[0]).toMatchObject({
      frameCount: 3,
      jankCount: 1,
      fps: 6,
      maxMs: 40,
      frameIntervalMs: 16.67,
    });
    session.stop();
  });

  it('warns once per session when a window returns a full framestats history', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { device, session } = setup();
    device.framesPerPoll = 120;
    await session.start();
    await vi.advanceTimersByTimeAsync(2100);
    const warnings = warn.mock.calls.filter((call) => String(call[0]).includes('framestats history'));
    expect(warnings).toHaveLength(1);
    session.stop();
  });

  it('skips a frames poll without device uptime', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command.includes('gfxinfo') ? framestats([{ vsync: 1, durationMs: 5 }]) : original(command);
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ofType('frames')).toEqual([]);
    session.stop();
  });

  it('emits no frames sample for a dump without PROFILEDATA blocks, and reports a streak once', async () => {
    const warn = vi.spyOn(log, 'warn');
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    let broken = true;
    device.handle = (command) =>
      broken && command.includes('gfxinfo')
        ? `${device.uptimeLine}No process found for: 1105\n`
        : original(command);
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(5000); // 10 polls
    expect(ofType('frames')).toEqual([]);
    expect(ofType('error')).toEqual([
      {
        type: 'error',
        code: 'collector_error',
        message: 'Frame data unavailable on this device (no window frame stats from gfxinfo)',
      },
    ]);
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('frames: unparsable output')),
    ).toHaveLength(1);

    broken = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(ofType('frames').length).toBeGreaterThan(0);
    session.stop();
  });

  it('treats the process header without windows (cold start) as no windows yet, not as a parse miss', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    let coldStart = true;
    device.handle = (command) =>
      coldStart && command.includes('gfxinfo')
        ? `${device.uptimeLine}Applications Graphics Acceleration Info:\nUptime: 1 Realtime: 1\n\n` +
          `** Graphics info for pid 1105 [${PKG}] **\n\nStats since: 1ns\nTotal frames rendered: 0\n`
        : original(command);
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(5000); // 10 polls without a window
    expect(ofType('frames')).toEqual([]);
    expect(ofType('error')).toEqual([]);

    coldStart = false; // the first activity window appeared
    await vi.advanceTimersByTimeAsync(1100);
    expect(ofType('frames').length).toBeGreaterThan(0);
    expect(ofType('error')).toEqual([]);
    session.stop();
  });

  it('still reports windows that never have frame stats (an OEM format without PROFILEDATA)', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command.includes('gfxinfo')
        ? `${device.uptimeLine}** Graphics info for pid 1105 [${PKG}] **\n\nWindow: ${PKG}/.Main\nStats since: 1ns\n`
        : original(command);
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ofType('error').map((message) => message.message)).toEqual([
      'Frame data unavailable on this device (no window frame stats from gfxinfo)',
    ]);
    session.stop();
  });

  it('gives gfxinfo 8 s before timing out (slow devices)', async () => {
    const warn = vi.spyOn(log, 'warn');
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) => (command.includes('gfxinfo') ? 'hang' : original(command));
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(7900);
    expect(ofType('error')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(ofType('error').map((message) => message.message)).toEqual(['Frame sampling failed; retrying']);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('timed out after 8000 ms'))).toBe(true);
    session.stop();
  });

  it('resets the parse-miss streak on success', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    let polls = 0;
    device.handle = (command) => {
      if (!command.includes('gfxinfo')) return original(command);
      polls += 1;
      // Two misses, one good dump, two misses, ...: never three in a row.
      return polls % 3 === 0 ? original(command) : `${device.uptimeLine}No process found for: 1105\n`;
    };
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(ofType('error')).toEqual([]);
    session.stop();
  });

  it('reports memory output that never parses', async () => {
    const { device, session, ofType } = setup();
    device.meminfoReply = () => 'No process found for: 1105\n';
    await session.start();
    await vi.advanceTimersByTimeAsync(5900); // memory polls at 0, 3 s
    expect(ofType('error')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200); // third poll at 6 s
    expect(ofType('memory')).toEqual([]);
    expect(ofType('error').map((message) => message.message)).toEqual([
      'Memory data unavailable on this device',
    ]);
    session.stop();
  });

  it('reports /proc/<pid>/stat output that never parses while the process is running', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) =>
      command.endsWith('/stat') ? `${device.uptimeLine}garbage\n` : original(command);
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(ofType('cpu')).toEqual([]);
    expect(session.state.status).toBe('running');
    expect(ofType('error').map((message) => message.message)).toEqual([
      'CPU data unavailable on this device',
    ]);
    session.stop();
  });

  it('tracks PID changes: died → start → restart, with logcat following the PID', async () => {
    const { adb, device, session, ofType } = setup();
    await session.start();

    device.pid = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ofType('event').map((message) => message.event)).toEqual([
      { ts: expect.any(Number), kind: 'process_died', pid: 1105 },
    ]);
    expect(session.state).toMatchObject({ status: 'waiting_for_process', pid: null });
    expect(adb.liveLogcats).toHaveLength(0);

    device.pid = 2000;
    await vi.advanceTimersByTimeAsync(1000);
    device.pid = 3000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ofType('event').map((message) => [message.event.kind, message.event.pid])).toEqual([
      ['process_died', 1105],
      ['process_start', 2000],
      ['process_restart', 3000],
    ]);
    expect(session.state).toMatchObject({ status: 'running', pid: 3000 });
    expect(adb.liveLogcats.map((entry) => entry.args[5])).toEqual(['--pid=3000']);
    expect(session.snapshot().events).toHaveLength(3);
    session.stop();
  });

  it('detects PID reuse from the stat starttime', async () => {
    const { adb, device, session, ofType } = setup();
    await session.start();
    await vi.advanceTimersByTimeAsync(2000);
    const cpuBefore = ofType('cpu').length;
    const firstLogcat = adb.liveLogcats[0]?.child;

    device.startTime = 99_999; // a new process that got the same PID
    await vi.advanceTimersByTimeAsync(1000);
    expect(ofType('event').map((message) => [message.event.kind, message.event.pid])).toEqual([
      ['process_restart', 1105],
    ]);
    expect(firstLogcat?.killed).toBe(true);
    expect(adb.liveLogcats).toHaveLength(1);
    // The CPU baseline was reset: no sample mixes the two processes' tick counters.
    expect(ofType('cpu')).toHaveLength(cpuBefore);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ofType('cpu')).toHaveLength(cpuBefore + 1);
    session.stop();
  });

  it('starts in waiting_for_process when the app is not running', async () => {
    const device = new FakeDevice();
    device.pid = null;
    const { adb, session, ofType } = setup(device);
    await session.start();
    expect(session.state.status).toBe('waiting_for_process');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ofType('cpu')).toEqual([]);
    expect(ofType('memory')).toEqual([]);
    expect(adb.logcats).toHaveLength(0);
    session.stop();
  });

  it('batches logcat lines every 250 ms and shifts them onto the laptop clock', async () => {
    const { adb, device, session, ofType } = setup();
    device.clockSkewMs = -5000;
    await session.start();
    const logcat = adb.liveLogcats[0]?.child;
    const deviceNow = Date.now() - 5000;
    logcat?.stdout.write('--------- beginning of main\n');
    logcat?.stdout.write(logLine(deviceNow, 'Davey! duration=700ms', 'HWUI    '));
    logcat?.stdout.write(logLine(deviceNow, 'boom', 'Launcher'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('logs')).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    const batches = ofType('logs');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries.map((entry) => [entry.tag, entry.message])).toEqual([
      ['HWUI', 'Davey! duration=700ms'],
      ['Launcher', 'boom'],
    ]);
    expect(Math.abs((batches[0]?.entries[0]?.ts ?? 0) - (deviceNow + 5000))).toBeLessThanOrEqual(1);
    expect(session.snapshot().logs).toHaveLength(2);
    session.stop();
  });

  it('follows the crash buffer of every process from the session start, across PID changes', async () => {
    const { adb, device, session } = setup();
    await session.start();
    const crashes = adb.crashLogcats[0];
    expect(crashes?.args.slice(0, 8)).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'epoch',
      '-b',
      'crash',
      '-T',
    ]);
    // From the session's start on the device clock (5 s behind here).
    expect(Math.abs(Number(crashes?.args[8]) * 1000 - (START + device.clockSkewMs))).toBeLessThan(50);

    // The app dies and comes back: its own logcat is restarted for the new PID, the crash stream is not.
    device.pid = 2000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(adb.liveLogcats.map((entry) => entry.args[5])).toEqual(['--pid=2000']);
    expect(adb.crashLogcats).toHaveLength(1);
    const deviceNow = Date.now();
    for (const line of [
      crashLine(deviceNow, 1105, 'FATAL EXCEPTION: main'),
      crashLine(deviceNow, 1105, `Process: ${PKG}, PID: 1105`),
      crashLine(deviceNow, 4000, 'FATAL EXCEPTION: main'),
      crashLine(deviceNow, 1105, 'java.lang.IllegalStateException: cart is empty'),
      crashLine(deviceNow, 4000, 'Process: com.example.other, PID: 4000'),
      crashLine(deviceNow, 1105, '\tat com.example.shop.CartActivity.onCreate(CartActivity.kt:42)'),
      crashLine(deviceNow, 2000, 'FATAL EXCEPTION: main'),
      crashLine(deviceNow, 2000, `Process: ${PKG}:remote, PID: 2000`),
      crashLine(deviceNow, 2000, 'java.lang.OutOfMemoryError'),
    ]) {
      crashes?.child.stdout.write(line);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(
      session.crashes().map((crash) => [crash.pid, crash.process, crash.exception, crash.stack]),
    ).toEqual([
      [
        1105,
        PKG,
        'java.lang.IllegalStateException',
        ['\tat com.example.shop.CartActivity.onCreate(CartActivity.kt:42)'],
      ],
      [2000, `${PKG}:remote`, 'java.lang.OutOfMemoryError', []],
    ]);
    session.stop();
    expect(adb.crashLogcats[0]?.child.killed).toBe(true);
  });

  it('keeps a crash after the log buffer has dropped its lines', async () => {
    const { adb, session } = setup();
    await session.start();
    const deviceNow = Date.now() - 5000;
    for (const message of ['FATAL EXCEPTION: main', `Process: ${PKG}, PID: 1105`, 'java.lang.Error: boom']) {
      adb.liveLogcats[0]?.child.stdout.write(crashLine(deviceNow, 1105, message));
      adb.crashLogcats[0]?.child.stdout.write(crashLine(deviceNow, 1105, message));
    }
    for (let i = 0; i < MAX_LOG_ENTRIES + 100; i++) {
      adb.liveLogcats[0]?.child.stdout.write(
        logLine(deviceNow + 1, `GET https://api.example.com/v1/items/${i}`, 'OkHttp'),
      );
    }
    await vi.advanceTimersByTimeAsync(250);
    const logs = session.snapshot().logs;
    expect(logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(logs.some((entry) => entry.tag === 'AndroidRuntime')).toBe(false);
    expect(session.crashes()).toEqual([
      expect.objectContaining({ exception: 'java.lang.Error', message: 'boom' }),
    ]);
    session.stop();
  });

  it('resumes the crash stream after an exit without recording a crash twice', async () => {
    const { adb, session, ofType } = setup();
    await session.start();
    const ts = Date.now() - 5000;
    const block = [
      crashLine(ts, 1105, 'FATAL EXCEPTION: main'),
      crashLine(ts, 1105, `Process: ${PKG}, PID: 1105`),
      crashLine(ts, 1105, 'java.lang.IllegalStateException: boom'),
    ];
    const first = adb.crashLogcats[0]?.child;
    for (const line of block) first?.stdout.write(line);
    await vi.advanceTimersByTimeAsync(0);
    first?.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('error').map((message) => message.message)).toEqual([
      'Crash log stream failed; restarting',
    ]);

    await vi.advanceTimersByTimeAsync(2000);
    const second = adb.crashLogcats[1];
    expect(second?.args.at(-1)).toBe(`${Math.floor(ts / 1000)}.${String(ts % 1000).padStart(3, '0')}`);
    // `-T <ts>` replays the lines at that timestamp; a whole buffer replayed (a new stream) is caught by CrashLog.
    for (const line of block) second?.child.stdout.write(line);
    await vi.advanceTimersByTimeAsync(250);
    expect(session.crashes()).toHaveLength(1);
    session.stop();
  });

  it('starts the crash stream from the buffer end when the device clock is unknown', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) => (command === 'date +%s%3N' ? 'date: unknown option\n' : original(command));
    const { adb, session } = setup(device);
    await session.start();
    expect(adb.crashLogcats[0]?.args.slice(-2)).toEqual(['-T', '1']);
    // The one line logcat replays (the end of an older crash) starts no report.
    adb.crashLogcats[0]?.child.stdout.write(
      crashLine(Date.now() - 60_000, 1105, '\tat com.example.Old.f(Old.kt:1)'),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(session.crashes()).toEqual([]);
    session.stop();
  });

  it('keeps a crash whose lines were still pending when the session stopped', async () => {
    const { adb, session } = setup();
    await session.start();
    const deviceNow = Date.now();
    for (const message of ['FATAL EXCEPTION: main', `Process: ${PKG}, PID: 1105`, 'java.lang.Error: late']) {
      adb.crashLogcats[0]?.child.stdout.write(crashLine(deviceNow, 1105, message));
    }
    await vi.advanceTimersByTimeAsync(0);
    session.stop();
    expect(session.crashes()).toEqual([
      expect.objectContaining({ exception: 'java.lang.Error', message: 'late' }),
    ]);
  });

  it('drops logcat history older than the buffer window', async () => {
    const { adb, session, ofType } = setup();
    await session.start();
    const logcat = adb.liveLogcats[0]?.child;
    const deviceNow = Date.now() - 5000;
    logcat?.stdout.write(logLine(deviceNow - 11 * 60 * 1000, 'ancient'));
    logcat?.stdout.write(logLine(deviceNow, 'recent'));
    await vi.advanceTimersByTimeAsync(250);
    expect(ofType('logs').flatMap((batch) => batch.entries.map((entry) => entry.message))).toEqual([
      'recent',
    ]);
    session.stop();
  });

  it('resumes logcat after an unexpected exit without duplicating same-timestamp lines', async () => {
    const { adb, session, ofType } = setup();
    await session.start();
    const first = adb.liveLogcats[0]?.child;
    const ts = Date.now() - 5000;
    first?.stdout.write(logLine(ts - 1, 'older'));
    first?.stdout.write(logLine(ts, 'a'));
    first?.stdout.write(logLine(ts, 'b'));
    await vi.advanceTimersByTimeAsync(0);
    first?.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType('error').map((message) => message.message)).toEqual(['Logcat stream failed; restarting']);

    await vi.advanceTimersByTimeAsync(2000);
    const second = adb.liveLogcats[0];
    expect(second?.args.at(-1)).toBe(`${Math.floor(ts / 1000)}.${String(ts % 1000).padStart(3, '0')}`);
    // `-T <ts>` is inclusive: logcat replays every line at exactly that timestamp.
    second?.child.stdout.write(logLine(ts, 'a'));
    second?.child.stdout.write(logLine(ts, 'b'));
    second?.child.stdout.write(logLine(ts, 'c'));
    second?.child.stdout.write(logLine(ts + 1, 'd'));
    await vi.advanceTimersByTimeAsync(250);
    const messages = ofType('logs').flatMap((batch) => batch.entries.map((entry) => entry.message));
    expect(messages).toEqual(['older', 'a', 'b', 'c', 'd']);
    session.stop();
  });

  it('keeps state consistent and retries when spawning logcat throws', async () => {
    const { adb, session, ofType } = setup();
    const spawn = adb.spawn.bind(adb);
    let failures = 2;
    adb.spawn = (args) => {
      // The app's own logcat (the crash stream has its own error and retry).
      if (args.includes('logcat') && !args.includes('crash') && failures > 0) {
        failures -= 1;
        throw new Error('spawn EAGAIN');
      }
      return spawn(args);
    };
    await session.start();
    expect(session.state).toMatchObject({ status: 'running', pid: 1105 });
    expect(ofType('session').at(-1)?.session).toMatchObject({ status: 'running', pid: 1105 });
    expect(ofType('error').map((message) => message.message)).toEqual(['Logcat stream failed; restarting']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(adb.liveLogcats).toHaveLength(1);
    session.stop();
  });

  it('never overlaps ticks of one collector, and keeps other collectors running', async () => {
    const { adb, device, session, ofType } = setup();
    device.meminfoReply = () => ({ output: device.meminfo, delayMs: 7000 });
    await session.start();
    await vi.advanceTimersByTimeAsync(21_000);
    const memoryShell = adb.shells[2];
    // 7 s per dump: ticks at ~0, 7, 14, 21 s instead of every 3 s.
    expect(memoryShell?.commands.length).toBeLessThanOrEqual(4);
    expect(ofType('memory').length).toBeGreaterThanOrEqual(2);
    expect(ofType('cpu').length).toBeGreaterThanOrEqual(19);
    session.stop();
  });

  it('sends clients a fixed message, logs the details, and re-reports after 5 minutes', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { device, session, ofType } = setup();
    device.meminfoReply = () => 'hang';
    await session.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ofType('error')).toEqual([
      { type: 'error', code: 'collector_error', message: 'Memory sampling failed; retrying' },
    ]);
    const details = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('memory:'));
    expect(details).toEqual([
      `[emulator-5554 ${PKG}] memory: adb shell command timed out after 10000 ms: dumpsys meminfo --local 1105`,
    ]);
    expect(ofType('cpu').length).toBeGreaterThanOrEqual(30);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(ofType('error')).toHaveLength(2);
    session.stop();
  });

  it('tolerates failing probes independently, keeping defaults', async () => {
    const device = new FakeDevice();
    const original = device.handle.bind(device);
    device.handle = (command) => {
      if (command === 'getconf CLK_TCK') return 'hang';
      if (command === 'cat /sys/devices/system/cpu/possible') return 'cat: no such file\n';
      if (command === 'nproc --all') return '2\n';
      return original(command);
    };
    const { session, ofType } = setup(device);
    const started = session.start();
    await vi.advanceTimersByTimeAsync(3000);
    await started;
    expect(ofType('error').map((message) => message.message)).toEqual([
      'Could not read device properties; using defaults',
    ]);
    expect(device.commands).toContain('date +%s%3N'); // later probes still ran
    await vi.advanceTimersByTimeAsync(2000);
    // CLK_TCK default 100, `nproc --all` = 2 → 50 ticks/s = 50% of one core = 25%.
    expect(ofType('cpu')[0]?.sample).toMatchObject({ percent: 25, percentSingleCore: 50 });
    session.stop();
  });

  it('stop() is idempotent, releases every process and silences the session', async () => {
    const { adb, session, messages } = setup();
    await session.start();
    await vi.advanceTimersByTimeAsync(1000);
    session.stop('error', 'Device emulator-5554 disconnected');
    session.stop();
    expect(session.isStopped).toBe(true);
    expect(session.state).toMatchObject({
      status: 'error',
      pid: null,
      error: 'Device emulator-5554 disconnected',
    });
    expect(messages.at(-1)).toEqual({ type: 'session', session: session.state });
    await vi.advanceTimersByTimeAsync(0);
    expect(adb.shells.every((shell) => shell.killed)).toBe(true);
    expect(adb.liveLogcats).toHaveLength(0);
    const count = messages.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages).toHaveLength(count);
    expect(session.snapshot().cpu.length).toBeGreaterThan(0);
  });

  it('stop() during start() prevents collectors from starting', async () => {
    const { adb, session } = setup();
    const started = session.start();
    session.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await started;
    expect(adb.shells.length).toBeLessThanOrEqual(1);
    expect(adb.logcats).toHaveLength(0);
  });

  it('parses the real meminfo --local fixture end to end', async () => {
    const device = new FakeDevice();
    device.meminfo = fixture('meminfo-local.txt');
    const { session, ofType } = setup(device);
    await session.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(ofType('memory')[0]?.sample.totalPssKb).toBeGreaterThan(0);
    session.stop();
  });
});

import { describe, expect, it } from 'vitest';
import { parseDevices } from '../src/parsers/devices.ts';
import { FRAMESTATS_HISTORY_ROWS, parseFramestats } from '../src/parsers/gfxinfo.ts';
import { MAX_LOG_MESSAGE_CHARS, parseLogcatLine, parseThreadtimeLine } from '../src/parsers/logcat.ts';
import type { LegacyLogClock } from '../src/parsers/logcat.ts';
import { parseMeminfo } from '../src/parsers/meminfo.ts';
import { buildAppList, parsePackageList } from '../src/parsers/packages.ts';
import { parseProcStat } from '../src/parsers/procStat.ts';
import { parsePs, parsePsPids } from '../src/parsers/ps.ts';
import {
  isImplausibleAppPidList,
  parseCpuList,
  parseDeviceEpochMs,
  parseLegacyLogClock,
  parsePidList,
  parsePidof,
  parsePositiveInt,
  parseUptime,
} from '../src/parsers/shellValues.ts';
import { api30Framestats, fixture } from './helpers/fakes.ts';

describe('parseDevices', () => {
  it('parses the real `adb devices -l` fixture', () => {
    expect(parseDevices(fixture('adb-devices.txt'))).toEqual([
      {
        serial: 'emulator-5554',
        state: 'device',
        product: 'sdk_gphone16k_arm64',
        model: 'sdk_gphone16k_arm64',
        transportId: '4',
      },
    ]);
  });

  it('maps states, skips daemon banners and drops unsafe serials', () => {
    const output = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'R58M123ABC             unauthorized usb:1-1 transport_id:7',
      '192.168.1.5:5555       offline',
      'weird-1                recovery',
      'bad;serial             device',
      'lonely',
      '',
    ].join('\n');
    expect(parseDevices(output)).toEqual([
      { serial: 'R58M123ABC', state: 'unauthorized', transportId: '7' },
      { serial: '192.168.1.5:5555', state: 'offline' },
      { serial: 'weird-1', state: 'unknown' },
    ]);
  });
});

describe('parseProcStat', () => {
  it('reads utime/stime/threads/starttime from the real fixture', () => {
    expect(parseProcStat(fixture('proc-pid-stat.txt'))).toEqual({
      pid: 1105,
      utime: 166,
      stime: 694,
      numThreads: 40,
      startTime: 1152,
    });
  });

  it('splits after the last ")" so comm may contain spaces and parentheses', () => {
    const line = '42 (my (evil) ) app) R 1 2 3 4 5 6 7 8 9 10 111 222 0 0 20 0 7 0 1 2\n';
    expect(parseProcStat(line)).toEqual({ pid: 42, utime: 111, stime: 222, numThreads: 7, startTime: 1 });
  });

  it('finds the stat line after /proc/uptime output', () => {
    const text = `807.02 2907.73\n${fixture('proc-pid-stat.txt')}`;
    expect(parseProcStat(text)?.pid).toBe(1105);
  });

  it.each([
    '',
    'cat: /proc/1/stat: No such file or directory',
    '12 (short) S 1 2',
    '12 (x) S 1 2 3 4 5 6 7 8 9 10 a b',
    '12 (x) S 1 2 3 4 5 6 7 8 9 10 111 222 0 0 20 0 7 0',
  ])('returns null for %j', (text) => {
    expect(parseProcStat(text)).toBeNull();
  });
});

describe('parseMeminfo', () => {
  it('reads the App Summary of the real fixture', () => {
    expect(parseMeminfo(fixture('meminfo.txt'))).toEqual({
      totalPssKb: 102638,
      javaHeapKb: 6752,
      nativeHeapKb: 13200,
      codeKb: 19856,
      stackKb: 720,
      graphicsKb: 0,
      privateOtherKb: 2608,
      systemKb: 59502,
    });
  });

  it('reads the App Summary of a real `dumpsys meminfo --local` fixture', () => {
    const local = fixture('meminfo-local.txt');
    const summaryTotal = Number(/TOTAL PSS:\s+(\d+)/.exec(local)?.[1]);
    expect(summaryTotal).toBeGreaterThan(0);
    expect(parseMeminfo(local)).toMatchObject({ totalPssKb: summaryTotal });
    expect(parseMeminfo(local)?.javaHeapKb).toBeGreaterThan(0);
  });

  it('falls back to the TOTAL row when there is no App Summary', () => {
    const legacy = ['  Native Heap    13207    13200', '        TOTAL   102638    23840    19296'].join('\n');
    expect(parseMeminfo(legacy)).toMatchObject({ totalPssKb: 102638, javaHeapKb: 0 });
  });

  it.each(['', 'No process found for: 1234', 'garbage\nlines'])('returns null for %j', (text) => {
    expect(parseMeminfo(text)).toBeNull();
  });
});

describe('parseFramestats', () => {
  it('parses every PROFILEDATA block of the real fixture, skipping HWUI outlier and unfinished rows', () => {
    const text = fixture('gfxinfo-framestats.txt');
    const { frames, blockCount, maxWindowRows } = parseFramestats(text);
    const rows = text.split('\n').filter((line) => /^\d+,\d/.test(line));
    // Column 18 is FrameCompleted; it is 0 for frames that never completed.
    const valid = rows.filter((line) => line.startsWith('0,') && line.split(',')[17] !== '0');
    expect(rows.length).toBeGreaterThan(valid.length);
    expect(frames).toHaveLength(valid.length);
    expect(blockCount).toBe(2);
    expect(maxWindowRows).toBe(120); // the launcher window holds a full (possibly truncated) history
    expect(maxWindowRows).toBeGreaterThanOrEqual(FRAMESTATS_HISTORY_ROWS);
    expect(frames.every((frame) => frame.reportedIntervalMs === 16.666666)).toBe(true);
    expect(frames.every((frame) => frame.missedDeadline !== null)).toBe(true);

    // Taskbar row: 0,4970,31296845125,...,FrameDeadline=31313511791,...,FrameCompleted=32931782598
    const first = frames[0];
    expect(first?.intendedVsyncNs).toBe(31296845125);
    expect(first?.durationMs).toBeCloseTo((32931782598 - 31296845125) / 1e6, 6);
    expect(first?.missedDeadline).toBe(true);
  });

  it('parses the after-reset fixture (two windows rendering the same vsyncs)', () => {
    const { frames, blockCount, maxWindowRows } = parseFramestats(
      fixture('gfxinfo-framestats-after-reset.txt'),
    );
    expect(frames).toHaveLength(7);
    expect(blockCount).toBe(2);
    expect(maxWindowRows).toBe(4);
    expect(frames.filter((frame) => frame.intendedVsyncNs === 300513501023)).toHaveLength(2);
  });

  it('keeps HyperOS frames whose only flag bit is a vendor bit (real Xiaomi 12T / Android 15 header)', () => {
    // Real capture from a Xiaomi 12T on HyperOS 2: two windows, no frames since the last reset.
    const capture = fixture('gfxinfo-framestats-hyperos.txt');
    expect(parseFramestats(capture)).toMatchObject({ frames: [], blockCount: 2 });

    const headerLine = capture.split('\n').find((line) => line.startsWith('Flags,')) ?? '';
    const header = headerLine.split(',');
    const row = (values: Record<string, number>): string =>
      header.map((name) => (name === '' ? '' : String(values[name] ?? 0))).join(',');
    const frameAt = (flags: number, vsync: number) =>
      row({
        Flags: flags,
        IntendedVsync: vsync,
        FrameInterval: 8_333_333,
        FrameDeadline: vsync + 16_666_666,
        FrameCompleted: vsync + 12_000_000,
      });
    const rows = [
      frameAt(32, 1_000_000_000), // HyperOS normal frame: vendor bit 5 only → kept
      frameAt(32, 1_008_333_333), // kept
      frameAt(33, 1_016_666_666), // + WindowVisibilityChanged → outlier
      frameAt(34, 1_025_000_000), // + RTAnimation → outlier
      frameAt(36, 1_033_333_333), // + SurfaceCanvas → outlier
      frameAt(40, 1_041_666_666), // + SkippedFrame → outlier
    ];
    const withFrames = capture.replace(headerLine, [headerLine, ...rows].join('\n'));

    const { frames, inferredIntervalMs } = parseFramestats(withFrames);
    expect(frames.map((frame) => frame.intendedVsyncNs)).toEqual([1_000_000_000, 1_008_333_333]);
    expect(frames[0]).toMatchObject({ durationMs: 12, reportedIntervalMs: 8.333333, missedDeadline: false });
    expect(inferredIntervalMs).toBeCloseTo(8.333333, 5);
  });

  it('reads real HyperOS frames despite its swapped FrameInterval/FrameStartTime header labels', () => {
    // Xiaomi 12T, HyperOS 2, 120 Hz panel: every row has Flags=32 and the column labelled
    // "FrameInterval" holds a timestamp while "FrameStartTime" holds the ~8.44 ms vsync period.
    const text = fixture('gfxinfo-framestats-hyperos-frames.txt');
    const rows = text.split('\n').filter((line) => /^\d+,\d/.test(line));
    const finished = rows.filter((line) => {
      const cells = line.split(',').map(Number);
      return (cells[16] ?? 0) >= (cells[2] ?? 0); // FrameCompleted ≥ IntendedVsync
    });
    const { frames, inferredIntervalMs } = parseFramestats(text);

    expect(rows.every((line) => line.startsWith('32,'))).toBe(true);
    expect(frames).toHaveLength(finished.length);
    expect(frames.length).toBeGreaterThan(40);
    expect(frames.every((frame) => frame.reportedIntervalMs !== null)).toBe(true);
    expect(frames.every((frame) => Math.abs((frame.reportedIntervalMs ?? 0) - 8.44) < 0.05)).toBe(true);
    expect(Math.max(...frames.map((frame) => frame.durationMs))).toBeLessThan(100);
    expect(inferredIntervalMs).not.toBeNull();
  });

  it('drops rows with garbage timestamps instead of reporting absurd frame times', () => {
    const text = [
      '---PROFILEDATA---',
      'Flags,IntendedVsync,FrameCompleted,',
      '0,1000000000,1012000000,',
      '0,1000000000,432351626538720000,',
      '---PROFILEDATA---',
    ].join('\n');
    expect(parseFramestats(text).frames.map((frame) => frame.durationMs)).toEqual([12]);
  });

  it('uses header names rather than positions and reads FrameDeadline without FrameInterval', () => {
    const text = [
      '---PROFILEDATA---',
      'FrameCompleted,Flags,FrameDeadline,IntendedVsync,',
      '1050000000,0,1020000000,1000000000,',
      '1010000000,0,1020000000,1008000000,',
      '2000000000,4,1020000000,1000000000,',
      '0,0,1020000000,1000000000,',
      'not,a,frame,row',
      '---PROFILEDATA---',
    ].join('\n');
    expect(parseFramestats(text)).toEqual({
      frames: [
        { intendedVsyncNs: 1e9, durationMs: 50, reportedIntervalMs: null, missedDeadline: true },
        { intendedVsyncNs: 1008e6, durationMs: 2, reportedIntervalMs: null, missedDeadline: false },
      ],
      blockCount: 1,
      maxWindowRows: 4,
      processHeader: false,
      windowCount: 0,
      inferredIntervalMs: 8,
    });
  });

  it('infers the vsync period per window from the smallest IntendedVsync gap (API < 31)', () => {
    const { frames, inferredIntervalMs } = parseFramestats(
      api30Framestats([
        [0, 2, 3, 7],
        [100, 103],
      ]),
    );
    expect(frames.every((frame) => frame.reportedIntervalMs === null && frame.missedDeadline === null)).toBe(
      true,
    );
    // Window 1 gaps: 2, 1, 4 vsyncs → 1 vsync = 8.333333 ms; window 2: 3 vsyncs. Smallest wins.
    expect(inferredIntervalMs).toBeCloseTo(8.333333, 5);
  });

  it('does not infer a period from a single frame or implausible gaps', () => {
    expect(parseFramestats(api30Framestats([[0]])).inferredIntervalMs).toBeNull();
    expect(parseFramestats(api30Framestats([[0, 10]])).inferredIntervalMs).toBeNull(); // 83 ms
  });

  it('ignores headerless blocks and blocks without the needed columns, but counts them', () => {
    const text = [
      '---PROFILEDATA---',
      'IntendedVsync,FrameCompleted,',
      '1000000000,1010000000,',
      '1000000000,900000000,',
      '---PROFILEDATA---',
      '---PROFILEDATA---',
      '0,1,2,',
      '---PROFILEDATA---',
      '---PROFILEDATA---',
      'Flags,Vsync,',
      '0,1,',
      '---PROFILEDATA---',
    ].join('\n');
    const parsed = parseFramestats(text);
    expect(parsed.frames).toEqual([
      { intendedVsyncNs: 1e9, durationMs: 10, reportedIntervalMs: null, missedDeadline: null },
    ]);
    expect(parsed.blockCount).toBe(3);
  });

  it('sees the process header and counts windows (outside PROFILEDATA blocks)', () => {
    expect(parseFramestats(fixture('gfxinfo-framestats.txt'))).toMatchObject({
      processHeader: true,
      windowCount: 2,
    });
    const coldStart = [
      'Applications Graphics Acceleration Info:',
      'Uptime: 5260843 Realtime: 5260843',
      '',
      '** Graphics info for pid 4242 [com.example.app] **',
      '',
      'Stats since: 5260001000000ns',
      'Total frames rendered: 0',
      '',
    ].join('\n');
    expect(parseFramestats(coldStart)).toMatchObject({ blockCount: 0, processHeader: true, windowCount: 0 });
  });

  it('reports zero blocks for output without profile data', () => {
    expect(parseFramestats('No process found for: 1105')).toEqual({
      frames: [],
      blockCount: 0,
      maxWindowRows: 0,
      processHeader: false,
      windowCount: 0,
      inferredIntervalMs: null,
    });
    expect(parseFramestats('---PROFILEDATA---\nFlags,IntendedVsync,')).toMatchObject({ blockCount: 0 });
  });
});

describe('parseLogcatLine', () => {
  const lines = fixture('logcat-epoch.txt').split('\n');

  it('parses the real fixture, including padded tags and skipped separators', () => {
    const entries = lines.map(parseLogcatLine).filter((entry) => entry !== null);
    expect(entries).toHaveLength(lines.filter((line) => /^\s+\d/.test(line)).length);
    expect(entries[0]).toEqual({
      deviceTs: 1792499202894,
      pid: 1105,
      tid: 2400,
      level: 'D',
      tag: 'StatsLog',
      message: 'LAUNCHER_GOOGLE_SEARCH_GMS_PLAY_EMPTY_COMPONENT_NAME',
    });
    const hwui = entries.find((entry) => entry.tag === 'HWUI');
    expect(hwui?.level).toBe('I');
    expect(hwui?.message.startsWith('Davey! duration=1055ms;')).toBe(true);
  });

  it('skips "beginning of" separators and junk', () => {
    expect(parseLogcatLine('--------- beginning of main')).toBeNull();
    expect(parseLogcatLine('garbage')).toBeNull();
  });

  it('caps long messages, maps assert to fatal and keeps colons in messages', () => {
    const long = parseLogcatLine(`  1.000  1  2 A Tag: ${'x'.repeat(MAX_LOG_MESSAGE_CHARS + 50)}`);
    expect(long?.level).toBe('F');
    expect(long?.message).toHaveLength(MAX_LOG_MESSAGE_CHARS);
    expect(parseLogcatLine('1.005 1 2 W My Tag : a: b')).toMatchObject({
      tag: 'My Tag',
      message: 'a: b',
      deviceTs: 1005,
    });
  });
});

describe('parsePs / packages', () => {
  it('maps process names to pids', () => {
    const pids = parsePs(fixture('ps.txt'));
    expect(pids.get('com.google.android.apps.nexuslauncher')).toBe(1105);
    expect(pids.get('com.example.shop')).toBe(4081);
    expect(pids.has('NAME')).toBe(false);
    expect(parsePs('  1 init\n  2 init\n').get('init')).toBe(1);
  });

  it('maps process names to pids in the full table of toolbox ps (API 23), the NAME last', () => {
    const toolbox = fixture('ps-api23.txt');
    const pids = parsePs(toolbox);
    expect(pids.get('io.github.risyadul.lionscope.sample')).toBe(2455);
    expect(pids.get('/init')).toBe(1);
    expect(pids.has('NAME')).toBe(false);
    expect(pids.has('USER')).toBe(false);
  });

  it('keeps the first PID of a name and compares names as a whole in both ps formats', () => {
    const toolbox = [
      'USER      PID   PPID  VSIZE  RSS   WCHAN              PC  NAME',
      'u0_a1     500   1     1      1     SyS_epoll_ 00 S com.app:remote',
      'u0_a1     501   1     1      1     SyS_epoll_ 00 S com.app',
      'u10_a1    900   1     1      1     SyS_epoll_ 00 S com.app',
      'u0_a1     502   1     1      1     SyS_epoll_ 00 S com.app.debug',
    ].join('\r\n');
    expect(parsePs(toolbox).get('com.app')).toBe(501);
    expect(parsePs('PID NAME\n 7 com.app:remote\n 8 com.app.debug\n').get('com.app')).toBeUndefined();
    expect(parsePs('usage: ps [-o COL,COL...]\nps: bad option -- A\n').size).toBe(0);
  });

  it('parses package lists and filters invalid names', () => {
    const all = parsePackageList(fixture('pm-list-packages.txt'));
    expect(all).toContain('com.google.android.apps.nexuslauncher');
    expect(all.length).toBeGreaterThan(50);
    expect(
      parsePackageList('package:com.ok.app\npackage:bad;rm\nnoise\npackage:single\npackage:com.ok.app'),
    ).toEqual(['com.ok.app']);
  });

  it('builds the app list: running first, then third-party, then alphabetical', () => {
    const apps = buildAppList(
      parsePackageList(fixture('pm-list-packages.txt')),
      parsePackageList(fixture('pm-list-packages-3.txt')),
      parsePs(fixture('ps.txt')),
    );
    expect(apps[0]).toEqual({
      packageName: 'com.example.shop',
      pid: 4081,
      thirdParty: true,
    });
    const firstStopped = apps.findIndex((app) => app.pid === null);
    expect(apps.slice(0, firstStopped).every((app) => app.pid !== null)).toBe(true);
    expect(apps.find((app) => app.packageName === 'com.google.android.apps.nexuslauncher')?.pid).toBe(1105);
    const stoppedNames = apps.slice(firstStopped).map((app) => app.packageName);
    expect(stoppedNames).toEqual([...stoppedNames].sort((a, b) => a.localeCompare(b)));
  });

  it('orders third-party before system apps among stopped apps', () => {
    const apps = buildAppList(['b.sys', 'a.sys'], ['z.third'], new Map());
    expect(apps.map((app) => app.packageName)).toEqual(['z.third', 'a.sys', 'b.sys']);
  });
});

describe('shell values', () => {
  it('parses pidof output', () => {
    expect(parsePidof(fixture('pidof.txt'))).toBe(1105);
    expect(parsePidof('1105 2201\n')).toBe(1105);
    expect(parsePidof('')).toBeNull();
    expect(parsePidof('0\n')).toBeNull();
  });

  it('parses /proc/uptime, positive ints and device clocks', () => {
    expect(parseUptime('807.02 2907.73\n')).toBe(807.02);
    expect(parseUptime('nope')).toBeNull();
    expect(parsePositiveInt('100\n')).toBe(100);
    expect(parsePositiveInt('0\n')).toBeNull();
    expect(parsePositiveInt('x')).toBeNull();
    expect(parseDeviceEpochMs('1792499594091\n')).toBe(1792499594091);
    expect(parseDeviceEpochMs('1792499594%3N\n')).toBe(1792499594500);
    expect(parseDeviceEpochMs('date: bad format')).toBeNull();
  });

  it('reads the seconds of the clock of API 23 (toolbox prints `<seconds>3N`) as 10 digits, not 11', () => {
    expect(parseDeviceEpochMs('17934733453N\r\n')).toBe(1793473345500);
    expect(parseDeviceEpochMs('1793473345N')).toBe(1793473345500);
    expect(parseDeviceEpochMs('1793473345')).toBe(1793473345500);
    expect(parseDeviceEpochMs('179347334534N')).toBeNull();
  });

  it('flags a pidof list that ignored its name (API 23) and keeps real ones', () => {
    const everything = parsePidList(fixture('pidof-api23.txt'));
    expect(everything.length).toBeGreaterThan(100);
    expect(isImplausibleAppPidList(everything)).toBe(true);
    expect(isImplausibleAppPidList([1])).toBe(true);
    expect(isImplausibleAppPidList(Array.from({ length: 17 }, (_, i) => 2000 + i))).toBe(true);
    expect(isImplausibleAppPidList([])).toBe(false);
    expect(isImplausibleAppPidList([1105])).toBe(false);
    expect(isImplausibleAppPidList([1105, 2201])).toBe(false);
  });

  it('parses the device clock of `date "+%s %Y-%m-%d %H:%M:%S"` into a zone offset', () => {
    expect(parseLegacyLogClock('1793474375 2026-11-01 02:19:35\r\n')).toEqual({
      utcOffsetMs: 7 * 3_600_000,
      probeMs: 1793474375000,
    });
    expect(parseLegacyLogClock('1793474375 2026-10-31 19:19:35')?.utcOffsetMs).toBe(0);
    expect(parseLegacyLogClock('1793474375 2026-10-31 15:19:35')?.utcOffsetMs).toBe(-4 * 3_600_000);
    expect(parseLegacyLogClock('1793474375 2026-11-01 00:49:35')?.utcOffsetMs).toBe(5.5 * 3_600_000);
    expect(parseLegacyLogClock('date: bad format')).toBeNull();
    expect(parseLegacyLogClock('')).toBeNull();
  });

  it('counts CPUs in kernel CPU lists', () => {
    expect(parseCpuList('0-3\n')).toBe(4);
    expect(parseCpuList('0')).toBe(1);
    expect(parseCpuList('0-3,6,8-9')).toBe(7);
    expect(parseCpuList('3-1')).toBeNull();
    expect(parseCpuList('cat: no such file')).toBeNull();
    expect(parseCpuList('')).toBeNull();
  });
});

describe('parsePsPids', () => {
  const NAME = 'io.github.risyadul.lionscope.sample';

  it('lists no PID for an app that is not in the toolbox ps of API 23', () => {
    expect(parsePsPids(fixture('ps-api23.txt'), 'com.does.not.exist')).toEqual([]);
    expect(parsePsPids('', NAME)).toEqual([]);
  });

  it('finds the app by its exact NAME in the last column of the toolbox ps of API 23', () => {
    const ps = fixture('ps-api23.txt');
    expect(parsePsPids(fixture('ps-grep-api23.txt'), NAME)).toEqual([2455]);
    expect(parsePsPids(ps, NAME)).toEqual([2455]);
    expect(parsePsPids(ps, 'system_server')).toEqual([1227]);
    expect(parsePsPids(ps, 'zygote64')).toEqual([897]);
    expect(parsePsPids(ps, 'init')).toEqual([]); // the NAME there is `/init`
    expect(parsePsPids(ps, '/init')).toEqual([1]);
  });

  it('does not take a longer name, a prefix or another process of the package for the app', () => {
    const ps = [
      'USER      PID   PPID  VSIZE  RSS   WCHAN              PC  NAME',
      `u0_a55    2455  897   1245156 114040 SyS_epoll_ 7b974f3a34 S ${NAME}`,
      `u0_a55    2460  897   1245156 114040 SyS_epoll_ 7b974f3a34 S ${NAME}:service`,
      `u0_a55    2470  897   1245156 114040 SyS_epoll_ 7b974f3a34 S ${NAME}.debug`,
      `u0_a56    2480  897   1245156 114040 SyS_epoll_ 7b974f3a34 S x.${NAME}`,
      '',
    ].join('\r\n');
    expect(parsePsPids(ps, NAME)).toEqual([2455]);
    expect(parsePsPids(ps, `${NAME}:service`)).toEqual([2460]);
  });

  it('reads the `PID NAME` format of `ps -A -o PID,NAME` and drops duplicates of both listings', () => {
    expect(parsePsPids(fixture('ps.txt'), '[kthreadd]')).toEqual([2]);
    expect(parsePsPids(`  2455 ${NAME}\n  2455 ${NAME}\n  2456 ${NAME}\n`, NAME)).toEqual([2455, 2456]);
  });

  it('ignores the usage and error lines of the ps flavour that does not know `-A`', () => {
    const output = `${fixture('ps-grep-api23.txt')}bad pid '-A'\n`;
    expect(parsePsPids(output, NAME)).toEqual([2455]);
  });
});

describe('parseThreadtimeLine', () => {
  const clock: LegacyLogClock = { utcOffsetMs: 7 * 3_600_000, probeMs: 1793474375000 };

  it('parses the lines of `logcat -v threadtime` of API 23 and skips its separators', () => {
    const lines = fixture('logcat-threadtime-api23.txt').split('\n');
    const entries = lines.map((line) => parseThreadtimeLine(line, clock)).filter((entry) => entry !== null);
    expect(entries).toHaveLength(15);
    expect(entries[0]).toEqual({
      // 11-01 02:19:31.425 at UTC+7
      deviceTs: Date.UTC(2026, 9, 31, 19, 19, 31, 425),
      pid: 2059,
      tid: 2059,
      level: 'D',
      tag: 'AndroidRuntime',
      message: 'CheckJNI is OFF',
    });
    expect(entries[2]).toMatchObject({ tag: 'ICU', level: 'D' }); // the tag is padded: `ICU     : `
    expect(entries.at(-1)).toMatchObject({ pid: 1212, tid: 1284, tag: 'ConnectivityService' });
    expect(parseThreadtimeLine('--------- beginning of system', clock)).toBeNull();
    expect(parseThreadtimeLine('Invalid parameter epoch to -v', clock)).toBeNull();
    expect(parseThreadtimeLine('', clock)).toBeNull();
  });

  it('reads the JavaBinder transaction line of API 23', () => {
    const line =
      '11-01 02:07:38.244  2557  2557 E JavaBinder: !!! FAILED BINDER TRANSACTION !!!  (parcel size = 566092)';
    expect(parseThreadtimeLine(line, clock)).toMatchObject({
      pid: 2557,
      level: 'E',
      tag: 'JavaBinder',
      message: '!!! FAILED BINDER TRANSACTION !!!  (parcel size = 566092)',
    });
  });

  it('takes the year from the device and the neighbouring year around New Year', () => {
    const newYearsEve: LegacyLogClock = { utcOffsetMs: 0, probeMs: Date.UTC(2026, 11, 31, 23, 59, 50) };
    expect(parseThreadtimeLine('12-31 23:59:49.000  1  1 I T: a', newYearsEve)?.deviceTs).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 49),
    );
    expect(parseThreadtimeLine('01-01 00:00:03.000  1  1 I T: after midnight', newYearsEve)?.deviceTs).toBe(
      Date.UTC(2027, 0, 1, 0, 0, 3),
    );
    const justAfter: LegacyLogClock = { utcOffsetMs: 0, probeMs: Date.UTC(2027, 0, 1, 0, 0, 10) };
    expect(parseThreadtimeLine('12-31 23:59:58.000  1  1 I T: before midnight', justAfter)?.deviceTs).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 58),
    );
  });

  it('truncates a long message like the epoch parser', () => {
    const long = parseThreadtimeLine(
      `11-01 02:19:31.425  1  2 A Tag: ${'x'.repeat(MAX_LOG_MESSAGE_CHARS + 50)}`,
      clock,
    );
    expect(long?.level).toBe('F');
    expect(long?.message).toHaveLength(MAX_LOG_MESSAGE_CHARS);
  });
});

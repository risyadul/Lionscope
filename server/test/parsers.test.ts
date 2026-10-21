import { describe, expect, it } from 'vitest';
import { parseDevices } from '../src/parsers/devices.ts';
import { FRAMESTATS_HISTORY_ROWS, parseFramestats } from '../src/parsers/gfxinfo.ts';
import { MAX_LOG_MESSAGE_CHARS, parseLogcatLine } from '../src/parsers/logcat.ts';
import { parseMeminfo } from '../src/parsers/meminfo.ts';
import { buildAppList, parsePackageList } from '../src/parsers/packages.ts';
import { parseProcStat } from '../src/parsers/procStat.ts';
import { parsePs } from '../src/parsers/ps.ts';
import {
  parseCpuList,
  parseDeviceEpochMs,
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

  it('counts CPUs in kernel CPU lists', () => {
    expect(parseCpuList('0-3\n')).toBe(4);
    expect(parseCpuList('0')).toBe(1);
    expect(parseCpuList('0-3,6,8-9')).toBe(7);
    expect(parseCpuList('3-1')).toBeNull();
    expect(parseCpuList('cat: no such file')).toBeNull();
    expect(parseCpuList('')).toBeNull();
  });
});

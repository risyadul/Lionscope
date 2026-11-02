import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@lionscope/protocol';
import type { Adb } from '../src/adb/adb.ts';
import type { LegacyLogClock } from '../src/parsers/logcat.ts';
import {
  LEGACY_LOGCAT_HISTORY_LINES,
  LEGACY_LOGCAT_RETAINED_LINES,
  formatLegacyTimestamp,
  startLogcatStream,
} from '../src/session/logcatStream.ts';
import { FakeChild } from './helpers/fakes.ts';

const HOUR = 3_600_000;
const APP_PID = 4242;

interface RingLine {
  deviceTs: number;
  pid: number;
  message: string;
}

/**
 * An API 23 logcat: a ring buffer behind `-v threadtime -T <count | 'MM-DD HH:mm:ss.SSS'>`, with dates in the
 * device's zone and the missing year read as the present one (what the real binary does).
 */
class LegacyLogcatDevice {
  readonly buffer: RingLine[] = [];
  readonly spawned: (readonly string[])[] = [];

  constructor(
    readonly clock: LegacyLogClock,
    private readonly nowMs: () => number,
  ) {}

  push(deviceTs: number, message: string, pid = APP_PID): void {
    this.buffer.push({ deviceTs, pid, message });
  }

  adb(): Adb {
    return {
      path: 'fake-adb',
      exec: () => Promise.resolve(''),
      reverse: () => Promise.resolve(),
      removeReverse: () => Promise.resolve(),
      spawn: (args) => this.spawn(args),
    };
  }

  private threadtime(line: RingLine): string {
    const local = new Date(line.deviceTs + this.clock.utcOffsetMs).toISOString();
    return `${local.slice(5, 10)} ${local.slice(11, 23)} ${String(line.pid).padStart(5)} ${String(line.pid).padStart(5)} I Tag: ${line.message}\r\n`;
  }

  private spawn(args: readonly string[]): FakeChild {
    this.spawned.push(args);
    const child = new FakeChild();
    const tail = args[args.indexOf('-T') + 1] ?? '';
    let replay: RingLine[];
    if (/^\d+$/.test(tail)) {
      replay = this.buffer.slice(-Number(tail));
    } else {
      const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(tail);
      if (!match) throw new Error(`bad -T ${tail}`);
      const [month, day, hour, minute, second, millis] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const year = new Date(this.nowMs() + this.clock.utcOffsetMs).getUTCFullYear();
      const from = Date.UTC(year, month - 1, day, hour, minute, second, millis) - this.clock.utcOffsetMs;
      replay = this.buffer.filter((line) => line.deviceTs >= from);
    }
    for (const line of replay) child.stdout.write(this.threadtime(line));
    return child;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

afterEach(() => {
  vi.useRealTimers();
});

function follow(
  device: LegacyLogcatDevice,
  extra: { resume?: { deviceTs: number; linesAtTs: number }; since?: number; historyLines?: number } = {},
) {
  const entries: LogEntry[] = [];
  const stream = startLogcatStream({
    adb: device.adb(),
    serial: 'emulator-5590',
    pid: APP_PID,
    legacyClock: device.clock,
    clockOffsetMs: 0,
    onEntry: (entry) => entries.push(entry),
    onExit: () => undefined,
    ...extra,
  });
  return { entries, stream };
}

describe('legacy logcat starts at a point in time', () => {
  const clock: LegacyLogClock = { utcOffsetMs: 7 * HOUR, probeMs: Date.UTC(2026, 10, 1, 3, 0, 0) };
  const now = Date.UTC(2026, 10, 1, 3, 5, 0);

  it('still catches a gap event after more than 2000 unrelated entries are in the ring buffer', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const resumeTs = Date.UTC(2026, 10, 1, 3, 4, 0, 250);
    device.push(resumeTs, 'before disconnect');
    device.push(resumeTs + 1000, 'gap marker');
    for (let i = 0; i < 2100; i++) device.push(resumeTs + 1001 + i, `other ${i}`, 999);
    device.push(resumeTs + 4000, 'after_reconnect');

    const { entries, stream } = follow(device, { resume: { deviceTs: resumeTs, linesAtTs: 1 } });
    await tick();
    stream.stop();

    expect(device.spawned[0]?.slice(-2)).toEqual(['-T', '11-01 10:04:00.250']);
    expect(device.buffer.slice(-LEGACY_LOGCAT_HISTORY_LINES).map((line) => line.message)).not.toContain(
      'gap marker',
    );
    expect(entries.map((entry) => entry.message)).toEqual(['gap marker', 'after_reconnect']);
  });

  it('would have lost that gap event with a line count (the buffer replay the timestamp replaces)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const base = Date.UTC(2026, 10, 1, 3, 4, 0);
    device.push(base, 'gap marker');
    for (let i = 0; i < 2100; i++) device.push(base + 1 + i, `other ${i}`, 999);
    const { entries, stream } = follow(device);
    await tick();
    stream.stop();
    expect(device.spawned[0]?.slice(-2)).toEqual(['-T', String(LEGACY_LOGCAT_HISTORY_LINES)]);
    expect(entries).toEqual([]);
  });

  it('does not duplicate lines at the resume millisecond, however many were delivered', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const at = Date.UTC(2026, 10, 1, 3, 4, 0, 500);
    device.push(at - 1, 'older');
    device.push(at, 'same ms 1');
    device.push(at, 'same ms 2');
    device.push(at, 'same ms 3');
    device.push(at + 1, 'newer');

    const partial = follow(device, { resume: { deviceTs: at, linesAtTs: 2 } });
    await tick();
    partial.stream.stop();
    expect(partial.entries.map((entry) => entry.message)).toEqual(['same ms 3', 'newer']);

    const complete = follow(device, { resume: { deviceTs: at, linesAtTs: 3 } });
    await tick();
    complete.stream.stop();
    expect(complete.entries.map((entry) => entry.message)).toEqual(['newer']);
    expect(device.spawned.map((args) => args.at(-1))).toEqual(['11-01 10:04:00.500', '11-01 10:04:00.500']);
  });

  it('keeps filtering by PID and by `since` on the lines received', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const since = Date.UTC(2026, 10, 1, 3, 3, 0);
    device.push(since - 1, 'too early');
    device.push(since, 'mine');
    device.push(since + 1, 'not mine', 999);
    const { entries, stream } = follow(device, { since });
    await tick();
    stream.stop();
    expect(device.spawned[0]?.slice(-2)).toEqual(['-T', '11-01 10:03:00.000']);
    expect(entries.map((entry) => entry.message)).toEqual(['mine']);
  });

  it('resume wins over since, and a line count stays for a start without a point in time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const since = Date.UTC(2026, 10, 1, 3, 1, 0);
    const resumeTs = Date.UTC(2026, 10, 1, 3, 2, 0);
    follow(device, { since, resume: { deviceTs: resumeTs, linesAtTs: 1 } }).stream.stop();
    follow(device).stream.stop();
    follow(device, { historyLines: 1 }).stream.stop();
    expect(device.spawned.map((args) => args.at(-1))).toEqual(['11-01 10:02:00.000', '2000', '1']);
  });

  it('keeps the epoch `-T` of API >= 24 and its line counts', async () => {
    const spawned: (readonly string[])[] = [];
    const adb: Adb = {
      path: 'fake-adb',
      exec: () => Promise.resolve(''),
      reverse: () => Promise.resolve(),
      removeReverse: () => Promise.resolve(),
      spawn: (args) => {
        spawned.push(args);
        return new FakeChild();
      },
    };
    const common = { adb, serial: 'emulator-5554', pid: 1105, clockOffsetMs: 0, onEntry: () => undefined };
    startLogcatStream({ ...common, onExit: () => undefined }).stop();
    startLogcatStream({ ...common, since: 1_793_474_375_250, onExit: () => undefined }).stop();
    startLogcatStream({
      ...common,
      resume: { deviceTs: 1_793_474_375_007, linesAtTs: 1 },
      onExit: () => undefined,
    }).stop();
    expect(spawned.map((args) => args.join(' '))).toEqual([
      '-s emulator-5554 logcat -v epoch --pid=1105 -T 200',
      '-s emulator-5554 logcat -v epoch --pid=1105 -T 1793474375.250',
      '-s emulator-5554 logcat -v epoch --pid=1105 -T 1793474375.007',
    ]);
  });
});

describe('formatLegacyTimestamp', () => {
  const at = (zoneMs: number): LegacyLogClock => ({ utcOffsetMs: zoneMs, probeMs: 0 });
  const ts = Date.UTC(2026, 10, 1, 3, 4, 5, 7);

  it('writes the device local wall time with milliseconds, in every zone', () => {
    expect(formatLegacyTimestamp(ts, at(0), ts)).toBe('11-01 03:04:05.007');
    expect(formatLegacyTimestamp(ts, at(7 * HOUR), ts)).toBe('11-01 10:04:05.007');
    expect(formatLegacyTimestamp(ts, at(-9.5 * HOUR), ts)).toBe('10-31 17:34:05.007');
    expect(formatLegacyTimestamp(ts, at(5.5 * HOUR), ts)).toBe('11-01 08:34:05.007');
    expect(formatLegacyTimestamp(ts, at(5.75 * HOUR), ts)).toBe('11-01 08:49:05.007');
  });

  it('follows the local calendar across midnight and a leap day', () => {
    const leap = Date.UTC(2028, 1, 28, 20, 0, 0, 0);
    expect(formatLegacyTimestamp(leap, at(7 * HOUR), leap)).toBe('02-29 03:00:00.000');
    expect(formatLegacyTimestamp(leap, at(0), leap)).toBe('02-28 20:00:00.000');
  });

  it('judges the year on the device local time, not on UTC', () => {
    const utcNewYearsEve = Date.UTC(2026, 11, 31, 20, 0, 0, 0);
    expect(formatLegacyTimestamp(utcNewYearsEve, at(7 * HOUR), utcNewYearsEve + 1000)).toBe(
      '01-01 03:00:00.000',
    );
    expect(formatLegacyTimestamp(utcNewYearsEve, at(0), utcNewYearsEve + 1000)).toBe('12-31 20:00:00.000');
  });

  it('gives up (the caller replays the retained range) when the point is in another year than the device present', () => {
    const lastMs = Date.UTC(2026, 11, 31, 16, 59, 59, 999);
    const afterNewYear = Date.UTC(2026, 11, 31, 17, 0, 10, 0);
    expect(formatLegacyTimestamp(lastMs, at(7 * HOUR), lastMs)).toBe('12-31 23:59:59.999');
    expect(formatLegacyTimestamp(lastMs, at(7 * HOUR), afterNewYear)).toBeNull();
    expect(formatLegacyTimestamp(lastMs + 1, at(7 * HOUR), afterNewYear)).toBe('01-01 00:00:00.000');
  });
});

describe('legacy resume across New Year', () => {
  it('replays the whole retained range, filtering and deduplicating, when the resume point is last year and 2000+ other lines followed the gap', async () => {
    const clock: LegacyLogClock = { utcOffsetMs: 7 * HOUR, probeMs: Date.UTC(2026, 11, 31, 16, 0, 0) };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 11, 31, 17, 0, 10) });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const resumeTs = Date.UTC(2026, 11, 31, 16, 59, 30, 0);
    device.push(resumeTs - 5000, 'older than the resume point');
    device.push(resumeTs, 'delivered');
    device.push(resumeTs + 50, 'gap marker');
    const newYear = Date.UTC(2026, 11, 31, 17, 0, 0, 0);
    for (let i = 0; i < 2100; i++) device.push(newYear + i, `other ${i}`, 999);
    device.push(newYear + 5000, 'after reconnect');
    const { entries, stream } = follow(device, { resume: { deviceTs: resumeTs, linesAtTs: 1 } });
    await tick();
    stream.stop();
    expect(device.spawned[0]?.slice(-2)).toEqual(['-T', String(LEGACY_LOGCAT_RETAINED_LINES)]);
    expect(entries.map((entry) => entry.message)).toEqual(['gap marker', 'after reconnect']);
    expect(entries.map((entry) => entry.ts)).toEqual([resumeTs + 50, newYear + 5000]);
  });

  it('reads the year of every line from the probe, so lines either side of New Year keep their order', async () => {
    const clock: LegacyLogClock = { utcOffsetMs: 7 * HOUR, probeMs: Date.UTC(2026, 11, 31, 16, 59, 0) };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2027, 0, 1, 0, 0, 30) });
    const device = new LegacyLogcatDevice(clock, () => Date.now());
    const before = Date.UTC(2026, 11, 31, 16, 59, 59, 999);
    const after = Date.UTC(2026, 11, 31, 17, 0, 0, 1);
    device.push(before, 'before');
    device.push(after, 'after');
    const { entries, stream } = follow(device, { since: before });
    await tick();
    stream.stop();
    expect(entries.map((entry) => entry.message)).toEqual(['before', 'after']);
  });
});

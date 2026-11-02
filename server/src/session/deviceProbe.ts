import type { ShellSession } from '../adb/shellSession.ts';
import type { LegacyLogClock } from '../parsers/logcat.ts';
import {
  parseCpuList,
  parseDeviceEpochMs,
  parseLegacyLogClock,
  parsePositiveInt,
} from '../parsers/shellValues.ts';

/** First API level whose logcat has `-v epoch` and `--pid`. */
export const LOGCAT_EPOCH_API = 24;

export interface DeviceFacts {
  clkTck: number;
  /** All CPUs the kernel can bring online (not just the ones online right now). */
  cores: number;
  /** laptop clock − device clock, in ms. */
  clockOffsetMs: number;
  /** clockOffsetMs was measured (false: the probe failed and it is a guess of 0). */
  clockMeasured: boolean;
  /**
   * The device's logcat predates `-v epoch` / `--pid` (API < 24): its lines come as `-v threadtime` and are
   * dated with this clock. Null: the modern dialect.
   */
  legacyLogClock: LegacyLogClock | null;
}

export const DEFAULT_DEVICE_FACTS: DeviceFacts = {
  clkTck: 100,
  cores: 1,
  clockOffsetMs: 0,
  clockMeasured: false,
  legacyLogClock: null,
};
const PROBE_TIMEOUT_MS = 3000;

/**
 * Read CLK_TCK, the CPU count and the device clock offset. Each probe is independent: a failure is
 * reported through `onError` and that value keeps its default.
 */
export async function probeDevice(
  shell: ShellSession,
  now: () => number,
  onError: (error: unknown) => void,
): Promise<DeviceFacts> {
  const facts = { ...DEFAULT_DEVICE_FACTS };
  const attempt = async (probe: () => Promise<void>): Promise<void> => {
    try {
      await probe();
    } catch (error) {
      onError(error);
    }
  };

  await attempt(async () => {
    facts.clkTck = parsePositiveInt(await shell.run('getconf CLK_TCK', PROBE_TIMEOUT_MS)) ?? facts.clkTck;
  });
  await attempt(async () => {
    const possible = parseCpuList(await shell.run('cat /sys/devices/system/cpu/possible', PROBE_TIMEOUT_MS));
    facts.cores =
      possible ?? parsePositiveInt(await shell.run('nproc --all', PROBE_TIMEOUT_MS)) ?? facts.cores;
  });
  await attempt(async () => {
    const before = now();
    const deviceMs = parseDeviceEpochMs(await shell.run('date +%s%3N', PROBE_TIMEOUT_MS));
    const after = now();
    if (deviceMs === null) return;
    facts.clockOffsetMs = Math.round((before + after) / 2 - deviceMs);
    facts.clockMeasured = true;
  });
  await attempt(async () => {
    const apiLevel = parsePositiveInt(await shell.run('getprop ro.build.version.sdk', PROBE_TIMEOUT_MS));
    if (apiLevel === null || apiLevel >= LOGCAT_EPOCH_API) return;
    // Legacy logcat even when its clock can't be read: lines dated as UTC are better than none.
    const probeMs = now() - facts.clockOffsetMs;
    facts.legacyLogClock = { utcOffsetMs: 0, probeMs };
    const clock = parseLegacyLogClock(await shell.run('date "+%s %Y-%m-%d %H:%M:%S"', PROBE_TIMEOUT_MS));
    if (clock) facts.legacyLogClock = clock;
  });
  return facts;
}

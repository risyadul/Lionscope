import type { ShellSession } from '../adb/shellSession.ts';
import { parseCpuList, parseDeviceEpochMs, parsePositiveInt } from '../parsers/shellValues.ts';

export interface DeviceFacts {
  clkTck: number;
  /** All CPUs the kernel can bring online (not just the ones online right now). */
  cores: number;
  /** laptop clock − device clock, in ms. */
  clockOffsetMs: number;
}

export const DEFAULT_DEVICE_FACTS: DeviceFacts = { clkTck: 100, cores: 1, clockOffsetMs: 0 };
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
    if (deviceMs !== null) facts.clockOffsetMs = Math.round((before + after) / 2 - deviceMs);
  });
  return facts;
}

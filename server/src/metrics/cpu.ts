export interface CpuReading {
  /** utime + stime of the process, in clock ticks. */
  ticks: number;
  /** Monotonic time of the reading in seconds (device /proc/uptime, or laptop clock as fallback). */
  atSec: number;
  threads: number;
}

export interface CpuUsage {
  percent: number;
  percentSingleCore: number;
  threads: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * CPU usage between two readings of the same process:
 * percentSingleCore = Δticks / (clkTck · Δsec) · 100, percent = percentSingleCore / cores.
 * Returns null without a baseline or when no time has elapsed.
 */
export function computeCpuUsage(
  previous: CpuReading | null,
  current: CpuReading,
  clkTck: number,
  cores: number,
): CpuUsage | null {
  if (!previous) return null;
  const elapsedSec = current.atSec - previous.atSec;
  if (!(elapsedSec > 0) || clkTck <= 0) return null;
  const safeCores = Math.max(1, cores);
  const deltaTicks = Math.max(0, current.ticks - previous.ticks);
  const single = Math.min((deltaTicks / (clkTck * elapsedSec)) * 100, 100 * safeCores);
  return {
    percent: round2(Math.min(single / safeCores, 100)),
    percentSingleCore: round2(single),
    threads: current.threads,
  };
}

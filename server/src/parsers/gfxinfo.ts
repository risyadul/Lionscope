export const DEFAULT_FRAME_INTERVAL_MS = 1000 / 60;

/** The framestats history HWUI keeps per window; a poll returning this many rows may have lost frames. */
export const FRAMESTATS_HISTORY_ROWS = 120;

export interface ParsedFrame {
  intendedVsyncNs: number;
  durationMs: number;
  /** FrameInterval (API 31+), or null when the column is missing. */
  reportedIntervalMs: number | null;
  /** FrameCompleted > FrameDeadline (API 31+), or null when there is no FrameDeadline column. */
  missedDeadline: boolean | null;
}

/**
 * HWUI's own FrameInfoFlags (WindowVisibilityChanged, RTAnimation, SurfaceCanvas, SkippedFrame = bits
 * 0–3) mark outlier rows. Higher bits are vendor additions and say nothing about the frame: HyperOS
 * (Xiaomi, Android 15) sets bit 5 on every normal frame, so a plain "Flags ≠ 0" filter drops them all.
 */
const AOSP_OUTLIER_FLAGS = 0b1111;
const MIN_PLAUSIBLE_INTERVAL_MS = 4;
const MAX_PLAUSIBLE_INTERVAL_MS = 50;
/** Longer than this is a garbage timestamp, not a slow frame. */
const MAX_PLAUSIBLE_FRAME_MS = 60_000;
const MARKER = '---PROFILEDATA---';
const NS_PER_MS = 1_000_000;

function column(header: readonly string[], name: string): number {
  return header.indexOf(name);
}

function numberAt(cells: readonly string[], index: number): number | null {
  if (index < 0) return null;
  const raw = cells[index]?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

export interface Framestats {
  frames: ParsedFrame[];
  /** Complete `---PROFILEDATA---` blocks found; 0 means there was no frame data to read at all. */
  blockCount: number;
  /** Largest number of data rows (valid or not) in any one window's block. */
  maxWindowRows: number;
  /** The `** Graphics info for pid N [package] **` header was there: gfxinfo knows the process. */
  processHeader: boolean;
  /** `Window:` sections; 0 with a process header = no window yet (e.g. during a cold start). */
  windowCount: number;
  /**
   * Vsync period inferred from the smallest positive gap between consecutive IntendedVsync values
   * within one window (for builds without FrameInterval), or null with fewer than 2 frames per window.
   */
  inferredIntervalMs: number | null;
}

interface Block {
  frames: ParsedFrame[];
  inferredIntervalMs: number | null;
}

function plausibleIntervalMs(ns: number | null): number | null {
  if (ns === null) return null;
  const ms = ns / NS_PER_MS;
  return ms >= MIN_PLAUSIBLE_INTERVAL_MS && ms <= MAX_PLAUSIBLE_INTERVAL_MS ? ms : null;
}

function smallestGapMs(vsyncs: readonly number[]): number | null {
  const sorted = [...new Set(vsyncs)].sort((a, b) => a - b);
  let smallest: number | null = null;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (gap > 0 && (smallest === null || gap < smallest)) smallest = gap;
  }
  // Outside 20–250 Hz the gap can't be one vsync period (jitter, or frames too sparse to tell).
  return plausibleIntervalMs(smallest);
}

function parseBlock(lines: readonly string[]): Block {
  const headerLine = lines.find((line) => /^[A-Za-z]/.test(line) && line.includes('IntendedVsync'));
  if (!headerLine) return { frames: [], inferredIntervalMs: null };
  const header = headerLine.split(',').map((cell) => cell.trim());
  const flagsCol = column(header, 'Flags');
  const vsyncCol = column(header, 'IntendedVsync');
  const completedCol = column(header, 'FrameCompleted');
  const intervalCol = column(header, 'FrameInterval');
  // HyperOS (Xiaomi, Android 15) swaps these two labels in the header while the data keeps AOSP's
  // order, so "FrameInterval" holds a timestamp. Fall back to the other column when it is implausible.
  const startTimeCol = column(header, 'FrameStartTime');
  const deadlineCol = column(header, 'FrameDeadline');
  if (vsyncCol < 0 || completedCol < 0) return { frames: [], inferredIntervalMs: null };

  const frames: ParsedFrame[] = [];
  for (const line of lines) {
    if (line === headerLine || !/^\d/.test(line)) continue;
    const cells = line.split(',');
    const flags = numberAt(cells, flagsCol);
    if (flagsCol >= 0 && (flags === null || (flags & AOSP_OUTLIER_FLAGS) !== 0)) continue;
    const vsync = numberAt(cells, vsyncCol);
    const completed = numberAt(cells, completedCol);
    // FrameCompleted is 0 for frames that never finished (e.g. dropped); they have no duration.
    if (vsync === null || completed === null || vsync <= 0 || completed < vsync) continue;
    const durationMs = (completed - vsync) / NS_PER_MS;
    if (durationMs > MAX_PLAUSIBLE_FRAME_MS) continue;

    const interval =
      plausibleIntervalMs(numberAt(cells, intervalCol)) ?? plausibleIntervalMs(numberAt(cells, startTimeCol));
    const deadline = deadlineCol < 0 ? null : numberAt(cells, deadlineCol);
    frames.push({
      intendedVsyncNs: vsync,
      durationMs,
      reportedIntervalMs: interval,
      missedDeadline: deadline !== null && deadline > 0 ? completed > deadline : null,
    });
  }
  return { frames, inferredIntervalMs: smallestGapMs(frames.map((frame) => frame.intendedVsyncNs)) };
}

/**
 * Parse `dumpsys gfxinfo <pid|pkg> framestats [reset]`: every block between `---PROFILEDATA---`
 * markers (one per window) is a header-driven CSV (column positions differ between Android
 * versions; rows end with a trailing comma). Rows flagged as outliers by HWUI are skipped.
 */
const PROCESS_HEADER = /^\*\* Graphics info for pid \d+ \[[^\]]*\] \*\*$/;

export function parseFramestats(text: string): Framestats {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const frames: ParsedFrame[] = [];
  let blockCount = 0;
  let maxWindowRows = 0;
  let processHeader = false;
  let windowCount = 0;
  let inferredIntervalMs: number | null = null;
  let block: string[] | null = null;
  for (const line of lines) {
    if (line === MARKER) {
      if (block) {
        const parsed = parseBlock(block);
        frames.push(...parsed.frames);
        blockCount += 1;
        maxWindowRows = Math.max(maxWindowRows, block.filter((row) => /^\d/.test(row)).length);
        if (parsed.inferredIntervalMs !== null) {
          inferredIntervalMs = Math.min(inferredIntervalMs ?? Infinity, parsed.inferredIntervalMs);
        }
        block = null;
      } else {
        block = [];
      }
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    if (line.startsWith('Window: ')) windowCount += 1;
    else if (PROCESS_HEADER.test(line)) processHeader = true;
  }
  return { frames, blockCount, maxWindowRows, processHeader, windowCount, inferredIntervalMs };
}

/**
 * Layout inflation figures (0.4.0). The Layouts tab rows and per-screen totals live in @lionscope/protocol/insights
 * (shared with the agent tools); the Main thread lane's markers and hit testing stay here.
 */
import type { InflateSample } from '@lionscope/protocol/wire';
import { SLOW_INFLATE_MS } from '@lionscope/protocol/wire';
import { isNested } from '@lionscope/protocol/insights';

export {
  aggregateLayouts,
  inflateByScreen,
  inflatesInWindow,
  isNested,
  latestViewTrees,
  layoutName,
  layoutRowKey,
  pathLabel,
  sortLayoutRows,
  UNKNOWN_LAYOUT,
} from '@lionscope/protocol/insights';
export type { LayoutRow, LayoutSortKey, ScreenInflate } from '@lionscope/protocol/insights';

/** Inflations drawn as markers on the Main thread lane: top-level ones whose slowest of a window reached the threshold. */
export function slowInflates(
  inflates: readonly InflateSample[],
  fromTs: number,
  toTs: number,
): InflateSample[] {
  // A marker spans ts..ts+maxMs, so one that started just before the window can still reach into it.
  return inflates.filter(
    (s) => !isNested(s) && s.maxMs >= SLOW_INFLATE_MS && s.ts + s.maxMs >= fromTs && s.ts <= toTs,
  );
}

/** Stable identity of an inflation sample: unique per (slowest start, layout or label, screen), as a tuple. */
export function inflateKey(
  sample: Pick<InflateSample, 'ts' | 'layout' | 'label' | 'screen' | 'nested'>,
): string {
  return JSON.stringify([sample.ts, sample.layout, sample.label, sample.screen, isNested(sample)]);
}

/** Pointer tolerance around an inflation pill, px. */
export const INFLATE_HIT_SLOP_PX = 5;
/** Pills are drawn at least this wide, px. */
export const INFLATE_MIN_PX = 4;

/** The pill under the pointer, or null. Nearest wins; on a tie the later (drawn on top) one. */
export function hitTestInflates(
  items: readonly InflateSample[],
  query: { ts: number; pxPerMs: number },
): InflateSample | null {
  if (!(query.pxPerMs > 0)) return null;
  let best: InflateSample | null = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const end = Math.max(item.ts + item.maxMs, item.ts + INFLATE_MIN_PX / query.pxPerMs);
    const distance =
      query.ts >= item.ts && query.ts <= end
        ? 0
        : Math.min(Math.abs(query.ts - item.ts), Math.abs(query.ts - end)) * query.pxPerMs;
    if (distance > INFLATE_HIT_SLOP_PX) continue;
    if (distance < bestDistance || (distance === bestDistance && best !== null && item.ts > best.ts)) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

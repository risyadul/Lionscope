/** Per-screen aggregation for the screens table; shared with the agent tools in @lionscope/protocol/insights. */
export {
  aggregateScreens,
  dominantStage,
  MIN_P90_BUCKET_FRAMES,
  sortScreenRows,
  weightedMedian,
  withLayoutStats,
  withStallCounts,
} from '@lionscope/protocol/insights';
export type { ScreenRow, ScreenSortKey, SortDirection, StageShare } from '@lionscope/protocol/insights';

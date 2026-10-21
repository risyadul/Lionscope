/** Display names and color tokens for FrameMetrics stages, shared by the lane and the screens table. */
import type { FrameStage } from '@lionscope/protocol/wire';
import type { ChartColor } from './theme.ts';

export const STAGE_LABELS: Readonly<Record<FrameStage, string>> = {
  input: 'Input',
  animation: 'Animation',
  layout: 'Measure/layout',
  draw: 'Draw',
  sync: 'Sync',
  command: 'Command issue',
  swap: 'Swap buffers',
  delay: 'Delay',
  gpu: 'GPU',
};

/** Short legend names; the full name is in the title. */
export const STAGE_SHORT_LABELS: Readonly<Record<FrameStage, string>> = {
  input: 'Input',
  animation: 'Anim',
  layout: 'Layout',
  draw: 'Draw',
  sync: 'Sync',
  command: 'Cmd',
  swap: 'Swap',
  delay: 'Delay',
  gpu: 'GPU',
};

/** Hue = the thread doing the work (UI blue, RenderThread green, GPU magenta); delay recedes. */
export const STAGE_COLORS: Readonly<Record<FrameStage, ChartColor>> = {
  input: 'stageInput',
  animation: 'stageAnimation',
  layout: 'stageLayout',
  draw: 'stageDraw',
  sync: 'stageSync',
  command: 'stageCommand',
  swap: 'stageSwap',
  delay: 'stageDelay',
  gpu: 'stageGpu',
};

export const STAGE_HINT =
  'Mean milliseconds per frame in each FrameMetrics stage, stacked in pipeline order: delay (waiting before the frame started) at the bottom, then UI thread (input → draw), RenderThread (sync → swap) and GPU (API 31+). GPU runs in parallel, so the stack can exceed the wall-clock frame time. Bars taller than the axis are clipped and marked at the top.';

/**
 * Stack order, bottom → top: delay first because it happens before the frame starts, then the
 * UI thread, RenderThread and GPU. Used by the lane, its legend and the table's stage bar.
 */
export const STACK_ORDER: readonly FrameStage[] = [
  'delay',
  'input',
  'animation',
  'layout',
  'draw',
  'sync',
  'command',
  'swap',
  'gpu',
];

export const STAGE_TOTAL_LABEL = 'Σ stages';
export const STAGE_TOTAL_HINT =
  'Sum of the stage means. GPU runs in parallel with the CPU stages, so this can exceed the wall-clock frame time.';

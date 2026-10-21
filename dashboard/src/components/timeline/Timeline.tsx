import { useMemo, useState, type ReactNode } from 'react';
import type {
  CpuSample,
  FrameBreakdownSample,
  FrameSample,
  FrameSource,
  MemorySample,
  ScreenSpan,
  TimelineEvent,
} from '@lionscope/protocol/wire';
import { useColorScheme } from '../../hooks/useColorScheme.ts';
import { formatFixed, formatMb } from '../../lib/format.ts';
import {
  buildBreakdownData,
  buildCpuData,
  buildFrameRateData,
  buildFrameTimeData,
  buildMemoryData,
  budgetLabel,
  frameFeed,
  type FrameFeed,
  isFrameIntervalAssumed,
  latestBreakdownInterval,
  latestFrameInterval,
  type CpuMode,
} from '../../lib/series.ts';
import type { Signal } from '../../lib/signal.ts';
import {
  STACK_ORDER,
  STAGE_COLORS,
  STAGE_HINT,
  STAGE_LABELS,
  STAGE_SHORT_LABELS,
  STAGE_TOTAL_HINT,
  STAGE_TOTAL_LABEL,
} from '../../lib/stages.ts';
import { GFXINFO_HINT, NO_UI_FRAMES, SDK_FRAMES_HINT, UI_IDLE } from '../../lib/stats.ts';
import { readDocumentTheme } from '../../lib/theme.ts';
import {
  BREAKDOWN_SPEC,
  CPU_SINGLE_CORE_SPEC,
  CPU_SPEC,
  FRAME_RATE_SPEC,
  FRAME_TIME_SPEC,
  MEMORY_SPEC,
  type Threshold,
} from './chartSpec.ts';
import { Lane, type LegendItem } from './Lane.tsx';
import { ScreensLane } from './ScreensLane.tsx';
import type { Backdrop } from './uplotOptions.ts';
import './timeline.css';

const pct = (v: number) => `${formatFixed(v, 1)}%`;
const ms = (v: number) => `${formatFixed(v, 1)} ms`;
const fps = (v: number) => formatFixed(v, 0);
const mb = (v: number) => formatMb(v);
/** The lane subtitle carries the unit; ten legend values need to stay short. */
const stageMs = (v: number) => formatFixed(v, 1);

const CPU_LEGEND: readonly LegendItem[] = [
  { label: 'CPU', color: 'cpu', key: 'line', column: 0, format: pct },
];

// Legend reads top of the stack first; columns index `buildMemoryData().raw`.
const MEMORY_LEGEND: readonly LegendItem[] = [
  { label: 'Total', color: 'memTotal', key: 'thin', column: 5, format: mb },
  { label: 'Java', color: 'memJava', key: 'area', column: 1, format: mb },
  { label: 'Native', color: 'memNative', key: 'area', column: 0, format: mb },
  { label: 'Graphics', color: 'memGraphics', key: 'area', column: 2, format: mb },
  { label: 'Code', color: 'memCode', key: 'area', column: 3, format: mb },
  { label: 'Other', color: 'memOther', key: 'area', column: 4, format: mb },
];

// Columns index `buildFrameRateData(...).slice(1)`: [slow/s, janky/s, fps].
function frameRateLegend(zeroLabel: string): readonly LegendItem[] {
  return [
    // 0 FPS means nothing was drawn — not a frame-rate drop.
    { label: 'FPS', color: 'fps', key: 'line', column: 2, format: (v) => (v === 0 ? zeroLabel : fps(v)) },
    { label: 'Janky/s', color: 'jank', key: 'bar', column: 1, format: (v) => formatFixed(v, 1) },
    {
      label: 'Slow/s',
      color: 'jank',
      key: 'bar',
      isTinted: true,
      column: 0,
      format: (v) => formatFixed(v, 1),
    },
  ];
}

const GFXINFO_FRAME_RATE_LEGEND = frameRateLegend(NO_UI_FRAMES);
const SDK_FRAME_RATE_LEGEND = frameRateLegend(UI_IDLE);

const FRAME_TIME_LEGEND: readonly LegendItem[] = [
  { label: 'p90', color: 'frameTime', key: 'line', column: 1, format: ms },
  { label: 'p50', color: 'frameTime', key: 'thin', column: 0, format: ms },
  { label: 'max', color: 'frameMax', key: 'thin', column: 2, format: ms },
];

// Columns index `buildBreakdownData().raw`: one per stage (stack order, bottom first), then Σ.
const BREAKDOWN_LEGEND: readonly LegendItem[] = [
  ...STACK_ORDER.map((stage, i): LegendItem => ({
    label: STAGE_SHORT_LABELS[stage],
    title: STAGE_LABELS[stage],
    color: STAGE_COLORS[stage],
    key: 'area',
    column: i,
    format: stageMs,
  })),
  {
    label: STAGE_TOTAL_LABEL,
    title: STAGE_TOTAL_HINT,
    color: 'ink',
    key: 'thin',
    column: STACK_ORDER.length,
    format: stageMs,
  },
];

/** The largest stage at the shown position (the total is not a stage). */
function dominantLegendIndex(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < STACK_ORDER.length; i++) {
    const value = values[i];
    if (value === null || value === undefined || value <= 0) continue;
    if (best === null || value > (values[best] ?? 0)) best = i;
  }
  return best;
}

const SOURCE_LABELS: Record<FrameSource, string> = { gfxinfo: 'gfxinfo', sdk: 'SDK FrameMetrics' };
const SDK_IDLE_TITLE =
  'The SDK is linked but the app’s windows drew no frames. Until they do, gfxinfo polling may fill in.';

function SourceTag({ feed }: { feed: FrameFeed }) {
  if (feed.isSdkIdle) {
    return (
      <span className="source-tag" data-source="sdk" data-idle title={SDK_IDLE_TITLE}>
        SDK · idle
      </span>
    );
  }
  return (
    <span className="source-tag" data-source={feed.source}>
      {SOURCE_LABELS[feed.source]}
    </span>
  );
}

type Props = {
  cpu: readonly CpuSample[];
  memory: readonly MemorySample[];
  frames: readonly FrameSample[];
  events: readonly TimelineEvent[];
  screens: readonly ScreenSpan[];
  breakdown: readonly FrameBreakdownSample[];
  /** Show the Screens lane (an SDK is connected or spans were recorded). */
  showScreens: boolean;
  /**
   * Keep the breakdown lane mounted (an SDK is connected or buckets are buffered) even while no
   * bucket is in the window, so lanes don't reflow as frames come and go.
   */
  showBreakdown: boolean;
  /** The in-app SDK is linked: it owns frame accounting, idle or not. */
  isSdkConnected: boolean;
  selectedScreen: string | null;
  onSelectScreen: (name: string | null) => void;
  /** Reveals the screens table; offered next to a selection while the table is hidden. */
  onViewScreens?: () => void;
  /** Right edge of the visible window, epoch ms. */
  endTs: number;
  windowMs: number;
  probeTs: Signal<number | null>;
  cursorX: Signal<number | null>;
  /** Window / pause controls, in one row above every lane they scope. */
  toolbar: ReactNode;
  overlay?: ReactNode;
  notice?: ReactNode;
};

export function Timeline({
  cpu,
  memory,
  frames,
  events,
  screens,
  breakdown,
  showScreens,
  showBreakdown,
  isSdkConnected,
  selectedScreen,
  onSelectScreen,
  onViewScreens,
  endTs,
  windowMs,
  probeTs,
  cursorX,
  toolbar,
  overlay,
  notice,
}: Props) {
  const scheme = useColorScheme();
  // Canvas colors are resolved from CSS tokens once per color scheme.
  const theme = useMemo(() => readDocumentTheme(scheme), [scheme]);
  const [cpuMode, setCpuMode] = useState<CpuMode>('normalized');

  const cpuData = useMemo(() => buildCpuData(cpu, cpuMode), [cpu, cpuMode]);
  const memoryData = useMemo(() => buildMemoryData(memory), [memory]);
  const frameRateData = useMemo(() => buildFrameRateData(frames), [frames]);
  const frameTimeData = useMemo(() => buildFrameTimeData(frames), [frames]);
  const budget = latestFrameInterval(frames);
  const isBudgetAssumed = isFrameIntervalAssumed(frames);
  const thresholds = useMemo<readonly Threshold[]>(
    () => [{ value: budget, label: budgetLabel(budget, isBudgetAssumed) }],
    [budget, isBudgetAssumed],
  );

  const breakdownData = useMemo(() => buildBreakdownData(breakdown), [breakdown]);
  const breakdownBudget = latestBreakdownInterval(breakdown);
  const breakdownThresholds = useMemo<readonly Threshold[]>(
    () => [{ value: breakdownBudget, label: budgetLabel(breakdownBudget, false) }],
    [breakdownBudget],
  );
  const feed = frameFeed(frames, isSdkConnected);
  const frameHint = feed.source === 'sdk' ? SDK_FRAMES_HINT : GFXINFO_HINT;

  const xMax = endTs / 1000;
  const xMin = xMax - windowMs / 1000;
  const startTs = endTs - windowMs;
  const backdrop = useMemo<Backdrop | null>(
    () => (screens.length === 0 ? null : { spans: screens, openEnd: endTs, selected: selectedScreen }),
    [screens, endTs, selectedScreen],
  );
  const shared = { theme, xMin, xMax, backdrop, events, probeTs, cursorX };

  const cpuToggle = (
    <button
      type="button"
      className="lane-toggle"
      aria-pressed={cpuMode === 'singleCore'}
      onClick={() => setCpuMode((m) => (m === 'normalized' ? 'singleCore' : 'normalized'))}
      title="Show CPU relative to a single core (can exceed 100% on multi-core devices)"
    >
      1 core
    </button>
  );

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-toolbar">
        <span className="overline">Timeline</span>
        {toolbar}
      </div>
      {notice}
      <div className="timeline-lanes" data-dense={(showScreens && showBreakdown) || undefined}>
        {showScreens && (
          <ScreensLane
            spans={screens}
            fromTs={startTs}
            toTs={endTs}
            openEnd={endTs}
            selected={selectedScreen}
            onSelect={onSelectScreen}
            onViewInTable={onViewScreens}
            cursorX={cursorX}
            probeTs={probeTs}
          />
        )}
        <Lane
          id="lane-cpu"
          title="CPU"
          unit={cpuMode === 'normalized' ? '% of all cores' : '% of one core'}
          spec={cpuMode === 'normalized' ? CPU_SPEC : CPU_SINGLE_CORE_SPEC}
          data={cpuData}
          legendItems={CPU_LEGEND}
          legendColumns={cpuData.slice(1)}
          showEventLabels
          controls={cpuToggle}
          weight={1}
          {...shared}
        />
        <Lane
          id="lane-memory"
          title="Memory"
          unit="PSS · MB"
          spec={MEMORY_SPEC}
          data={memoryData.data}
          legendItems={MEMORY_LEGEND}
          legendColumns={memoryData.raw}
          weight={1.25}
          {...shared}
        />
        <Lane
          id="lane-frames"
          title="Rendering"
          unit="frames / s"
          hint={frameHint}
          controls={<SourceTag feed={feed} />}
          spec={FRAME_RATE_SPEC}
          data={frameRateData}
          legendItems={feed.source === 'sdk' ? SDK_FRAME_RATE_LEGEND : GFXINFO_FRAME_RATE_LEGEND}
          legendColumns={frameRateData.slice(1)}
          weight={1}
          {...shared}
        />
        <Lane
          id="lane-frametime"
          title="Frame time"
          unit="ms · p50–p90 band"
          controls={<SourceTag feed={feed} />}
          spec={FRAME_TIME_SPEC}
          data={frameTimeData}
          legendItems={FRAME_TIME_LEGEND}
          legendColumns={frameTimeData.slice(1)}
          thresholds={thresholds}
          showTimeAxis={!showBreakdown}
          weight={1.1}
          {...shared}
        />
        {showBreakdown && (
          <Lane
            id="lane-breakdown"
            title="Frame breakdown"
            unit="mean ms / frame · by stage"
            hint={STAGE_HINT}
            spec={BREAKDOWN_SPEC}
            data={breakdownData.data}
            legendItems={BREAKDOWN_LEGEND}
            legendColumns={breakdownData.raw}
            thresholds={breakdownThresholds}
            pickEmphasis={dominantLegendIndex}
            showTimeAxis
            weight={1.2}
            {...shared}
          />
        )}
      </div>
      {overlay}
    </section>
  );
}

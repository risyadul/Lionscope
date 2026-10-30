/** `get_summary` and `get_screens`: the stat strip, the Screens table and the headline numbers of a window. */
import { z } from 'zod';
import type { CpuSample, MemorySample, Snapshot } from '@lionscope/protocol';
import {
  aggregateFrames,
  aggregateLayouts,
  FRAMES_STALE_MS,
  aggregateScreens,
  inflateByScreen,
  latestViewTrees,
  sortLayoutRows,
  sortScreenRows,
  stallsByScreen,
  summarizeFrames,
  summarizeWindow,
  withLayoutStats,
  withStallCounts,
} from '@lionscope/protocol/insights';
import type { ScreenRow } from '@lionscope/protocol/insights';
import { sessionView } from './statusTools.ts';
import { defineTool, READ_ONLY, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { round, timeWindow, windowInput, windowView } from './views.ts';
import type { TimeWindow } from './views.ts';

const TOP_ROWS = 5;

function inWindow<T extends { ts: number }>(samples: readonly T[], window: TimeWindow): T[] {
  return samples.filter((sample) => sample.ts >= window.fromTs && sample.ts <= window.toTs);
}

/** The Screens table rows, worst jank first (the dashboard's default order). */
export function screenRows(snapshot: Snapshot, window: TimeWindow): ScreenRow[] {
  const { fromTs, toTs } = window;
  const rows = withLayoutStats(
    withStallCounts(
      aggregateScreens(snapshot.breakdown ?? [], fromTs, toTs),
      stallsByScreen(snapshot.stalls ?? [], fromTs, toTs),
    ),
    inflateByScreen(snapshot.inflates ?? [], fromTs, toTs),
    latestViewTrees(snapshot.viewTrees ?? [], toTs),
  );
  return sortScreenRows(rows, 'jankPercent', 'desc');
}

function cpuView(samples: readonly CpuSample[]) {
  const latest = samples.at(-1);
  if (!latest) return null;
  const percents = samples.map((sample) => sample.percent);
  return {
    latestPercent: round(latest.percent),
    meanPercent: round(percents.reduce((sum, value) => sum + value, 0) / percents.length),
    maxPercent: round(Math.max(...percents)),
    latestSingleCorePercent: round(latest.percentSingleCore),
    threads: latest.threads,
  };
}

const mb = (kb: number) => round(kb / 1024);

function memoryView(samples: readonly MemorySample[]) {
  const latest = samples.at(-1);
  if (!latest) return null;
  return {
    totalPssMb: mb(latest.totalPssKb),
    maxTotalPssMb: mb(Math.max(...samples.map((sample) => sample.totalPssKb))),
    javaHeapMb: mb(latest.javaHeapKb),
    nativeHeapMb: mb(latest.nativeHeapKb),
    codeMb: mb(latest.codeKb),
    stackMb: mb(latest.stackKb),
    graphicsMb: mb(latest.graphicsKb),
    privateOtherMb: mb(latest.privateOtherKb),
    systemMb: mb(latest.systemKb),
  };
}

function framesView(snapshot: Snapshot, window: TimeWindow, now: number) {
  const summary = summarizeFrames(snapshot.frames, window.fromTs, window.toTs);
  // The stat strip's readout: the 30 s ending at the newest frame sample, blank once that sample is stale.
  const newest = snapshot.frames.at(-1);
  const recent = newest && now - newest.ts <= FRAMES_STALE_MS ? aggregateFrames(snapshot.frames) : null;
  return {
    source: summary.source,
    meanFps: round(summary.meanFps),
    latestFps: round(inWindow(snapshot.frames, window).at(-1)?.fps ?? null),
    renderedFrames: summary.renderedFrames,
    jankFrames: summary.jankFrames,
    jankPercent: round(summary.jankPercent, 2),
    slowFrames: summary.slowFrames,
    slowPercent: round(summary.slowPercent, 2),
    p50Ms: round(summary.p50Ms),
    p90Ms: round(summary.p90Ms),
    maxMs: round(summary.maxMs),
    frameIntervalMs: round(summary.frameIntervalMs, 2),
    last30s: recent && {
      jankPercent:
        recent.renderedFrames > 0 ? round((recent.jankFrames / recent.renderedFrames) * 100, 2) : null,
      p90Ms: round(recent.p90Ms),
      renderedFrames: recent.renderedFrames,
    },
  };
}

function screenView(row: ScreenRow) {
  return {
    name: row.name,
    frames: row.frames,
    jankPercent: round(row.jankPercent, 2),
    slowPercent: round(row.slowPercent, 2),
    typicalP90Ms: round(row.typicalP90Ms),
    worstP90Ms: round(row.worstP90Ms),
    dominantStage: row.dominant ? { stage: row.dominant.stage, ms: round(row.dominant.ms, 2) } : null,
    stalls: { count: row.stallCount, blockedMs: round(row.stallMs, 0) },
    inflate: {
      count: row.inflateCount,
      totalMs: round(row.inflateMs),
      slowest: row.slowestInflate
        ? { name: row.slowestInflate.name, ms: round(row.slowestInflate.ms) }
        : null,
    },
    viewTree: row.viewTree ? { views: row.viewTree.views, maxDepth: row.viewTree.maxDepth } : null,
  };
}

export const summaryTool = defineTool({
  name: 'get_summary',
  title: 'Performance summary',
  description: `Headline numbers of the profiled app over a time window (default the last minute): CPU % (normalized to all cores), memory (PSS total and breakdown, MB), frames (mean/latest FPS, jank % = frames that missed their deadline, slow % = frames over one vsync, p50/p90/max frame time in ms, frame source sdk or gfxinfo, plus the dashboard stat strip's last-30-s jank and p90, null once frames stop arriving), main-thread stalls (count, blocked ms, worst), StrictMode violations, process restarts, the top ${TOP_ROWS} screens by jank and the top ${TOP_ROWS} app layouts by inflate time. Start with this, then drill down with get_screens, get_stalls, get_strictmode, get_layouts, get_crashes or search_logcat. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({ window: windowInput }),
  annotations: READ_ONLY,
  async run({ window: label }, ctx) {
    const snapshot = ctx.sessions.getSnapshot();
    const window = timeWindow(ctx, snapshot, label);
    const stalls = summarizeWindow(
      snapshot.stalls ?? [],
      snapshot.strictMode ?? [],
      window.fromTs,
      window.toTs,
    );
    const events = inWindow(snapshot.events, window);
    const layouts = sortLayoutRows(
      aggregateLayouts(snapshot.inflates ?? [], window.fromTs, window.toTs, false),
      'totalMs',
      'desc',
    );
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        window: windowView(window),
        session: sessionView(ctx.sessions.getSessionState()),
        cpu: cpuView(inWindow(snapshot.cpu, window)),
        memory: memoryView(inWindow(snapshot.memory, window)),
        frames: framesView(snapshot, window, ctx.now()),
        stalls: {
          count: stalls.count,
          blockedMs: round(stalls.totalMs, 0),
          worstMs: round(stalls.worstMs, 0),
          debuggerStalls: stalls.debuggerCount,
        },
        strictMode: { violations: stalls.strictModeCount, occurrences: stalls.strictModeOccurrences },
        processRestarts: events.filter((event) => event.kind === 'process_restart').length,
        processDeaths: events.filter((event) => event.kind === 'process_died').length,
        topScreensByJank: screenRows(snapshot, window)
          .filter((row) => row.frames > 0)
          .slice(0, TOP_ROWS)
          .map((row) => ({
            name: row.name,
            frames: row.frames,
            jankPercent: round(row.jankPercent, 2),
            typicalP90Ms: round(row.typicalP90Ms),
          })),
        topLayoutsByInflate: layouts.slice(0, TOP_ROWS).map((row) => ({
          name: row.name,
          count: row.count,
          totalMs: round(row.totalMs),
          maxMs: round(row.maxMs),
        })),
      },
    };
  },
});

export const screensTool = defineTool({
  name: 'get_screens',
  title: 'Per-screen frames',
  description: `The dashboard's Screens table (needs the in-app SDK): one row per screen (Activity/Fragment/dialog name, null = no screen on top) over the window, worst jank first. Each row: frames drawn, jank % (missed deadline), slow % (over one vsync), typical p90 frame time (frame-weighted median of 0.5 s bucket p90s, ms) and the worst bucket p90, the dominant FrameMetrics stage (mean ms per frame), main-thread stalls on the screen (count, blocked ms), layout inflation on it (count, total ms, slowest layout) and its latest view tree (views, depth). ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    window: windowInput,
    limit: z.number().int().min(1).max(100).default(30).describe('Most rows returned (1-100).'),
  }),
  annotations: READ_ONLY,
  async run({ window: label, limit }, ctx) {
    const snapshot = ctx.sessions.getSnapshot();
    const window = timeWindow(ctx, snapshot, label);
    const rows = screenRows(snapshot, window);
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        window: windowView(window),
        total: rows.length,
        screens: rows.slice(0, limit).map(screenView),
      },
    };
  },
});

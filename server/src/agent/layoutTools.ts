/** `get_layouts` and `get_view_tree`: XML inflation timing and view hierarchies (SDK 0.4.0+). */
import { z } from 'zod';
import {
  aggregateLayouts,
  layoutRowKey,
  inflatesInWindow,
  latestViewTrees,
  pathLabel,
  sortLayoutRows,
} from '@lionscope/protocol/insights';
import type { ViewTreeSample } from '@lionscope/protocol';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import { iso, round, timeWindow, truncate, windowInput, windowView } from './views.ts';

const MAX_LAYOUTS = 50;
/** View trees listed without a screen (the newest ones). */
const MAX_TREES = 20;

export const layoutsTool = defineTool({
  name: 'get_layouts',
  title: 'Layout inflation',
  description: `The dashboard's Layouts tab: one row per XML layout the app inflated on the main thread in the window, most total inflate time first. Each row: name (resource name, or <View>:<line> when unresolved), count, nested count (inflated inside another layout, already part of that one's time), total/mean/max ms (a lower bound: parser setup is not timed), views created by the slowest inflation, and the screens it was inflated on. Library/framework layouts are hidden unless includeLibrary. Needs the in-app SDK 0.4.0+ on Android 10+. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    window: windowInput,
    includeLibrary: z.boolean().default(false).describe('Include library and framework layouts.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LAYOUTS)
      .default(20)
      .describe(`Most rows returned (1-${MAX_LAYOUTS}).`),
  }),
  annotations: READ_ONLY,
  async run({ window: label, includeLibrary, limit }, ctx) {
    const snapshot = ctx.sessions.getSnapshot();
    const window = timeWindow(ctx, snapshot, label);
    const inflates = snapshot.inflates ?? [];
    const rows = sortLayoutRows(
      aggregateLayouts(inflates, window.fromTs, window.toTs, includeLibrary),
      'totalMs',
      'desc',
    );
    const hiddenLibrary = includeLibrary
      ? 0
      : new Set(
          inflatesInWindow(inflates, window.fromTs, window.toTs)
            .filter((sample) => sample.library)
            .map(layoutRowKey),
        ).size;
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        window: windowView(window),
        inflateTracking: ctx.sessions.getSessionState().sdk?.options?.inflateTracking ?? null,
        total: rows.length,
        hiddenLibraryLayouts: hiddenLibrary,
        layouts: rows.slice(0, limit).map((row) => ({
          name: row.name,
          isLabel: row.isLabel,
          library: row.library,
          count: row.count,
          nestedCount: row.nestedCount,
          totalMs: round(row.totalMs),
          meanMs: round(row.meanMs, 2),
          maxMs: round(row.maxMs),
          views: row.views,
          screens: row.screens,
        })),
      },
    };
  },
});

function treeView(tree: ViewTreeSample) {
  return {
    screen: tree.screen,
    window: tree.window,
    at: iso(tree.ts),
    views: tree.views,
    viewGroups: tree.viewGroups,
    maxDepth: tree.maxDepth,
    deepestPath: truncate(pathLabel(tree), 2000),
    topClasses: tree.topClasses,
  };
}

export const viewTreeTool = defineTool({
  name: 'get_view_tree',
  title: 'View tree',
  description: `The latest view hierarchy snapshot the in-app SDK took of a screen (once per screen visit, after its first frame): total views and view groups, depth, the path to the deepest view (Class#id › …, root first) and the most frequent view classes. Without screen, the latest tree of each screen in the buffer, newest first (at most 20). Screen names are those get_screens reports. ${UNTRUSTED_DESCRIPTION}`,
  access: 'read',
  input: z.object({
    screen: z.string().max(256).optional().describe('Screen name; omit for every screen.'),
  }),
  annotations: READ_ONLY,
  async run({ screen }, ctx) {
    const latest = latestViewTrees(ctx.sessions.getSnapshot().viewTrees ?? [], Infinity);
    // Newest first, so a long session's list keeps the screens seen last.
    const all = [...latest.values()].sort((a, b) => b.ts - a.ts);
    if (screen !== undefined) {
      const tree = latest.get(screen);
      if (!tree) {
        const names = all.slice(0, MAX_TREES).map((candidate) => candidate.screen);
        const more = all.length > MAX_TREES ? `, … ${all.length - MAX_TREES} more` : '';
        throw new ToolError(
          `No view tree for screen "${truncate(screen, 100)}"; screens with one: ${names.join(', ') || 'none'}${more}`,
        );
      }
      return { data: { untrusted: UNTRUSTED_NOTE, viewTrees: [treeView(tree)] } };
    }
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        total: all.length,
        viewTrees: all.slice(0, MAX_TREES).map(treeView),
      },
    };
  },
});

import { describe, expect, it } from 'vitest';
import { SLOW_INFLATE_MS } from '@lionscope/protocol/wire';
import {
  aggregateLayouts,
  hitTestInflates,
  inflateByScreen,
  inflateKey,
  latestViewTrees,
  layoutName,
  pathLabel,
  slowInflates,
  sortLayoutRows,
  UNKNOWN_LAYOUT,
} from '../src/lib/layouts.ts';
import { aggregateScreens, sortScreenRows, withLayoutStats } from '../src/lib/screenStats.ts';
import { layoutsEmptyState, type LayoutsEmptyInput } from '../src/lib/viewState.ts';
import { breakdown, inflate, SDK_V2, SDK_V3, T0, viewTree } from './fixtures.ts';

const FROM = T0;
const TO = T0 + 60_000;

describe('aggregateLayouts', () => {
  const samples = [
    inflate(T0 + 1000, { layout: 'item_row', count: 10, totalMs: 40, maxMs: 6, views: 12, screen: 'List' }),
    inflate(T0 + 2000, { layout: 'item_row', count: 5, totalMs: 30, maxMs: 9, views: 15, screen: 'Cart' }),
    inflate(T0 + 3000, { layout: 'fragment_home', totalMs: 20, maxMs: 20, views: 80, screen: 'Home' }),
    inflate(T0 + 4000, { layout: 'abc_dialog', library: true, totalMs: 3, maxMs: 3, screen: 'Home' }),
    inflate(T0 + 5000, { layout: null, label: 'Button:12', totalMs: 1, maxMs: 1, screen: null }),
    inflate(T0 - 5000, { layout: 'item_row', count: 99, totalMs: 999, maxMs: 99 }),
  ];

  it('merges the samples of one layout inside the window', () => {
    const row = aggregateLayouts(samples, FROM, TO, true).find((r) => r.name === 'item_row');
    expect(row).toMatchObject({ count: 15, totalMs: 70, maxMs: 9, views: 15, library: false });
    expect(row?.meanMs).toBeCloseTo(70 / 15);
    // Most time first: List (40 ms) before Cart (30 ms).
    expect(row?.screens).toEqual(['List', 'Cart']);
  });

  it('takes views from the slowest inflation, not the largest view count', () => {
    const rows = aggregateLayouts(
      [
        inflate(T0 + 1, { layout: 'a', maxMs: 30, views: 5 }),
        inflate(T0 + 2, { layout: 'a', maxMs: 10, views: 50 }),
      ],
      FROM,
      TO,
      true,
    );
    expect(rows[0]?.views).toBe(5);
  });

  it('hides library layouts unless asked, and names unresolved ones by their label', () => {
    const hidden = aggregateLayouts(samples, FROM, TO, false).map((r) => r.name);
    expect(hidden).not.toContain('abc_dialog');
    const shown = aggregateLayouts(samples, FROM, TO, true);
    expect(shown.map((r) => r.name)).toContain('abc_dialog');
    const label = shown.find((r) => r.isLabel);
    expect(label).toMatchObject({ name: 'Button:12', screens: [] });
    expect(layoutName({ layout: null, label: null })).toBe(UNKNOWN_LAYOUT);
  });

  it('sorts by any column with a stable tie-break', () => {
    const rows = aggregateLayouts(samples, FROM, TO, true);
    expect(sortLayoutRows(rows, 'totalMs', 'desc')[0]?.name).toBe('item_row');
    expect(sortLayoutRows(rows, 'maxMs', 'desc')[0]?.name).toBe('fragment_home');
    expect(sortLayoutRows(rows, 'name', 'asc')[0]?.name).toBe('abc_dialog');
    expect(sortLayoutRows(rows, 'screenCount', 'desc')[0]?.name).toBe('item_row');
    expect(sortLayoutRows(rows, 'count', 'asc')[0]?.count).toBe(1);
  });
});

describe('collision-free keys', () => {
  it('keeps a layout named like a label apart from that label, in rows and marker keys', () => {
    const named = inflate(T0 + 1, { layout: 'label:Button:12', label: null, screen: 'a:b' });
    const labelled = inflate(T0 + 1, { layout: null, label: 'Button:12', screen: 'a:b' });
    const rows = aggregateLayouts([named, labelled], FROM, TO, true);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(inflateKey(named)).not.toBe(inflateKey(labelled));
    // Screens containing the separator can't merge two (name, screen) pairs either.
    expect(inflateKey(inflate(T0, { layout: 'x', screen: 'y:z' }))).not.toBe(
      inflateKey(inflate(T0, { layout: 'x:y', screen: 'z' })),
    );
  });
});

describe('nested inflations', () => {
  const outer = inflate(T0 + 1, { layout: 'fragment_home', screen: 'Home', totalMs: 30, maxMs: 30 });
  const inner = inflate(T0 + 1, {
    layout: 'view_banner',
    screen: 'Home',
    nested: true,
    totalMs: 12,
    maxMs: 12,
  });
  const legacy = { ...inflate(T0 + 2, { screen: 'Home', totalMs: 5, maxMs: 5 }) } as Partial<typeof outer>;
  delete legacy.nested;

  it('are left out of per-screen totals and counts, and out of the lane markers', () => {
    const home = inflateByScreen([outer, inner], FROM, TO).get('Home');
    expect(home).toEqual({ count: 1, totalMs: 30, slowest: { name: 'fragment_home', ms: 30 } });
    expect(slowInflates([outer, inner], FROM, TO)).toEqual([outer]);
  });

  it('stay as rows of their own, marked nested in the row data', () => {
    const rows = aggregateLayouts([outer, inner], FROM, TO, true);
    expect(rows.find((r) => r.name === 'view_banner')).toMatchObject({
      count: 1,
      nestedCount: 1,
      totalMs: 12,
    });
    expect(rows.find((r) => r.name === 'fragment_home')?.nestedCount).toBe(0);
  });

  it('count a layout that was both top-level and nested as partly nested', () => {
    const both = aggregateLayouts(
      [inflate(T0 + 1, { layout: 'v', count: 3 }), inflate(T0 + 1, { layout: 'v', count: 2, nested: true })],
      FROM,
      TO,
      true,
    );
    expect(both[0]).toMatchObject({ count: 5, nestedCount: 2 });
  });

  it('read a sample without the field as top-level, and keep both keys apart', () => {
    expect(inflateByScreen([legacy as typeof outer], FROM, TO).get('Home')?.totalMs).toBe(5);
    expect(slowInflates([{ ...(legacy as typeof outer), maxMs: 40 }], FROM, TO)).toHaveLength(1);
    expect(inflateKey(outer)).not.toBe(inflateKey({ ...outer, nested: true }));
  });
});

describe('per-screen figures', () => {
  it('sums inflation time per screen and names its slowest layout', () => {
    const byScreen = inflateByScreen(
      [
        inflate(T0 + 1, { screen: 'Home', layout: 'fragment_home', count: 1, totalMs: 20, maxMs: 20 }),
        inflate(T0 + 2, { screen: 'Home', layout: 'item_row', count: 4, totalMs: 12, maxMs: 4 }),
        inflate(T0 + 3, { screen: null }),
        inflate(T0 - 10, { screen: 'Home', totalMs: 500, maxMs: 500 }),
      ],
      FROM,
      TO,
    );
    expect(byScreen.size).toBe(1);
    expect(byScreen.get('Home')).toEqual({
      count: 5,
      totalMs: 32,
      slowest: { name: 'fragment_home', ms: 20 },
    });
  });

  it('keeps each screen’s latest view tree up to the end of the window', () => {
    const latest = latestViewTrees(
      [
        viewTree(T0 + 1, { screen: 'Home', views: 100 }),
        viewTree(T0 + 5, { screen: 'Home', views: 120 }),
        viewTree(T0 + 99_999, { screen: 'Home', views: 999 }),
        viewTree(T0 + 2, { screen: null }),
      ],
      TO,
    );
    expect([...latest.keys()]).toEqual(['Home']);
    expect(latest.get('Home')?.views).toBe(120);
    expect(pathLabel(viewTree(T0))).toBe('DecorView › ConstraintLayout#content › TextView#title');
  });

  it('attaches both to screen rows and sorts by them, screens without data last', () => {
    const rows = aggregateScreens(
      [breakdown(T0 + 1, 'Home'), breakdown(T0 + 2, 'Cart'), breakdown(T0 + 3, 'List')],
      FROM,
      TO,
    );
    const withStats = withLayoutStats(
      rows,
      inflateByScreen([inflate(T0 + 1, { screen: 'Home', totalMs: 9, maxMs: 9 })], FROM, TO),
      latestViewTrees(
        [viewTree(T0 + 1, { screen: 'Cart', views: 300 }), viewTree(T0 + 2, { screen: 'Home', views: 50 })],
        TO,
      ),
    );
    const home = withStats.find((r) => r.name === 'Home');
    expect(home).toMatchObject({ inflateMs: 9, inflateCount: 1 });
    expect(home?.slowestInflate).toEqual({ name: 'fragment_home', ms: 9 });
    expect(sortScreenRows(withStats, 'views', 'desc').map((r) => r.name)).toEqual(['Cart', 'Home', 'List']);
    expect(sortScreenRows(withStats, 'views', 'asc').map((r) => r.name)).toEqual(['Home', 'Cart', 'List']);
    expect(sortScreenRows(withStats, 'inflateMs', 'desc')[0]?.name).toBe('Home');
  });
});

describe('slow inflations on the lane', () => {
  it('keeps those at or over the threshold that touch the window', () => {
    const slow = inflate(T0 + 100, { maxMs: SLOW_INFLATE_MS });
    const justBefore = inflate(T0 - 10, { maxMs: 30 });
    const fast = inflate(T0 + 200, { maxMs: SLOW_INFLATE_MS - 1 });
    const after = inflate(TO + 1, { maxMs: 50 });
    expect(slowInflates([slow, justBefore, fast, after], FROM, TO)).toEqual([slow, justBefore]);
  });

  it('hit-tests a pill over its duration, with a minimum width and slop', () => {
    const item = inflate(T0, { maxMs: 40 });
    const query = (ts: number) => hitTestInflates([item], { ts, pxPerMs: 0.1 });
    expect(query(T0 + 20)).toBe(item);
    // 40 ms at 0.1 px/ms is 4 px wide: the 5 px slop reaches 50 ms further.
    expect(query(T0 + 40 + 40)).toBe(item);
    expect(query(T0 + 40 + 80)).toBeNull();
    expect(hitTestInflates([item], { ts: T0, pxPerMs: 0 })).toBeNull();
    expect(inflateKey(item)).toBe(JSON.stringify([T0, 'fragment_home', null, 'homepage', false]));
  });
});

describe('layoutsEmptyState', () => {
  const base: LayoutsEmptyInput = {
    hasItems: false,
    hasAnyData: false,
    isSessionActive: true,
    sdk: SDK_V3,
    sdkLinkError: null,
    isTrackingOn: true,
  };
  const kind = (patch: Partial<LayoutsEmptyInput>) => layoutsEmptyState({ ...base, ...patch })?.kind ?? null;

  it('is null with items, and "window" when only other windows have data', () => {
    expect(kind({ hasItems: true })).toBeNull();
    expect(kind({ hasAnyData: true })).toBe('window');
  });

  it('names what is missing, most specific first', () => {
    expect(kind({ isSessionActive: false })).toBe('no-session');
    expect(kind({ sdk: undefined })).toBe('old-server');
    expect(kind({ sdk: { ...SDK_V3, connected: false, sdkVersion: null } })).toBe('no-sdk');
    expect(kind({ sdk: { ...SDK_V3, connected: false }, sdkLinkError: 'x' })).toBe('link-failed');
    expect(kind({ sdk: { ...SDK_V3, connected: false } })).toBe('disconnected');
    expect(kind({ sdk: SDK_V2 })).toBe('old-sdk');
    expect(kind({ sdk: { ...SDK_V3, apiLevel: 28 } })).toBe('api-level');
    expect(kind({ isTrackingOn: false })).toBe('off');
    expect(kind({})).toBe('waiting');
  });

  it('treats Android 10 (API 29) as supported and an unknown level as supported', () => {
    expect(kind({ sdk: { ...SDK_V3, apiLevel: 29 } })).toBe('waiting');
    expect(kind({ sdk: { ...SDK_V3, apiLevel: null } })).toBe('waiting');
  });
});

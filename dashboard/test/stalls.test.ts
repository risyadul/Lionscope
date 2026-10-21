import { describe, expect, it } from 'vitest';
import { formatBlockMs } from '../src/lib/format.ts';
import {
  aggregateOffenders,
  buildFeed,
  buildStallScaleData,
  collapseStack,
  countDebuggerStalls,
  countEventsInWindow,
  culpritFrame,
  culpritKey,
  culpritLabel,
  culpritText,
  findFeedItem,
  formatStackLine,
  frameLocation,
  frameMethod,
  hitTestMarks,
  isGeneratedFrame,
  isPlatformFrame,
  NO_STACK_KEY,
  NO_STACK_LABEL,
  packageName,
  simpleClassName,
  stackText,
  stallColor,
  stallInWindow,
  stallKey,
  stallScaleMax,
  stallSeverity,
  stallsByScreen,
  strictModeKeys,
  summarizeWindow,
  type FeedItem,
} from '../src/lib/stalls.ts';
import { CART_STACK, HOME_STACK, stackFrame, stall, T0, violation } from './fixtures.ts';

describe('severity', () => {
  it('steps at 500 ms and 1 s', () => {
    expect([150, 499, 500, 999, 1000, 30_000].map(stallSeverity)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('colors by severity, and a debugger stall always recedes to gray', () => {
    expect(stallColor(stall(T0, 200))).toBe('stall1');
    expect(stallColor(stall(T0, 700))).toBe('stall2');
    expect(stallColor(stall(T0, 1200))).toBe('stall3');
    expect(stallColor(stall(T0, 1200, { debugger: true }))).toBe('stallDebug');
  });

  it('formats block lengths for reading', () => {
    expect([0, 342.4, 999.4, 999.6, 1240, 9994, 12_600].map(formatBlockMs)).toEqual([
      '0 ms',
      '342 ms',
      '999 ms',
      '1.00 s',
      '1.24 s',
      '9.99 s',
      '12.6 s',
    ]);
    expect(formatBlockMs(Number.NaN)).toBe('—');
    expect(formatBlockMs(-1)).toBe('—');
  });
});

describe('frames', () => {
  it('the culprit is the innermost app frame, else the innermost library frame, else the innermost frame', () => {
    expect(culpritFrame(HOME_STACK)?.method).toBe('mapItems');
    const library = HOME_STACK.map((f) => ({ ...f, inApp: false }));
    expect(culpritFrame(library)).toBe(library[3]);
    const platform = HOME_STACK.filter((f) => !f.inApp);
    expect(culpritFrame(platform)).toBe(platform[0]);
    expect(culpritFrame([])).toBeNull();
  });

  it('a third-party SDK waiting on a lock is the culprit, not the lock', () => {
    const frames = [
      stackFrame('jdk.internal.misc.Unsafe', 'park', 'Unsafe.java', -2),
      stackFrame('java.util.concurrent.locks.ReentrantLock', 'lock', 'ReentrantLock.java', 322),
      stackFrame('com.vendor.replay.Lockable', 'read', 'Lockable.kt', 81),
      stackFrame('androidx.recyclerview.widget.RecyclerView', 'onLayout', 'RecyclerView.java', 4578),
      stackFrame('com.google.android.material.button.MaterialButton', 'onDraw', 'MaterialButton.java', 12),
      stackFrame('android.view.ViewRootImpl', 'performTraversals', 'ViewRootImpl.java', 4284),
    ];
    expect(culpritFrame(frames)?.className).toBe('com.vendor.replay.Lockable');
    expect(culpritFrame(frames.filter((f) => !f.className.startsWith('com.vendor')))).toBe(frames[0]);
  });

  it('skips generated bindings for the app frame that inflates them', () => {
    const frames = [
      stackFrame('android.view.LayoutInflater', 'inflate', 'LayoutInflater.java', 571),
      stackFrame(
        'com.example.shop.databinding.FragmentHomeBinding',
        'inflate',
        'FragmentHomeBinding.java',
        364,
        true,
      ),
      stackFrame(
        'com.example.shop.databinding.ItemCartBindingImpl',
        'executeBindings',
        'ItemCartBindingImpl.java',
        9,
        true,
      ),
      stackFrame(
        'com.example.shop.DataBinderMapperImpl',
        'getDataBinder',
        'DataBinderMapperImpl.java',
        40,
        true,
      ),
      stackFrame('com.example.shop.home.HomeFragment', 'onCreateView', 'HomeFragment.kt', 356, true),
    ];
    expect(isGeneratedFrame(frames[1]!)).toBe(true);
    expect(isGeneratedFrame(frames[2]!)).toBe(true);
    expect(isGeneratedFrame(frames[3]!)).toBe(true);
    expect(isGeneratedFrame(frames[4]!)).toBe(false);
    expect(culpritFrame(frames)?.method).toBe('onCreateView');
    // A binding inflated from library code is still the app's own line.
    expect(culpritFrame(frames.slice(0, 2))).toBe(frames[1]);
  });

  it('treats the runtime and Google support libraries as platform frames', () => {
    for (const className of [
      'java.io.File',
      'jdk.internal.misc.Unsafe',
      'kotlinx.coroutines.DispatchedTask',
      'android.os.Looper',
      'androidx.fragment.app.Fragment',
      'com.android.internal.os.ZygoteInit',
      'dalvik.system.VMStack',
      'com.google.android.material.button.MaterialButton',
    ]) {
      expect(isPlatformFrame(stackFrame(className, 'm', null, null)), className).toBe(true);
    }
    for (const className of [
      'com.vendor.Sdk',
      'com.google.gson.Gson',
      'io.reactivex.Observable',
      'javalin.App',
    ]) {
      expect(isPlatformFrame(stackFrame(className, 'm', null, null)), className).toBe(false);
    }
  });

  it('names classes, methods and locations as the JVM prints them', () => {
    const frame = HOME_STACK[3]!;
    expect(simpleClassName('com.example.shop.home.HomeViewModel$load$1')).toBe('HomeViewModel$load$1');
    expect(simpleClassName('Bare')).toBe('Bare');
    expect(packageName(frame.className)).toBe('com.example.shop.home');
    expect(packageName('Bare')).toBe('');
    expect(frameMethod(frame)).toBe('HomeViewModel.mapItems');
    expect(frameLocation(frame)).toBe('HomeViewModel.kt:87');
    expect(frameLocation(stackFrame('a.B', 'c', null, -2))).toBe('Native Method');
    expect(frameLocation(stackFrame('a.B', 'c', null, 12))).toBe('Unknown Source');
    expect(frameLocation(stackFrame('a.B', 'c', 'B.kt', null))).toBe('B.kt');
    expect(frameLocation(stackFrame('a.B', 'c', 'B.kt', -1))).toBe('B.kt');
  });

  it('copies stacks as plain `at` lines and the culprit fully qualified', () => {
    expect(formatStackLine(HOME_STACK[3]!)).toBe(
      'at com.example.shop.home.HomeViewModel.mapItems(HomeViewModel.kt:87)',
    );
    expect(stackText(CART_STACK)).toBe(
      [
        'at java.io.FileInputStream.read(FileInputStream.java:321)',
        'at com.example.shop.data.CartRepository.loadFromDisk(CartRepository.kt:41)',
        'at android.os.Looper.loop(Looper.java:294)',
      ].join('\n'),
    );
    expect(culpritText(CART_STACK[1]!)).toBe(
      'com.example.shop.data.CartRepository.loadFromDisk (CartRepository.kt:41)',
    );
  });

  it('keys culprits by exact line', () => {
    const a = HOME_STACK[3]!;
    expect(culpritKey(a)).toBe(culpritKey({ ...a }));
    expect(culpritKey(a)).not.toBe(culpritKey({ ...a, line: 88 }));
    expect(culpritKey(null)).toBe(NO_STACK_KEY);
    expect(culpritLabel(null)).toBe('(no stack captured)');
    expect(culpritLabel(a)).toBe('HomeViewModel.kt:87');
  });
});

describe('collapseStack', () => {
  it('keeps the innermost frame and app frames, folding runs of two or more framework frames', () => {
    const items = collapseStack(HOME_STACK);
    expect(
      items.map((item) => (item.kind === 'frame' ? item.index : `+${item.frames.length}@${item.start}`)),
    ).toEqual([0, '+2@1', 3, 4, '+4@5']);
  });

  it('a lone framework frame between app frames stays visible', () => {
    const frames = [
      stackFrame('a.App', 'one', 'App.kt', 1, true),
      stackFrame('x.Lib', 'call', 'Lib.java', 2),
      stackFrame('a.App', 'two', 'App.kt', 3, true),
    ];
    expect(collapseStack(frames).every((item) => item.kind === 'frame')).toBe(true);
  });

  it('a stack of platform frames only folds everything under the innermost frame', () => {
    const frames = HOME_STACK.filter((f) => !f.inApp);
    const items = collapseStack(frames);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'collapsed', start: 1 });
    expect(collapseStack([])).toEqual([]);
  });

  it('keeps a library culprit visible when there is no app frame', () => {
    const frames = HOME_STACK.map((f) => ({ ...f, inApp: false }));
    const items = collapseStack(frames);
    expect(
      items.map((item) => (item.kind === 'frame' ? item.index : `+${item.frames.length}@${item.start}`)),
    ).toEqual([0, '+2@1', 3, '+5@4']);
  });
});

describe('offenders', () => {
  const stalls = [
    stall(T0, 300),
    stall(T0 + 1000, 900, { screen: 'search' }),
    stall(T0 + 2000, 400),
    stall(T0 + 3000, 1500, { frames: CART_STACK, screen: 'CartFragment' }),
    stall(T0 + 4000, 20_000, { debugger: true }),
    stall(T0 + 9000, 5000, { frames: CART_STACK }),
    stall(T0 + 5000, 200, { frames: [] }),
  ];

  it('groups by culprit line in the window, worst total first, without debugger stalls', () => {
    const rows = aggregateOffenders(stalls, T0, T0 + 5000);
    expect(rows.map((row) => row.frame?.method ?? null)).toEqual(['mapItems', 'loadFromDisk', null]);
    const home = rows[0]!;
    expect(home).toMatchObject({ count: 3, totalMs: 1600, maxMs: 900, lastTs: T0 + 2000 });
    // Most stalls first.
    expect(home.screens).toEqual(['homepage', 'search']);
    expect(rows[2]).toMatchObject({ key: NO_STACK_KEY, frame: null, count: 1 });
    expect(culpritLabel(rows[2]!.frame)).toBe(NO_STACK_LABEL);
    expect(countDebuggerStalls(stalls, T0, T0 + 5000)).toBe(1);
  });

  it('ties rank by count, then key', () => {
    const rows = aggregateOffenders(
      [stall(T0, 500, { frames: CART_STACK }), stall(T0, 250), stall(T0 + 1, 250)],
      T0,
      T0 + 1,
    );
    expect(rows.map((row) => row.count)).toEqual([2, 1]);
  });

  it('totals stalls per screen', () => {
    const byScreen = stallsByScreen([...stalls, stall(T0, 999, { screen: null })], T0, T0 + 5000);
    expect([...byScreen]).toEqual([
      ['homepage', { count: 3, totalMs: 900 }],
      ['search', { count: 1, totalMs: 900 }],
      ['CartFragment', { count: 1, totalMs: 1500 }],
    ]);
  });

  it('summarizes the window: stalls, blocked time, worst, violations by occurrence, debugger', () => {
    const summary = summarizeWindow(
      stalls,
      [violation(T0, { count: 3 }), violation(T0 + 99_000)],
      T0,
      T0 + 5000,
    );
    // Violations count as reports (the list's rows); coalesced repeats are the occurrences.
    expect(summary).toEqual({
      count: 5,
      totalMs: 3300,
      worstMs: 1500,
      strictModeCount: 1,
      strictModeOccurrences: 3,
      debuggerCount: 1,
    });
    expect(countEventsInWindow(stalls, [violation(T0, { count: 3 })], T0, T0 + 5000)).toBe(7);
  });
});

describe('feed', () => {
  const stalls = [stall(T0, 300), stall(T0 + 2000, 700, { frames: CART_STACK })];
  const violations = [violation(T0 + 1000), violation(T0 + 2000), violation(T0 + 2000), violation(T0 + 9000)];
  const all = { fromTs: T0, toTs: T0 + 5000, filter: 'all' as const, culprit: null };

  it('interleaves newest first; at the same instant the stall leads', () => {
    const feed = buildFeed(stalls, violations, all);
    expect(feed.map((item) => `${item.kind}@${item.ts - T0}`)).toEqual([
      'stall@2000',
      'strictmode@2000',
      'strictmode@2000',
      'strictmode@1000',
      'stall@0',
    ]);
  });

  it('gives repeated violations distinct keys and stalls their start', () => {
    expect(strictModeKeys(violations)).toEqual([
      `m:${T0 + 1000}:DiskReadViolation`,
      `m:${T0 + 2000}:DiskReadViolation`,
      `m:${T0 + 2000}:DiskReadViolation:1`,
      `m:${T0 + 9000}:DiskReadViolation`,
    ]);
    expect(stallKey(stalls[0]!)).toBe(`s:${T0}`);
    const keys = buildFeed(stalls, violations, all).map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('filters by kind and by culprit line', () => {
    expect(buildFeed(stalls, violations, { ...all, filter: 'stalls' }).every((i) => i.kind === 'stall')).toBe(
      true,
    );
    expect(buildFeed(stalls, violations, { ...all, filter: 'strictmode' })).toHaveLength(3);
    const cart = culpritKey(culpritFrame(CART_STACK));
    const narrowed = buildFeed(stalls, violations, { ...all, culprit: cart });
    expect(narrowed.map((item) => item.kind)).toEqual(['stall', 'strictmode', 'strictmode', 'strictmode']);
  });

  it('finds a selection anywhere in the buffer', () => {
    expect(findFeedItem(stalls, violations, `s:${T0 + 2000}`)?.sample).toBe(stalls[1]);
    expect(findFeedItem(stalls, violations, `m:${T0 + 2000}:DiskReadViolation:1`)?.sample).toBe(
      violations[2],
    );
    expect(findFeedItem(stalls, violations, `m:${T0 + 9000}:DiskReadViolation`)?.kind).toBe('strictmode');
    expect(findFeedItem(stalls, violations, 's:1')).toBeNull();
    expect(findFeedItem(stalls, violations, 'm:1:X')).toBeNull();
  });
});

describe('lane scale and hit testing', () => {
  it('caps the scale between 500 ms (or twice the threshold) and 2 s', () => {
    expect(stallScaleMax(null, 150)).toBe(500);
    expect(stallScaleMax(342, 150)).toBe(500);
    expect(stallScaleMax(700, 150)).toBe(1000);
    expect(stallScaleMax(1390, 150)).toBe(2000);
    expect(stallScaleMax(30_000, 150)).toBe(2000);
    expect(stallScaleMax(100, 500)).toBe(1000);
    expect(stallScaleMax(100, 1000)).toBe(2000);
  });

  it('feeds y auto-ranging with stall lengths, never debugger ones', () => {
    expect(buildStallScaleData([stall(T0, 300), stall(T0 + 1000, 9000, { debugger: true })])).toEqual([
      [T0 / 1000, T0 / 1000 + 1],
      [300, null],
    ]);
  });

  const items: FeedItem[] = buildFeed([stall(T0, 400), stall(T0 + 10_000, 20)], [violation(T0 + 200)], {
    fromTs: T0,
    toTs: T0 + 60_000,
    filter: 'all',
    culprit: null,
  });
  // 0.05 px per ms: the 400 ms stall is 20 px wide, the 20 ms one drawn at the 3 px minimum.
  const at = (ts: number, isOverRail = false) =>
    hitTestMarks(items, { ts, pxPerMs: 0.05, isOverRail })?.key ?? null;

  it('hits a bar anywhere across its length, within a small slop', () => {
    expect(at(T0 + 300)).toBe(`s:${T0}`);
    expect(at(T0 + 400 + 90)).toBe(`s:${T0}`);
    expect(at(T0 + 400 + 140)).toBeNull();
    expect(at(T0 - 90)).toBe(`s:${T0}`);
    // The minimum drawn width counts as part of the bar.
    expect(at(T0 + 10_000 + 55)).toBe(`s:${T0 + 10_000}`);
  });

  it('on the rail a violation wins over the bar above it', () => {
    expect(at(T0 + 200)).toBe(`s:${T0}`);
    expect(at(T0 + 200, true)).toBe(`m:${T0 + 200}:DiskReadViolation`);
    expect(at(T0 + 30_000, true)).toBeNull();
    expect(hitTestMarks(items, { ts: T0, pxPerMs: 0, isOverRail: false })).toBeNull();
  });
});

describe('stalls without a stack', () => {
  it('rank as one stable offender and can be filtered to', () => {
    const empty = [stall(T0, 300, { frames: [] }), stall(T0 + 1000, 500, { frames: [], screen: 'search' })];
    const rows = aggregateOffenders([...empty, stall(T0 + 2000, 100)], T0, T0 + 5000);
    expect(rows[0]).toMatchObject({ key: NO_STACK_KEY, frame: null, count: 2, totalMs: 800 });
    expect(rows[0]?.screens).toEqual(['homepage', 'search']);
    const feed = buildFeed(empty, [], { fromTs: T0, toTs: T0 + 5000, filter: 'all', culprit: NO_STACK_KEY });
    expect(feed.map((item) => item.culprit)).toEqual([null, null]);
    expect(collapseStack([])).toEqual([]);
    expect(stackText([])).toBe('');
  });
});

describe('window edges and filters', () => {
  const longOne = stall(T0 - 4000, 5000);

  it('a stall that started before the window but ends inside it is in the window', () => {
    expect(stallInWindow(longOne, T0, T0 + 10_000)).toBe(true);
    expect(stallInWindow(stall(T0 - 4000, 3000), T0, T0 + 10_000)).toBe(false);
    expect(stallInWindow(stall(T0 + 10_001, 100), T0, T0 + 10_000)).toBe(false);
    const window = { fromTs: T0, toTs: T0 + 10_000, filter: 'all' as const, culprit: null };
    expect(buildFeed([longOne], [], window).map((item) => item.ts)).toEqual([T0 - 4000]);
    expect(aggregateOffenders([longOne], T0, T0 + 10_000)[0]?.totalMs).toBe(5000);
    expect(summarizeWindow([longOne], [], T0, T0 + 10_000).count).toBe(1);
    // The lane can still hover it at the plot's left edge.
    const hit = hitTestMarks(buildFeed([longOne], [], window), {
      ts: T0 + 10,
      pxPerMs: 0.05,
      isOverRail: false,
    });
    expect(hit?.key).toBe(`s:${T0 - 4000}`);
  });

  it('a culprit filter lists exactly what its offender row counts: no debugger stalls', () => {
    const stalls = [stall(T0, 300), stall(T0 + 1000, 9000, { debugger: true }), stall(T0 + 2000, 200)];
    const [row] = aggregateOffenders(stalls, T0, T0 + 60_000);
    const feed = buildFeed(stalls, [], {
      fromTs: T0,
      toTs: T0 + 60_000,
      filter: 'stalls',
      culprit: row!.key,
    });
    expect(feed).toHaveLength(row!.count);
    // Unfiltered, the debugger stall is still listed.
    expect(
      buildFeed(stalls, [], { fromTs: T0, toTs: T0 + 60_000, filter: 'stalls', culprit: null }),
    ).toHaveLength(3);
  });
});

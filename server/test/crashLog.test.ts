import type { LogEntry } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import {
  CrashLog,
  MAX_CRASH_FRAMES_PER_CAUSE,
  MAX_CRASH_STACK_LINES,
  MAX_CRASHES,
} from '../src/store/crashLog.ts';

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const PKG = 'com.example.shop';
const PID = 4321;

const line = (ts: number, tag: string, message: string, overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts,
  pid: PID,
  tid: PID,
  level: 'E',
  tag,
  message,
  ...overrides,
});

/** A main-thread crash as AndroidRuntime logs it to the crash buffer (one record, split into lines by logcat). */
function javaCrash(ts: number, overrides: Partial<LogEntry> = {}, process = PKG): LogEntry[] {
  return [
    'FATAL EXCEPTION: main',
    `Process: ${process}, PID: ${overrides.pid ?? PID}`,
    'java.lang.RuntimeException: Unable to start activity ComponentInfo{com.example.shop/com.example.shop.CartActivity}',
    '\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3782)',
    '\tat android.os.Looper.loop(Looper.java:288)',
    'Caused by: java.lang.IllegalStateException: cart is empty',
    '\tat com.example.shop.CartActivity.onCreate(CartActivity.kt:42)',
    '\t... 12 more',
  ].map((message) => line(ts, 'AndroidRuntime', message, overrides));
}

/** crash_dump's report of a native crash, from its own process. */
function nativeCrash(ts: number, process = PKG): LogEntry[] {
  return [
    '*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
    "Build fingerprint: 'google/sdk_gphone64_arm64/emu64a:16/BE2A/1:userdebug/dev-keys'",
    `Cmdline: ${process}`,
    `pid: ${PID}, tid: 4330, name: RenderThread  >>> ${process} <<<`,
    'signal 6 (SIGABRT), code -1 (SI_QUEUE), fault addr --------',
    'Cause: null pointer dereference',
    "Abort message: 'Check failed: frame != nullptr'",
    '    x0  0000000000000000  x1  0000000000000487',
    'backtrace:',
    '      #00 pc 00000000000707b0  /apex/com.android.runtime/lib64/bionic/libc.so (abort+156)',
    '      #01 pc 0000000000016188  /data/app/com.example.shop/lib/arm64/libshop.so (render+80)',
    'memory near x1:',
  ].map((message) => line(ts, 'DEBUG', message, { pid: 6885, tid: 6885, level: 'F' }));
}

describe('CrashLog', () => {
  it('reads a FATAL EXCEPTION block: thread, process, exception, message and stack', () => {
    const crashes = new CrashLog(PKG);
    crashes.add(javaCrash(T0));
    expect(crashes.list()).toEqual([
      {
        ts: T0,
        pid: PID,
        tid: PID,
        kind: 'java',
        thread: 'main',
        process: PKG,
        exception: 'java.lang.RuntimeException',
        message: 'Unable to start activity ComponentInfo{com.example.shop/com.example.shop.CartActivity}',
        stack: [
          '\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3782)',
          '\tat android.os.Looper.loop(Looper.java:288)',
          'Caused by: java.lang.IllegalStateException: cart is empty',
          '\tat com.example.shop.CartActivity.onCreate(CartActivity.kt:42)',
          '\t... 12 more',
        ],
        droppedLines: 0,
      },
    ]);
  });

  it("keeps the app's crashes only, its other processes included", () => {
    const crashes = new CrashLog(PKG);
    crashes.add(javaCrash(T0, {}, 'com.example.shopping'));
    crashes.add(javaCrash(T0 + 1, { pid: 5000, tid: 5000 }, `${PKG}:remote`));
    crashes.add([
      line(T0 + 2, 'AndroidRuntime', 'FATAL EXCEPTION: main'),
      line(T0 + 2, 'AndroidRuntime', 'PID: 77'),
    ]);
    crashes.add(nativeCrash(T0 + 3, 'com.example.other'));
    expect(crashes.list().map((crash) => [crash.pid, crash.process])).toEqual([[5000, `${PKG}:remote`]]);
  });

  it('keeps lines of other threads and processes out of a block that they interleave with', () => {
    const [header, process, thrown, ...stack] = javaCrash(T0);
    const crashes = new CrashLog(PKG);
    crashes.add([
      header!,
      line(T0, 'AndroidRuntime', 'Shutting down VM', { pid: 999, tid: 999, level: 'D' }),
      process!,
      line(T0, 'AndroidRuntime', 'FATAL EXCEPTION: worker-2', { tid: PID + 9 }),
      thrown!,
      line(T0, 'AndroidRuntime', `Process: ${PKG}, PID: ${PID}`, { tid: PID + 9 }),
      line(T0, 'AndroidRuntime', 'java.lang.OutOfMemoryError', { tid: PID + 9 }),
      ...stack,
    ]);
    const [main, worker] = crashes.list();
    expect(main).toMatchObject({ thread: 'main', exception: 'java.lang.RuntimeException' });
    expect(main?.stack).toHaveLength(5);
    expect(worker).toMatchObject({
      thread: 'worker-2',
      tid: PID + 9,
      exception: 'java.lang.OutOfMemoryError',
      message: null,
      stack: [],
    });
  });

  it('starts a new crash at a second FATAL EXCEPTION of the same thread, and ends one after a pause', () => {
    const crashes = new CrashLog(PKG);
    crashes.add(javaCrash(T0).slice(0, 4));
    crashes.add(javaCrash(T0 + 1));
    crashes.add([
      line(T0 + 10_000, 'AndroidRuntime', 'FATAL EXCEPTION: main'),
      line(T0 + 10_000, 'AndroidRuntime', `Process: ${PKG}, PID: ${PID}`),
      line(T0 + 15_000, 'AndroidRuntime', 'java.lang.IllegalStateException: much later'),
    ]);
    const [first, second, third] = crashes.list();
    expect(first?.stack).toHaveLength(1);
    expect(second?.stack).toHaveLength(5);
    expect(third).toMatchObject({ exception: null, message: null });
  });

  it('records a crash once when the buffer is read again (a resumed stream, a reused PID)', () => {
    const crashes = new CrashLog(PKG);
    crashes.add(javaCrash(T0));
    crashes.add(javaCrash(T0));
    crashes.add(javaCrash(T0 + 5000));
    expect(crashes.list().map((crash) => [crash.ts, crash.stack.length])).toEqual([
      [T0, 5],
      [T0 + 5000, 5],
    ]);
  });

  it("reads crash_dump's report of a native crash", () => {
    const crashes = new CrashLog(PKG);
    crashes.add(nativeCrash(T0));
    expect(crashes.list()).toEqual([
      {
        ts: T0,
        pid: PID,
        tid: 4330,
        kind: 'native',
        thread: 'RenderThread',
        process: PKG,
        exception: 'SIGABRT',
        message: 'Check failed: frame != nullptr',
        stack: [
          'Cause: null pointer dereference',
          '#00 pc 00000000000707b0  /apex/com.android.runtime/lib64/bionic/libc.so (abort+156)',
          '#01 pc 0000000000016188  /data/app/com.example.shop/lib/arm64/libshop.so (render+80)',
        ],
        droppedLines: 0,
      },
    ]);
  });

  it('keeps every Caused by of a long stack and counts the frames past the cap', () => {
    const crashes = new CrashLog(PKG);
    const [header, process, thrown] = javaCrash(T0);
    const frames = (count: number, name: string) =>
      Array.from({ length: count }, (_, i) =>
        line(T0, 'AndroidRuntime', `\tat androidx.compose.${name}.f${i}(${name}.kt:${i})`),
      );
    crashes.add([
      header!,
      process!,
      thrown!,
      ...frames(200, 'Layout'),
      line(T0, 'AndroidRuntime', 'Caused by: java.lang.IllegalStateException: root cause'),
      ...frames(3, 'Root'),
    ]);
    const { stack, droppedLines } = crashes.list()[0]!;
    expect(stack).toHaveLength(MAX_CRASH_FRAMES_PER_CAUSE + 1 + 1 + 3);
    expect(stack[MAX_CRASH_FRAMES_PER_CAUSE]).toBe(`… ${200 - MAX_CRASH_FRAMES_PER_CAUSE} more frames`);
    expect(stack[MAX_CRASH_FRAMES_PER_CAUSE + 1]).toBe(
      'Caused by: java.lang.IllegalStateException: root cause',
    );
    expect(droppedLines).toBe(0);

    const chain = new CrashLog(PKG);
    const causes = Array.from({ length: MAX_CRASH_STACK_LINES + 5 }, (_, i) =>
      line(T0, 'AndroidRuntime', `Suppressed: java.io.IOException: close ${i}`),
    );
    chain.add([header!, process!, thrown!, ...causes]);
    expect(chain.list()[0]).toMatchObject({ droppedLines: 5 });
  });

  it('waits longer for the lines of a native report (crash_dump unwinds before printing them)', () => {
    const crashes = new CrashLog(PKG);
    const lines = nativeCrash(T0);
    crashes.add(lines.slice(0, 7));
    crashes.add(lines.slice(7).map((entry) => ({ ...entry, ts: T0 + 3000 })));
    expect(crashes.list()[0]?.stack).toHaveLength(3);
  });

  it('stores texts redacted, then cut', () => {
    const crashes = new CrashLog(PKG);
    const [header, process] = javaCrash(T0);
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.fake-signature';
    crashes.add([
      header!,
      process!,
      line(T0, 'AndroidRuntime', `java.io.IOException: ${'x'.repeat(480)} ${jwt}`),
      line(T0, 'AndroidRuntime', 'Caused by: retrofit2.HttpException: HTTP 401 for Bearer fake-opaque-token'),
      line(T0, 'AndroidRuntime', `Caused by: java.lang.Error: ${'y'.repeat(700)}`),
    ]);
    const [crash] = crashes.list();
    expect(crash?.message).toBe(`${'x'.repeat(480)} ‹redacted›`);
    expect(crash?.stack[0]).toBe('Caused by: retrofit2.HttpException: HTTP 401 for Bearer ‹redacted›');
    expect(crash?.stack[1]).toMatch(/^Caused by: java\.lang\.Error: y+… \(228 more chars\)$/);
    expect(crash?.stack[1]).toHaveLength(500 + '… (228 more chars)'.length);
  });

  it('keeps the last crashes', () => {
    const crashes = new CrashLog(PKG);
    for (let i = 0; i < MAX_CRASHES + 5; i++) crashes.add(javaCrash(T0 + i * 10_000));
    const list = crashes.list();
    expect(list).toHaveLength(MAX_CRASHES);
    expect(list[0]?.ts).toBe(T0 + 5 * 10_000);
  });

  it('forgets reports of processes that never log again', () => {
    const crashes = new CrashLog(PKG);
    for (let i = 0; i < 40; i++) {
      crashes.add([line(T0, 'AndroidRuntime', 'FATAL EXCEPTION: main', { pid: 100 + i, tid: 100 + i })]);
    }
    expect(crashes.openReports).toBe(16);
    crashes.add([line(T0 + 5000, 'ActivityManager', 'Process com.example.shop has died', { pid: 500 })]);
    expect(crashes.openReports).toBe(0);
  });
});

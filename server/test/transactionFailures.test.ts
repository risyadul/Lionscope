import { readFileSync } from 'node:fs';
import { MAX_FAILURE_REPORT_BYTES, TRANSACTION_FAILURE_JOIN_MS } from '@lionscope/protocol';
import type { LogEntry, SavedStateSample, ServerMessage } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { parseLogcatLine } from '../src/parsers/logcat.ts';
import { CrashLog } from '../src/store/crashLog.ts';
import { crashFacts, TransactionFailures } from '../src/store/transactionFailures.ts';

const SAMPLE = 'io.github.risyadul.lionscope.sample';

type LineChunks = LogEntry[][];

/** Real lines of the SDK sample's SavedStateActivity crashing on an emulator (filler data, laptop = device clock). */
function fixtureLines(api: 28 | 31): LogEntry[] {
  return readFileSync(new URL(`./fixtures/logcat-ttle-api${api}.txt`, import.meta.url), 'utf8')
    .split('\n')
    .map(parseLogcatLine)
    .filter((line) => line !== null)
    .map(({ deviceTs, ...entry }) => ({ ...entry, ts: Math.round(deviceTs) }));
}

function setup(topScreen: string | null = null) {
  const messages: ServerMessage[] = [];
  const timeline: number[] = [];
  const failures = new TransactionFailures({
    emit: (message) => messages.push(message),
    topScreenAt: () => topScreen,
    onNew: (failure) => timeline.push(failure.id),
  });
  const crashLog = new CrashLog(SAMPLE);
  /** The app's own log (JavaBinder) and the crash buffer (AndroidRuntime), as the session splits them. */
  const feed = (entries: LogEntry[]) => {
    failures.addLogs(entries.filter((entry) => entry.tag === 'JavaBinder'));
    crashLog.add(entries.filter((entry) => entry.tag === 'AndroidRuntime'));
    failures.addCrashes(crashLog.list());
  };
  return { failures, messages, timeline, feed };
}

function savedState(ts: number, totalBytes = 583_420): SavedStateSample {
  return {
    ts,
    activity: `${SAMPLE}.SavedStateActivity`,
    pid: 4321,
    instanceId: null,
    screen: 'saved_state_demo',
    hook: 'posted',
    totalBytes,
    measureMs: 0.4,
    breakdownMs: 3,
    entries: [],
    truncated: false,
  };
}

describe('TransactionFailures', () => {
  it('joins the JavaBinder line and the crash of an Activity stop on API 28 into one failure', () => {
    const { failures, messages, timeline, feed } = setup('saved_state_demo');
    const lines = fixtureLines(28);
    feed(lines);
    const [failure] = failures.list();
    expect(failures.list()).toHaveLength(1);
    expect(failure).toMatchObject({
      id: 1,
      pid: 3299,
      parcelBytes: 583_524,
      binderLine: true,
      crashed: true,
      transaction: 'IActivityManager.activityStopped',
      screen: 'saved_state_demo',
      savedState: null,
    });
    expect(failure?.ts).toBe(lines[0]?.ts);
    // New, then updated by the crash; one timeline marker.
    expect(messages.map((message) => message.type)).toEqual(['transactionFailure', 'transactionFailure']);
    expect(timeline).toEqual([1]);
  });

  it('names Android 12+ activityStopped through IActivityClientController (API 31 fixture)', () => {
    const { failures, feed } = setup();
    feed(fixtureLines(31));
    expect(failures.list()).toEqual([
      expect.objectContaining({
        pid: 4840,
        parcelBytes: 583_552,
        transaction: 'IActivityClientController.activityStopped',
        crashed: true,
        binderLine: true,
      }),
    ]);
  });

  it('records a crash alone, a binder line alone, and never the same crash twice', () => {
    const lines = fixtureLines(28);
    const crashOnly = setup();
    crashOnly.feed(lines.slice(1));
    crashOnly.feed(lines.slice(1)); // a replayed buffer
    expect(crashOnly.failures.list()).toEqual([
      expect.objectContaining({ binderLine: false, crashed: true, parcelBytes: 583_524 }),
    ]);
    const binderOnly = setup();
    binderOnly.feed([{ ...lines[0]!, message: '!!! FAILED BINDER TRANSACTION !!!' }]);
    expect(binderOnly.failures.list()).toEqual([
      expect.objectContaining({ binderLine: true, crashed: false, parcelBytes: null, transaction: null }),
    ]);
  });

  it('keeps failures of another process or outside the join window apart', () => {
    const lines = fixtureLines(28);
    const { failures, feed } = setup();
    feed([lines[0]!]);
    feed(lines.slice(1).map((line) => ({ ...line, ts: line.ts + TRANSACTION_FAILURE_JOIN_MS + 1 })));
    feed([{ ...lines[0]!, pid: 9999, ts: lines[0]!.ts + 10 }]);
    expect(failures.list().map((failure) => [failure.pid, failure.binderLine, failure.crashed])).toEqual([
      [3299, true, false],
      [3299, false, true],
      [9999, true, false],
    ]);
  });

  it("joins the SDK's saved-state report of the same process, before or after the failure", () => {
    const lines = fixtureLines(28);
    const before = setup();
    before.failures.addSavedState(3299, savedState(lines[0]!.ts - 4));
    before.failures.addSavedState(4000, savedState(lines[0]!.ts - 2, 1));
    before.feed(lines);
    expect(before.failures.list()[0]?.savedState).toEqual({
      ts: lines[0]!.ts - 4,
      activity: `${SAMPLE}.SavedStateActivity`,
      totalBytes: 583_420,
      instanceId: null,
    });

    const after = setup();
    after.feed(lines);
    after.failures.addSavedState(3299, savedState(lines[0]!.ts + 20));
    expect(after.failures.list()[0]?.savedState?.totalBytes).toBe(583_420);
    expect(after.messages.at(-1)).toMatchObject({ type: 'transactionFailure', failure: { id: 1 } });
  });

  it.each([28, 31] as const)(
    'gets the same failure from the API %i fixture whatever the flush boundaries',
    (api) => {
      const lines = fixtureLines(api);
      const whole = setup();
      whole.feed(lines);
      const [expected] = whole.failures.list();
      expect(expected?.transaction).toMatch(/\.activityStopped$/);
      const runs: LineChunks[] = [lines.map((line) => [line])];
      for (let cut = 1; cut < lines.length; cut++) runs.push([lines.slice(0, cut), lines.slice(cut)]);
      for (const chunks of runs) {
        const split = setup();
        for (const chunk of chunks) split.feed(chunk);
        // A replayed buffer (every flush hands CrashLog's whole list again) changes nothing.
        split.feed([]);
        split.feed([]);
        expect(split.failures.list()).toEqual([expected]);
        expect(split.timeline).toEqual([1]);
        expect(new Set(split.messages.map((message) => message.type))).toEqual(
          new Set(['transactionFailure']),
        );
      }
      // The crash buffer's flush can come before the app log's JavaBinder line: still one failure.
      const binder = lines.findIndex((line) => line.tag === 'JavaBinder');
      const crashFirst = setup();
      crashFirst.feed(lines.filter((_, index) => index !== binder));
      crashFirst.feed([lines[binder]!]);
      const { ts: _ts, ...facts } = expected!;
      expect(crashFirst.failures.list()).toEqual([expect.objectContaining(facts)]);
      expect(crashFirst.timeline).toEqual([1]);
    },
  );

  it('fills in a crash seen before its stack, without a new failure or timeline marker', () => {
    const lines = fixtureLines(28);
    const header = lines.findIndex((line) => line.message.includes('TransactionTooLargeException'));
    const { failures, messages, timeline, feed } = setup();
    feed(lines.slice(1, header + 1));
    expect(failures.list()).toEqual([expect.objectContaining({ crashed: true, transaction: null })]);
    const emitted = messages.length;
    feed(lines.slice(header + 1));
    expect(failures.list()).toEqual([
      expect.objectContaining({
        id: 1,
        transaction: 'IActivityManager.activityStopped',
        parcelBytes: 583_524,
      }),
    ]);
    expect(timeline).toEqual([1]);
    expect(messages.length).toBe(emitted + 1);
    feed([]);
    expect(messages.length).toBe(emitted + 1);
  });

  it('explains a failure by the newest report at or before it, whatever order the streams deliver', () => {
    const lines = fixtureLines(28);
    const t = lines[0]!.ts;
    const older = { ...savedState(t - 2000, 100_000), activity: 'com.example.OlderActivity' };
    const crashing = { ...savedState(t - 5), activity: 'com.example.CrashingActivity' };

    const lateNewest = setup();
    lateNewest.failures.addSavedState(3299, older);
    lateNewest.feed(lines);
    expect(lateNewest.failures.list()[0]?.savedState?.activity).toBe('com.example.OlderActivity');
    lateNewest.failures.addSavedState(3299, crashing);
    expect(lateNewest.failures.list()[0]?.savedState).toEqual({
      ts: t - 5,
      activity: 'com.example.CrashingActivity',
      totalBytes: 583_420,
      instanceId: null,
    });
    expect(lateNewest.messages.at(-1)).toMatchObject({
      type: 'transactionFailure',
      failure: { id: 1, savedState: { activity: 'com.example.CrashingActivity' } },
    });

    const lateOlder = setup();
    lateOlder.failures.addSavedState(3299, crashing);
    lateOlder.feed(lines);
    const emitted = lateOlder.messages.length;
    lateOlder.failures.addSavedState(3299, older);
    expect(lateOlder.failures.list()[0]?.savedState?.activity).toBe('com.example.CrashingActivity');
    expect(lateOlder.messages.length).toBe(emitted);

    // Another process, a report outside the window, and a later save do not replace it.
    lateOlder.failures.addSavedState(4000, { ...savedState(t - 1), activity: 'com.example.Other' });
    lateOlder.failures.addSavedState(3299, {
      ...savedState(t - TRANSACTION_FAILURE_JOIN_MS - 1),
      activity: 'com.example.TooOld',
    });
    lateOlder.failures.addSavedState(3299, { ...savedState(t + 500), activity: 'com.example.NextActivity' });
    expect(lateOlder.failures.list()[0]?.savedState?.activity).toBe('com.example.CrashingActivity');
    expect(lateOlder.messages.length).toBe(emitted);

    // Without a report before it, the nearest one after it explains it.
    const onlyAfter = setup();
    onlyAfter.feed(lines);
    onlyAfter.failures.addSavedState(3299, { ...savedState(t + 900), activity: 'com.example.Later' });
    onlyAfter.failures.addSavedState(3299, { ...savedState(t + 20), activity: 'com.example.Sooner' });
    expect(onlyAfter.failures.list()[0]?.savedState?.activity).toBe('com.example.Sooner');
  });

  it.each([
    ['another process', (t: number, i: number) => ({ pid: 4000, ts: t - 1 - i })],
    [
      'the same process outside the window',
      (t: number, i: number) => ({ pid: 3299, ts: t - TRANSACTION_FAILURE_JOIN_MS - 1 - i }),
    ],
  ])(
    'keeps the best known report once 20 reports of %s pushed it out of the recent history',
    (_label, filler) => {
      const lines = fixtureLines(28);
      const t = lines[0]!.ts;
      const { failures, messages, feed } = setup();
      failures.addSavedState(3299, { ...savedState(t - 5), activity: 'com.example.CrashingActivity' });
      feed(lines);
      expect(failures.list()[0]?.savedState?.activity).toBe('com.example.CrashingActivity');
      for (let i = 0; i < 20; i++) {
        const { pid, ts } = filler(t, i);
        failures.addSavedState(pid, { ...savedState(ts, 1), activity: 'com.example.Filler' });
      }
      const emitted = messages.length;

      // Late and worse: an older save before the failure, and saves after it.
      failures.addSavedState(3299, {
        ...savedState(t - 2000, 100_000),
        activity: 'com.example.OlderActivity',
      });
      failures.addSavedState(3299, { ...savedState(t + 20), activity: 'com.example.After' });
      expect(failures.list()[0]?.savedState).toEqual({
        ts: t - 5,
        activity: 'com.example.CrashingActivity',
        totalBytes: 583_420,
        instanceId: null,
      });
      expect(messages.length).toBe(emitted);

      // Late and better (newer before it, then the same time: the later arrival) still replaces it.
      failures.addSavedState(3299, { ...savedState(t - 1), activity: 'com.example.Newer' });
      expect(failures.list()[0]?.savedState?.activity).toBe('com.example.Newer');
      failures.addSavedState(3299, { ...savedState(t - 1, 600_000), activity: 'com.example.SameTime' });
      expect(failures.list()[0]?.savedState).toEqual({
        ts: t - 1,
        activity: 'com.example.SameTime',
        totalBytes: 600_000,
        instanceId: null,
      });
      expect(messages.length).toBe(emitted + 2);
    },
  );

  it('ignores other crashes and binder lines of other tags', () => {
    expect(
      crashFacts({ exception: 'java.lang.IllegalStateException', message: 'cart is empty', stack: [] }),
    ).toBeNull();
    const { failures } = setup();
    failures.addLogs([
      { ts: 1, pid: 1, tid: 1, level: 'E', tag: 'Binder', message: '!!! FAILED BINDER TRANSACTION !!!' },
    ]);
    expect(failures.list()).toEqual([]);
  });

  it('keeps each failure report within MAX_FAILURE_REPORT_BYTES, dropping the oldest reports, not summaries', () => {
    const { failures, messages } = setup();
    const big = (ts: number) => ({ ...savedState(ts), activity: `com.example.${'X'.repeat(300_000)}` });
    for (const [index, pid] of [11, 12, 13, 14].entries()) {
      const ts = 1_800_000_000_000 + index * 10_000;
      failures.addSavedState(pid, big(ts - 5));
      failures.addLogs([
        {
          ts,
          pid,
          tid: pid,
          level: 'E',
          tag: 'JavaBinder',
          message: '!!! FAILED BINDER TRANSACTION !!!  (parcel size = 583524)',
        },
      ]);
    }
    const list = failures.list();
    expect(list.map((failure) => failure.report !== null)).toEqual([false, true, true, true]);
    expect(list.every((failure) => failure.savedState?.totalBytes === 583_420)).toBe(true);
    const total = list.reduce(
      (sum, failure) => sum + (failure.report ? Buffer.byteLength(JSON.stringify(failure.report)) : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_FAILURE_REPORT_BYTES);
    // The drop was announced.
    expect(messages.at(-1)).toMatchObject({ type: 'transactionFailure', failure: { id: 1, report: null } });
  });

  it('keeps the report with the summary it explains, replaced together', () => {
    const { failures, feed } = setup();
    const lines = fixtureLines(28);
    failures.addSavedState(3299, savedState(lines[0]!.ts - 400, 100_000));
    feed(lines);
    expect(failures.list()[0]?.report?.totalBytes).toBe(100_000);
    failures.addSavedState(3299, { ...savedState(lines[0]!.ts - 4), instanceId: 7 });
    expect(failures.list()[0]?.savedState).toMatchObject({ totalBytes: 583_420, instanceId: 7 });
    expect(failures.list()[0]?.report).toMatchObject({ totalBytes: 583_420, instanceId: 7 });
  });

  describe('two instances of one class saving at the same time with the same size', () => {
    /** A report of instance `instanceId` whose only entry is `key` (what tells the two apart). */
    const report = (ts: number, instanceId: number, key: string): SavedStateSample => ({
      ...savedState(ts),
      instanceId,
      entries: [
        { path: [key], bytes: 583_000, kind: 'value', fragment: null, valueClass: 'android.os.Bundle' },
      ],
    });
    const explained = (failures: TransactionFailures) => {
      const [failure] = failures.list();
      return [
        failure?.savedState?.instanceId,
        failure?.report?.instanceId,
        failure?.report?.entries[0]?.path[0],
      ];
    };

    it.each([
      ['both reports before the failure', ['a', 'b', 'failure']],
      ['the failure between the reports', ['a', 'failure', 'b']],
      ['both reports after the failure (late)', ['failure', 'a', 'b']],
    ] as const)('is explained by the later arrival, summary and report together: %s', (_label, order) => {
      const lines = fixtureLines(28);
      const t = lines[0]!.ts;
      const { failures, messages, feed } = setup();
      const steps = {
        a: () => failures.addSavedState(3299, report(t - 5, 1, 'payload1')),
        b: () => failures.addSavedState(3299, report(t - 5, 2, 'payload2')),
        failure: () => feed(lines),
      };
      for (const step of order) steps[step]();
      expect(explained(failures)).toEqual([2, 2, 'payload2']);

      // The same report again changes nothing and announces nothing.
      const emitted = messages.length;
      steps.b();
      expect(explained(failures)).toEqual([2, 2, 'payload2']);
      expect(messages.length).toBe(emitted);
    });
  });
});

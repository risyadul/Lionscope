import { describe, expect, it } from 'vitest';
import type { SessionState } from '@lionscope/protocol';
import { DontKeepActivities, parseAlwaysFinish } from '../src/agent/dontKeepActivities.ts';
import { callTool } from '../src/agent/registry.ts';
import {
  fullComponent,
  parseRecordStates,
  parseTopActivities,
  parseTopRecord,
} from '../src/agent/restoreTools.ts';
import type { UiHelpers } from '../src/agent/uiHelper.ts';
import { HELPER_REFUSED, UiHelperError } from '../src/agent/uiHelper.ts';
import { fakeAgent, PKG, RUNNING } from './helpers/agentFixtures.ts';
import { FakeAdb } from './helpers/fakes.ts';

/** `dumpsys activity top` (API 36): one section per visible task's top activity, the focused one last. */
function topDump(shop: { local: string; decor: string; pid: number | null; resumed?: boolean }): string {
  return [
    'TASK null id=2 userId=0 displayId=0(type=INTERNAL)',
    '  ACTIVITY com.android.launcher/.Launcher 9c6470b pid=998 userId=0 uid=10175 displayId=0(type=INTERNAL)',
    '    Local Activity 58cf0f6 State:',
    '      mResumed=false mStopped=true mFinished=false',
    '    View Hierarchy:',
    '      com.android.internal.policy.DecorView{1e945a4 I.E...... R.....ID 0,0-1080,2424 aid=1}[Launcher]',
    `TASK 10151:${PKG} id=111 userId=0 displayId=0(type=INTERNAL)`,
    `  ACTIVITY ${PKG}/.checkout.CheckoutActivity 8c965e2 pid=${shop.pid ?? '(not running)'} userId=0 uid=10151 displayId=0(type=INTERNAL)`,
    `    Local Activity ${shop.local} State:`,
    `      mResumed=${shop.resumed ?? true} mStopped=false mFinished=false`,
    '      mIsInMultiWindowMode=false mIsInPictureInPictureMode=false',
    '    Active Fragments:',
    '      CartFragment{8b1c2d0} (e1748422 id=0x7f0b014e tag=cart)',
    '        mCreated=true mResumed=false mStopped=true',
    '        mResumed=false',
    '    View Hierarchy:',
    `      com.android.internal.policy.DecorView{${shop.decor} V.E...... R....... 0,0-1080,2424 aid=0}[CheckoutActivity]`,
    '        android.widget.LinearLayout{67a0b12 V.E...... ........ 0,0-1080,2424}',
    '          android.widget.TextView{2c7e3a1 V.ED..... ........ 0,0-200,60 #7f0b0099 app:id/total}',
    '',
  ].join('\n');
}

/** `dumpsys activity -p com.example.shop activities`: records from the top task down, saved state included. */
function recordsDump(state: string, pid: number | null, taskId = 111): string {
  return [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    'Display #0 (activities from top to bottom):',
    `  * Task{9976d73 #${taskId} type=standard A=10151:${PKG} U=0 visible=false sz=2}`,
    `    * Hist  #1: ActivityRecord{147416546 u0 ${PKG}/.checkout.CheckoutActivity t${taskId}}`,
    `      packageName=${PKG} processName=${PKG}`,
    `      app=${pid === null ? 'null' : `ProcessRecord{2bb47aa ${pid}:${PKG}/u0a151}`}`,
    // An app's saved state is printed as it is: its strings must not be read as the record's fields.
    '      mHaveState=true mIcicle=Bundle[{note=',
    '      state=RESUMED delayedResume=false finishing=false',
    '      }]',
    `      state=${state} delayedResume=false finishing=false`,
    `    * Hist  #0: ActivityRecord{221774314 u0 ${PKG}/.MainActivity t${taskId}}`,
    '      app=ProcessRecord{2bb47aa 9999:com.example.shop/u0a151}',
    '      state=STOPPED delayedResume=false finishing=false',
    '',
  ].join('\n');
}

/**
 * The same records as Android 7 to 13 print them (ActivityRecord.dump/toString, AOSP 7.0.0_r1, 9.0.0_r1,
 * 10.0.0_r1, 12.0.0_r1, 13.0.0_r1): a `stopped=` field before `delayedResume=`, a hex hash, and a finishing record
 * ending in ` f}` up to Android 11 (` f}}` from 12).
 */
function legacyRecordsDump(state: string, pid: number | null, api: 9 | 13): string {
  const finishingEnd = api >= 12 ? 'f}}' : 'f}';
  return [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    'Display #0 (activities from top to bottom):',
    `  Stack #12: type=standard mode=fullscreen`,
    `    * TaskRecord{5d2e8a1 #12 A=${PKG} U=0 StackId=12 sz=3}`,
    `      * Hist #2: ActivityRecord{8f1c2a u0 ${PKG}/.MainActivity t12 ${finishingEnd}`,
    '          state=PAUSED stopped=false delayedResume=false finishing=true',
    `      * Hist #1: ActivityRecord{3b4c5d u0 ${PKG}/.checkout.CheckoutActivity t12}`,
    `          app=${pid === null ? 'null' : `ProcessRecord{2bb47aa ${pid}:${PKG}/u0a151}`}`,
    `          state=${state} stopped=${state === 'STOPPED'} delayedResume=false finishing=false`,
    `      * Hist #0: ActivityRecord{6e7f80 u0 ${PKG}/.MainActivity t12 isExiting}`,
    '          app=ProcessRecord{2bb47aa 9999:com.example.shop/u0a151}',
    '          state=STOPPED stopped=true delayedResume=false finishing=false',
    '',
  ].join('\n');
}

describe('restore scenario parsers', () => {
  it('reads each top activity, its instance, window and pid from dumpsys activity top', () => {
    expect(parseTopActivities(topDump({ local: 'ac7f4ab', decor: 'c1847fd', pid: 2134 }))).toEqual([
      {
        component: 'com.android.launcher/.Launcher',
        pid: 998,
        instanceId: '58cf0f6',
        resumed: false,
      },
      {
        component: `${PKG}/.checkout.CheckoutActivity`,
        pid: 2134,
        instanceId: 'ac7f4ab',
        resumed: true,
      },
    ]);
    expect(parseTopActivities(topDump({ local: 'ac7f4ab', decor: 'c1847fd', pid: null }))[1]?.pid).toBeNull();
    // Only an ACTIVITY line right after a TASK line starts a section: an app printing one in its own dump does not.
    expect(parseTopActivities('    ACTIVITY com.evil/.Fake 1 pid=1\n')).toEqual([]);
    const forged = topDump({ local: 'ac7f4ab', decor: 'c1847fd', pid: 2134 }).replace(
      '    Active Fragments:',
      '  ACTIVITY com.evil/.Fake 1 pid=1\n    Local Activity 2 State:\n      mResumed=true mStopped=false',
    );
    expect(parseTopActivities(forged).map((activity) => activity.component)).toEqual([
      'com.android.launcher/.Launcher',
      `${PKG}/.checkout.CheckoutActivity`,
    ]);
    expect(parseTopActivities('')).toEqual([]);
  });

  it("reads the package's topmost record and ignores saved-state text", () => {
    expect(parseTopRecord(recordsDump('STOPPED', 4321), PKG)).toEqual({
      component: `${PKG}/${PKG}.checkout.CheckoutActivity`,
      taskId: 111,
      state: 'STOPPED',
    });
    expect(parseTopRecord(recordsDump('DESTROYED', null), PKG)).toMatchObject({ state: 'DESTROYED' });
    expect(parseTopRecord(recordsDump('STOPPED', 4321), 'com.example.other')).toBeNull();
    // A trampoline on its way out (` f}`) is not the task's top activity.
    const finishing = recordsDump('RESUMED', 4321).replace(
      '  * Task{9976d73',
      [
        `  * Task{9976d73 #111 type=standard A=10151:${PKG} U=0 visible=true sz=3}`,
        `    * Hist  #2: ActivityRecord{228671138 u0 ${PKG}/.MainActivity t111 f}}`,
        '      state=STOPPING delayedResume=false finishing=true',
        '  * Task{9976d73',
      ].join('\n'),
    );
    expect(parseTopRecord(finishing, PKG)).toMatchObject({
      component: `${PKG}/${PKG}.checkout.CheckoutActivity`,
    });
    expect([...parseRecordStates(recordsDump('STOPPED', 4321)).values()]).toEqual([
      { state: 'STOPPED', attached: true },
      { state: 'STOPPED', attached: true },
    ]);
    expect([...parseRecordStates(recordsDump('DESTROYED', null)).values()][0]).toEqual({
      state: 'DESTROYED',
      attached: false,
    });
    // Android 7 to 13: the `stopped=` field, finishing (` f}` / ` f}}`) and isExiting records.
    for (const api of [9, 13] as const) {
      expect(parseTopRecord(legacyRecordsDump('STOPPED', 4321, api), PKG)).toEqual({
        component: `${PKG}/${PKG}.checkout.CheckoutActivity`,
        taskId: 12,
        state: 'STOPPED',
      });
      expect([...parseRecordStates(legacyRecordsDump('STOPPING', 4321, api)).values()]).toEqual([
        { state: 'PAUSED', attached: false },
        { state: 'STOPPING', attached: true },
        { state: 'STOPPED', attached: true },
      ]);
    }
    expect(fullComponent('com.example.shop/com.example.lib.Screen')).toBe(
      'com.example.shop/com.example.lib.Screen',
    );
  });
});

describe('get_activity_instance', () => {
  function instanceAgent() {
    const screen = { local: 'ac7f4ab', decor: 'c1847fd', pid: 2134 as number | null, resumed: true };
    const adb = new FakeAdb((args) =>
      String(args.at(-1)) === 'dumpsys activity top' ? topDump(screen) : '',
    );
    return { agent: fakeAgent({}, { adb }), screen };
  }

  it('compares the instance and pid with the previous call', async () => {
    const { agent, screen } = instanceAgent();
    const activity = `${PKG}/${PKG}.checkout.CheckoutActivity`;
    expect(await callTool(agent.ctx, 'get_activity_instance', { packageName: PKG }, true)).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        packageName: PKG,
        activity,
        instanceId: 'ac7f4ab',
        pid: 2134,
        recreated: null,
        processRestarted: null,
        previous: null,
      },
    });
    // Back from the background: the same object.
    expect(await callTool(agent.ctx, 'get_activity_instance', {}, true)).toMatchObject({
      result: { recreated: false, processRestarted: false },
    });
    screen.local = 'e315c50';
    expect(await callTool(agent.ctx, 'get_activity_instance', {}, true)).toMatchObject({
      result: {
        instanceId: 'e315c50',
        recreated: true,
        processRestarted: false,
        previous: { activity, instanceId: 'ac7f4ab', pid: 2134 },
      },
    });
    screen.local = 'a8c4248';
    screen.pid = 4317;
    expect(await callTool(agent.ctx, 'get_activity_instance', { packageName: PKG }, true)).toMatchObject({
      result: { recreated: true, processRestarted: true, pid: 4317 },
    });
    // A new process can hand out the same identity hash: still a new instance.
    screen.pid = 4400;
    expect(await callTool(agent.ctx, 'get_activity_instance', {}, true)).toMatchObject({
      result: { instanceId: 'a8c4248', recreated: true, processRestarted: true },
    });
  });

  it('waits briefly for an activity that is about to be resumed', async () => {
    const { agent, screen } = instanceAgent();
    screen.resumed = false;
    setTimeout(() => (screen.resumed = true), 300);
    expect(await callTool(agent.ctx, 'get_activity_instance', { packageName: PKG }, true)).toMatchObject({
      ok: true,
      result: { instanceId: 'ac7f4ab' },
    });
  });

  it('needs the app on screen, and device control', async () => {
    const { agent, screen } = instanceAgent();
    expect(
      await callTool(agent.ctx, 'get_activity_instance', { packageName: 'com.example.other' }, true),
    ).toEqual({
      ok: false,
      code: 'failed',
      error: `com.example.other is not on screen on emulator-5554 (${PKG}/${PKG}.checkout.CheckoutActivity is): bring it to the front first`,
    });
    screen.resumed = false;
    expect(await callTool(agent.ctx, 'get_activity_instance', {}, true)).toMatchObject({ ok: false });
    expect(await callTool(agent.ctx, 'get_activity_instance', {}, false)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(agent.ctx.activityInstances.size).toBe(0);
  });
});

/** `dumpsys activity processes` as the tools filter it on the device: the header, and the flag's line while on. */
function processesGrep(on: boolean): string {
  return `ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)\n${on ? '  mAlwaysFinishActivities=true\n' : ''}`;
}

describe('set_dont_keep_activities', () => {
  /**
   * A device whose helper switches the flag (unless `fail`); with the flag on, the shop's stopped CheckoutActivity
   * (in the background with its process) is destroyed, unless `keeps`. `api` picks the record format.
   */
  function dontKeepAgent(
    options: { fail?: boolean; keeps?: boolean; background?: boolean; on?: boolean; api?: 13 | 36 } = {},
  ) {
    const device = { live: options.on ?? false, stored: options.on ? '1' : '0', destroyed: false };
    const calls: boolean[] = [];
    const adb = new FakeAdb((args) => {
      const command = String(args.at(-1));
      if (command.startsWith('dumpsys activity processes')) return processesGrep(device.live);
      if (command === 'dumpsys activity activities') {
        if (options.background === false) return 'Display #0 (activities from top to bottom):\n';
        const [state, pid] = device.destroyed ? ['DESTROYED', null] : ['STOPPED', 4321];
        return options.api === 13
          ? legacyRecordsDump(String(state), pid as number | null, 13)
          : recordsDump(String(state), pid as number | null);
      }
      if (command === 'settings get global always_finish_activities') return `${device.stored}\n`;
      const put = /^settings put global always_finish_activities ([01])$/.exec(command)?.[1];
      if (put) device.stored = put;
      return '';
    });
    const agent = fakeAgent({}, { adb });
    agent.ctx.uiHelper = {
      setAlwaysFinish: async (_serial: string, enabled: boolean) => {
        calls.push(enabled);
        if (options.fail) throw new UiHelperError(HELPER_REFUSED);
        device.live = enabled;
        device.stored = enabled ? '1' : '0';
        device.destroyed = enabled && !options.keeps;
      },
    } as unknown as UiHelpers;
    return { agent, adb, calls, device };
  }
  const commands = (adb: FakeAdb) => adb.execCalls.map((args) => String(args.at(-1)));

  it('switches the flag through the helper and verifies it and its effect', async () => {
    const { agent, adb, calls } = dontKeepAgent();
    const on = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true);
    expect(on).toMatchObject({
      ok: true,
      result: {
        serial: 'emulator-5554',
        enabled: true,
        verified: true,
        activityManager: true,
        // Both stopped activities had their process; the fake destroys CheckoutActivity only.
        destroyCheck: { background: 2, destroyed: 1 },
        setting: true,
        autoOff: true,
      },
    });
    expect(JSON.stringify(on)).toContain('enabled: false');
    expect(calls).toEqual([true]);
    expect(commands(adb).slice(0, 3)).toEqual([
      "dumpsys activity processes | grep -e '^ACTIVITY MANAGER RUNNING PROCESSES' -e '^  mAlwaysFinishActivities=true$' || true",
      'settings get global always_finish_activities',
      'dumpsys activity activities',
    ]);
    expect(await callTool(agent.ctx, 'status', {}, true)).toMatchObject({
      result: {
        devices: [{ serial: 'emulator-5554', dontKeepActivities: true }, { dontKeepActivities: false }],
      },
    });
    const off = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: false }, true);
    expect(off).toMatchObject({
      ok: true,
      result: {
        enabled: false,
        verified: true,
        activityManager: false,
        destroyCheck: null,
        setting: false,
        autoOff: false,
      },
    });
    expect(off.ok && (off.result as Record<string, unknown>).note).toBeUndefined();
    expect(commands(adb).some((command) => command.startsWith('settings put'))).toBe(false);
  });

  it('watches the background activities in the record format of Android 13', async () => {
    const { agent } = dontKeepAgent({ api: 13 });
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true)).toMatchObject({
      result: { verified: true, destroyCheck: { background: 2, destroyed: 1 } },
    });
  });

  it('leaves a setting that was already on to the user, and watches nothing then', async () => {
    const { agent, adb } = dontKeepAgent({ on: true });
    const outcome = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true);
    expect(outcome).toMatchObject({ result: { verified: true, destroyCheck: null, autoOff: false } });
    expect(commands(adb)).not.toContain('dumpsys activity activities');
    expect(outcome.ok && String((outcome.result as Record<string, unknown>).note)).toContain(
      'was on already',
    );
    expect(agent.ctx.dontKeepActivities.isOn('emulator-5554')).toBe(false);
  });

  it('counts the flag alone when nothing is in the background, and not when nothing gets destroyed', async () => {
    const empty = dontKeepAgent({ background: false });
    expect(
      await callTool(empty.agent.ctx, 'set_dont_keep_activities', { enabled: true }, true),
    ).toMatchObject({
      result: { verified: true, activityManager: true, destroyCheck: null },
    });
    const keeps = dontKeepAgent({ keeps: true });
    const kept = await callTool(keeps.agent.ctx, 'set_dont_keep_activities', { enabled: true }, true);
    expect(kept).toMatchObject({
      result: { verified: false, activityManager: true, destroyCheck: { background: 2, destroyed: 0 } },
    });
    expect(kept.ok && String((kept.result as Record<string, unknown>).note)).toContain(
      'next process-priority update',
    );
  }, 20_000);

  it('fails without changing anything when it cannot be switched on', async () => {
    const { agent, adb } = dontKeepAgent({ fail: true });
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true)).toEqual({
      ok: false,
      code: 'failed',
      error: `Could not switch "Don't keep activities" on on emulator-5554 (${HELPER_REFUSED}); nothing was changed`,
    });
    expect(commands(adb).some((command) => command.startsWith('settings put'))).toBe(false);
    expect(agent.ctx.dontKeepActivities.isOn('emulator-5554')).toBe(false);
    delete agent.ctx.uiHelper;
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('this server has no on-device helper'),
    });
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, false)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('clears the stored setting when it cannot be switched off, unverified, and keeps it marked', async () => {
    const { agent, device } = dontKeepAgent();
    await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true);
    agent.ctx.uiHelper = {
      setAlwaysFinish: async () => {
        throw new UiHelperError(HELPER_REFUSED);
      },
    } as unknown as UiHelpers;
    const off = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: false }, true);
    expect(off).toMatchObject({
      ok: true,
      result: { verified: false, activityManager: true, setting: false, autoOff: true },
    });
    expect(off.ok && String((off.result as Record<string, unknown>).note)).toContain(
      'could not be switched off',
    );
    expect(device.stored).toBe('0');
  });

  it("refuses to guess when the activity manager's dump is empty", async () => {
    const { agent, adb, calls } = dontKeepAgent();
    const base = adb.execHandler;
    adb.execHandler = (args) =>
      String(args.at(-1)).startsWith('dumpsys activity processes') ? '' : base(args);
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: false }, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Could not read the activity manager's state on emulator-5554"),
    });
    expect(calls).toEqual([]);
  });
});

describe('simulate_process_death', () => {
  /**
   * A device where the shop app runs (pid 4321) with CheckoutActivity on top: HOME stops it, `am kill` kills it
   * unless `survives`, and the helper's task-to-front brings its task back in a new process (pid 4400).
   */
  function deathAgent(
    options: {
      survives?: boolean;
      state?: string;
      installed?: boolean;
      reopenFails?: boolean;
      /** What startActivityFromRecents answers (default 2, START_TASK_TO_FRONT). */
      startResult?: number;
      /** The reopened activity never gets resumed (it crashes while restoring). */
      crashes?: boolean;
      api?: 13 | 36;
    } = {},
  ) {
    const device = { pid: 4321 as number | null, state: options.state ?? 'RESUMED', polls: 0 };
    const tasksToFront: number[] = [];
    const adb = new FakeAdb((args) => {
      const command = String(args.at(-1));
      if (command.startsWith('pm path'))
        return options.installed === false ? '' : 'package:/data/app/base.apk\n';
      if (command.startsWith(`dumpsys activity -p ${PKG} activities`)) {
        // Stopping takes a moment after HOME.
        if (device.state === 'PAUSED' && ++device.polls > 1) device.state = 'STOPPED';
        return options.api === 13
          ? legacyRecordsDump(device.state, device.pid, 13)
          : recordsDump(device.state, device.pid);
      }
      if (command === `pidof ${PKG} || true`) return device.pid === null ? '' : `${device.pid}\n`;
      if (command === 'input keyevent 3') device.state = 'PAUSED';
      if (command === `am kill ${PKG}` && !options.survives) {
        device.pid = null;
        device.state = 'DESTROYED';
      }
      return '';
    });
    const agent = fakeAgent({}, { adb });
    agent.ctx.uiHelper = {
      taskToFront: async (_serial: string, taskId: number) => {
        tasksToFront.push(taskId);
        if (options.reopenFails) throw new UiHelperError(HELPER_REFUSED);
        const result = options.startResult ?? 2;
        if (result < 0 || result >= 100) return result;
        device.pid ??= 4400;
        device.state = options.crashes ? 'DESTROYED' : 'RESUMED';
        return result;
      },
    } as unknown as UiHelpers;
    return { agent, adb, device, tasksToFront };
  }
  const commands = (adb: FakeAdb) => adb.execCalls.map((args) => String(args.at(-1)));
  const checkout = `${PKG}/${PKG}.checkout.CheckoutActivity`;

  it('backgrounds, waits for the stop, kills, and brings the same task back', async () => {
    const { agent, adb, tasksToFront } = deathAgent();
    expect(await callTool(agent.ctx, 'simulate_process_death', { packageName: PKG }, true)).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        packageName: PKG,
        oldPid: 4321,
        newPid: 4400,
        killed: true,
        reopened: true,
        resumed: true,
        previousTopActivity: checkout,
        topActivity: checkout,
        sameTask: true,
      },
    });
    const sent = commands(adb);
    const order = ['input keyevent 3', `am kill ${PKG}`].map((command) => sent.indexOf(command));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0] ?? 0);
    // The kill comes only after the record reported STOPPED.
    expect(sent.filter((command) => command.startsWith('dumpsys')).length).toBeGreaterThanOrEqual(3);
    // Recents' way, never an `am start`, which could add an activity to the task.
    expect(tasksToFront).toEqual([111]);
    expect(sent.some((command) => command.startsWith('am start'))).toBe(false);
  });

  it('works with the record format of Android 7 to 13 (a `stopped=` field before `delayedResume=`)', async () => {
    const { agent, tasksToFront } = deathAgent({ api: 13 });
    expect(await callTool(agent.ctx, 'simulate_process_death', { packageName: PKG }, true)).toMatchObject({
      ok: true,
      result: {
        oldPid: 4321,
        newPid: 4400,
        killed: true,
        resumed: true,
        topActivity: checkout,
        sameTask: true,
      },
    });
    expect(tasksToFront).toEqual([12]);
  });

  it('says when the activity does not come back, and when the system refuses the start', async () => {
    const crashing = deathAgent({ crashes: true });
    const outcome = await callTool(crashing.agent.ctx, 'simulate_process_death', { packageName: PKG }, true);
    expect(outcome).toMatchObject({ ok: true, result: { killed: true, reopened: true, resumed: false } });
    expect(outcome.ok && String((outcome.result as Record<string, unknown>).note)).toContain('get_crashes');
    const refused = deathAgent({ startResult: 102 });
    expect(await callTool(refused.agent.ctx, 'simulate_process_death', { packageName: PKG }, true)).toEqual({
      ok: false,
      code: 'failed',
      error: `${PKG} was killed (pid 4321), but its task could not be brought back: the system refused it (start result 102); open it from Recents`,
    });
  }, 30_000);

  it('only kills with reopen: false, and skips HOME for an app already in the background', async () => {
    const { agent, adb, tasksToFront } = deathAgent({ state: 'STOPPED' });
    // Killing alone needs no helper.
    delete agent.ctx.uiHelper;
    expect(
      await callTool(agent.ctx, 'simulate_process_death', { packageName: PKG, reopen: false }, true),
    ).toMatchObject({
      ok: true,
      result: {
        oldPid: 4321,
        newPid: null,
        killed: true,
        reopened: false,
        resumed: null,
        topActivity: null,
        sameTask: null,
      },
    });
    const sent = commands(adb);
    expect(sent).not.toContain('input keyevent 3');
    expect(tasksToFront).toEqual([]);
  });

  it('says so when the process survives the kill', async () => {
    const { agent, adb } = deathAgent({ survives: true });
    expect(await callTool(agent.ctx, 'simulate_process_death', { packageName: PKG }, true)).toMatchObject({
      ok: true,
      result: { oldPid: 4321, newPid: 4321, killed: false, reopened: true },
    });
    // `am kill` is repeated while the process is there (its priority drops a moment after the stop).
    expect(commands(adb).filter((command) => command === `am kill ${PKG}`).length).toBeGreaterThan(1);
  }, 15_000);

  it('says what happened when the task cannot be brought back, and needs the helper to reopen', async () => {
    const { agent } = deathAgent({ reopenFails: true });
    expect(await callTool(agent.ctx, 'simulate_process_death', { packageName: PKG }, true)).toEqual({
      ok: false,
      code: 'failed',
      error: `${PKG} was killed (pid 4321), but its task could not be brought back: ${HELPER_REFUSED}; open it from Recents`,
    });
    const noHelper = deathAgent();
    delete noHelper.agent.ctx.uiHelper;
    expect(
      await callTool(noHelper.agent.ctx, 'simulate_process_death', { packageName: PKG }, true),
    ).toMatchObject({ ok: false, error: expect.stringContaining('pass reopen: false') });
    expect(noHelper.adb.execCalls).toHaveLength(0);
  });

  it('refuses an app that is not installed, has no task or is not running', async () => {
    const missing = deathAgent({ installed: false });
    expect(
      await callTool(missing.agent.ctx, 'simulate_process_death', { packageName: PKG }, true),
    ).toMatchObject({
      ok: false,
      error: `${PKG} is not installed on emulator-5554`,
    });
    const notRunning = deathAgent();
    notRunning.device.pid = null;
    expect(
      await callTool(notRunning.agent.ctx, 'simulate_process_death', { packageName: PKG }, true),
    ).toMatchObject({ ok: false, error: `${PKG} is not running on emulator-5554: open it first` });
    const noTask = deathAgent();
    noTask.adb.execHandler = (args) =>
      String(args.at(-1)).startsWith('pm path') ? 'package:/data/app/base.apk\n' : 'Display #0\n';
    expect(
      await callTool(noTask.agent.ctx, 'simulate_process_death', { packageName: PKG }, true),
    ).toMatchObject({
      ok: false,
      error: `${PKG} has no activity on emulator-5554: open it first (launch_app)`,
    });
    for (const { adb } of [missing, notRunning, noTask]) {
      expect(
        commands(adb).some((command) => command.startsWith('am kill') || command.startsWith('input')),
      ).toBe(false);
    }
  });
});

describe('bring_to_front', () => {
  function frontAgent(options: { hasTask?: boolean; crashes?: boolean } = {}) {
    const device = { state: 'STOPPED' };
    const tasks: number[] = [];
    const adb = new FakeAdb((args) =>
      String(args.at(-1)) === `dumpsys activity -p ${PKG} activities` && options.hasTask !== false
        ? recordsDump(device.state, 4321)
        : '',
    );
    const agent = fakeAgent({}, { adb });
    agent.ctx.uiHelper = {
      taskToFront: async (_serial: string, taskId: number) => {
        tasks.push(taskId);
        device.state = options.crashes ? 'DESTROYED' : 'RESUMED';
        return 2;
      },
    } as unknown as UiHelpers;
    return { agent, adb, tasks };
  }

  it("brings the app's task back the way Recents does, without am start", async () => {
    const { agent, adb, tasks } = frontAgent();
    expect(await callTool(agent.ctx, 'bring_to_front', { packageName: PKG }, true)).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        packageName: PKG,
        topActivity: `${PKG}/${PKG}.checkout.CheckoutActivity`,
        resumed: true,
        sameTask: true,
      },
    });
    expect(tasks).toEqual([111]);
    expect(adb.execCalls.some((args) => String(args.at(-1)).startsWith('am start'))).toBe(false);
  });

  it('needs a task, the helper and device control', async () => {
    const { agent } = frontAgent({ hasTask: false });
    expect(await callTool(agent.ctx, 'bring_to_front', { packageName: PKG }, true)).toMatchObject({
      ok: false,
      error: `${PKG} has no task on emulator-5554: open it with launch_app`,
    });
    const noHelper = frontAgent();
    delete noHelper.agent.ctx.uiHelper;
    expect(await callTool(noHelper.agent.ctx, 'bring_to_front', { packageName: PKG }, true)).toMatchObject({
      ok: false,
      error: `Could not bring ${PKG} back on emulator-5554: this server has no on-device helper`,
    });
    expect(await callTool(agent.ctx, 'bring_to_front', { packageName: PKG }, false)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
});

describe('DontKeepActivities', () => {
  /** A device with the flag and the stored setting; the helper switches both (as setAlwaysFinish does). */
  function tracked(
    options: { live?: boolean; stored?: boolean; helperFails?: () => boolean; hang?: () => boolean } = {},
  ) {
    const device = { live: options.live ?? false, stored: options.stored ?? false };
    const switches: boolean[] = [];
    const puts: string[] = [];
    const adb = new FakeAdb((args) => {
      const command = String(args.at(-1));
      if (command.startsWith('dumpsys activity processes')) return processesGrep(device.live);
      if (command === 'settings get global always_finish_activities') return device.stored ? '1\n' : 'null\n';
      const put = /^settings put global always_finish_activities ([01])$/.exec(command)?.[1];
      if (put) {
        puts.push(put);
        device.stored = put === '1';
      }
      return '';
    });
    const helpers = {
      setAlwaysFinish: async (_serial: string, enabled: boolean) => {
        switches.push(enabled);
        if (options.hang?.()) await new Promise(() => undefined);
        if (options.helperFails?.()) throw new UiHelperError(HELPER_REFUSED);
        device.live = enabled;
        device.stored = enabled;
      },
    } as unknown as UiHelpers;
    return { state: new DontKeepActivities({ adb, helpers: () => helpers }), device, switches, puts };
  }
  const session = (serial: string | null, status: SessionState['status']): SessionState => ({
    ...RUNNING,
    serial,
    status,
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const DEVICE = { serial: 'emulator-5554', state: 'device' as const };

  it('reads the flag only from a real processes dump', () => {
    expect(parseAlwaysFinish(processesGrep(true))).toBe(true);
    expect(parseAlwaysFinish(processesGrep(false))).toBe(false);
    expect(parseAlwaysFinish('')).toBeNull();
    // Indented differently, the line is not the activity manager's.
    expect(parseAlwaysFinish(`${processesGrep(false)}    mAlwaysFinishActivities=true\n`)).toBe(false);
  });

  it('puts back on close only what it switched on, as it was', async () => {
    const off = tracked();
    expect(await off.state.enable('emulator-5554', await off.state.state('emulator-5554'))).toBeNull();
    expect(off.state.isOn('emulator-5554')).toBe(true);
    await off.state.close();
    expect(off.switches).toEqual([true, false]);
    expect(off.device).toEqual({ live: false, stored: false });
    expect(off.state.isOn('emulator-5554')).toBe(false);
    // Already on (flag and setting): not Lionscope's to undo.
    const on = tracked({ live: true, stored: true });
    await on.state.enable('emulator-5554', await on.state.state('emulator-5554'));
    expect(on.state.isOn('emulator-5554')).toBe(false);
    await on.state.close();
    expect(on.switches).toEqual([true]);
  });

  it('puts a stored value written without effect (settings put) back too', async () => {
    const { state, device, puts } = tracked({ stored: true });
    const before = await state.state('emulator-5554');
    expect(before).toEqual({ live: false, stored: true });
    await state.enable('emulator-5554', before);
    expect(state.isOn('emulator-5554')).toBe(true);
    expect(await state.restore('emulator-5554')).toBe(true);
    expect(device).toEqual({ live: false, stored: true });
    expect(puts).toEqual(['1']);
  });

  it('puts it back when the device session stops, not when a new session replaces it there', async () => {
    const { state, switches } = tracked();
    await state.enable('emulator-5554', { live: false, stored: false });
    let current = session('emulator-5554', 'waiting_for_process');
    state.sessionChanged(session('emulator-5554', 'idle'), () => current);
    await tick();
    expect(switches).toEqual([true]);
    current = session('emulator-5554', 'idle');
    state.sessionChanged(session('emulator-5554', 'idle'), () => current);
    await tick();
    await tick();
    expect(switches).toEqual([true, false]);
    expect(state.isOn('emulator-5554')).toBe(false);
  });

  it('keeps the device marked when putting it back fails, and retries when the device comes back', async () => {
    let failing = false;
    const { state, device, switches } = tracked({ helperFails: () => failing });
    await state.enable('emulator-5554', { live: false, stored: false });
    failing = true;
    expect(await state.restore('emulator-5554')).toBe(false);
    expect(state.isOn('emulator-5554')).toBe(true);
    const idle = () => session('emulator-5554', 'error');
    state.setDevices([DEVICE], idle);
    await tick();
    await tick();
    // Listed as before: no retry yet (it only retries a device that comes back).
    const tries = switches.length;
    state.setDevices([DEVICE], idle);
    await tick();
    expect(switches).toHaveLength(tries);
    failing = false;
    state.setDevices([], idle);
    state.setDevices([DEVICE], idle);
    await tick();
    await tick();
    expect(device.live).toBe(false);
    expect(state.isOn('emulator-5554')).toBe(false);
  });

  it('leaves a marked device alone when it only reconnects (a USB flicker mid-scenario)', async () => {
    const { state, switches } = tracked();
    await state.enable('emulator-5554', { live: false, stored: false });
    const idle = () => session(null, 'idle');
    state.setDevices([DEVICE], idle);
    state.setDevices([], idle);
    state.setDevices([DEVICE], idle);
    await tick();
    await tick();
    expect(switches).toEqual([true]);
    expect(state.isOn('emulator-5554')).toBe(true);
  });

  it('puts back as it was on an explicit switch-off, keeping a stored value the user had', async () => {
    const { state, device } = tracked({ stored: true });
    await state.enable('emulator-5554', await state.state('emulator-5554'));
    expect(await state.disable('emulator-5554')).toBeNull();
    expect(device).toEqual({ live: false, stored: true });
    expect(state.isOn('emulator-5554')).toBe(false);
  });

  it('always ends with the flag off on an explicit switch-off, even if it was on before', async () => {
    // On before but not stored (e.g. stored cleared by hand): Lionscope marked it when switching it on.
    const { state, device } = tracked({ live: true, stored: false });
    await state.enable('emulator-5554', await state.state('emulator-5554'));
    expect(state.isOn('emulator-5554')).toBe(true);
    expect(await state.disable('emulator-5554')).toBeNull();
    expect(device).toEqual({ live: false, stored: false });
    expect(state.isOn('emulator-5554')).toBe(false);
    // The same while a put-back to "on" is running.
    const racing = tracked({ live: true, stored: false });
    await racing.state.enable('emulator-5554', await racing.state.state('emulator-5554'));
    const putBack = racing.state.restore('emulator-5554');
    expect(await racing.state.disable('emulator-5554')).toBeNull();
    await putBack;
    expect(racing.device.live).toBe(false);
  });

  it('writes the stored value back even when the flag cannot be switched back', async () => {
    let failing = false;
    const { state, device, puts } = tracked({ helperFails: () => failing });
    await state.enable('emulator-5554', { live: false, stored: false });
    failing = true;
    expect(await state.restore('emulator-5554')).toBe(false);
    expect(puts).toEqual(['0']);
    expect(device).toEqual({ live: true, stored: false });
    expect(state.isOn('emulator-5554')).toBe(true);
  });

  it('switches it on after a put-back already running, and keeps it marked', async () => {
    const { state, device, switches } = tracked();
    await state.enable('emulator-5554', { live: false, stored: false });
    const putBack = state.restore('emulator-5554');
    expect(await state.enable('emulator-5554', { live: true, stored: true })).toBeNull();
    expect(await putBack).toBe(true);
    expect(switches).toEqual([true, false, true]);
    expect(device.live).toBe(true);
    expect(state.isOn('emulator-5554')).toBe(true);
  });

  it('does not let a stuck device hold up closing', async () => {
    let hang = false;
    const { state } = tracked({ hang: () => hang });
    await state.enable('emulator-5554', { live: false, stored: false });
    hang = true;
    const started = performance.now();
    await state.close(100);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(state.isOn('emulator-5554')).toBe(true);
  });
});

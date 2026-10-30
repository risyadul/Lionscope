import { describe, expect, it } from 'vitest';
import { callTool } from '../src/agent/registry.ts';
import {
  fullComponent,
  parseRecordStates,
  parseTopActivities,
  parseTopRecord,
} from '../src/agent/restoreTools.ts';
import type { UiHelpers } from '../src/agent/uiHelper.ts';
import { HELPER_REFUSED, UiHelperError } from '../src/agent/uiHelper.ts';
import { fakeAgent, PKG } from './helpers/agentFixtures.ts';
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
    // Only the system's own ACTIVITY line (two spaces in) starts a section.
    expect(parseTopActivities('    ACTIVITY com.evil/.Fake 1 pid=1\n')).toEqual([]);
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

describe('set_dont_keep_activities', () => {
  /**
   * A device whose helper switches the flag (unless `fail`); with the flag on, the shop's stopped CheckoutActivity
   * (in the background with its process) is destroyed, unless `keeps`.
   */
  function dontKeepAgent(options: { fail?: boolean; keeps?: boolean; background?: boolean } = {}) {
    const device = { live: false, stored: '0', destroyed: false };
    const calls: boolean[] = [];
    const adb = new FakeAdb((args) => {
      const command = String(args.at(-1));
      if (command.startsWith('dumpsys activity processes')) return device.live ? '1\n' : '0\n';
      if (command === 'dumpsys activity activities') {
        if (options.background === false) return 'Display #0 (activities from top to bottom):\n';
        return device.destroyed ? recordsDump('DESTROYED', null) : recordsDump('STOPPED', 4321);
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
      },
    });
    expect(JSON.stringify(on)).toContain('enabled: false');
    expect(calls).toEqual([true]);
    expect(commands(adb)[0]).toBe('dumpsys activity activities');
    const off = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: false }, true);
    expect(off).toMatchObject({
      ok: true,
      result: { enabled: false, verified: true, activityManager: false, destroyCheck: null, setting: false },
    });
    expect(off.ok && (off.result as Record<string, unknown>).note).toBeUndefined();
    expect(commands(adb).some((command) => command.startsWith('settings put'))).toBe(false);
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

  it('falls back to the stored setting, unverified, when the helper fails or is missing', async () => {
    const { agent, adb, device } = dontKeepAgent({ fail: true });
    const outcome = await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, true);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        enabled: true,
        verified: false,
        activityManager: false,
        destroyCheck: null,
        setting: true,
        fallback: true,
      },
    });
    expect(outcome.ok && String((outcome.result as Record<string, unknown>).note)).toContain(
      `could not be switched (${HELPER_REFUSED})`,
    );
    expect(commands(adb)).toContain('settings put global always_finish_activities 1');
    expect(device.stored).toBe('1');
    delete agent.ctx.uiHelper;
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: false }, true)).toMatchObject({
      result: { verified: false, setting: false, fallback: true },
    });
    expect(await callTool(agent.ctx, 'set_dont_keep_activities', { enabled: true }, false)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
});

describe('simulate_process_death', () => {
  /**
   * A device where the shop app runs (pid 4321) with CheckoutActivity on top: HOME stops it, `am kill` kills it
   * unless `survives`, and the helper's task-to-front brings its task back in a new process (pid 4400).
   */
  function deathAgent(
    options: { survives?: boolean; state?: string; installed?: boolean; reopenFails?: boolean } = {},
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
        return recordsDump(device.state, device.pid);
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
        device.pid ??= 4400;
        device.state = 'RESUMED';
        return 2;
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

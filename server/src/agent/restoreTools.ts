/**
 * State-restore scenarios (device control): which instance of an activity is on screen, "Don't keep activities",
 * and a process death that keeps the task, the way Android kills a backgrounded app to free memory. Unlike
 * stop_app (a force-stop, which discards the saved state and the task), these bring the app back through
 * onSaveInstanceState / onCreate(savedInstanceState).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { adbShell } from '../adb/adb.ts';
import { errorMessage } from '../log.ts';
import { parsePidof } from '../parsers/shellValues.ts';
import { INPUT, input, optionalSerial, targetSerial } from './deviceTools.ts';
import { packageInput } from './sessionTools.ts';
import { defineTool, ToolError } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { invalidateUi } from './uiDump.ts';

const SHELL_TIMEOUT_MS = 10_000;
/** `dumpsys activity top` waits for every visible app to dump its activity. */
const DUMPSYS_TIMEOUT_MS = 15_000;
/** A one-shot run of the UI helper (push, app_process, the answer). */
const HELPER_RUN_TIMEOUT_MS = 20_000;
const POLL_MS = 250;
/** How long get_activity_instance waits for an activity to be resumed (just after a launch). */
const RESUME_TIMEOUT_MS = 2000;
/**
 * After HOME, how long the app gets to be stopped (its state saved) before the kill: Android stops a backgrounded
 * activity once the next one is idle, at the latest after its 10 s idle timeout. Also how long it gets to come back.
 */
export const BACKGROUND_TIMEOUT_MS = 15_000;
/** How long `am kill` is repeated until the process is gone. */
export const KILL_TIMEOUT_MS = 5000;

const COMPONENT = /^[A-Za-z][\w.]*\/[\w.$]+$/;
const HEX = /^[0-9a-f]{1,16}$/;

/**
 * A record line of `dumpsys activity activities`: `* Hist  #1: ActivityRecord{<hash> u0 <component> t<task>}`, with
 * ` f}` for a finishing record (` t12 f}` up to Android 11, ` t12 f}}` from 12) and ` isExiting` from Android 12
 * (ActivityRecord.toString, AOSP 7.0.0_r1 to 16.0.0_r1). Groups: the record, its component, task, flags.
 */
const HIST_LINE = /^\s*\* Hist\s+#\d+: (ActivityRecord\{\S+ u\d+ (\S+) t(\d+))((?: f\}| isExiting)*)\}?\s*$/;
/**
 * A record's state line (ActivityRecord.dump): `state=STOPPED stopped=true delayedResume=false …` up to Android 13
 * (AOSP 7.0.0_r1, 9.0.0_r1, 10.0.0_r1, 12.0.0_r1, 13.0.0_r1), `state=STOPPED delayedResume=false …` from 14.
 */
const STATE_LINE = /^\s+state=([A-Z_]+) (?:stopped=(?:true|false) )?delayedResume=(?:true|false) /;

/** One activity of `dumpsys activity top`, as the system and the app's own dump report it. */
export interface TopActivity {
  /** package/class as the system prints it (the class may be relative: `.MainActivity`). */
  component: string;
  /** The app process, null when the dump says it is not running. */
  pid: number | null;
  /** The Activity object's identity hash ("Local Activity <hash> State:"): new when the activity is recreated. */
  instanceId: string | null;
  resumed: boolean;
}

/**
 * The activities `dumpsys activity top` lists (the top activity of each visible task, the focused one last). The
 * app dumps part of each section itself and could print lines that look like the system's: only an ACTIVITY line
 * right after a TASK line starts a section, and every value is checked against its format. An app that forges a
 * whole TASK and ACTIVITY pair can still misreport itself; nothing read here reaches a command.
 */
export function parseTopActivities(dump: string): TopActivity[] {
  const activities: TopActivity[] = [];
  let current: TopActivity | null = null;
  // The activity's own lifecycle line comes first; fragments print theirs later.
  let lifecycleRead = false;
  let previousLine = '';
  for (const line of dump.split(/\r?\n/)) {
    const afterTask = previousLine.startsWith('TASK ');
    previousLine = line;
    const header = afterTask ? /^ {2}ACTIVITY (\S+) [0-9a-f]+ pid=(\d+|\(not running\))/.exec(line) : null;
    if (header) {
      const [, component = '', pid = ''] = header;
      current = COMPONENT.test(component)
        ? {
            component,
            pid: /^\d+$/.test(pid) ? Number(pid) : null,
            instanceId: null,
            resumed: false,
          }
        : null;
      if (current) activities.push(current);
      lifecycleRead = false;
      continue;
    }
    if (!current) continue;
    const local = /^\s+Local Activity ([0-9a-f]+) State:/.exec(line)?.[1];
    if (local && current.instanceId === null && HEX.test(local)) {
      current.instanceId = local;
      continue;
    }
    const resumed = /^\s+mResumed=(true|false) /.exec(line)?.[1];
    if (resumed && current.instanceId !== null && !lifecycleRead) {
      current.resumed = resumed === 'true';
      lifecycleRead = true;
    }
  }
  return activities;
}

/** The package of `package/class`. */
function packageOf(component: string): string {
  return component.slice(0, component.indexOf('/'));
}

/** `package/.Class` → `package/package.Class`, so the same activity always reads the same. */
export function fullComponent(component: string): string {
  const pkg = packageOf(component);
  const cls = component.slice(pkg.length + 1);
  return `${pkg}/${cls.startsWith('.') ? pkg + cls : cls}`;
}

/** An activity record of `dumpsys activity activities`: its task and lifecycle state as the system keeps them. */
export interface ActivityRecordState {
  component: string;
  taskId: number;
  /** RESUMED, PAUSED, STOPPING, STOPPED, DESTROYED, … */
  state: string | null;
}

/**
 * The topmost activity record of `packageName` in `dumpsys activity -p <package> activities` (records are listed
 * from the top task down). The record's saved state is printed before its state line and may hold any text, so
 * the last line in the system's exact format counts.
 */
export function parseTopRecord(dump: string, packageName: string): ActivityRecordState | null {
  let record: ActivityRecordState | null = null;
  for (const line of dump.split(/\r?\n/)) {
    const hist = HIST_LINE.exec(line);
    if (hist) {
      if (record) break;
      const [, , component = '', taskId = '', flags = ''] = hist;
      // A finishing record (a trampoline activity on its way out) is not what the task shows.
      if (!flags.includes(' f}') && COMPONENT.test(component) && packageOf(component) === packageName) {
        record = { component: fullComponent(component), taskId: Number(taskId), state: null };
      }
      continue;
    }
    if (!record) continue;
    // The record's fields end where the next task begins.
    if (/^\s*\* Task\{/.test(line)) break;
    const state = STATE_LINE.exec(line)?.[1];
    if (state) record.state = state;
  }
  return record;
}

/** Where the activity no longer runs in the foreground and its saved state is with the system. */
const BACKGROUND_STATES = new Set(['STOPPED', 'DESTROYED']);

function shell(ctx: AgentContext, serial: string, command: string, timeoutMs = SHELL_TIMEOUT_MS) {
  return adbShell(ctx.adb, serial, command, { timeoutMs });
}

/** The main process of the package, or null (`pidof` exits 1 when nothing runs). */
async function appPid(ctx: AgentContext, serial: string, packageName: string): Promise<number | null> {
  return parsePidof(await shell(ctx, serial, `pidof ${packageName} || true`));
}

async function topRecord(ctx: AgentContext, serial: string, packageName: string) {
  return parseTopRecord(
    await shell(ctx, serial, `dumpsys activity -p ${packageName} activities`, DUMPSYS_TIMEOUT_MS),
    packageName,
  );
}

/** Polls `check` every POLL_MS until it returns non-null or `timeoutMs` passes (then null). */
async function poll<T>(timeoutMs: number, check: () => Promise<T | null>): Promise<T | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (performance.now() + POLL_MS > deadline) return null;
    await sleep(POLL_MS);
  }
}

export const getActivityInstanceTool = defineTool({
  name: 'get_activity_instance',
  title: 'Activity instance',
  description:
    "The activity on screen (resumed) and which instance of it this is: instanceId is the Activity object's identity hash (from `dumpsys activity top`), new whenever Android recreates the activity in the same process (configuration change, \"Don't keep activities\") and unchanged when the app only went to the background and came back; pid is the app's process. A hash is unique only within one process, so recreated is also true when the process changed (process death). recreated and processRestarted compare with the previous call for the same device and app (null on the first call; recreated is also null when another activity is on top than last time). Call it before and after a scenario (HOME and back, set_dont_keep_activities, simulate_process_death, a rotation) as proof of what happened. With packageName, that app must be the one on screen; without it, the last resumed activity `dumpsys activity top` lists (with several on screen, e.g., split screen or another display, pass packageName). Device control.",
  access: 'device',
  input: z.object({
    packageName: packageInput.optional().describe('The app that must be on screen; default: whichever is.'),
    serial: optionalSerial,
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run({ packageName, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    let activities: TopActivity[] = [];
    // Right after a launch or a return to the app, its activity may not be resumed yet.
    const top = await poll(RESUME_TIMEOUT_MS, async () => {
      activities = parseTopActivities(
        await shell(ctx, serial, 'dumpsys activity top', DUMPSYS_TIMEOUT_MS),
      ).filter((activity) => activity.resumed);
      return (
        activities.findLast(
          (activity) => packageName === undefined || packageOf(activity.component) === packageName,
        ) ?? null
      );
    });
    if (!top) {
      const onScreen = activities.at(-1)?.component;
      throw new ToolError(
        packageName === undefined
          ? `No activity is resumed on ${serial} (screen off, or an animation still running?): try again`
          : `${packageName} is not on screen on ${serial}${onScreen ? ` (${fullComponent(onScreen)} is)` : ''}: bring it to the front first`,
      );
    }
    if (top.instanceId === null) {
      throw new ToolError(
        `${fullComponent(top.component)} did not dump its state in time (its main thread may be busy)`,
      );
    }
    const activity = fullComponent(top.component);
    const key = `${serial} ${packageOf(activity)}`;
    const previous = ctx.activityInstances.get(key) ?? null;
    ctx.activityInstances.set(key, { activity, instanceId: top.instanceId, pid: top.pid });
    return {
      data: {
        serial,
        packageName: packageOf(activity),
        activity,
        instanceId: top.instanceId,
        pid: top.pid,
        // A hash is unique only within a process (a new one can hand out the same): a new process is a new instance.
        recreated:
          previous && previous.activity === activity
            ? previous.pid !== top.pid || previous.instanceId !== top.instanceId
            : null,
        processRestarted: previous ? previous.pid !== top.pid : null,
        previous,
      },
    };
  },
});

/**
 * How long the destroy check waits. Android destroys them at its next process-priority update, which came after
 * 1 to 7 s on an idle emulator (once not within 23 s; any activity being stopped brings one at once).
 */
const DESTROY_CHECK_MS = 10_000;

/**
 * Per activity record of `dumpsys activity activities` (every task), its lifecycle state and whether it still has a
 * process. A record's `app=` line comes before its saved state, its state line after it.
 */
export function parseRecordStates(dump: string): Map<string, { state: string | null; attached: boolean }> {
  const records = new Map<string, { state: string | null; attached: boolean }>();
  let current: { state: string | null; attached: boolean } | null = null;
  let appRead = false;
  for (const line of dump.split(/\r?\n/)) {
    const hist = HIST_LINE.exec(line)?.[1];
    if (hist) {
      current = { state: null, attached: false };
      records.set(hist, current);
      appRead = false;
      continue;
    }
    if (!current) continue;
    if (/^\s*\* Task\{/.test(line)) {
      current = null;
      continue;
    }
    const app = /^\s+app=(null|ProcessRecord\{)/.exec(line)?.[1];
    if (app && !appRead) {
      current.attached = app !== 'null';
      appRead = true;
    }
    const state = STATE_LINE.exec(line)?.[1];
    if (state) current.state = state;
  }
  return records;
}

/** Stopped (or stopping) activities that still have their process: what the flag makes Android destroy. */
const DESTROYABLE_STATES = new Set(['STOPPING', 'STOPPED']);

async function recordStates(ctx: AgentContext, serial: string) {
  return parseRecordStates(await shell(ctx, serial, 'dumpsys activity activities', DUMPSYS_TIMEOUT_MS));
}

/**
 * The real effect: with the flag on, Android destroys every activity in the background that still has its process
 * at its next process-priority update. Null when there was none to watch.
 */
async function destroyCheck(
  ctx: AgentContext,
  serial: string,
  before: Map<string, { state: string | null; attached: boolean }>,
): Promise<{ background: number; destroyed: number } | null> {
  const watched = [...before]
    .filter(([, record]) => record.attached && DESTROYABLE_STATES.has(record.state ?? ''))
    .map(([id]) => id);
  if (watched.length === 0) return null;
  let destroyed = 0;
  await poll(DESTROY_CHECK_MS, async () => {
    const now = await recordStates(ctx, serial);
    destroyed = watched.filter((id) => now.get(id)?.state === 'DESTROYED').length;
    return destroyed > 0 ? true : null;
  });
  return { background: watched.length, destroyed };
}

const DONT_KEEP_NOTE =
  'A global developer setting for every app on this device: tell the user, and call set_dont_keep_activities { enabled: false } when you are done.';

/** What the result says besides the data: why it is not verified, and what to tell the user. */
function dontKeepNote(
  enabled: boolean,
  failure: string | null,
  destroyed: { background: number; destroyed: number } | null,
  wasOn: boolean,
  autoOff: boolean,
): string | null {
  if (!enabled) {
    return failure === null
      ? null
      : `Not verified: the activity manager could not be switched off (${failure}). The stored setting was written (back to what it was before Lionscope turned it on, else off), so it is off after the next reboot at the latest; Lionscope tries again when the device reconnects or Lionscope stops.`;
  }
  const failed =
    failure === null
      ? ''
      : `Not verified: switching it reported an error (${failure}), yet the device's state changed: check activityManager. `;
  const pending =
    destroyed?.destroyed === 0
      ? `Not verified yet, not failed: the flag is on, but none of the ${destroyed.background} activities in the background has been destroyed within ${DESTROY_CHECK_MS / 1000} s. Android does it at its next process-priority update (leaving a screen brings one); check with get_activity_instance after leaving a screen. `
      : '';
  const owner = autoOff
    ? 'Lionscope puts it back as it was when the profiling session on this device stops or Lionscope stops. '
    : wasOn
      ? 'It was on already, so Lionscope will not turn it off by itself. '
      : '';
  return failed + pending + owner + DONT_KEEP_NOTE;
}

export const setDontKeepActivitiesTool = defineTool({
  name: 'set_dont_keep_activities',
  title: "Don't keep activities",
  description:
    'Switches Developer options\' "Don\'t keep activities" (always_finish_activities) the way Settings does, so it takes effect at once: with it on, Android destroys every activity as soon as it is no longer visible (HOME, or opening the next screen), and the app must restore it from its saved state when the user comes back. A plain `settings put` changes only the stored value, which the system reads at boot. verified: the activity manager reports the new state (`dumpsys activity processes`) and, when turning it on, activities that were in the background with their process were destroyed (destroyCheck; null when there were none to watch or it was on already). verified: false with destroyCheck.destroyed 0 means "not destroyed yet": Android does it at its next process-priority update. If it cannot be switched on, the call fails and nothing is changed. What Lionscope turned on it puts back as it was when the device\'s profiling session stops or Lionscope stops, and retries a failed put-back when the device reconnects (autoOff; status shows it per device). enabled: false on a device Lionscope switched on puts it back as it was. Use get_activity_instance before and after to see an activity recreated. A global developer setting for every app on the device: tell the user you turned it on, and turn it off (enabled: false) when you are done. Device control.',
  access: 'device',
  input: z.object({
    enabled: z
      .boolean()
      .describe('true: destroy activities when they leave the screen; false: back to normal.'),
    serial: optionalSerial,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run({ enabled, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const dontKeep = ctx.dontKeepActivities;
    const readState = async () => {
      try {
        return await dontKeep.state(serial);
      } catch (error) {
        throw new ToolError(
          `Could not read the activity manager's state on ${serial}: ${errorMessage(error)}`,
        );
      }
    };
    const before = await readState();
    // Nothing to watch when it was on already: what it would destroy is gone.
    const records = enabled && !before.live ? await recordStates(ctx, serial) : null;
    let failure: string | null;
    if (enabled) {
      const outcome = await dontKeep.enable(serial, before);
      if (outcome && !outcome.changed) {
        throw new ToolError(
          `Could not switch "Don't keep activities" on on ${serial} (${outcome.failure}); nothing was changed`,
        );
      }
      failure = outcome?.failure ?? null;
    } else {
      failure = await dontKeep.disable(serial);
    }
    const after = await readState();
    const destroyed =
      records && failure === null && after.live ? await destroyCheck(ctx, serial, records) : null;
    const note = dontKeepNote(enabled, failure, destroyed, before.live, dontKeep.isOn(serial));
    return {
      data: {
        serial,
        enabled,
        verified:
          failure === null && after.live === enabled && (destroyed === null || destroyed.destroyed > 0),
        activityManager: after.live,
        destroyCheck: destroyed,
        setting: after.stored,
        autoOff: dontKeep.isOn(serial),
        ...(note !== null ? { note } : {}),
      },
    };
  },
});

/** How long a reopened app gets to have its top activity resumed (in a new process, from its saved state). */
const RETURN_TIMEOUT_MS = 15_000;

/** Start results of ActivityManager: 0 to 99 are successes (2 = START_TASK_TO_FRONT), 100+ and negatives not. */
function startSucceeded(result: number): boolean {
  return Number.isInteger(result) && result >= 0 && result < 100;
}

/**
 * Brings the task back the way Recents does (startActivityFromRecents, through the UI helper) and waits until its
 * top activity is resumed. The launcher intent would add an activity on top of a task whose root intent differs from
 * it (one started by `am start -n`, launch_app included). Throws when the system refused.
 */
async function bringBack(ctx: AgentContext, serial: string, packageName: string, taskId: number) {
  if (!ctx.uiHelper) throw new ToolError('this server has no on-device helper');
  const startResult = await ctx.uiHelper.taskToFront(serial, taskId, HELPER_RUN_TIMEOUT_MS);
  if (!startSucceeded(startResult))
    throw new ToolError(`the system refused it (start result ${startResult})`);
  const resumed = await poll(RETURN_TIMEOUT_MS, async () => {
    const record = await topRecord(ctx, serial, packageName);
    return record?.state === 'RESUMED' ? record : null;
  });
  return { resumed: resumed !== null, after: resumed ?? (await topRecord(ctx, serial, packageName)) };
}

/** Said when the app did not come back: the usual reason is a crash while restoring. */
const NOT_RESUMED_NOTE = `The activity was not resumed within ${RETURN_TIMEOUT_MS / 1000} s: did the app crash while restoring its state? See get_crashes.`;

export const bringToFrontTool = defineTool({
  name: 'bring_to_front',
  title: 'Bring an app back',
  description:
    "Brings an app's existing task back to the screen the way Recents does: the activity that was on top comes back (recreated from its saved state if it or its process was destroyed meanwhile) and nothing is added to the task. Unlike launch_app (`am start -n`), which can start the launcher activity on top of a task the user opened from the home screen. Use it to return to an app after HOME in restore scenarios. Returns the top activity and whether it was resumed (false: see get_crashes). Device control.",
  access: 'device',
  input: z.object({ packageName: packageInput, serial: optionalSerial }),
  annotations: INPUT,
  async run({ packageName, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const before = await topRecord(ctx, serial, packageName);
    if (!before) throw new ToolError(`${packageName} has no task on ${serial}: open it with launch_app`);
    try {
      const { resumed, after } = await bringBack(ctx, serial, packageName, before.taskId);
      return {
        data: {
          serial,
          packageName,
          topActivity: after?.component ?? null,
          resumed,
          sameTask: after !== null && after.taskId === before.taskId,
          ...(resumed ? {} : { note: NOT_RESUMED_NOTE }),
        },
      };
    } catch (error) {
      throw new ToolError(`Could not bring ${packageName} back on ${serial}: ${errorMessage(error)}`);
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

export const simulateProcessDeathTool = defineTool({
  name: 'simulate_process_death',
  title: 'Simulate process death',
  description:
    "Kills an app's process the way Android does to a backgrounded app that needs its memory, keeping its task and saved state: presses HOME if the app is on screen, waits until its activity is stopped (state saved), runs `am kill`, checks the process is gone, then (unless reopen: false) brings the task back like Recents does, so the activity that was on top is recreated from its saved state in a new process. Returns oldPid, newPid, killed, reopened, resumed (false: the activity did not come back, e.g. a crash while restoring; see get_crashes), and topActivity before and after. killed is false when the process survived (`am kill` spares a process with a foreground service or one another visible app uses). Unlike stop_app (a force-stop, which discards the saved state and the task). Killing the app being profiled ends its SDK link until it runs again. Device control.",
  access: 'device',
  input: z.object({
    packageName: packageInput,
    reopen: z.boolean().default(true).describe('Bring the task back afterwards (default true).'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ packageName, reopen, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    if (reopen && !ctx.uiHelper) {
      throw new ToolError('This server cannot bring a task back (no on-device helper): pass reopen: false');
    }
    const path = await shell(ctx, serial, `pm path ${packageName} || true`);
    if (!/^package:/m.test(path)) throw new ToolError(`${packageName} is not installed on ${serial}`);
    const before = await topRecord(ctx, serial, packageName);
    if (!before)
      throw new ToolError(`${packageName} has no activity on ${serial}: open it first (launch_app)`);
    const oldPid = await appPid(ctx, serial, packageName);
    if (oldPid === null) throw new ToolError(`${packageName} is not running on ${serial}: open it first`);
    try {
      if (!BACKGROUND_STATES.has(before.state ?? '')) await input(ctx, serial, 'keyevent 3');
      const stopped = await poll(BACKGROUND_TIMEOUT_MS, async () => {
        const record = await topRecord(ctx, serial, packageName);
        return record && BACKGROUND_STATES.has(record.state ?? '') ? record : null;
      });
      if (!stopped) {
        throw new ToolError(
          `${packageName} did not stop within ${BACKGROUND_TIMEOUT_MS / 1000} s after HOME; nothing was killed`,
        );
      }
      // Repeated: the process's priority drops to "background" (which `am kill` requires) a moment after the stop.
      const killed =
        (await poll(KILL_TIMEOUT_MS, async () => {
          await shell(ctx, serial, `am kill ${packageName}`);
          return (await appPid(ctx, serial, packageName)) === oldPid ? null : true;
        })) ?? false;
      if (!reopen) {
        return {
          data: {
            serial,
            packageName,
            oldPid,
            newPid: null,
            killed,
            reopened: false,
            resumed: null,
            previousTopActivity: before.component,
            topActivity: null,
            sameTask: null,
          },
        };
      }
      let back: Awaited<ReturnType<typeof bringBack>>;
      try {
        back = await bringBack(ctx, serial, packageName, stopped.taskId);
      } catch (error) {
        throw new ToolError(
          `${packageName} was ${killed ? 'killed' : 'not killed'} (pid ${oldPid}), but its task could not be brought back: ${errorMessage(error)}; open it from Recents`,
        );
      }
      const { resumed, after } = back;
      return {
        data: {
          serial,
          packageName,
          oldPid,
          newPid: await appPid(ctx, serial, packageName),
          killed,
          reopened: true,
          resumed,
          previousTopActivity: before.component,
          topActivity: after?.component ?? null,
          sameTask: after !== null && after.taskId === before.taskId,
          ...(resumed ? {} : { note: NOT_RESUMED_NOTE }),
        },
      };
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

/**
 * Developer options' "Don't keep activities" on the devices this server switched it on. It is a global setting
 * that outlives the server and a reboot (the activity manager reads it at boot), so what Lionscope turned on is put
 * back as it was when the device's profiling session stops and when the server closes; a device that was gone then
 * gets it when it is listed again.
 */
import type { DeviceInfo, SessionState } from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';
import { UiHelperError } from './uiHelper.ts';
import type { UiHelpers } from './uiHelper.ts';

const SHELL_TIMEOUT_MS = 10_000;
/** `dumpsys activity processes` lists every process. */
const DUMPSYS_TIMEOUT_MS = 15_000;
/** A one-shot run of the UI helper (push, app_process, the answer). */
const HELPER_RUN_TIMEOUT_MS = 20_000;
/** At server close, putting it back gets this long (the server exits after 10 s whatever is still running). */
export const CLOSE_RESTORE_MS = 5000;

const STOPPED_SESSION: ReadonlySet<SessionState['status']> = new Set(['idle', 'error']);

const PROCESSES_HEADER = 'ACTIVITY MANAGER RUNNING PROCESSES';
const ALWAYS_FINISH_LINE = '  mAlwaysFinishActivities=true';

/**
 * Whether the activity manager's own flag is on, from `dumpsys activity processes` filtered on the device: the
 * section header (to tell an empty or failed dump apart) and the line it prints only while the flag is on (the same
 * on Android 9 to 16).
 */
export function parseAlwaysFinish(output: string): boolean | null {
  const lines = output.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith(PROCESSES_HEADER))) return null;
  return lines.includes(ALWAYS_FINISH_LINE);
}

/** The flag the activity manager acts on, and the stored setting (read at boot; never written counts as off). */
export interface AlwaysFinishState {
  live: boolean;
  stored: boolean;
}

export interface DontKeepActivitiesOptions {
  adb: Adb;
  /** The UI helper, which switches the flag the way Settings does. */
  helpers: () => UiHelpers | undefined;
}

export class DontKeepActivities {
  /** Devices where Lionscope switched it on and has not put it back yet, with what it was before. */
  private readonly owned = new Map<string, AlwaysFinishState>();
  /** Devices listed as ready in the last device list (a device that comes back is retried). */
  private ready = new Set<string>();
  /** A restore in progress per device: a second request waits for it instead of switching again. */
  private readonly restoring = new Map<string, Promise<boolean>>();
  private closing = false;

  constructor(private readonly options: DontKeepActivitiesOptions) {}

  /** Lionscope switched it on on this device and has not put it back yet (it may still be on). */
  isOn(serial: string): boolean {
    return this.owned.has(serial);
  }

  /** The activity manager's flag and the stored setting; throws when the dump is not one. */
  async state(serial: string): Promise<AlwaysFinishState> {
    const [processes, stored] = await Promise.all([
      this.shell(
        serial,
        `dumpsys activity processes | grep -e '^${PROCESSES_HEADER}' -e '^${ALWAYS_FINISH_LINE}$' || true`,
        DUMPSYS_TIMEOUT_MS,
      ),
      this.shell(serial, 'settings get global always_finish_activities'),
    ]);
    const live = parseAlwaysFinish(processes);
    if (live === null) throw new Error(`dumpsys activity processes gave nothing on ${serial}`);
    return { live, stored: stored.trim() === '1' };
  }

  /**
   * Switches it on through the helper; `before` is the state read just before. Returns null, or why it failed and
   * whether anything changed anyway (an adb timeout after the device did it). The stored setting alone is never
   * written: it would only apply after a reboot.
   */
  async enable(
    serial: string,
    before: AlwaysFinishState,
  ): Promise<{ failure: string; changed: boolean } | null> {
    // Marked first (unless already marked: the first "before" is what gets put back), so that a switch that
    // happened despite an error is undone too.
    const owns = before.live && before.stored ? false : !this.owned.has(serial);
    if (owns) this.owned.set(serial, before);
    const failure = await this.helperSwitch(serial, true, HELPER_RUN_TIMEOUT_MS);
    if (failure === null) return null;
    const now = await this.state(serial).catch(() => null);
    const changed = now === null || now.live !== before.live || now.stored !== before.stored;
    if (owns && !changed) this.owned.delete(serial);
    return { failure, changed };
  }

  /**
   * Switches it off (an explicit request). Returns null, or why the activity manager could not be switched: then the
   * stored setting is still cleared, and the device stays marked so that it is tried again later.
   */
  async disable(serial: string): Promise<string | null> {
    const failure = await this.helperSwitch(serial, false, HELPER_RUN_TIMEOUT_MS);
    if (failure === null) {
      this.owned.delete(serial);
      return null;
    }
    await this.shell(serial, 'settings put global always_finish_activities 0').catch(() => undefined);
    return failure;
  }

  /**
   * Puts back what Lionscope changed, as it was before: the flag through the helper, then the stored setting if it
   * differed. The device stays marked until that worked. True when nothing is left to put back.
   */
  restore(serial: string, timeoutMs = HELPER_RUN_TIMEOUT_MS): Promise<boolean> {
    const running = this.restoring.get(serial);
    if (running) return running;
    const restored = this.restoreNow(serial, timeoutMs).finally(() => this.restoring.delete(serial));
    this.restoring.set(serial, restored);
    return restored;
  }

  private async restoreNow(serial: string, timeoutMs: number): Promise<boolean> {
    const before = this.owned.get(serial);
    if (!before) return true;
    const failure =
      (await this.helperSwitch(serial, before.live, timeoutMs)) ??
      (before.stored !== before.live
        ? await this.shell(
            serial,
            `settings put global always_finish_activities ${before.stored ? 1 : 0}`,
          ).then(
            () => null,
            (error: unknown) => errorMessage(error),
          )
        : null);
    if (failure !== null) {
      log.warn(`Could not put "Don't keep activities" back on ${serial} (${failure}); trying again later`);
      return false;
    }
    // Switched again meanwhile (a new enable) only if the mark changed.
    if (this.owned.get(serial) === before) this.owned.delete(serial);
    log.info(`Put "Don't keep activities" back as it was on ${serial}`);
    return true;
  }

  /**
   * A session update: once a device's session has stopped, what Lionscope turned on there is put back, unless a
   * new session started there right away (start_session ends the previous one first).
   */
  sessionChanged(session: SessionState, current: () => SessionState): void {
    const serial = session.serial;
    if (serial === null || !STOPPED_SESSION.has(session.status) || !this.owned.has(serial)) return;
    setImmediate(() => {
      // Closing puts it back itself (the session stops then too).
      if (this.closing) return;
      const now = current();
      if (now.serial === serial && !STOPPED_SESSION.has(now.status)) return;
      void this.restore(serial);
    });
  }

  /**
   * The device list changed: a device that comes back while Lionscope still has to put the setting back (the
   * restore failed while it was gone) is tried again, unless its session is still running.
   */
  setDevices(devices: readonly DeviceInfo[], current: () => SessionState): void {
    const ready = new Set(
      devices.filter((device) => device.state === 'device').map((device) => device.serial),
    );
    const session = current();
    for (const serial of ready) {
      if (this.closing || this.ready.has(serial) || !this.owned.has(serial)) continue;
      if (session.serial === serial && !STOPPED_SESSION.has(session.status)) continue;
      void this.restore(serial);
    }
    this.ready = ready;
  }

  /**
   * Puts it back on every device where Lionscope switched it on, within `timeoutMs` (the server's other cleanup
   * runs meanwhile; the UI helpers close after this).
   */
  async close(timeoutMs = CLOSE_RESTORE_MS): Promise<void> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([
      Promise.all([...this.owned.keys()].map((serial) => this.restore(serial, timeoutMs))),
      deadline,
    ]);
    clearTimeout(timer);
  }

  /** Null, or why the helper could not switch the flag. */
  private async helperSwitch(serial: string, enabled: boolean, timeoutMs: number): Promise<string | null> {
    const helpers = this.options.helpers();
    if (!helpers) return 'this server has no on-device helper';
    try {
      await helpers.setAlwaysFinish(serial, enabled, timeoutMs);
      return null;
    } catch (error) {
      return error instanceof UiHelperError ? error.message : errorMessage(error);
    }
  }

  private shell(serial: string, command: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<string> {
    return adbShell(this.options.adb, serial, command, { timeoutMs });
  }
}

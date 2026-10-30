/**
 * Developer options' "Don't keep activities" on the devices this server switched it on. It is a global setting
 * that outlives the server and a reboot (the activity manager reads it at boot), so what Lionscope turned on is
 * turned off again when the device's profiling session stops and when the server closes.
 */
import type { SessionState } from '@lionscope/protocol';
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

export interface DontKeepActivitiesOptions {
  adb: Adb;
  /** The UI helper, which switches the flag the way Settings does. */
  helpers: () => UiHelpers | undefined;
}

export class DontKeepActivities {
  /** Devices where Lionscope turned it on (it was off before) and has not turned it off since. */
  private readonly turnedOn = new Set<string>();

  constructor(private readonly options: DontKeepActivitiesOptions) {}

  /** Lionscope turned it on on this device and it has not been turned off since. */
  isOn(serial: string): boolean {
    return this.turnedOn.has(serial);
  }

  /** The activity manager's flag (what it acts on), not the stored setting. */
  async live(serial: string): Promise<boolean> {
    const output = await adbShell(
      this.options.adb,
      serial,
      `dumpsys activity processes | grep -e '^${PROCESSES_HEADER}' -e '^${ALWAYS_FINISH_LINE}$' || true`,
      { timeoutMs: DUMPSYS_TIMEOUT_MS },
    );
    const live = parseAlwaysFinish(output);
    if (live === null) throw new Error(`dumpsys activity processes gave nothing on ${serial}`);
    return live;
  }

  /**
   * Switches it. Returns null, or why the activity manager could not be switched: then only the stored setting was
   * written, which takes effect at the next boot. `wasOn`: it was on before (then Lionscope did not turn it on).
   */
  async set(serial: string, enabled: boolean, wasOn: boolean): Promise<string | null> {
    // Marked first: whatever part of the switch happens, it is undone later.
    if (enabled && !wasOn) this.turnedOn.add(serial);
    const failure = await this.switch(serial, enabled);
    if (!enabled) this.turnedOn.delete(serial);
    return failure;
  }

  /** Turns it off again if Lionscope turned it on (session stopped). */
  async restore(serial: string): Promise<void> {
    if (!this.turnedOn.delete(serial)) return;
    const failure = await this.switch(serial, false);
    if (failure === null) log.info(`Turned "Don't keep activities" off again on ${serial}`);
    else log.warn(`Could not turn "Don't keep activities" off on ${serial} (${failure})`);
  }

  /**
   * A session update: once a device's session has stopped, what Lionscope turned on there is turned off, unless a
   * new session started there right away (start_session ends the previous one first).
   */
  sessionChanged(session: SessionState, current: () => SessionState): void {
    const serial = session.serial;
    if (serial === null || !STOPPED_SESSION.has(session.status) || !this.turnedOn.has(serial)) return;
    setImmediate(() => {
      const now = current();
      if (now.serial === serial && !STOPPED_SESSION.has(now.status)) return;
      void this.restore(serial);
    });
  }

  /** Turns it off on every device where Lionscope turned it on; before the UI helpers close. */
  async close(): Promise<void> {
    await Promise.all([...this.turnedOn].map((serial) => this.restore(serial)));
  }

  private async switch(serial: string, enabled: boolean): Promise<string | null> {
    const helpers = this.options.helpers();
    let failure: string | null = helpers ? null : 'this server has no on-device helper';
    if (helpers) {
      try {
        await helpers.setAlwaysFinish(serial, enabled, HELPER_RUN_TIMEOUT_MS);
      } catch (error) {
        failure = error instanceof UiHelperError ? error.message : errorMessage(error);
      }
    }
    if (failure === null) return null;
    // The stored value at least: Android reads it at the next boot.
    try {
      await adbShell(
        this.options.adb,
        serial,
        `settings put global always_finish_activities ${enabled ? 1 : 0}`,
        { timeoutMs: SHELL_TIMEOUT_MS },
      );
    } catch (error) {
      return `${failure}; writing the setting failed too: ${errorMessage(error)}`;
    }
    return failure;
  }
}

import { parsePsPids } from '../parsers/ps.ts';
import { isImplausibleAppPidList, parsePidList } from '../parsers/shellValues.ts';

/** Runs one command on the device shell and resolves with its output. */
export type DeviceShell = (command: string) => Promise<string>;

/**
 * Both formats of `ps` in one call: a bare `ps` lists every process on API 23-25 (toolbox) but only the
 * shell's own from API 26 on, where `ps -A` lists them all and a bare `ps` is all the older one has.
 * Toolbox of API 24-25 rejects `-A` with exit 1 (API 23's adb hides the exit status), which adb passes on and
 * which would discard the valid rows of the bare `ps`: `|| true` keeps them. A failure of adb itself still rejects.
 */
export const PS_COMMAND = 'ps; ps -A || true';

/** `PID NAME` of every process where `ps -A -o PID,NAME` works (API 26+); toolbox exits 1 and prints an error instead. */
export const PS_NAMES_COMMAND = 'ps -A -o PID,NAME || true';

/**
 * The PIDs of an app's processes. `pidof` answers it, except toybox's of API 23, which ignores its
 * argument and prints every PID: such an answer (see isImplausibleAppPidList) is dropped for good and
 * the processes named exactly like the package are read from `ps` instead.
 */
export class AppPidResolver {
  private pidofIgnoresName = false;

  constructor(
    private readonly shell: DeviceShell,
    private readonly packageName: string,
  ) {}

  async resolve(): Promise<number[]> {
    if (!this.pidofIgnoresName) {
      const pids = parsePidList(await this.shell(`pidof ${this.packageName}`));
      if (!isImplausibleAppPidList(pids)) return pids;
      this.pidofIgnoresName = true;
    }
    return parsePsPids(await this.shell(PS_COMMAND), this.packageName);
  }
}

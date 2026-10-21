import { isValidAvdName } from '@lionscope/protocol';
import type { Adb } from '../adb/adb.ts';

const ADB_TIMEOUT_MS = 5000;
/** A failed lookup is retried after this, doubling up to the maximum. */
export const AVD_NAME_RETRY_MS = 2000;
export const AVD_NAME_MAX_RETRY_MS = 60_000;

/**
 * The AVD of an emulator serial, asked over its console (`adb -s emulator-N emu avd name`), for emulators that
 * left no discovery file. Answers are kept per serial; failures are retried with a growing back-off.
 */
export class AvdNameLookup {
  private readonly names = new Map<string, string | null>();
  private readonly failures = new Map<string, { retryAt: number; delayMs: number }>();

  constructor(
    private readonly adb: Adb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forget serials adb no longer lists. */
  retain(serials: ReadonlySet<string>): void {
    for (const serial of [...this.names.keys(), ...this.failures.keys()]) {
      if (serials.has(serial)) continue;
      this.names.delete(serial);
      this.failures.delete(serial);
    }
  }

  /** The AVD name; null for an answer that is no AVD name, or while a failed lookup waits for its retry. */
  async nameOf(serial: string): Promise<string | null> {
    if (this.names.has(serial)) return this.names.get(serial) ?? null;
    const failure = this.failures.get(serial);
    if (failure && this.now() < failure.retryAt) return null;
    try {
      const output = await this.adb.exec(['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: ADB_TIMEOUT_MS });
      const name = output.split('\n')[0]?.trim() ?? '';
      this.names.set(serial, isValidAvdName(name) ? name : null);
      this.failures.delete(serial);
      return this.names.get(serial) ?? null;
    } catch {
      const delayMs = failure ? Math.min(failure.delayMs * 2, AVD_NAME_MAX_RETRY_MS) : AVD_NAME_RETRY_MS;
      this.failures.set(serial, { retryAt: this.now() + delayMs, delayMs });
      return null;
    }
  }
}

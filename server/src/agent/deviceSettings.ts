/**
 * Tracks original device environment settings (orientation, dark mode, font scale) changed by agent tools on each
 * device, so they are restored automatically when the device's profiling session stops, before a managed emulator
 * shuts down, when the server closes, or explicitly via `restore_device_settings`.
 *
 * Every read–record–write and restore is serialized per serial so concurrent calls cannot drop originals. Originals
 * are preserved across uncertain (timed-out / disconnected) writes so a later retry still restores them.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceInfo, SessionState } from '@lionscope/protocol';
import { adbShellArgs } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';
import { parseWmSize } from './display.ts';
import { ToolError } from './tool.ts';

const SETTINGS_TIMEOUT_MS = 10_000;
export const CLOSE_SETTINGS_RESTORE_MS = 5000;
/** Brief settle delay after `settings delete system font_scale` before reading back Android's persisted value. */
const DEFAULT_FONT_SCALE_SETTLE_MS = 150;

const STOPPED_SESSION: ReadonlySet<SessionState['status']> = new Set(['idle', 'error']);

export type DeviceSettingKey = 'orientation' | 'darkMode' | 'fontScale';
export type OrientationMode = 'portrait' | 'landscape' | 'reverse_portrait' | 'reverse_landscape' | 'auto';
export type NaturalOrientation = 'portrait' | 'landscape';
export type DarkModeOption = 'dark' | 'light' | 'auto';
/** Night mode values that `cmd uimode night <value>` can both report and restore faithfully. */
export type UiModeNightValue = 'yes' | 'no' | 'auto' | 'custom_schedule' | 'custom_bedtime';

const PORTRAIT_NATURAL_ROTATIONS: Readonly<Record<Exclude<OrientationMode, 'auto'>, number>> = {
  portrait: 0,
  landscape: 1,
  reverse_portrait: 2,
  reverse_landscape: 3,
};

const LANDSCAPE_NATURAL_ROTATIONS: Readonly<Record<Exclude<OrientationMode, 'auto'>, number>> = {
  landscape: 0,
  portrait: 1,
  reverse_landscape: 2,
  reverse_portrait: 3,
};

const NIGHT_MODE_ARG: Readonly<Record<DarkModeOption, 'yes' | 'no' | 'auto'>> = {
  dark: 'yes',
  light: 'no',
  auto: 'auto',
};

const KNOWN_NIGHT_MODES: ReadonlySet<string> = new Set([
  'yes',
  'no',
  'auto',
  'custom_schedule',
  'custom_bedtime',
]);

export interface OriginalOrientation {
  accelerometerRotation: string | null;
  userRotation: string | null;
}

export interface OriginalDeviceSettings {
  orientation?: OriginalOrientation;
  darkMode?: UiModeNightValue;
  fontScale?: string | null;
}

export interface DeviceSettingsRestoreResult {
  restored: boolean;
  settings: DeviceSettingKey[];
  outstanding: DeviceSettingKey[];
  errors: string[];
  note?: string;
}

export interface DeviceSettingsCloseResult {
  timedOut: boolean;
  abandoned: { serial: string; inFlight: boolean; outstanding: DeviceSettingKey[] }[];
}

/** Normalizes `settings get` output (`"null"` or empty → null). */
export function parseSettingValue(output: string): string | null {
  const value = output.trim();
  if (value === '' || value.toLowerCase() === 'null') return null;
  return value;
}

/**
 * Parses `cmd uimode night` output (`Night mode: yes|no|auto|custom_schedule|custom_bedtime`).
 * Preserves `custom_schedule` and `custom_bedtime` verbatim so restore does not clobber them into `auto`.
 * Returns null for unrecognized or unsupported responses.
 */
export function parseNightMode(output: string): UiModeNightValue | null {
  const match = /Night mode:\s*([A-Za-z_]+)/i.exec(output);
  if (!match?.[1]) return null;
  const value = match[1].toLowerCase();
  if (KNOWN_NIGHT_MODES.has(value)) return value as UiModeNightValue;
  return null;
}

/** Extracts a raw `Night mode: <token>` value even when unrecognized, for clear refusal messages. */
function rawNightModeToken(output: string): string | null {
  return /Night mode:\s*([A-Za-z0-9_-]+)/i.exec(output)?.[1] ?? null;
}

/** Derives `user_rotation` (0..3) for a named orientation given the display's natural dimensions. */
export function rotationForOrientation(
  orientation: Exclude<OrientationMode, 'auto'>,
  naturalOrientation: NaturalOrientation,
): number {
  return naturalOrientation === 'landscape'
    ? LANDSCAPE_NATURAL_ROTATIONS[orientation]
    : PORTRAIT_NATURAL_ROTATIONS[orientation];
}

export function formatFontScale(scale: number): string {
  return String(Math.round(scale * 100) / 100);
}

/** Output from `cmd uimode night <arg>` indicating Android explicitly rejected the command before applying it. */
function isExplicitUiModeRejection(output: string): boolean {
  return (
    parseNightMode(output) === null &&
    /\b(?:Unknown command|Bad command|IllegalArgument|Usage:|not found|unrecognized)\b/i.test(output)
  );
}

export interface DeviceSettingsOptions {
  adb: Adb;
  /** Delay before verifying an originally-unset `font_scale` after delete (default 150 ms). */
  fontScaleSettleMs?: number;
}

export class DeviceSettings {
  private readonly originals = new Map<string, OriginalDeviceSettings>();
  private readonly pending = new Set<string>();
  private ready = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Shared restore promise ONLY while that restore remains the last queued operation for `serial`. Any setter
   * queued after it clears this entry so a subsequent restore runs after the setter (`restore → set → restore`).
   */
  private readonly tailRestore = new Map<string, Promise<DeviceSettingsRestoreResult>>();
  private closing = false;

  constructor(private readonly options: DeviceSettingsOptions) {}

  /** Settings currently modified by Lionscope on `serial`. */
  tracked(serial: string): DeviceSettingKey[] {
    const entry = this.originals.get(serial);
    if (!entry) return [];
    const names: DeviceSettingKey[] = [];
    if (entry.orientation !== undefined) names.push('orientation');
    if (entry.darkMode !== undefined) names.push('darkMode');
    if (entry.fontScale !== undefined) names.push('fontScale');
    return names;
  }

  hasTracked(serial: string): boolean {
    return this.tracked(serial).length > 0;
  }

  /** True when `serial` has tracked originals OR an in-flight/queued setter/restore operation. */
  hasPendingOrTracked(serial: string): boolean {
    return this.hasTracked(serial) || this.queues.has(serial);
  }

  /**
   * Records original orientation before first change, then applies the requested orientation using the display's
   * natural dimensions (`wm size`). Serialized per device with restores.
   */
  setOrientation(
    serial: string,
    orientation: OrientationMode,
  ): Promise<{
    orientation: OrientationMode;
    naturalOrientation?: NaturalOrientation;
    accelerometerRotation: number;
    userRotation: number | null;
    recordedOriginal: boolean;
  }> {
    return this.enqueue(serial, async () => {
      if (this.closing) throw new ToolError('Server is shutting down');

      let naturalOrientation: NaturalOrientation | undefined;
      let rotation: number | null = null;
      if (orientation !== 'auto') {
        const wmOutput = await this.shellArgs(serial, ['wm', 'size']);
        const natural = parseWmSize(wmOutput);
        if (!natural) {
          throw new ToolError(`Could not read natural display dimensions on ${serial} via \`wm size\``);
        }
        naturalOrientation = natural.width > natural.height ? 'landscape' : 'portrait';
        rotation = rotationForOrientation(orientation, naturalOrientation);
      }

      const entry = this.entryFor(serial);
      let recordedOriginal = false;
      if (entry.orientation === undefined) {
        let accelOut: string;
        let rotOut: string;
        try {
          [accelOut, rotOut] = await Promise.all([
            this.shellArgs(serial, ['settings', 'get', 'system', 'accelerometer_rotation']),
            this.shellArgs(serial, ['settings', 'get', 'system', 'user_rotation']),
          ]);
        } catch (error) {
          this.cleanupIfEmpty(serial);
          throw error;
        }
        entry.orientation = {
          accelerometerRotation: parseSettingValue(accelOut),
          userRotation: parseSettingValue(rotOut),
        };
        recordedOriginal = true;
      }

      try {
        if (orientation === 'auto') {
          await this.shellArgs(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '1']);
          this.pending.delete(serial);
          return { orientation, accelerometerRotation: 1, userRotation: null, recordedOriginal };
        }

        await this.shellArgs(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0']);
        await this.shellArgs(serial, ['settings', 'put', 'system', 'user_rotation', String(rotation!)]);
        this.pending.delete(serial);
        return {
          orientation,
          ...(naturalOrientation ? { naturalOrientation } : {}),
          accelerometerRotation: 0,
          userRotation: rotation,
          recordedOriginal,
        };
      } catch (error) {
        // Uncertain write: keep the recorded original and mark pending so stop/reconnect/close restores it.
        this.pending.add(serial);
        throw error;
      }
    });
  }

  /**
   * Records original dark mode / font scale before first change, then applies the requested display options.
   * Refuses dark mode changes if the current mode cannot be restored faithfully. Preserves recorded originals
   * after uncertain writes (e.g. timeouts or disconnects). Serialized per device with restores.
   */
  setDisplayOptions(
    serial: string,
    options: { darkMode?: DarkModeOption | undefined; fontScale?: number | undefined },
  ): Promise<{
    applied: { darkMode?: DarkModeOption; fontScale?: number };
    recordedOriginal: boolean;
  }> {
    return this.enqueue(serial, async () => {
      if (this.closing) throw new ToolError('Server is shutting down');
      const entry = this.entryFor(serial);
      let recordedOriginal = false;
      const applied: { darkMode?: DarkModeOption; fontScale?: number } = {};

      if (options.darkMode !== undefined) {
        let newlyRecordedDarkMode = false;
        if (entry.darkMode === undefined) {
          let probeOutput: string;
          try {
            probeOutput = await this.shellArgs(serial, ['cmd', 'uimode', 'night']);
          } catch (error) {
            this.cleanupIfEmpty(serial);
            throw new ToolError(
              `Dark mode control via \`cmd uimode night\` is not supported on ${serial}: ${errorMessage(error)}`,
            );
          }
          const currentNight = parseNightMode(probeOutput);
          if (currentNight === null) {
            this.cleanupIfEmpty(serial);
            const rawToken = rawNightModeToken(probeOutput);
            if (rawToken !== null) {
              throw new ToolError(
                `Current night mode "${rawToken}" on ${serial} cannot be restored via \`cmd uimode night\`; refusing to change dark mode`,
              );
            }
            throw new ToolError(
              `Dark mode control via \`cmd uimode night\` is not supported on ${serial} (unexpected output: ${probeOutput.trim().slice(0, 120) || 'empty'})`,
            );
          }
          entry.darkMode = currentNight;
          recordedOriginal = true;
          newlyRecordedDarkMode = true;
        }
        const modeArg = NIGHT_MODE_ARG[options.darkMode];
        let setOutput: string;
        try {
          setOutput = await this.shellArgs(serial, ['cmd', 'uimode', 'night', modeArg]);
        } catch (error) {
          // Uncertain write (timeout/disconnect): Android may have applied it, so KEEP entry.darkMode for restore.
          this.pending.add(serial);
          throw new ToolError(
            `Could not set dark mode on ${serial} via \`cmd uimode night ${modeArg}\`: ${errorMessage(error)}`,
          );
        }
        if (isExplicitUiModeRejection(setOutput)) {
          if (newlyRecordedDarkMode) delete entry.darkMode;
          this.cleanupIfEmpty(serial);
          throw new ToolError(
            `Dark mode control via \`cmd uimode night\` failed on ${serial}: ${setOutput.trim().slice(0, 120)}`,
          );
        }
        applied.darkMode = options.darkMode;
      }

      if (options.fontScale !== undefined) {
        if (entry.fontScale === undefined) {
          let currentScale: string;
          try {
            currentScale = await this.shellArgs(serial, ['settings', 'get', 'system', 'font_scale']);
          } catch (error) {
            this.cleanupIfEmpty(serial);
            throw error;
          }
          entry.fontScale = parseSettingValue(currentScale);
          recordedOriginal = true;
        }
        const formatted = formatFontScale(options.fontScale);
        try {
          await this.shellArgs(serial, ['settings', 'put', 'system', 'font_scale', formatted]);
        } catch (error) {
          this.pending.add(serial);
          throw error;
        }
        applied.fontScale = Number(formatted);
      }

      this.pending.delete(serial);
      return { applied, recordedOriginal };
    });
  }

  /**
   * Idempotently restores every device setting Lionscope modified on `serial`. Serialized behind any in-flight
   * setter on that serial, acting as a restore barrier even while a setter's initial read is still pending.
   * Coalesces with an existing restore ONLY while that restore is still the last queued operation for `serial`.
   * Settings that fail to restore remain tracked (`outstanding`) for retry.
   */
  restore(serial: string, timeoutMs = SETTINGS_TIMEOUT_MS): Promise<DeviceSettingsRestoreResult> {
    const tail = this.tailRestore.get(serial);
    if (tail) return tail;
    const promise = this.enqueue(serial, () => this.restoreNow(serial, timeoutMs)).finally(() => {
      if (this.tailRestore.get(serial) === promise) this.tailRestore.delete(serial);
    });
    this.tailRestore.set(serial, promise);
    return promise;
  }

  private async restoreNow(serial: string, timeoutMs: number): Promise<DeviceSettingsRestoreResult> {
    const entry = this.originals.get(serial);
    if (!entry) return { restored: false, settings: [], outstanding: [], errors: [] };

    const restored: DeviceSettingKey[] = [];
    const errors: string[] = [];
    const notes: string[] = [];

    if (entry.orientation !== undefined) {
      const { accelerometerRotation, userRotation } = entry.orientation;
      try {
        if (userRotation === null) {
          await this.shellArgs(serial, ['settings', 'delete', 'system', 'user_rotation'], timeoutMs);
        } else {
          await this.shellArgs(
            serial,
            ['settings', 'put', 'system', 'user_rotation', userRotation],
            timeoutMs,
          );
        }
        if (accelerometerRotation === null) {
          await this.shellArgs(serial, ['settings', 'delete', 'system', 'accelerometer_rotation'], timeoutMs);
        } else {
          await this.shellArgs(
            serial,
            ['settings', 'put', 'system', 'accelerometer_rotation', accelerometerRotation],
            timeoutMs,
          );
        }
        delete entry.orientation;
        restored.push('orientation');
      } catch (error) {
        errors.push(`orientation: ${errorMessage(error)}`);
      }
    }

    if (entry.darkMode !== undefined) {
      try {
        const output = await this.shellArgs(serial, ['cmd', 'uimode', 'night', entry.darkMode], timeoutMs);
        if (isExplicitUiModeRejection(output)) {
          throw new Error(output.trim().slice(0, 120));
        }
        delete entry.darkMode;
        restored.push('darkMode');
      } catch (error) {
        errors.push(`darkMode: ${errorMessage(error)}`);
      }
    }

    if (entry.fontScale !== undefined) {
      try {
        if (entry.fontScale === null) {
          await this.shellArgs(serial, ['settings', 'delete', 'system', 'font_scale'], timeoutMs);
          // Android (verified on API 28/31) can asynchronously rewrite `font_scale=1.0` after delete.
          // Wait briefly for it to settle and read back once instead of looping on delete.
          const settleMs = this.options.fontScaleSettleMs ?? DEFAULT_FONT_SCALE_SETTLE_MS;
          if (settleMs > 0) await sleep(Math.min(settleMs, timeoutMs));
          const readBackRaw = await this.shellArgs(
            serial,
            ['settings', 'get', 'system', 'font_scale'],
            timeoutMs,
          );
          const readBack = parseSettingValue(readBackRaw);
          if (readBack === null) {
            delete entry.fontScale;
            restored.push('fontScale');
          } else if (Number(readBack) === 1) {
            delete entry.fontScale;
            restored.push('fontScale');
            notes.push(
              `fontScale was originally unset; after deleting the key, Android persisted the default effective scale (${readBack}).`,
            );
          } else {
            errors.push(`fontScale: expected unset or default 1.0 after delete, read back "${readBack}"`);
          }
        } else {
          await this.shellArgs(
            serial,
            ['settings', 'put', 'system', 'font_scale', entry.fontScale],
            timeoutMs,
          );
          delete entry.fontScale;
          restored.push('fontScale');
        }
      } catch (error) {
        errors.push(`fontScale: ${errorMessage(error)}`);
      }
    }

    this.cleanupIfEmpty(serial);
    const outstanding = this.tracked(serial);
    if (errors.length > 0) {
      this.pending.add(serial);
      log.warn(`Could not restore device settings on ${serial}: ${errors.join('; ')}`);
    } else if (restored.length > 0) {
      this.pending.delete(serial);
      log.info(`Restored device settings (${restored.join(', ')}) on ${serial}`);
    }
    return {
      restored: restored.length > 0,
      settings: restored,
      outstanding,
      errors,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  }

  /** Restores settings automatically when a device's profiling session stops. */
  sessionChanged(session: SessionState, current: () => SessionState): void {
    const serial = session.serial;
    if (serial === null || !STOPPED_SESSION.has(session.status)) return;
    if (!this.hasTracked(serial) && !this.queues.has(serial)) return;
    setImmediate(() => {
      if (this.closing) return;
      const now = current();
      if (now.serial === serial && !STOPPED_SESSION.has(now.status)) return;
      void this.restore(serial);
    });
  }

  /** Retries failed restores when a device reconnects, unless its session is active. */
  setDevices(devices: readonly DeviceInfo[], current: () => SessionState): void {
    const ready = new Set(
      devices.filter((device) => device.state === 'device').map((device) => device.serial),
    );
    const session = current();
    for (const serial of ready) {
      if (this.closing || this.ready.has(serial) || !this.pending.has(serial)) continue;
      if (session.serial === serial && !STOPPED_SESSION.has(session.status)) continue;
      void this.restore(serial);
    }
    this.ready = ready;
  }

  /**
   * Drains any in-flight per-device setters, then restores modified settings on all tracked devices when the
   * server shuts down. Logs and returns any cleanup still pending/outstanding if the exit deadline is hit.
   */
  async close(timeoutMs = CLOSE_SETTINGS_RESTORE_MS): Promise<DeviceSettingsCloseResult> {
    this.closing = true;
    const start = performance.now();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          // Wait for in-flight setters to finish recording/writing before collecting tracked serials.
          await Promise.all([...this.queues.values()]);
          const remaining = Math.max(100, Math.floor(timeoutMs - (performance.now() - start)));
          const serials = [...this.originals.keys()];
          await Promise.all(serials.map((serial) => this.restore(serial, remaining)));
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }

    const serials = new Set<string>([...this.originals.keys(), ...this.queues.keys()]);
    const abandoned: DeviceSettingsCloseResult['abandoned'] = [];
    for (const serial of serials) {
      const outstanding = this.tracked(serial);
      const inFlight = this.queues.has(serial);
      if (outstanding.length > 0 || inFlight) {
        abandoned.push({ serial, inFlight, outstanding });
      }
    }
    if (timedOut && abandoned.length > 0) {
      const summary = abandoned
        .map(
          (item) =>
            `${item.serial} (${[
              ...(item.outstanding.length > 0 ? [`outstanding: ${item.outstanding.join(', ')}`] : []),
              ...(item.inFlight ? ['cleanup still in flight'] : []),
            ].join('; ')})`,
        )
        .join('; ');
      log.warn(
        `Device settings restore hit the ${timeoutMs} ms shutdown deadline; abandoned cleanup on: ${summary}`,
      );
    }
    return { timedOut, abandoned };
  }

  private enqueue<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    // Any newly queued operation invalidates tail-restore coalescing so a later restore will run after it.
    this.tailRestore.delete(serial);
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.catch(() => undefined);
    this.queues.set(serial, tail);
    void tail.finally(() => {
      if (this.queues.get(serial) === tail) this.queues.delete(serial);
    });
    return next;
  }

  private entryFor(serial: string): OriginalDeviceSettings {
    let entry = this.originals.get(serial);
    if (!entry) {
      entry = {};
      this.originals.set(serial, entry);
    }
    return entry;
  }

  private cleanupIfEmpty(serial: string): void {
    if (!this.hasTracked(serial)) this.originals.delete(serial);
  }

  private shellArgs(
    serial: string,
    args: readonly string[],
    timeoutMs = SETTINGS_TIMEOUT_MS,
  ): Promise<string> {
    return adbShellArgs(this.options.adb, serial, args, { timeoutMs });
  }
}

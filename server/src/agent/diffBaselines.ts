/**
 * Scoped and memory-bounded baselines for `diff_ui_tree` and `diff_screenshot`.
 * Baselines are tied to the device's connection generation and the active session generation via a `BaselineToken`
 * captured BEFORE async I/O starts, so a slow capture cannot cross a session/device boundary during an `await`.
 * Retained screenshot baselines are evicted LRU within `MAX_SCREENSHOT_BASELINE_BYTES` and `MAX_SCREENSHOT_BASELINES`;
 * an oversized screenshot is rejected without discarding an existing baseline and reports its retention outcome.
 */
import type { DeviceInfo, SessionState } from '@lionscope/protocol';
import type { Size } from '../emulator/screenInput.ts';
import type { DecodedPng } from './png.ts';
import type { UiTree } from './uiTree.ts';

export const MAX_UI_BASELINES = 8;
export const MAX_SCREENSHOT_BASELINES = 8;
export const MAX_SCREENSHOT_BASELINE_BYTES = 32 * 1024 * 1024;

const STOPPED_SESSION: ReadonlySet<SessionState['status']> = new Set(['idle', 'error']);

export interface BaselineToken {
  readonly serial: string;
  readonly connectionGen: number;
  readonly sessionGen: number;
}

export interface UiBaseline {
  at: number;
  tree: UiTree;
  activity: string | null;
}

export interface ScreenshotBaseline {
  at: number;
  image: DecodedPng;
  shotSize: Size;
}

export type ScreenshotRetentionResult =
  | { saved: true; bytes: number; maxBytes: number }
  | { saved: false; reason: 'stale' | 'too_large'; bytes: number; maxBytes: number };

interface ScopedUiEntry {
  baseline: UiBaseline;
  connectionGen: number;
  sessionGen: number;
}

interface ScopedScreenshotEntry {
  baseline: ScreenshotBaseline;
  bytes: number;
  connectionGen: number;
  sessionGen: number;
}

export interface DiffBaselinesOptions {
  maxUiBaselines?: number;
  maxScreenshotBaselines?: number;
  maxScreenshotBytes?: number;
}

function sessionIdentity(session: SessionState): string | null {
  if (STOPPED_SESSION.has(session.status) || !session.serial || !session.packageName) return null;
  return `${session.serial}|${session.packageName}|${session.startedAt ?? ''}`;
}

export class DiffBaselines {
  private readonly ui = new Map<string, ScopedUiEntry>();
  private readonly screenshots = new Map<string, ScopedScreenshotEntry>();
  private readonly connectionGen = new Map<string, number>();
  private ready = new Set<string>();
  private sessionGen = 0;
  private activeSessionKey: string | null = null;
  private activeSessionSerial: string | null = null;
  private retainedScreenshotBytes = 0;

  private readonly maxUi: number;
  private readonly maxScreenshots: number;
  private readonly maxScreenshotBytes: number;

  constructor(options: DiffBaselinesOptions = {}) {
    this.maxUi = options.maxUiBaselines ?? MAX_UI_BASELINES;
    this.maxScreenshots = options.maxScreenshotBaselines ?? MAX_SCREENSHOT_BASELINES;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? MAX_SCREENSHOT_BASELINE_BYTES;
  }

  /** Total decoded pixel bytes retained across screenshot baselines. */
  get screenshotBytes(): number {
    return this.retainedScreenshotBytes;
  }

  /** Configured retention budget in bytes. */
  get maxBytes(): number {
    return this.maxScreenshotBytes;
  }

  /** Number of retained UI baselines. */
  get uiCount(): number {
    return this.ui.size;
  }

  /** Number of retained screenshot baselines. */
  get screenshotCount(): number {
    return this.screenshots.size;
  }

  /** Snapshots the current device connection & session generation BEFORE starting async capture I/O. */
  token(serial: string): BaselineToken {
    return {
      serial,
      connectionGen: this.genOf(serial),
      sessionGen: this.sessionGen,
    };
  }

  /** True if neither `token.serial`'s connection nor the active session generation changed since `token` was taken. */
  isCurrent(token: BaselineToken): boolean {
    return this.genOf(token.serial) === token.connectionGen && this.sessionGen === token.sessionGen;
  }

  getUi(serial: string, token?: BaselineToken): UiBaseline | null {
    if (token && (token.serial !== serial || !this.isCurrent(token))) return null;
    const entry = this.ui.get(serial);
    if (!entry) return null;
    if (entry.connectionGen !== this.genOf(serial) || entry.sessionGen !== this.sessionGen) {
      this.ui.delete(serial);
      return null;
    }
    // Touch LRU order.
    this.ui.delete(serial);
    this.ui.set(serial, entry);
    return entry.baseline;
  }

  /** Stores a UI baseline only if `token` (when given) is still current; returns whether it was saved. */
  setUi(serial: string, baseline: UiBaseline, token?: BaselineToken): boolean {
    if (token && (token.serial !== serial || !this.isCurrent(token))) return false;
    this.ui.delete(serial);
    this.ui.set(serial, {
      baseline,
      connectionGen: token?.connectionGen ?? this.genOf(serial),
      sessionGen: token?.sessionGen ?? this.sessionGen,
    });
    while (this.ui.size > this.maxUi) {
      const oldest = this.ui.keys().next().value;
      if (oldest === undefined) break;
      this.ui.delete(oldest);
    }
    return true;
  }

  getScreenshot(serial: string, token?: BaselineToken): ScreenshotBaseline | null {
    if (token && (token.serial !== serial || !this.isCurrent(token))) return null;
    const entry = this.screenshots.get(serial);
    if (!entry) return null;
    if (entry.connectionGen !== this.genOf(serial) || entry.sessionGen !== this.sessionGen) {
      this.deleteScreenshot(serial);
      return null;
    }
    this.screenshots.delete(serial);
    this.screenshots.set(serial, entry);
    return entry.baseline;
  }

  /**
   * Stores a decoded screenshot baseline if `token` (when given) is still current and the image fits within
   * `maxScreenshotBytes`. On rejection (`stale` or `too_large`), any existing baseline for `serial` is preserved.
   */
  setScreenshot(
    serial: string,
    baseline: ScreenshotBaseline,
    token?: BaselineToken,
  ): ScreenshotRetentionResult {
    const bytes = baseline.image.pixels.byteLength;
    if (token && (token.serial !== serial || !this.isCurrent(token))) {
      return { saved: false, reason: 'stale', bytes, maxBytes: this.maxScreenshotBytes };
    }
    if (bytes > this.maxScreenshotBytes) {
      // Preserve any existing baseline on rejection.
      return { saved: false, reason: 'too_large', bytes, maxBytes: this.maxScreenshotBytes };
    }
    this.deleteScreenshot(serial);
    this.screenshots.set(serial, {
      baseline,
      bytes,
      connectionGen: token?.connectionGen ?? this.genOf(serial),
      sessionGen: token?.sessionGen ?? this.sessionGen,
    });
    this.retainedScreenshotBytes += bytes;
    while (
      this.screenshots.size > this.maxScreenshots ||
      this.retainedScreenshotBytes > this.maxScreenshotBytes
    ) {
      const oldest = this.screenshots.keys().next().value;
      if (oldest === undefined) break;
      this.deleteScreenshot(oldest);
    }
    return { saved: true, bytes, maxBytes: this.maxScreenshotBytes };
  }

  clear(serial?: string): void {
    if (serial === undefined) {
      this.ui.clear();
      this.screenshots.clear();
      this.retainedScreenshotBytes = 0;
      return;
    }
    this.ui.delete(serial);
    this.deleteScreenshot(serial);
  }

  /** Drops baselines for devices that disconnected or left the ready (`device`) state. */
  setDevices(devices: readonly DeviceInfo[]): void {
    const nextReady = new Set(
      devices.filter((device) => device.state === 'device').map((device) => device.serial),
    );
    for (const serial of this.ready) {
      if (!nextReady.has(serial)) {
        this.bumpConnection(serial);
        this.clear(serial);
      }
    }
    for (const serial of nextReady) {
      if (!this.ready.has(serial) && (this.ui.has(serial) || this.screenshots.has(serial))) {
        this.bumpConnection(serial);
        this.clear(serial);
      }
    }
    this.ready = nextReady;
  }

  /** Drops session-bound baselines whenever the profiling session stops or is replaced. */
  sessionChanged(session: SessionState): void {
    const nextKey = sessionIdentity(session);
    if (nextKey === this.activeSessionKey) return;
    const prevSerial = this.activeSessionSerial;
    this.activeSessionKey = nextKey;
    this.activeSessionSerial = nextKey ? session.serial : null;
    this.sessionGen += 1;
    if (prevSerial) this.clear(prevSerial);
    if (session.serial) this.clear(session.serial);
  }

  private genOf(serial: string): number {
    return this.connectionGen.get(serial) ?? 0;
  }

  private bumpConnection(serial: string): void {
    this.connectionGen.set(serial, this.genOf(serial) + 1);
  }

  private deleteScreenshot(serial: string): void {
    const existing = this.screenshots.get(serial);
    if (!existing) return;
    this.screenshots.delete(serial);
    this.retainedScreenshotBytes = Math.max(0, this.retainedScreenshotBytes - existing.bytes);
  }
}

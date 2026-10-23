/**
 * The Layout Inspector: snapshots of a device screen's view hierarchy with a screenshot taken at the same moment.
 * From the in-app SDK when the app on top of that device is linked at device protocol ≥ 4 (layout source, owners,
 * layout params): the session's link, or outside a session an inspect-only link (SDK 0.5.2+); else, and for
 * Compose screens, from `uiautomator dump`. The last few snapshots and their PNGs are kept in memory; the newest is
 * the current one, and the selection always refers to it.
 */
import { randomBytes } from 'node:crypto';
import { DEVICE_PROTOCOL_V4 } from '@lionscope/protocol';
import type { DeviceInfo, InspectorSelection, InspectorSnapshot, ServerMessage } from '@lionscope/protocol';
import type { InspectLinkFallback, InspectLinkReadiness } from '../device/inspectLinks.ts';
import type { SdkInspectFailure } from '../device/sdkLink.ts';
import { SdkInspectError } from '../device/sdkLink.ts';
import { PublicError } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import type { InspectorSessionSource } from '../session/sessionManager.ts';
import type { UiTree } from '../agent/uiTree.ts';
import { isPng } from '../agent/png.ts';
import { matchingNode, sdkSnapshot, topWindowIsCompose, uiautomatorSnapshot } from './snapshots.ts';
import type { SnapshotBody } from './snapshots.ts';

/** Snapshots (with their PNGs) kept for `/inspector/<id>.png`; the oldest go first. */
export const MAX_KEPT_SNAPSHOTS = 5;
/** Bytes of PNGs and snapshot JSON kept at most (the newest snapshot is always kept). */
export const MAX_KEPT_BYTES = 64 * 1024 * 1024;
/** A snapshot's JSON at most: a larger SDK snapshot falls back to uiautomator (`sdk_too_large`). */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export type SelectionOrigin = InspectorSelection['origin'];

interface Built {
  snapshot: InspectorSnapshot;
  message: ServerMessage;
  /** `message` as JSON. */
  payload: string;
  /** UTF-8 bytes of `payload`. */
  bytes: number;
}

/** Why a snapshot came from uiautomator (`InspectorSnapshot.fallbackReason`). */
export type FallbackReason =
  | 'no_sdk'
  | 'old_sdk'
  | 'compose'
  | 'background'
  | 'no_window'
  | 'sdk_disabled'
  | 'sdk_timeout'
  | 'sdk_too_large'
  | 'sdk_failed'
  | InspectLinkFallback
  | 'sdk_needs_session';

const SDK_FALLBACKS: Readonly<Record<SdkInspectFailure, FallbackReason>> = {
  background: 'background',
  no_window: 'no_window',
  disabled: 'sdk_disabled',
  failed: 'sdk_failed',
  invalid: 'sdk_failed',
  timeout: 'sdk_timeout',
  too_large: 'sdk_too_large',
  closed: 'no_sdk',
  unsupported: 'old_sdk',
};

/** Inspect-only SDK links outside the session (InspectLinks). */
export interface InspectorLinks {
  /** An inspect of `serial`: keeps (or starts) its inspect-only link for a while. */
  noteInspect(serial: string): void;
  /** Its linked apps on top, after the wait window when that applies. */
  prepare(serial: string): Promise<InspectLinkReadiness>;
  /** An SDK too old to link outside a session is in `packageName` on `serial`. */
  needsSession(serial: string, packageName: string): boolean;
}

/** Reasons that only say no SDK on the device answered: refined when the app on top has an SDK below v5. */
const NO_ANSWER_REASONS: ReadonlySet<FallbackReason> = new Set(['no_sdk', 'sdk_linking', 'background']);

export interface InspectorServiceOptions {
  sessions: {
    getDevices(): DeviceInfo[];
    inspectorSource(serial: string): InspectorSessionSource | null;
  };
  links?: InspectorLinks;
  /**
   * The package of the device's foreground activity now (`dumpsys activity`), read with the screenshot: an
   * inspect-only link is only asked when its app is that package (any app can claim to be on top). Omitted, or
   * null: no inspect-only link is asked.
   */
  foregroundPackage?: (serial: string) => Promise<string | null>;
  /** A fresh `uiautomator dump` of the device (the agent's uiDump). */
  dumpUi: (serial: string) => Promise<UiTree>;
  /** `adb exec-out screencap -p`. */
  screencap: (serial: string) => Promise<Buffer>;
  /** `payload`, when given, is `message` already serialized. */
  broadcast: (message: ServerMessage, payload?: string) => void;
  now?: () => number;
  maxKeptBytes?: number;
}

interface Kept {
  snapshot: InspectorSnapshot;
  png: Buffer;
  bytes: number;
}

export class InspectorService {
  private readonly now: () => number;
  private readonly maxKeptBytes: number;
  /** Oldest first; the last one is current. */
  private kept: Kept[] = [];
  private currentSelection: InspectorSelection | null = null;
  private readonly inFlight = new Map<string, Promise<InspectorSnapshot>>();

  constructor(private readonly options: InspectorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeptBytes = options.maxKeptBytes ?? MAX_KEPT_BYTES;
  }

  /** The newest snapshot, null before the first one. */
  get current(): InspectorSnapshot | null {
    return this.kept.at(-1)?.snapshot ?? null;
  }

  get selection(): InspectorSelection | null {
    return this.currentSelection;
  }

  /** A kept snapshot's screenshot, null once it is gone. */
  png(snapshotId: string): Buffer | null {
    return this.kept.find((entry) => entry.snapshot.id === snapshotId)?.png ?? null;
  }

  /**
   * Capture a snapshot of `serial`'s screen and broadcast it (`inspection`); a request while one runs for the
   * same device joins it. Rejects with a PublicError when neither the SDK nor uiautomator could read the screen.
   */
  inspect(serial: string): Promise<InspectorSnapshot> {
    // Every inspect (also one joining a capture) keeps the device's inspect-only link around.
    this.options.links?.noteInspect(serial);
    let pending = this.inFlight.get(serial);
    if (!pending) {
      pending = this.capture(serial).finally(() => this.inFlight.delete(serial));
      this.inFlight.set(serial, pending);
    }
    return pending;
  }

  /**
   * Select a node of the current snapshot (null clears) on behalf of `origin` (a dashboard click: `user`; an agent:
   * `agent`) and broadcast the selection when it changed. Throws a PublicError for another snapshot or a node it
   * does not have.
   */
  select(snapshotId: string, nodeId: number | null, origin: SelectionOrigin): InspectorSelection | null {
    const current = this.current;
    if (!current || current.id !== snapshotId) {
      throw new PublicError('That Inspector snapshot is not the current one: inspect again and select in it');
    }
    if (nodeId !== null && !current.nodes[nodeId]) {
      throw new PublicError(`The Inspector snapshot has no node ${nodeId}`);
    }
    const previous = this.currentSelection;
    const same =
      previous?.snapshotId === snapshotId && previous.nodeId === nodeId && previous.origin === origin;
    if (same) return previous;
    if (previous === null && nodeId === null) return null;
    this.setSelection(nodeId === null ? null : { snapshotId, nodeId, ts: this.now(), origin });
    return this.currentSelection;
  }

  private async capture(serial: string): Promise<InspectorSnapshot> {
    const device = this.options.sessions.getDevices().find((candidate) => candidate.serial === serial);
    if (!device) throw new PublicError(`Device ${serial} is not connected`);
    if (device.state !== 'device') throw new PublicError(`Device ${serial} is ${device.state}`);
    const session = this.options.sessions.inspectorSource(serial);
    // At the same moment as the hierarchy, so the boxes line up with the picture.
    let shot = this.screenshot(serial);
    /** An SDK was asked, or the wait window ran, since `shot` was taken: the next reading needs a new one. */
    let stale = false;
    const ask = async (source: InspectorSessionSource): Promise<Built | FallbackReason> => {
      if (source.link && source.link.protocolVersion < DEVICE_PROTOCOL_V4) return 'old_sdk';
      if (stale) shot = this.screenshot(serial);
      stale = true;
      return this.fromSdk(serial, source, shot.ts);
    };
    const readiness = (): Promise<InspectLinkReadiness> =>
      this.options.links?.prepare(serial).then((ready) => {
        if (ready.waited) stale = true;
        return ready;
      }) ?? Promise.resolve({ sources: [], reason: null, waited: false });
    const foreground = async (): Promise<string | null> => {
      // A fresh picture goes with the foreground app it is checked against.
      if (stale) shot = this.screenshot(serial);
      stale = false;
      try {
        return (await this.options.foregroundPackage?.(serial)) ?? null;
      } catch (error) {
        log.warn(`Inspector: could not read the foreground app of ${serial}: ${errorMessage(error)}`);
        return null;
      }
    };
    const sourced = await this.fromSources(session, ask, readiness, foreground);
    let result = sourced.result;
    if (typeof result === 'string') {
      if (stale) shot = this.screenshot(serial);
      const sources = [session, ...sourced.linked];
      result = this.build(serial, shot.ts, await this.fromUiautomator(serial, sources, result));
      if (result.bytes > MAX_SNAPSHOT_BYTES) {
        throw new PublicError(`The screen of ${serial} has too many views to inspect`);
      }
    }
    let png: Buffer;
    try {
      png = await shot.png;
    } catch (error) {
      log.warn(`Inspector: screencap of ${serial} failed: ${errorMessage(error)}`);
      throw new PublicError(`Could not take a screenshot of ${serial}`);
    }
    if (!isPng(png)) throw new PublicError(`Could not take a screenshot of ${serial} (no PNG)`);
    this.keep(result, png);
    return result.snapshot;
  }

  private screenshot(serial: string): { ts: number; png: Promise<Buffer> } {
    const png = this.options.screencap(serial);
    // Awaited later, or dropped when the SDK falls through: never an unhandled rejection meanwhile.
    png.catch(() => undefined);
    return { ts: this.now(), png };
  }

  /**
   * Ask the SDK links in turn: the session's when its app is on top, then the inspect-only link of the foreground
   * app, if it says it is on top (an app that went to the background answers `background`), then a session app
   * that seems to be in the background. The first answer, or the first failure that is not about being in the
   * background, wins. `linked`: the inspect-only sources there were.
   */
  private async fromSources(
    session: InspectorSessionSource | null,
    ask: (source: InspectorSessionSource) => Promise<Built | FallbackReason>,
    readiness: () => Promise<InspectLinkReadiness>,
    foreground: () => Promise<string | null>,
  ): Promise<{ result: Built | FallbackReason; linked: InspectorSessionSource[] }> {
    const sessionLink = session?.link ? session : null;
    let asked = false;
    if (sessionLink && sessionLink.screen !== null) {
      const result = await ask(sessionLink);
      if (result !== 'background') return { result, linked: [] };
      asked = true;
    }
    const ready = await readiness();
    const top = ready.sources.length > 0 ? await foreground() : null;
    for (const source of ready.sources.filter((candidate) => candidate.packageName === top)) {
      const result = await ask(source);
      if (result !== 'background' && result !== 'no_sdk') return { result, linked: ready.sources };
      asked = true;
    }
    if (sessionLink && sessionLink.screen === null) {
      const result = await ask(sessionLink);
      if (result !== 'background' || ready.reason === null) return { result, linked: ready.sources };
    }
    return { result: ready.reason ?? (asked ? 'background' : 'no_sdk'), linked: ready.sources };
  }

  /**
   * The SDK's snapshot when it can give one (top window not Compose, not too large), else why not. The capture
   * time is the screenshot's, taken at the same moment.
   */
  private async fromSdk(
    serial: string,
    source: InspectorSessionSource,
    ts: number,
  ): Promise<Built | FallbackReason> {
    if (!source.link) return 'no_sdk';
    if (source.link.protocolVersion < DEVICE_PROTOCOL_V4) return 'old_sdk';
    let inspection;
    try {
      inspection = await source.link.inspect();
    } catch (error) {
      if (!(error instanceof SdkInspectError)) throw error;
      return SDK_FALLBACKS[error.reason];
    }
    if (topWindowIsCompose(inspection)) return 'compose';
    const built = this.build(serial, ts, sdkSnapshot(inspection, source.packageName));
    return built.bytes > MAX_SNAPSHOT_BYTES ? 'sdk_too_large' : built;
  }

  /** `sources`: the session and inspect-only links of the device, whose screen names describe their own app. */
  private async fromUiautomator(
    serial: string,
    sources: readonly (InspectorSessionSource | null)[],
    reason: FallbackReason,
  ): Promise<SnapshotBody> {
    let tree;
    try {
      tree = await this.options.dumpUi(serial);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(`Could not inspect the screen of ${serial}: ${errorMessage(error)}`);
    }
    // The SDK's screen name only describes its own app.
    const screen = sources.find((source) => source && tree.package === source.packageName)?.screen ?? null;
    const needsSession =
      NO_ANSWER_REASONS.has(reason) &&
      tree.package !== null &&
      this.options.links?.needsSession(serial, tree.package) === true;
    return uiautomatorSnapshot(tree, screen, needsSession ? 'sdk_needs_session' : reason);
  }

  /** The snapshot with its id, and its `inspection` message serialized once (measured and broadcast). */
  private build(serial: string, ts: number, body: SnapshotBody): Built {
    const snapshot: InspectorSnapshot = { id: randomBytes(8).toString('hex'), ts, serial, ...body };
    const message: ServerMessage = { type: 'inspection', snapshot };
    const payload = JSON.stringify(message);
    return { snapshot, message, payload, bytes: Buffer.byteLength(payload) };
  }

  private keep(built: Built, png: Buffer): void {
    const previous = this.current;
    this.kept.push({ snapshot: built.snapshot, png, bytes: png.length + built.bytes });
    let bytes = this.kept.reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.kept.length > 1 && (this.kept.length > MAX_KEPT_SNAPSHOTS || bytes > this.maxKeptBytes)) {
      bytes -= this.kept.shift()?.bytes ?? 0;
    }
    this.options.broadcast(built.message, built.payload);
    this.carrySelection(previous, built.snapshot);
  }

  /** The selection moves to the new snapshot when the same element is in it, else it is cleared. */
  private carrySelection(previous: InspectorSnapshot | null, snapshot: InspectorSnapshot): void {
    const selection = this.currentSelection;
    if (!selection) return;
    const node = previous?.id === selection.snapshotId ? previous.nodes[selection.nodeId] : undefined;
    const match = node ? matchingNode(node, snapshot) : null;
    this.setSelection(match ? { ...selection, snapshotId: snapshot.id, nodeId: match.id } : null);
  }

  private setSelection(selection: InspectorSelection | null): void {
    this.currentSelection = selection;
    this.options.broadcast({ type: 'inspectorSelection', selection });
  }
}

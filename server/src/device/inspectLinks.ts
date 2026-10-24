/**
 * Inspect-only SDK links (device protocol ≥ 5): outside a profiling session, debuggable apps with the SDK link in
 * `inspect` mode (no collectors) so an Inspector snapshot can come from the SDK. Only on demand: while a dashboard
 * focuses the Inspector of a device, and for INSPECT_LINK_LINGER_MS after the last `inspect` of it. Each such device
 * gets its own loopback listener, so the port a connection arrives on tells which device it came from, and a polite
 * `adb reverse`: another live server's mapping is never taken over or removed.
 */
import type { AddressInfo } from 'node:net';
import {
  DEVICE_LINK_PORT,
  DEVICE_PROTOCOL_V5,
  INSPECT_LINK_LINGER_MS,
  INSPECT_LINK_WAIT_MS,
} from '@lionscope/protocol';
import type { DeviceInfo } from '@lionscope/protocol';
import { adbShell } from '../adb/adb.ts';
import type { Adb } from '../adb/adb.ts';
import { ErrorThrottle } from '../errors.ts';
import { errorMessage, log } from '../log.ts';
import type { InspectorSessionSource } from '../session/sessionManager.ts';
import { DeviceReverseQueues, mappedHostPort, probeLoopbackPort } from './reverseTunnel.ts';
import type { SdkAttachResult, SdkHello, SdkLink, SdkLinkTarget } from './sdkLink.ts';

/** Inspect-only links on all devices at most (each listener also caps its own connections). */
export const MAX_INSPECT_LINKS = 16;
/** A verified SDK below v5 is remembered this long (it retries every 5-15 s while its app is in front)… */
export const OLD_SDK_MEMORY_MS = 60_000;
/** …for this many apps at most (the oldest go first). */
export const MAX_OLD_SDKS = 32;
/** While a device has no inspect-only link, its mapping is checked (and re-applied if lost) this often. */
export const INSPECT_REMAP_INTERVAL_MS = 10_000;
/**
 * Demand that ends is acted on this much later: a dashboard flipping its focus back and forth costs no adb steps,
 * and links survive a quick tab switch.
 */
export const INSPECT_TEARDOWN_DELAY_MS = 2000;
/**
 * Inspect-only links that arrived through the session gateway (other apps on the session's device) at most: the
 * gateway's remaining link slots stay free for the session's own app.
 */
export const MAX_INSPECT_LINKS_VIA_SESSION = 2;
/** Debuggable checks remembered (by device, package and PID) at most. */
export const MAX_DEBUGGABLE_CHECKS = 64;
const LIST_TIMEOUT_MS = 5000;
const DUMPSYS_TIMEOUT_MS = 5000;

/** Lines of a package's dumpsys section from which on the text is the app's own (permission names). */
const APP_TEXT_HEADERS = /^(?:declared|requested|install|runtime) permissions:/;

/**
 * Whether `dumpsys package <packageName>` output marks the package debuggable. Only the package's own flags count:
 * the first `flags=[ … ]` (or `pkgFlags=[ … ]`) line at its section's attribute indent, before any permission list.
 * Deeper lines and those lists hold app-controlled text (permission names) that could imitate a flags line.
 */
export function isDebuggablePackage(output: string, packageName: string): boolean {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(`Package [${packageName}]`));
  if (start === -1) return false;
  const sectionIndent = lines[start]?.search(/\S/) ?? 0;
  let attributeIndent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (text === '') continue;
    const indent = line.search(/\S/);
    if (indent <= sectionIndent) return false;
    attributeIndent ??= indent;
    if (indent !== attributeIndent) continue;
    if (APP_TEXT_HEADERS.test(text)) return false;
    const flags = /^(?:pkgFlags|flags)=\[(.*)\]$/.exec(text);
    if (flags) return (flags[1] ?? '').trim().split(/\s+/).includes('DEBUGGABLE');
  }
  return false;
}

/** Why no inspect-only link could answer (`InspectorSnapshot.fallbackReason`). */
export type InspectLinkFallback = 'sdk_linking' | 'sdk_link_busy';

export interface InspectLinkReadiness {
  /** Linked apps on top of the screen, the most recent first. */
  sources: InspectorSessionSource[];
  /** Why there are none, when it is not simply that no SDK app is on top. */
  reason: InspectLinkFallback | null;
  /** It waited (for a pending mapping step or the wait window): a screenshot taken before is stale. */
  waited: boolean;
}

/** A loopback SDK listener (the device gateway). */
export interface InspectLinkListener {
  listen(port?: number): Promise<AddressInfo>;
  close(): Promise<void>;
  readonly address: AddressInfo | null;
}

export interface InspectLinksOptions {
  adb: Adb;
  /** A new loopback listener on a free port whose hellos go to `target` (createDeviceGateway). */
  createListener: (target: SdkLinkTarget) => InspectLinkListener;
  /**
   * Where a hello that arrived on `serial`'s listener goes: PID checked on that device, then to the session or
   * back to attach() (the session manager's attachSdkOn).
   */
  route: (serial: string, hello: SdkHello, link: SdkLink) => Promise<SdkAttachResult>;
  /** Bound port of the session gateway (a mapping to it is this server's own), null while it isn't listening. */
  sessionPort: () => number | null;
  /** Replaces the TCP probe that tells a live server's mapping from a stale one (tests). */
  isHostPortLive?: (port: number) => Promise<boolean>;
  /** Whether `packageName` is debuggable on `serial` (default: `dumpsys package`); only those link in inspect mode. */
  isDebuggable?: (serial: string, packageName: string) => Promise<boolean>;
  now?: () => number;
}

interface LinkRecord {
  packageName: string;
  link: SdkLink;
  /** Arrived through the session gateway (MAX_INSPECT_LINKS_VIA_SESSION). */
  viaSession: boolean;
  /** The SDK's top screen name; null while its app is not in front (or before it said). */
  screen: string | null;
  /** When `screen` last changed to non-null. */
  topSince: number;
}

/**
 * One device with inspect demand. `mapping`: `none` (not yet, or `adb reverse` failed), `mapped` (to our
 * listener), `busy` (another live server holds the device port) or `session` (the profiling session's mapping
 * to the session gateway: links arrive there).
 */
interface DeviceEntry {
  serial: string;
  listener: InspectLinkListener | null;
  mapping: 'none' | 'mapped' | 'busy' | 'session';
  /** When the current mapping was made (the wait window runs from here). */
  mappedAt: number | null;
  /** When the mapping was last checked. */
  checkedAt: number;
  /** The last mapping step scheduled. */
  settled: Promise<void>;
  /** Mapping steps scheduled and not yet done. */
  steps: number;
  /** A check is scheduled and has not started: another one would only repeat it. */
  checkQueued: boolean;
  /** The demand ended: torn down when this fires (INSPECT_TEARDOWN_DELAY_MS) unless it came back. */
  teardownTimer: ReturnType<typeof setTimeout> | null;
  links: Map<string, LinkRecord>;
  /** Inspects waiting for a linked app on top. */
  waiters: Set<() => void>;
  /** Not in the last device listing (or not in state `device`). */
  missing: boolean;
}

const NO_SESSION: SdkAttachResult = { ok: false, reason: 'no_session' };

export class InspectLinks {
  /** Every `adb reverse` step of this server (the session's too), per device: steps on one never interleave. */
  readonly queues = new DeviceReverseQueues();
  private readonly now: () => number;
  private readonly errors: ErrorThrottle;
  private readonly entries = new Map<string, DeviceEntry>();
  /** The serial each dashboard client focuses. */
  private readonly focus = new Map<object, string>();
  /** Linger timers by serial: present while the last `inspect` is less than INSPECT_LINK_LINGER_MS ago. */
  private readonly lingers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `serial package` of verified SDKs below v5 → until when they count. */
  private readonly oldSdks = new Map<string, number>();
  /** `serial package pid` → whether that app is debuggable (it can't change without a new process). */
  private readonly debuggable = new Map<string, Promise<boolean>>();
  private readyDevices = new Set<string>();
  /** The device and app of the session that maps its device to the session gateway. */
  private session: { serial: string; packageName: string; since: number } | null = null;
  private closed = false;

  constructor(private readonly options: InspectLinksOptions) {
    this.now = options.now ?? Date.now;
    this.errors = new ErrorThrottle(this.now);
  }

  /** A dashboard client focuses the Inspector of `serial` (null: no longer). The latest per client wins. */
  setFocus(client: object, serial: string | null): void {
    const previous = this.focus.get(client) ?? null;
    if (previous === serial) return;
    if (serial === null) this.focus.delete(client);
    else this.focus.set(client, serial);
    if (previous !== null) this.update(previous);
    if (serial !== null) this.update(serial, true);
  }

  /** An `inspect` of `serial` (dashboard or agent): its link is kept for INSPECT_LINK_LINGER_MS from now. */
  noteInspect(serial: string): void {
    if (this.closed || !this.readyDevices.has(serial)) return;
    clearTimeout(this.lingers.get(serial));
    const timer = setTimeout(() => {
      this.lingers.delete(serial);
      this.update(serial);
    }, INSPECT_LINK_LINGER_MS);
    timer.unref();
    this.lingers.set(serial, timer);
    this.update(serial, true);
  }

  /**
   * For an inspect of `serial`: once its mapping step settled, the linked apps on top. While the mapping is younger
   * than INSPECT_LINK_WAIT_MS and none is, wait (until then, or until one is): SDKs need a moment to reconnect.
   */
  async prepare(serial: string): Promise<InspectLinkReadiness> {
    const entry = this.entries.get(serial);
    if (!entry) return { sources: [], reason: null, waited: false };
    const stepped = entry.steps > 0;
    let settled: Promise<void>;
    do {
      settled = entry.settled;
      await settled;
    } while (settled !== entry.settled);
    if (entry.mapping === 'busy') return { sources: [], reason: 'sdk_link_busy', waited: stepped };
    let sources = this.onTop(entry);
    const deadline = entry.mappedAt === null ? 0 : entry.mappedAt + INSPECT_LINK_WAIT_MS;
    if (sources.length > 0 || this.now() >= deadline || this.entries.get(serial) !== entry) {
      return { sources, reason: null, waited: stepped };
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, deadline - this.now());
      entry.waiters.add(done);
    });
    sources = this.onTop(entry);
    return { sources, reason: sources.length > 0 ? null : 'sdk_linking', waited: true };
  }

  /** A verified SDK below v5 of `packageName` tried to link from `serial` lately (it links only in a session). */
  needsSession(serial: string, packageName: string): boolean {
    const key = `${serial} ${packageName}`;
    const until = this.oldSdks.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.oldSdks.delete(key);
    return false;
  }

  /**
   * A hello from `serial` whose PID was verified on that device, not for the profiling session: an inspect-only
   * link while the device has demand, the SDK speaks v5 and the app is debuggable (a release app must not feed the
   * Inspector, nor the agents reading it). `viaSession`: it arrived through the session gateway. Every refusal is
   * `no_session`.
   */
  async attach(serial: string, hello: SdkHello, link: SdkLink, viaSession = false): Promise<SdkAttachResult> {
    if (link.protocolVersion < DEVICE_PROTOCOL_V5) {
      this.rememberOldSdk(serial, hello.packageName);
      return NO_SESSION;
    }
    if (!this.accepting(serial)) return NO_SESSION;
    if (!(await this.isDebuggable(serial, hello))) {
      this.refuse(serial, hello.packageName, 'the app is not debuggable');
      return NO_SESSION;
    }
    // Demand may have ended while checking.
    const entry = this.entries.get(serial);
    if (!entry || !this.accepting(serial)) return NO_SESSION;
    const previous = entry.links.get(hello.packageName);
    const others = [...this.entries.values()].flatMap((device) =>
      [...device.links.values()].filter((record) => record !== previous),
    );
    const full =
      others.length >= MAX_INSPECT_LINKS ||
      (viaSession && others.filter((record) => record.viaSession).length >= MAX_INSPECT_LINKS_VIA_SESSION);
    if (full) {
      this.refuse(serial, hello.packageName, 'too many inspect-only links');
      return NO_SESSION;
    }
    // The app reconnected (or restarted): the new link replaces the old one.
    previous?.link.close();
    const record: LinkRecord = {
      packageName: hello.packageName,
      link,
      viaSession,
      screen: null,
      topSince: 0,
    };
    entry.links.set(hello.packageName, record);
    return {
      ok: true,
      mode: 'inspect',
      handler: {
        onMessage: (message) => {
          if (message.type !== 'screen' || entry.links.get(record.packageName) !== record) return;
          const screen = message.screen?.name ?? null;
          if (screen !== null && record.screen === null) record.topSince = this.now();
          record.screen = screen;
          if (screen !== null) wake(entry);
        },
        onInvalidDiagnostic: () => undefined,
        onClose: () => {
          if (entry.links.get(record.packageName) === record) entry.links.delete(record.packageName);
        },
      },
    };
  }

  /**
   * The session on `serial` mapped the device port to the session gateway (explicit Start may take it over): links
   * now arrive there. Its own app's inspect-only link is closed, so the SDK reconnects into the session.
   */
  sessionMapped(serial: string, packageName: string): void {
    if (this.session?.serial !== serial || this.session.packageName !== packageName) {
      this.session = { serial, packageName, since: this.now() };
    }
    const entry = this.entries.get(serial);
    if (!entry) return;
    entry.mapping = 'session';
    entry.mappedAt ??= this.session.since;
    entry.links.get(packageName)?.link.close('no_session');
  }

  /**
   * The session on `serial` ended. true: the device has inspect demand, and its mapping is re-pointed to the inspect
   * listener (the session must not remove it); false: the session removes its mapping as usual. A device that is
   * not ready now is re-mapped once it is back.
   */
  sessionEnded(serial: string): boolean {
    if (this.session?.serial === serial) this.session = null;
    const entry = this.entries.get(serial);
    if (entry?.mapping === 'session') entry.mapping = 'none';
    if (this.closed || !this.isDemanded(serial)) return false;
    if (!this.readyDevices.has(serial)) {
      if (entry) entry.missing = true;
      return false;
    }
    if (entry) this.check(entry);
    else this.update(serial);
    return true;
  }

  /** The device listing (`listingRecovered`: earlier listings failed, adb may have restarted). */
  onDevices(devices: readonly DeviceInfo[], listingRecovered: boolean): void {
    this.readyDevices = new Set(
      devices.filter((device) => device.state === 'device').map((device) => device.serial),
    );
    for (const entry of this.entries.values()) {
      if (!this.readyDevices.has(entry.serial)) {
        entry.missing = true;
        continue;
      }
      // After a USB flicker or an adb restart the mapping is gone; while no SDK is linked, check it now and then.
      const flickered = entry.missing;
      entry.missing = false;
      const remapDue = entry.links.size === 0 && this.now() - entry.checkedAt >= INSPECT_REMAP_INTERVAL_MS;
      // The session that held the device is gone (it ended while the device was away): map it ourselves.
      const orphaned = entry.mapping === 'session' && this.session?.serial !== entry.serial;
      if (orphaned) entry.mapping = 'none';
      // A busy device is retried on the next demand change or inspect, not on its own.
      if (entry.mapping === 'busy' || entry.mapping === 'session') continue;
      if (orphaned || flickered || listingRecovered || remapDue) this.check(entry);
    }
    for (const serial of new Set([...this.focus.values(), ...this.lingers.keys()])) this.update(serial);
  }

  /** Close every inspect-only link, remove our mappings and stop the listeners. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.lingers.values()) clearTimeout(timer);
    this.lingers.clear();
    this.focus.clear();
    for (const entry of [...this.entries.values()]) this.teardown(entry);
    await this.queues.idle();
  }

  private isDemanded(serial: string): boolean {
    return this.lingers.has(serial) || [...this.focus.values()].includes(serial);
  }

  /** New links are accepted for `serial`: it has an entry and demand (not just a teardown pending). */
  private accepting(serial: string): boolean {
    return !this.closed && this.entries.has(serial) && this.isDemanded(serial);
  }

  /**
   * Start or end `serial`'s inspect-only link to match its demand. `retry`: a new demand (focus, inspect) also
   * retries a mapping that failed or was busy.
   */
  private update(serial: string, retry = false): void {
    const entry = this.entries.get(serial);
    const demanded = !this.closed && this.isDemanded(serial);
    if (!demanded) {
      if (!entry) return;
      if (this.closed) this.teardown(entry);
      else this.scheduleTeardown(entry);
      return;
    }
    if (entry) {
      if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
      entry.teardownTimer = null;
      if (retry && (entry.mapping === 'none' || entry.mapping === 'busy')) this.check(entry);
      return;
    }
    if (!this.readyDevices.has(serial)) return;
    const created: DeviceEntry = {
      serial,
      listener: null,
      mapping: 'none',
      mappedAt: null,
      checkedAt: 0,
      settled: Promise.resolve(),
      steps: 0,
      checkQueued: false,
      teardownTimer: null,
      links: new Map(),
      waiters: new Set(),
      missing: false,
    };
    this.entries.set(serial, created);
    this.check(created);
  }

  private scheduleTeardown(entry: DeviceEntry): void {
    if (entry.teardownTimer) return;
    entry.teardownTimer = setTimeout(() => {
      entry.teardownTimer = null;
      if (this.entries.get(entry.serial) === entry && !this.isDemanded(entry.serial)) this.teardown(entry);
    }, INSPECT_TEARDOWN_DELAY_MS);
    entry.teardownTimer.unref();
  }

  /** Run a mapping step of `entry` in its device's queue (`entry.settled`, `entry.steps` follow it). */
  private step(entry: DeviceEntry, operation: () => Promise<void>): void {
    entry.steps += 1;
    entry.settled = this.queues.run(entry.serial, async () => {
      try {
        await operation();
      } finally {
        entry.steps -= 1;
      }
    });
  }

  /**
   * Make sure the device port of `entry` reaches our listener, politely: read `reverse --list` first; a mapping to
   * another host port that is live belongs to another server (busy: left alone). Ours, a dead one or none is
   * (re-)mapped. While the session holds the device, its mapping serves. At most one check waits per device.
   */
  private check(entry: DeviceEntry): void {
    entry.checkedAt = this.now();
    if (entry.checkQueued) return;
    entry.checkQueued = true;
    this.step(entry, async () => {
      entry.checkQueued = false;
      if (this.entries.get(entry.serial) !== entry || this.heldBySession(entry)) return;
      try {
        await this.map(entry);
      } catch (error) {
        entry.mapping = 'none';
        if (this.errors.shouldReport(`map ${entry.serial}`)) {
          log.warn(`No inspect-only SDK link on ${entry.serial}: ${errorMessage(error)}`);
        }
      }
    });
  }

  /** The session maps `entry`'s device now: its mapping serves (and must not be overwritten). */
  private heldBySession(entry: DeviceEntry): boolean {
    if (this.session?.serial !== entry.serial) return false;
    entry.mapping = 'session';
    entry.mappedAt ??= this.session.since;
    return true;
  }

  private async map(entry: DeviceEntry): Promise<void> {
    entry.listener ??= this.options.createListener({
      attachSdk: (hello, link) => this.options.route(entry.serial, hello, link),
    });
    const port = (entry.listener.address ?? (await entry.listener.listen(0))).port;
    const target = await this.mappedPort(entry.serial);
    // The session may have mapped the device while we waited (it takes the device over: explicit Start).
    if (this.heldBySession(entry)) return;
    if (target === port) {
      if (entry.mapping !== 'mapped') entry.mappedAt = this.now();
      entry.mapping = 'mapped';
      return;
    }
    const ours = target === undefined || (target !== null && target === this.options.sessionPort());
    if (!ours && (target === null || (await this.isHostPortLive(target))))
      return this.markBusy(entry, target);
    if (this.heldBySession(entry)) return;
    await this.options.adb.reverse(entry.serial, DEVICE_LINK_PORT, port);
    // adb has no compare-and-swap: another server may have mapped the port between our listing and our reverse
    // (then it was overwritten: undetectable) or right after it (then ours is gone). Reading it back catches the
    // latter while it is still recent; a mapping that changes after this read is only noticed on the next check.
    const after = await this.mappedPort(entry.serial);
    if (after !== port) {
      entry.mapping = 'none';
      if (after !== undefined) this.markBusy(entry, after);
      return;
    }
    entry.mapping = 'mapped';
    entry.mappedAt = this.now();
  }

  private async mappedPort(serial: string): Promise<number | null | undefined> {
    const listing = await this.options.adb.exec(['-s', serial, 'reverse', '--list'], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    return mappedHostPort(listing, DEVICE_LINK_PORT);
  }

  private markBusy(entry: DeviceEntry, target: number | null): void {
    if (entry.mapping !== 'busy') {
      log.info(
        `No inspect-only SDK link on ${entry.serial}: another server holds adb reverse tcp:${DEVICE_LINK_PORT}` +
          (target === null ? '' : ` (port ${target})`),
      );
    }
    entry.mapping = 'busy';
  }

  /**
   * No more demand: close its links (`bye no_session`), remove the mapping if it is still ours (to our listener, or
   * to the session gateway left behind by a session that handed the device over), stop listening.
   */
  private teardown(entry: DeviceEntry): void {
    this.entries.delete(entry.serial);
    if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
    for (const record of entry.links.values()) record.link.close('no_session');
    entry.links.clear();
    wake(entry);
    const listener = entry.listener;
    this.step(entry, async () => {
      const port = listener?.address?.port;
      try {
        const target = await this.mappedPort(entry.serial);
        // Another server (or a new session) may have taken the device port over meanwhile: then it is not ours.
        const ours =
          target !== undefined &&
          target !== null &&
          (target === port ||
            (target === this.options.sessionPort() && this.session?.serial !== entry.serial));
        if (ours) await this.options.adb.removeReverse(entry.serial, DEVICE_LINK_PORT);
      } catch (error) {
        log.warn(`Could not remove the inspect-only adb reverse on ${entry.serial}: ${errorMessage(error)}`);
      }
      await listener?.close();
    });
  }

  /** Cached per device, package and PID; a failed check counts as not debuggable (and is not cached). */
  private isDebuggable(serial: string, hello: SdkHello): Promise<boolean> {
    const key = `${serial} ${hello.packageName} ${hello.pid}`;
    let checked = this.debuggable.get(key);
    if (!checked) {
      const check =
        this.options.isDebuggable ?? ((device, packageName) => this.dumpsysDebuggable(device, packageName));
      checked = check(serial, hello.packageName).catch((error: unknown) => {
        this.debuggable.delete(key);
        if (this.errors.shouldReport(`debuggable ${serial}`)) {
          log.warn(
            `Could not check whether ${hello.packageName} on ${serial} is debuggable: ${errorMessage(error)}`,
          );
        }
        return false;
      });
      this.debuggable.set(key, checked);
      while (this.debuggable.size > MAX_DEBUGGABLE_CHECKS) {
        const oldest = this.debuggable.keys().next().value;
        if (oldest === undefined) break;
        this.debuggable.delete(oldest);
      }
    }
    return checked;
  }

  private async dumpsysDebuggable(serial: string, packageName: string): Promise<boolean> {
    const output = await adbShell(this.options.adb, serial, `dumpsys package ${packageName}`, {
      timeoutMs: DUMPSYS_TIMEOUT_MS,
    });
    return isDebuggablePackage(output, packageName);
  }

  private refuse(serial: string, packageName: string, reason: string): void {
    if (this.errors.shouldReport(`refuse ${serial} ${packageName} ${reason}`)) {
      log.info(`Refused an inspect-only SDK link from ${packageName} on ${serial}: ${reason}`);
    }
  }

  /** Linked apps on top of `entry`'s screen, the one that came to the front last first. */
  private onTop(entry: DeviceEntry): InspectorSessionSource[] {
    return [...entry.links.values()]
      .filter((record) => record.screen !== null)
      .sort((a, b) => b.topSince - a.topSince)
      .map((record) => ({ packageName: record.packageName, link: record.link, screen: record.screen }));
  }

  private rememberOldSdk(serial: string, packageName: string): void {
    const key = `${serial} ${packageName}`;
    this.oldSdks.delete(key);
    this.oldSdks.set(key, this.now() + OLD_SDK_MEMORY_MS);
    while (this.oldSdks.size > MAX_OLD_SDKS) {
      const oldest = this.oldSdks.keys().next().value;
      if (oldest === undefined) break;
      this.oldSdks.delete(oldest);
    }
    if (this.errors.shouldReport(`old ${key}`)) {
      log.info(
        `Refused an SDK link from ${packageName} on ${serial} outside a session: its SDK is older than 0.9.0`,
      );
    }
    // An inspect waiting for a link need not wait any longer: this app won't link.
    const entry = this.entries.get(serial);
    if (entry) wake(entry);
  }

  private isHostPortLive(port: number): Promise<boolean> {
    return (this.options.isHostPortLive ?? probeLoopbackPort)(port);
  }
}

function wake(entry: DeviceEntry): void {
  for (const waiter of [...entry.waiters]) waiter();
}

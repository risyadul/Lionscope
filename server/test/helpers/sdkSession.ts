import type {
  NetworkMockRule,
  ScreenRef,
  SdkFrame,
  SdkOptions,
  ServerMessage,
  ViewProperty,
  ViewPropertyGroup,
  ViewPropertyValue,
} from '@lionscope/protocol';
import { vi } from 'vitest';
import { SdkEditError, SdkInspectError } from '../../src/device/sdkLink.ts';
import type {
  ByeReason,
  SdkHello,
  SdkInspection,
  SdkLink,
  SdkLinkHandler,
  SdkViewEditResult,
} from '../../src/device/sdkLink.ts';
import { ProfilingSession } from '../../src/session/profilingSession.ts';
import { FakeAdb, FakeDevice } from './fakes.ts';

export const PKG = 'com.google.android.apps.nexuslauncher';
export const START = 1_800_000_000_250;
/** FakeDevice's clock runs 5 s behind the laptop. */
export const OFFSET_MS = 5000;
export const HOME: ScreenRef = { name: 'home', className: 'com.example.HomeFragment', kind: 'fragment' };
export const PROMO: ScreenRef = { name: 'Promo', className: 'com.example.PromoSheet', kind: 'dialog' };

export const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 1,
  sdkVersion: '0.1.0',
  packageName: PKG,
  processName: PKG,
  pid: 1105,
  apiLevel: 35,
  deviceWallMs: START - OFFSET_MS,
  refreshRateHz: 120,
};

/** What a fake link without edits has of them: a session link below v8, without a proof (edits fail `unsupported`). */
export const NO_EDITS: Pick<SdkLink, 'mode' | 'proven' | 'setViewProperty' | 'revertViewProperties'> = {
  mode: 'session',
  proven: false,
  setViewProperty: () => Promise.reject(new SdkEditError('unsupported')),
  revertViewProperties: () => Promise.reject(new SdkEditError('unsupported')),
};

/** One edit a FakeLink was asked for. */
export type EditRequest =
  | { kind: 'set'; viewKey: number; property: ViewProperty; value: ViewPropertyValue }
  | { kind: 'revert'; viewKey?: number; property?: ViewProperty | ViewPropertyGroup };

export class FakeLink implements SdkLink {
  mode: SdkLink['mode'] = 'session';
  /** The welcome carried the link proof (a session link the SDK takes edits from). */
  proven = true;
  readonly configs: SdkOptions[] = [];
  closedWith: ByeReason | 'none' | null = null;
  constructor(readonly protocolVersion = 1) {}
  close(reason?: ByeReason): void {
    this.closedWith = reason ?? 'none';
  }
  sendConfig(options: SdkOptions): void {
    this.configs.push(options);
  }
  /** Every rule set sent (`sendMocks`), as given. */
  readonly mockSets: { rev: number; rules: readonly NetworkMockRule[] }[] = [];
  sendMocks(rev: number, rules: readonly NetworkMockRule[]): void {
    this.mockSets.push({ rev, rules });
  }
  /** What inspect() answers; unset, it fails as `unsupported`. */
  answerInspect: (() => Promise<SdkInspection>) | null = null;
  inspects = 0;
  inspect(): Promise<SdkInspection> {
    this.inspects += 1;
    return this.answerInspect?.() ?? Promise.reject(new SdkInspectError('unsupported'));
  }
  /** What the edits answer; unset, they fail as `unsupported`. */
  answerEdit: ((request: EditRequest) => Promise<SdkViewEditResult>) | null = null;
  readonly edits: EditRequest[] = [];
  setViewProperty(
    viewKey: number,
    property: ViewProperty,
    value: ViewPropertyValue,
  ): Promise<SdkViewEditResult> {
    return this.edit({ kind: 'set', viewKey, property, value });
  }
  revertViewProperties(
    viewKey?: number,
    property?: ViewProperty | ViewPropertyGroup,
  ): Promise<SdkViewEditResult> {
    return this.edit({ kind: 'revert', viewKey, property });
  }
  private edit(request: EditRequest): Promise<SdkViewEditResult> {
    this.edits.push(request);
    return this.answerEdit?.(request) ?? Promise.reject(new SdkEditError('unsupported'));
  }
}

/** Device wall-clock ms for "now" on the laptop. */
export const deviceNow = () => Date.now() - OFFSET_MS;

export function sdkFrame(ts: number, totalMs: number): SdkFrame {
  return {
    ts,
    totalMs,
    inputMs: 0.5,
    animationMs: 0.5,
    layoutMs: 1,
    drawMs: 2,
    syncMs: 0.5,
    commandMs: 1,
    swapMs: 0.5,
    delayMs: 1,
    gpuMs: 3,
    deadlineMs: 16,
    firstDraw: false,
  };
}

/** A started session (fake timers must be on) with helpers to attach SDK links and feed them. */
export async function setupSdkSession() {
  const device = new FakeDevice();
  device.clockSkewMs = -OFFSET_MS;
  const adb = new FakeAdb(
    () => '',
    (command) => device.handle(command),
  );
  const messages: ServerMessage[] = [];
  const session = new ProfilingSession({
    adb,
    serial: 'emulator-5554',
    packageName: PKG,
    emit: (message) => messages.push(message),
  });
  await session.start();
  const ofType = <T extends ServerMessage['type']>(type: T) =>
    messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  const gfxinfoPolls = () => device.commands.filter((command) => command.includes('gfxinfo')).length;
  /** Attach a link and let its PID check (a `pidof` on the device) finish; `proven`: it got the link proof. */
  const connect = async (
    hello: SdkHello = HELLO,
    link = new FakeLink(hello.protocolVersion),
    proven = false,
  ): Promise<{ link: FakeLink; handler: SdkLinkHandler }> => {
    const handler = session.attachSdk(hello, link, false, proven);
    await vi.advanceTimersByTimeAsync(0);
    return { link, handler };
  };
  /** pidof commands sent to the device (counted at the shell, whatever handles them). */
  const pidofs = () =>
    adb.shells.flatMap((shell) => shell.commands).filter((command) => command.startsWith('pidof')).length;
  /** Send one 500 ms batch of `count` frames that just rendered. */
  const sendFrames = (handler: SdkLinkHandler, count: number, totalMs = 6) => {
    const end = deviceNow();
    const frames = Array.from({ length: count }, (_, i) => sdkFrame(end - 499 + i * 8, totalMs));
    handler.onMessage({ type: 'frames', window: 'com.example.MainActivity', intervalMs: 8.333, frames });
  };
  return { adb, device, session, messages, ofType, gfxinfoPolls, connect, sendFrames, pidofs };
}

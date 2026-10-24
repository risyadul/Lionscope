import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LINK_KEY_RECEIVER } from '@lionscope/protocol';
import type { NetworkMockRule, ServerMessage } from '@lionscope/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAdb, describeArgs } from '../src/adb/adb.ts';
import { deliverLinkKey, LINK_KEY_TIMEOUT_MS, linkKeyCommand, linkProof } from '../src/device/linkKey.ts';
import type { SdkAttachResult, SdkHello, SdkLink } from '../src/device/sdkLink.ts';
import { log } from '../src/log.ts';
import { SessionManager } from '../src/session/sessionManager.ts';
import { execShellCommand, FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';
import { mockInput } from './helpers/networkFixtures.ts';
import { NO_EDITS } from './helpers/sdkSession.ts';

const PKG = 'com.example.shop';
const SERIAL = 'emulator-5554';
const NONCE = '0123456789abcdef0123456789abcdef';
const HELLO: SdkHello & { nonce: string } = {
  type: 'hello',
  protocolVersion: 7,
  sdkVersion: '0.7.0',
  packageName: PKG,
  processName: PKG,
  pid: 1105,
  apiLevel: 36,
  deviceWallMs: 1,
  refreshRateHz: 60,
  nonce: NONCE,
};
const COMPLETED =
  'Broadcasting: Intent { flg=0x400000 cmp=com.example.shop/x (has extras) }\nBroadcast completed: result=0\n';
const KEY_EXTRA = /--es key ([0-9a-f]+)/;

const expectedProof = (keyHex: string, protocolVersion = 7) =>
  createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(`${NONCE}:${protocolVersion}:session`)
    .digest('hex');

class RecordingLink implements SdkLink {
  readonly mockSets: { rev: number; rules: readonly NetworkMockRule[] }[] = [];
  constructor(readonly protocolVersion = 7) {}
  close(): void {}
  sendConfig(): void {}
  sendMocks(rev: number, rules: readonly NetworkMockRule[]): void {
    this.mockSets.push({ rev, rules });
  }
  inspect(): Promise<never> {
    return Promise.reject(new Error('unsupported'));
  }
  readonly mode = 'session';
  readonly proven = false;
  setViewProperty = NO_EDITS.setViewProperty;
  revertViewProperties = NO_EDITS.revertViewProperties;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('deliverLinkKey', () => {
  it('broadcasts a fresh 32-byte key to the app’s receiver for its pid, and signs the nonce with it', async () => {
    const adb = new FakeAdb(() => COMPLETED);
    const exec = vi.spyOn(adb, 'exec');
    const first = await deliverLinkKey(adb, SERIAL, HELLO, 7);
    const second = await deliverLinkKey(adb, SERIAL, HELLO, 7);
    const commands = adb.execCalls.map((args) => execShellCommand(args) ?? '');
    const keys = commands.map((command) => KEY_EXTRA.exec(command)?.[1] ?? '');
    expect(adb.execCalls[0]).toEqual([
      '-s',
      SERIAL,
      'shell',
      `am broadcast -n ${PKG}/${LINK_KEY_RECEIVER} --es key ${keys[0]} --ei pid 1105`,
    ]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect((exec.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual({ timeoutMs: LINK_KEY_TIMEOUT_MS });
    expect(first).toEqual({ ok: true, proof: expectedProof(keys[0] ?? '') });
    expect(second).toEqual({ ok: true, proof: expectedProof(keys[1] ?? '') });
    expect(linkKeyCommand(PKG, 42, 'ab')).toBe(
      `am broadcast -n ${PKG}/${LINK_KEY_RECEIVER} --es key ab --ei pid 42`,
    );
    expect(linkProof(Buffer.alloc(32), NONCE, 7, 'session')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails without a proof when the broadcast did not complete or adb failed, never naming the key', async () => {
    const incomplete = await deliverLinkKey(
      new FakeAdb(() => 'Broadcasting: Intent { … }\n'),
      SERIAL,
      HELLO,
      7,
    );
    expect(incomplete).toEqual({ ok: false, error: 'the broadcast did not complete' });

    // The worst case: an error that quotes the whole command line.
    const echoing = new FakeAdb((args) => {
      throw new Error(`adb ${args.join(' ')} failed: device offline`);
    });
    const failed = await deliverLinkKey(echoing, SERIAL, HELLO, 7);
    const key = KEY_EXTRA.exec(execShellCommand(echoing.execCalls[0] ?? []) ?? '')?.[1] ?? '';
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(key);
    expect(failed).toMatchObject({ error: expect.stringContaining('--es key <redacted>') });

    expect(await deliverLinkKey(new FakeAdb(() => COMPLETED), SERIAL, { ...HELLO, pid: -1 }, 7)).toEqual({
      ok: false,
      error: 'invalid package name or pid',
    });
  });

  it('keeps the key out of adb error messages (describeArgs)', () => {
    expect(describeArgs(['-s', SERIAL, 'shell', linkKeyCommand(PKG, 7, 'f'.repeat(64))])).toBe(
      `-s ${SERIAL} shell am broadcast -n ${PKG}/${LINK_KEY_RECEIVER} --es key <redacted> --ei pid 7`,
    );
  });
});

describe('deliverLinkKey with a real adb process', () => {
  let dir: string;
  let fakeAdb: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lionscope-link-key-'));
    fakeAdb = path.join(dir, 'adb');
    // Fails echoing its arguments on stderr, or hangs.
    writeFileSync(
      fakeAdb,
      ['#!/bin/sh', 'if [ "$2" = "emulator-5556" ]; then sleep 5; fi', 'echo "error: $*" >&2', 'exit 1'].join(
        '\n',
      ),
    );
    chmodSync(fakeAdb, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scrubs the key from stderr and reports a timeout', async () => {
    const adb = createAdb(fakeAdb);
    const exec = vi.spyOn(adb, 'exec');
    const failed = await deliverLinkKey(adb, SERIAL, HELLO, 7);
    const command = execShellCommand(exec.mock.calls[0]?.[0] ?? []) ?? '';
    const key = KEY_EXTRA.exec(command)?.[1] ?? '';
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(key);
    expect(JSON.stringify(failed)).toContain('error: -s emulator-5554 shell am broadcast');

    const slow = createAdb(fakeAdb);
    const originalExec = slow.exec;
    // The same deadline, shortened for the test.
    vi.spyOn(slow, 'exec').mockImplementation((args) => originalExec(args, { timeoutMs: 100 }));
    expect(await deliverLinkKey(slow, 'emulator-5556', HELLO, 7)).toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out'),
    });
  });
});

describe('SessionManager link proof', () => {
  function setup(broadcast: (command: string) => string | Promise<string> = () => COMPLETED) {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const device = new FakeDevice();
    device.clockSkewMs = -5000;
    const adb = new FakeAdb(
      (args) => {
        if (args[0] === 'devices') return fixture('adb-devices.txt');
        const command = execShellCommand(args) ?? '';
        if (command.startsWith('pidof ')) return String(device.handle(command));
        if (command.startsWith('am broadcast ')) return broadcast(command);
        return '';
      },
      (command) => device.handle(command),
    );
    const messages: ServerMessage[] = [];
    const manager = new SessionManager({
      adb,
      broadcast: (message) => messages.push(message),
      // The session gateway's hellos come from the device its `adb reverse` maps.
      deviceGatewayPort: () => 9123,
      isHostPortLive: () => Promise.resolve(false),
    });
    const start = async () => {
      await manager.startSession(SERIAL, PKG);
      await vi.advanceTimersByTimeAsync(50);
    };
    const broadcasts = () =>
      adb.execCalls
        .map((args) => execShellCommand(args) ?? '')
        .filter((command) => command.startsWith('am '));
    const keyOf = (index: number) => KEY_EXTRA.exec(broadcasts()[index] ?? '')?.[1] ?? '';
    return { adb, manager, messages, start, broadcasts, keyOf };
  }

  it('hands a v7 session link a key after its pid check, before answering, and welcomes it with the proof', async () => {
    let complete: (output: string) => void = () => undefined;
    const { adb, manager, start, broadcasts, keyOf } = setup(
      () => new Promise((resolve) => (complete = resolve)),
    );
    await start();
    const rule = manager.setNetworkMock(mockInput(), 'user');
    const link = new RecordingLink();
    let result: SdkAttachResult | null = null;
    void manager.attachSdk(HELLO, link).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(0);
    const commands = adb.execCalls.map((args) => execShellCommand(args) ?? '');
    expect(commands.filter((command) => /^(pidof|am) /.test(command))).toEqual([
      `pidof ${PKG}`,
      broadcasts()[0],
    ]);
    // Nothing is answered (so no welcome written) and nothing is sent while the broadcast runs.
    expect(result).toBeNull();
    expect(link.mockSets).toEqual([]);
    expect(manager.getSessionState().sdk?.connected).toBe(false);

    complete(COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ ok: true, mode: 'session', proof: expectedProof(keyOf(0)) });
    expect(manager.getSessionState().sdk).toMatchObject({ connected: true, network: 'active' });
    expect(link.mockSets).toEqual([{ rev: 1, rules: [rule] }]);
    await manager.close();
    expect(manager.getSessionState().sdk?.network).toBeNull();
  });

  it('welcomes without a proof as `unverified` when the key could not be delivered, logging no key', async () => {
    const logged: string[] = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const { manager, messages, start, broadcasts, keyOf } = setup((command) => {
      throw new Error(`adb shell ${command} failed: Security exception`);
    });
    await start();
    manager.setNetworkMock(mockInput(), 'user');
    const link = new RecordingLink();
    const result = await manager.attachSdk(HELLO, link);
    expect(result).toMatchObject({ ok: true, mode: 'session' });
    expect(result).not.toHaveProperty('proof');
    expect(manager.getSessionState().sdk).toMatchObject({
      connected: true,
      protocolVersion: 7,
      network: 'unverified',
    });
    // Mocks only go to proven links, now and on later changes.
    manager.setNetworkMock(mockInput({ url: 'https://api.example.com/v2' }), 'user');
    await vi.advanceTimersByTimeAsync(1000);
    expect(link.mockSets).toEqual([]);
    expect(manager.getNetworkMocks().appliedRev).toBeNull();

    const key = keyOf(0);
    expect(broadcasts()).toHaveLength(1);
    expect(logged.some((line) => line.includes('No link key') && line.includes('Security exception'))).toBe(
      true,
    );
    expect(logged.join('\n')).not.toContain(key);
    expect(JSON.stringify(messages)).not.toContain(key);
    await manager.close();
  });

  it('gives no key to older SDKs (`needs_sdk`), to a hello without a nonce (`unverified`) or to other apps', async () => {
    const { manager, start, broadcasts } = setup();
    await start();
    const old = new RecordingLink(6);
    expect(await manager.attachSdk({ ...HELLO, protocolVersion: 6 }, old)).not.toHaveProperty('proof');
    expect(manager.getSessionState().sdk?.network).toBe('needs_sdk');

    const { nonce: _nonce, ...withoutNonce } = HELLO;
    expect(await manager.attachSdk(withoutNonce, new RecordingLink())).not.toHaveProperty('proof');
    expect(manager.getSessionState().sdk?.network).toBe('unverified');

    // Another app's hello (an inspect-only link at most) never gets a key.
    expect(await manager.attachSdk({ ...HELLO, packageName: 'com.other.app' }, new RecordingLink())).toEqual({
      ok: false,
      reason: 'no_session',
    });
    expect(broadcasts()).toEqual([]);
    await manager.close();
  });
});

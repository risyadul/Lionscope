import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProcessAlive } from '../src/emulator/discovery.ts';
import { createEmulatorHost, isPortFree } from '../src/emulator/emulatorHost.ts';
import { FIXTURE_PROTO } from './helpers/fakeEmulator.ts';

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createEmulatorHost', () => {
  let sdk: string;
  let logName: string;

  /** The per-run log directory (`<tmp>/lionscope-XXXXXX`) holding this test's log. */
  const findLogDir = (): string | undefined =>
    readdirSync(tmpdir())
      .filter((entry) => entry.startsWith('lionscope-'))
      .map((entry) => path.join(tmpdir(), entry))
      .find((dir) => existsSync(path.join(dir, `emulator-${logName}.log`)));

  beforeEach(() => {
    sdk = mkdtempSync(path.join(tmpdir(), 'lionscope-sdk-'));
    mkdirSync(path.join(sdk, 'platform-tools'));
    mkdirSync(path.join(sdk, 'emulator', 'lib'), { recursive: true });
    // A stand-in `emulator`: lists one AVD, starts a child it waits for (like the launcher starts qemu), or
    // echoes its arguments.
    const script = path.join(sdk, 'emulator', 'emulator');
    writeFileSync(
      script,
      '#!/bin/sh\n' +
        'if [ "$1" = "-list-avds" ]; then echo Pixel_9a; exit 0; fi\n' +
        'if [ "$1" = "-child" ]; then sleep 30 & echo $! > "$2"; wait; exit 0; fi\n' +
        'echo "booted $*"\n',
    );
    chmodSync(script, 0o755);
    logName = `test-${process.pid}-${Date.now()}`;
  });

  afterEach(() => {
    rmSync(sdk, { recursive: true, force: true });
    const logDir = findLogDir();
    if (logDir) rmSync(logDir, { recursive: true, force: true });
  });

  const hostOf = () =>
    createEmulatorHost(path.join(sdk, 'platform-tools', 'adb'), {
      env: { ANDROID_AVD_HOME: '/avds' },
      platform: 'linux',
      home: '/home/me',
    });

  it('runs and spawns the emulator of the SDK that adb belongs to', async () => {
    copyFileSync(FIXTURE_PROTO, path.join(sdk, 'emulator', 'lib', 'emulator_controller.proto'));
    const host = hostOf();
    expect(host.emulatorPath).toBe(path.join(sdk, 'emulator', 'emulator'));
    expect(host.createClient).toBeTypeOf('function');
    expect(host.avdHome).toBe('/avds');
    expect(host.isAlive(process.pid)).toBe(true);
    expect(await host.runEmulator(['-list-avds'])).toBe('Pixel_9a\n');

    const child = host.spawnEmulator(['-avd', 'Pixel_9a'], logName);
    const exit = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(exit).toBe(0);
    const logDir = findLogDir() ?? '';
    const logFile = path.join(logDir, `emulator-${logName}.log`);
    // A private directory of this run, and a private file.
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    await waitUntil(() => readFileSync(logFile, 'utf8').includes('booted'));
    expect(readFileSync(logFile, 'utf8')).toBe('booted -avd Pixel_9a\n');
  });

  it('cannot mirror without a usable proto', () => {
    expect(hostOf().createClient).toBeNull();
    writeFileSync(path.join(sdk, 'emulator', 'lib', 'emulator_controller.proto'), 'this is not a proto');
    expect(hostOf().createClient).toBeNull();
  });

  it('has nothing to run without an installed emulator', async () => {
    rmSync(path.join(sdk, 'emulator'), { recursive: true });
    const host = hostOf();
    expect(host.emulatorPath).toBeNull();
    expect(host.createClient).toBeNull();
    await expect(host.runEmulator(['-list-avds'])).rejects.toThrow('no Android Emulator');
    expect(() => host.spawnEmulator(['-avd', 'x'], logName)).toThrow('no Android Emulator');
  });

  it('signals the whole process group, so the emulator the launcher spawned stops too', async () => {
    const host = hostOf();
    const pidFile = path.join(sdk, 'child.pid');
    const child = host.spawnEmulator(['-child', pidFile], logName);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(isProcessAlive(grandchild)).toBe(true);
    expect(child.kill('SIGTERM')).toBe(true);
    await exited;
    await waitUntil(() => !isProcessAlive(grandchild));
    // Once the group is gone it falls back to the launcher itself (which has exited too).
    expect(child.kill('SIGTERM')).toBe(false);
  });

  it('tells free ports from ports in use', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await isPortFree(port)).toBe(false);
    await new Promise((resolve) => server.close(resolve));
    expect(await isPortFree(port)).toBe(true);
  });
});

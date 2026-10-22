import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbShell, createAdb, execBinary } from '../src/adb/adb.ts';
import { resolveAdbPath } from '../src/adb/resolveAdb.ts';
import { FakeAdb, FakeChild } from './helpers/fakes.ts';

describe('createAdb (against a stand-in POSIX adb script)', () => {
  let dir: string;
  let fakeAdb: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lionscope-adb-'));
    fakeAdb = path.join(dir, 'adb');
    writeFileSync(
      fakeAdb,
      [
        '#!/bin/sh',
        'if [ "$1" = "fail" ]; then echo "boom" >&2; exit 3; fi',
        'if [ "$1" = "sleep" ]; then sleep 5; fi',
        'if [ "$2" = "offline-1" ]; then echo "device offline" >&2; exit 1; fi',
        'printf "%s|" "$@"',
      ].join('\n'),
    );
    chmodSync(fakeAdb, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('passes arguments verbatim, without a host shell', async () => {
    const adb = createAdb(fakeAdb);
    await expect(adb.exec(['devices', '-l'])).resolves.toBe('devices|-l|');
    await expect(adbShell(adb, 'emulator-5554', 'echo $(id); rm -rf /')).resolves.toBe(
      '-s|emulator-5554|shell|echo $(id); rm -rf /|',
    );
  });

  it('rejects with stderr on failure and on timeout', async () => {
    const adb = createAdb(fakeAdb);
    await expect(adb.exec(['fail'])).rejects.toThrow(/adb fail failed: boom/);
    await expect(adb.exec(['sleep'], { timeoutMs: 100 })).rejects.toThrow(/adb sleep failed/);
  });

  it('sets up and removes adb reverse mappings with argument arrays', async () => {
    const adb = createAdb(fakeAdb);
    await expect(adb.reverse('emulator-5554', 8700, 9123)).resolves.toBeUndefined();
    await expect(adb.removeReverse('emulator-5554', 8700)).resolves.toBeUndefined();
    await expect(adb.reverse('offline-1', 8700, 9123)).rejects.toThrow(
      'adb -s offline-1 reverse tcp:8700 tcp:9123 failed: device offline',
    );
    await expect(adb.removeReverse('offline-1', 8700)).rejects.toThrow(
      'adb -s offline-1 reverse --remove tcp:8700 failed: device offline',
    );
  });

  it('spawns long-running processes with piped stdio', async () => {
    const adb = createAdb(fakeAdb);
    const child = adb.spawn(['logcat', '-v', 'epoch']);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += String(chunk)));
    const code = await new Promise<number | null>((resolve) =>
      child.on('exit', (exitCode) => resolve(exitCode)),
    );
    expect(code).toBe(0);
    expect(output).toBe('logcat|-v|epoch|');
  });
});

describe('resolveAdbPath', () => {
  const none = () => false;

  it('prefers LIONSCOPE_ADB', () => {
    expect(
      resolveAdbPath({ env: { LIONSCOPE_ADB: '/opt/adb', ANDROID_HOME: '/sdk' }, exists: () => true }),
    ).toBe('/opt/adb');
  });

  it('checks ANDROID_HOME, then ANDROID_SDK_ROOT, then the platform default', () => {
    const existing = new Set([
      path.join('/sdk-root', 'platform-tools', 'adb'),
      path.join('/home/me', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    ]);
    const exists = (file: string) => existing.has(file);
    expect(
      resolveAdbPath({
        env: { ANDROID_HOME: '/missing', ANDROID_SDK_ROOT: '/sdk-root' },
        exists,
        platform: 'darwin',
      }),
    ).toBe(path.join('/sdk-root', 'platform-tools', 'adb'));
    expect(resolveAdbPath({ env: {}, exists, platform: 'darwin', home: '/home/me' })).toBe(
      path.join('/home/me', 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    );
  });

  it('knows the Linux and Windows default SDK locations', () => {
    const linux = path.join('/home/me', 'Android', 'Sdk', 'platform-tools', 'adb');
    expect(resolveAdbPath({ env: {}, platform: 'linux', home: '/home/me', exists: (f) => f === linux })).toBe(
      linux,
    );
    const win = path.join('C:/Users/me/AppData/Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
    expect(
      resolveAdbPath({
        env: { LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
        platform: 'win32',
        exists: (f) => f === win,
      }),
    ).toBe(win);
  });

  it('falls back to adb on PATH', () => {
    expect(resolveAdbPath({ env: {}, exists: none, platform: 'linux', home: '/x' })).toBe('adb');
    expect(resolveAdbPath({ env: {}, exists: none, platform: 'win32' })).toBe('adb.exe');
  });
});

describe('execBinary', () => {
  const adbWith = (script: (child: FakeChild) => void) => {
    const adb = new FakeAdb(() => '');
    const children: FakeChild[] = [];
    adb.spawn = () => {
      const child = new FakeChild();
      children.push(child);
      setImmediate(() => script(child));
      return child;
    };
    return { adb, children };
  };

  it('collects stdout as bytes once the process exited and its output ended', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const { adb } = adbWith((child) => {
      child.stdout.write(png.subarray(0, 3));
      child.stdout.write(png.subarray(3));
      child.exit(0);
    });
    await expect(
      execBinary(adb, ['exec-out', 'screencap', '-p'], { timeoutMs: 1000, maxBytes: 100 }),
    ).resolves.toEqual(png);
  });

  it('kills the process and rejects when aborted', async () => {
    const { adb, children } = adbWith(() => undefined);
    const controller = new AbortController();
    const running = execBinary(adb, ['push', 'x', 'y'], {
      timeoutMs: 1000,
      maxBytes: 4,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(children[0]?.killed).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      execBinary(adb, ['x'], { timeoutMs: 1000, maxBytes: 4, signal: aborted.signal }),
    ).rejects.toThrow('aborted');
  });

  it('rejects on a failed exit (with stderr), too much output, a timeout and a spawn error', async () => {
    const options = { timeoutMs: 1000, maxBytes: 4 };
    await expect(
      execBinary(
        adbWith((child) => (child.stderr.write('device offline\n'), child.exit(1))).adb,
        ['x'],
        options,
      ),
    ).rejects.toThrow('adb x failed: device offline');
    await expect(execBinary(adbWith((child) => child.exit(2)).adb, ['x'], options)).rejects.toThrow(
      'exit code 2',
    );
    const big = adbWith((child) => child.stdout.write(Buffer.alloc(5)));
    await expect(execBinary(big.adb, ['x'], options)).rejects.toThrow('output over 4 bytes');
    expect(big.children[0]?.killed).toBe(true);
    await expect(
      execBinary(adbWith(() => undefined).adb, ['x'], { ...options, timeoutMs: 20 }),
    ).rejects.toThrow('timed out');
    await expect(
      execBinary(adbWith((child) => child.emit('error', new Error('spawn ENOENT'))).adb, ['x'], options),
    ).rejects.toThrow('spawn ENOENT');
  });
});

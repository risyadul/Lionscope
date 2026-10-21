import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkRootCandidates } from '../src/adb/resolveAdb.ts';
import {
  AVD_LIST_TTL_MS,
  AvdCatalog,
  avdHomeDirectory,
  bootArguments,
  FIRST_CONSOLE_PORT,
  FIRST_GRPC_PORT,
  LAST_CONSOLE_PORT,
  LAST_GRPC_PORT,
  parseAvdList,
  pickConsolePort,
  pickGrpcPort,
  readAvdDisplayName,
} from '../src/emulator/avds.ts';
import {
  discoveryDirectories,
  isProcessAlive,
  parseDiscoveryFile,
  readRunningEmulators,
  Secret,
} from '../src/emulator/discovery.ts';
import { parseIni } from '../src/emulator/ini.ts';
import { MAX_SMALL_FILE_BYTES } from '../src/emulator/safeFile.ts';
import { gpuModeOf, rendererFromCmdline, rendererFromSurfaceFlinger } from '../src/emulator/renderer.ts';
import { PROTO_RELATIVE_PATH, resolveEmulatorToolchain } from '../src/emulator/toolchain.ts';

const TOKEN = 'c2VjcmV0LXRva2Vu';

/** As written by emulator 36.6 on macOS (paths shortened). */
function discoveryText(overrides: Record<string, string | null> = {}, eol = '\n'): string {
  const values: Record<string, string | null> = {
    'emulator.build': '15507667',
    'avd.id': 'Pixel_9a',
    'port.serial': '5554',
    'port.adb': '5555',
    'avd.name': 'Pixel 9a',
    'grpc.port': '8554',
    'grpc.token': TOKEN,
    'emulator.version': '36.6.11.0',
    'avd.dir': '/home/me/.android/avd/Pixel_9a.avd',
    cmdline:
      '"/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless" "-avd" "Pixel_9a" "-no-window" "-gpu" "host"',
    ...overrides,
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(eol);
}

describe('parseIni', () => {
  it('splits on the first =, trims, skips comments and lines without a key', () => {
    const values = parseIni('a=1\r\n# c=2\n=3\nnoequals\n b = x=y \nempty=\na=4');
    expect([...values]).toEqual([
      ['a', '4'],
      ['b', 'x=y'],
      ['empty', ''],
    ]);
  });
});

describe('emulator discovery', () => {
  it('parses a discovery file into serial, AVD, display name and gRPC endpoint', () => {
    const emulator = parseDiscoveryFile(discoveryText(), 39793);
    expect(emulator).toMatchObject({
      pid: 39793,
      serial: 'emulator-5554',
      avdName: 'Pixel_9a',
      displayName: 'Pixel 9a',
      grpc: { port: 8554 },
    });
    expect(emulator?.grpc?.token.reveal()).toBe(TOKEN);
    expect(emulator?.cmdline).toContain('"-gpu" "host"');
  });

  it('reads CRLF files', () => {
    expect(parseDiscoveryFile(discoveryText({}, '\r\n'), 1)?.grpc?.token.reveal()).toBe(TOKEN);
  });

  it('has no endpoint without a token or a valid gRPC port', () => {
    expect(parseDiscoveryFile(discoveryText({ 'grpc.token': null }), 1)?.grpc).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'grpc.token': '' }), 1)?.grpc).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'grpc.port': null }), 1)?.grpc).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'grpc.port': '70000' }), 1)?.grpc).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'grpc.port': '0' }), 1)?.grpc).toBeNull();
  });

  it('skips files without a console port or a usable AVD id', () => {
    expect(parseDiscoveryFile(discoveryText({ 'port.serial': null }), 1)).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'port.serial': '55a4' }), 1)).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'avd.id': null }), 1)).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'avd.id': 'Pixel 9a' }), 1)).toBeNull();
    expect(parseDiscoveryFile(discoveryText({ 'avd.name': null, cmdline: null }), 1)).toMatchObject({
      displayName: null,
      cmdline: '',
    });
  });

  it('never shows the token when a record is logged, inspected or serialized', () => {
    const emulator = parseDiscoveryFile(discoveryText(), 1);
    for (const shown of [
      JSON.stringify(emulator),
      inspect(emulator, { depth: 5 }),
      String(emulator?.grpc?.token),
    ]) {
      expect(shown).not.toContain(TOKEN);
    }
    expect(inspect(new Secret(TOKEN))).toBe('Secret([redacted])');
  });

  it('knows the discovery directory of each platform', () => {
    expect(discoveryDirectories({ platform: 'darwin', env: {}, home: '/Users/me' })).toEqual([
      '/Users/me/Library/Caches/TemporaryItems/avd/running',
      '/Users/me/.android/avd/running',
    ]);
    expect(
      discoveryDirectories({
        platform: 'linux',
        env: {
          XDG_RUNTIME_DIR: '/xdg',
          USER: 'me',
          ANDROID_EMULATOR_HOME: '/emu',
          ANDROID_SDK_HOME: '/sdkhome',
        },
        home: '/home/me',
        uid: 7,
        tmpDir: '/tmp',
      }),
    ).toEqual([
      '/xdg/avd/running',
      '/run/user/7/avd/running',
      '/home/me/.android/avd/running',
      '/tmp/android-me/avd/running',
      '/emu/avd/running',
      '/sdkhome/.android/avd/running',
    ]);
    expect(
      discoveryDirectories({
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: '/run/user/7', ANDROID_AVD_HOME: '/avds' },
        home: '/h',
        uid: 7,
      }),
    ).toEqual(['/run/user/7/avd/running', '/h/.android/avd/running', '/avds/avd/running']);
    expect(
      discoveryDirectories({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        home: 'C:\\Users\\me',
      }),
    ).toEqual(['C:\\Users\\me\\AppData\\Local\\Temp\\avd\\running', 'C:\\Users\\me\\.android\\avd\\running']);
    expect(discoveryDirectories({ platform: 'win32', env: {}, home: 'C:\\h' })).toEqual([
      'C:\\h\\.android\\avd\\running',
    ]);
  });

  describe('readRunningEmulators', () => {
    let dir: string;
    let other: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'lionscope-avd-running-'));
      other = mkdtempSync(path.join(tmpdir(), 'lionscope-avd-running-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    });

    it('lists live emulators and skips stale, foreign, incomplete and duplicate files', async () => {
      writeFileSync(path.join(dir, 'pid_100.ini'), discoveryText());
      writeFileSync(path.join(dir, 'pid_200.ini'), discoveryText({ 'avd.id': 'Old', 'port.serial': '5556' }));
      writeFileSync(path.join(dir, 'pid_300.ini'), 'port.serial=5558\n');
      writeFileSync(path.join(dir, 'notes.txt'), discoveryText());
      writeFileSync(path.join(dir, 'pid_0.ini'), discoveryText());
      mkdirSync(path.join(dir, 'pid_400.ini'));
      mkdirSync(path.join(dir, '100'));
      writeFileSync(path.join(other, 'pid_100.ini'), discoveryText({ 'avd.id': 'Duplicate' }));
      const alive = new Set([0, 100, 300, 400]);

      const running = await readRunningEmulators([dir, other, path.join(dir, 'missing')], {
        isAlive: (pid) => alive.has(pid),
      });
      expect(running.map((emulator) => [emulator.pid, emulator.avdName])).toEqual([[100, 'Pixel_9a']]);
    });

    const everyoneAlive = { isAlive: () => true };

    it('reads only small regular files: no symlink, FIFO, device or oversized file', async () => {
      writeFileSync(path.join(other, 'target.ini'), discoveryText());
      symlinkSync(path.join(other, 'target.ini'), path.join(dir, 'pid_1.ini'));
      symlinkSync('/dev/zero', path.join(dir, 'pid_2.ini'));
      execFileSync('mkfifo', [path.join(dir, 'pid_3.ini')]);
      writeFileSync(path.join(dir, 'pid_4.ini'), `${discoveryText()}\n#${'x'.repeat(MAX_SMALL_FILE_BYTES)}`);
      writeFileSync(path.join(dir, 'pid_5.ini'), discoveryText({ 'avd.id': 'Fine' }));
      // Would hang on the FIFO or run out of memory on /dev/zero if they were opened as plain files.
      const running = await readRunningEmulators([dir], everyoneAlive);
      expect(running.map((emulator) => emulator.avdName)).toEqual(['Fine']);
    });

    it('skips files of another user, and directories others can write to or that are symlinks', async () => {
      writeFileSync(path.join(dir, 'pid_5.ini'), discoveryText());
      const me = process.getuid?.() ?? 0;
      expect(await readRunningEmulators([dir], { ...everyoneAlive, owner: me + 1 })).toEqual([]);
      expect(await readRunningEmulators([dir], { ...everyoneAlive, owner: me })).toHaveLength(1);

      const unsafe: string[] = [];
      chmodSync(dir, 0o777);
      const linked = path.join(other, 'linked');
      symlinkSync(dir, linked);
      expect(
        await readRunningEmulators([dir, linked], {
          ...everyoneAlive,
          onUnsafeDirectory: (d) => unsafe.push(d),
        }),
      ).toEqual([]);
      expect(unsafe).toEqual([dir, linked]);
      chmodSync(dir, 0o700);
    });
  });

  it('tells live processes from gone ones; a pid of another user is not ours except on Windows', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 30)).toBe(false);
    const eperm = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    try {
      expect(isProcessAlive(1, 'linux')).toBe(false);
      expect(isProcessAlive(1, 'darwin')).toBe(false);
      expect(isProcessAlive(1, 'win32')).toBe(true);
    } finally {
      eperm.mockRestore();
    }
  });
});

describe('AVDs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lionscope-avd-home-'));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds the AVD home like the emulator does', () => {
    expect(
      avdHomeDirectory({ env: { ANDROID_AVD_HOME: '/avds', ANDROID_USER_HOME: '/u' }, home: '/h' }),
    ).toBe('/avds');
    expect(
      avdHomeDirectory({ env: { ANDROID_EMULATOR_HOME: '/e', ANDROID_USER_HOME: '/u' }, home: '/h' }),
    ).toBe(path.join('/e', 'avd'));
    expect(avdHomeDirectory({ env: { ANDROID_USER_HOME: ' /u ' }, home: '/h' })).toBe(path.join('/u', 'avd'));
    expect(avdHomeDirectory({ env: { ANDROID_AVD_HOME: ' ' }, home: '/h' })).toBe(
      path.join('/h', '.android', 'avd'),
    );
  });

  it('parses `emulator -list-avds`, dropping log lines and unsafe names', () => {
    const output =
      'INFO    | Storing crashdata in: /tmp/x\nPixel_9a\r\nMedium_Phone_API_36.1\n\n-evil\nPixel_9a\n';
    expect(parseAvdList(output)).toEqual(['Pixel_9a', 'Medium_Phone_API_36.1']);
  });

  it('reads the display name through the .ini pointer, else from <name>.avd', async () => {
    const elsewhere = path.join(home, 'elsewhere', 'Pixel_9a.avd');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(home, 'Pixel_9a.ini'), `avd.ini.encoding=UTF-8\npath=${elsewhere}\n`);
    writeFileSync(
      path.join(elsewhere, 'config.ini'),
      'avd.ini.displayname=Pixel 9a\r\nhw.lcd.width=1080\r\n',
    );
    mkdirSync(path.join(home, 'Tablet.avd'));
    writeFileSync(path.join(home, 'Tablet.avd', 'config.ini'), 'avd.ini.displayname=Big Tablet\n');
    mkdirSync(path.join(home, 'Bare.avd'));
    writeFileSync(path.join(home, 'Bare.avd', 'config.ini'), 'avd.ini.displayname=\n');

    expect(await readAvdDisplayName(home, 'Pixel_9a')).toBe('Pixel 9a');
    expect(await readAvdDisplayName(home, 'Tablet')).toBe('Big Tablet');
    expect(await readAvdDisplayName(home, 'Bare')).toBeNull();
    expect(await readAvdDisplayName(home, 'Missing')).toBeNull();
  });

  it('does not read an AVD config that is a FIFO, a device or too large', async () => {
    mkdirSync(path.join(home, 'Fifo.avd'));
    execFileSync('mkfifo', [path.join(home, 'Fifo.avd', 'config.ini')]);
    mkdirSync(path.join(home, 'Zero.avd'));
    symlinkSync('/dev/zero', path.join(home, 'Zero.avd', 'config.ini'));
    mkdirSync(path.join(home, 'Big.avd'));
    writeFileSync(
      path.join(home, 'Big.avd', 'config.ini'),
      `avd.ini.displayname=Big\n#${'x'.repeat(MAX_SMALL_FILE_BYTES)}`,
    );
    for (const name of ['Fifo', 'Zero', 'Big']) expect(await readAvdDisplayName(home, name)).toBeNull();
  });

  it('lists AVDs once at a time, reuses the list for the TTL, and keeps it when a listing fails', async () => {
    let now = 0;
    let calls = 0;
    let output: string | Error = 'Pixel_9a\n';
    const catalog = new AvdCatalog(
      {
        emulatorPath: '/sdk/emulator/emulator',
        avdHome: home,
        runEmulator: async () => {
          calls += 1;
          if (output instanceof Error) throw output;
          return output;
        },
      },
      AVD_LIST_TTL_MS,
      () => now,
    );
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(a).toEqual([{ name: 'Pixel_9a', displayName: null }]);
    expect(b).toBe(a);
    expect(calls).toBe(1);
    output = 'Pixel_9a\nTablet\n';
    now = AVD_LIST_TTL_MS - 1;
    expect(await catalog.refresh()).toHaveLength(1);
    now = AVD_LIST_TTL_MS;
    expect(await catalog.refresh()).toHaveLength(2);
    output = new Error('timeout');
    now = 10 * AVD_LIST_TTL_MS;
    expect(catalog.list.map((avd) => avd.name)).toEqual(['Pixel_9a', 'Tablet']);
    expect(await catalog.refresh()).toHaveLength(2);
    expect(
      await new AvdCatalog({ emulatorPath: null, avdHome: home, runEmulator: async () => 'x' }).refresh(),
    ).toEqual([]);
  });

  it('boots headless on the host GPU on a pinned console port; cold boot skips the snapshot', () => {
    expect(bootArguments('Pixel_9a', 'quick', { console: 5556, grpc: 8556 })).toEqual([
      '-avd',
      'Pixel_9a',
      '-port',
      '5556',
      '-grpc',
      '8556',
      '-grpc-use-token',
      '-no-window',
      '-gpu',
      'host',
      '-no-boot-anim',
    ]);
    expect(bootArguments('Pixel_9a', 'cold', { console: 5556, grpc: 8556 })).toEqual([
      ...bootArguments('Pixel_9a', 'quick', { console: 5556, grpc: 8556 }),
      '-no-snapshot-load',
    ]);
  });

  it('always gives -grpc together with -grpc-use-token (alone it would listen without auth)', () => {
    for (const mode of ['quick', 'cold'] as const) {
      const args = bootArguments('Pixel_9a', mode, { console: 5600, grpc: 8700 });
      const grpc = args.indexOf('-grpc');
      expect(args.slice(grpc, grpc + 3)).toEqual(['-grpc', '8700', '-grpc-use-token']);
      expect(args.filter((arg) => arg.startsWith('-grpc'))).toEqual(['-grpc', '-grpc-use-token']);
    }
  });

  it('picks the gRPC port: console port + 3000 if free, else the first free one in range', async () => {
    const free = (busy: number[]) => async (port: number) => !busy.includes(port);
    expect(await pickGrpcPort(5556, new Set(), free([]))).toBe(8556);
    expect(await pickGrpcPort(5556, new Set([8556]), free([]))).toBe(8554);
    expect(await pickGrpcPort(5556, new Set(), free([8556, 8554, 8555]))).toBe(8557);
    const busy = Array.from({ length: LAST_GRPC_PORT - FIRST_GRPC_PORT + 1 }, (_, i) => FIRST_GRPC_PORT + i);
    expect(await pickGrpcPort(5556, new Set(), free(busy))).toBeNull();
  });

  it('picks the first even console port that is unused and free with its adb port', async () => {
    const free = (busy: number[]) => async (port: number) => !busy.includes(port);
    expect(await pickConsolePort(new Set(), free([]))).toBe(FIRST_CONSOLE_PORT);
    expect(await pickConsolePort(new Set([5554]), free([]))).toBe(5556);
    expect(await pickConsolePort(new Set([5557]), free([]))).toBe(5554);
    expect(await pickConsolePort(new Set([5554]), free([5557, 5558]))).toBe(5560);
    const all = new Set(Array.from({ length: 65 }, (_, i) => FIRST_CONSOLE_PORT + i * 2));
    expect(LAST_CONSOLE_PORT).toBe(5682);
    expect(await pickConsolePort(all, free([]))).toBeNull();
  });
});

describe('resolveEmulatorToolchain', () => {
  const files = (...present: string[]) => {
    const set = new Set(present);
    return (file: string) => set.has(file);
  };

  it('uses the SDK of the adb in use first', () => {
    const exists = files(
      path.join('/sdk-a', 'emulator', 'emulator'),
      path.join('/sdk-a', PROTO_RELATIVE_PATH),
      path.join('/sdk-b', 'emulator', 'emulator'),
    );
    expect(
      resolveEmulatorToolchain(path.join('/sdk-a', 'platform-tools', 'adb'), {
        env: { ANDROID_HOME: '/sdk-b' },
        exists,
      }),
    ).toEqual({
      sdkRoot: '/sdk-a',
      emulatorPath: path.join('/sdk-a', 'emulator', 'emulator'),
      protoPath: path.join('/sdk-a', PROTO_RELATIVE_PATH),
    });
  });

  it('falls back to the usual SDK locations, and reports a missing proto', () => {
    const exists = files(path.join('/home/me', 'Library', 'Android', 'sdk', 'emulator', 'emulator'));
    expect(
      resolveEmulatorToolchain('adb', { env: {}, platform: 'darwin', home: '/home/me', exists }),
    ).toEqual({
      sdkRoot: path.join('/home/me', 'Library', 'Android', 'sdk'),
      emulatorPath: path.join('/home/me', 'Library', 'Android', 'sdk', 'emulator', 'emulator'),
      protoPath: null,
    });
    const windows = files(path.join('C:/Local', 'Android', 'Sdk', 'emulator', 'emulator.exe'));
    expect(
      resolveEmulatorToolchain('adb.exe', {
        env: { LOCALAPPDATA: 'C:/Local' },
        platform: 'win32',
        exists: windows,
      })?.emulatorPath,
    ).toBe(path.join('C:/Local', 'Android', 'Sdk', 'emulator', 'emulator.exe'));
  });

  it('is null without an installed emulator', () => {
    expect(
      resolveEmulatorToolchain('/sdk/platform-tools/adb', {
        env: {},
        platform: 'linux',
        exists: () => false,
      }),
    ).toBeNull();
    expect(sdkRootCandidates({ env: { ANDROID_SDK_ROOT: ' /r ' }, platform: 'linux', home: '/h' })).toEqual([
      '/r',
      path.join('/h', 'Android', 'Sdk'),
    ]);
  });
});

describe('renderer detection', () => {
  it('reads -gpu from the quoted command line', () => {
    expect(gpuModeOf('"/sdk/qemu" "-avd" "Pixel_9a" "-gpu" "Host"')).toBe('host');
    expect(gpuModeOf('/sdk/qemu -avd x -gpu swiftshader_indirect')).toBe('swiftshader_indirect');
    expect(gpuModeOf('"/sdk/qemu" "-avd" "x" "-gpu"')).toBeNull();
    expect(gpuModeOf('')).toBeNull();
  });

  it('flags software rendering from the command line', () => {
    expect(rendererFromCmdline('"q" "-gpu" "swiftshader_indirect"')).toBe('software');
    expect(rendererFromCmdline('"q" "-gpu" "guest"')).toBe('software');
    expect(rendererFromCmdline('"q" "-gpu" "lavapipe"')).toBe('software');
    expect(rendererFromCmdline('"q" "-gpu" "host"')).toBe('unknown');
    expect(rendererFromCmdline('"q" "-no-window"')).toBe('unknown');
  });

  it('reads the GLES line of dumpsys SurfaceFlinger', () => {
    const host =
      '------------RE GLES (Ganesh)------------\nGLES: Google (Apple), Android Emulator OpenGL ES Translator (Apple M4 Pro), OpenGL ES 3.0 (4.1 Metal - 90.5)\n';
    const software =
      'GLES: Google Inc., Android Emulator OpenGL ES Translator (Google SwiftShader), OpenGL ES 3.0 (OpenGL ES 3.0 SwiftShader 4.0.0.1)\n';
    expect(rendererFromSurfaceFlinger(host)).toBe('host');
    expect(rendererFromSurfaceFlinger(`  ${software}`)).toBe('software');
    expect(rendererFromSurfaceFlinger('GLES: Mesa, llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('software');
    expect(rendererFromSurfaceFlinger('Display 0\n')).toBe('unknown');
  });
});

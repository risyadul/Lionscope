import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { isValidAvdName } from '@lionscope/protocol';
import { log } from '../log.ts';
import { parseIni } from './ini.ts';
import { checkPrivateDirectory, readSmallFile } from './safeFile.ts';

/**
 * The emulator's gRPC token. Logging, JSON-encoding or inspecting a discovery record shows `[redacted]`; only
 * the gRPC client calls reveal().
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'Secret([redacted])';
  }
}

export interface GrpcEndpoint {
  port: number;
  token: Secret;
}

/** One running emulator, from its `pid_<pid>.ini` discovery file. */
export interface DiscoveredEmulator {
  pid: number;
  /** `emulator-<port.serial>`. */
  serial: string;
  /** `avd.id`: the AVD id `emulator -list-avds` prints (`Pixel_9a`). */
  avdName: string;
  /** `avd.name`: the display name (`Pixel 9a`). */
  displayName: string | null;
  /** null when the emulator has no gRPC endpoint or no token (`-grpc` without `-grpc-use-token`, too old). */
  grpc: GrpcEndpoint | null;
  /** The emulator's command line as written there (quoted arguments). */
  cmdline: string;
}

export interface DiscoveryDirectoryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** `process.getuid()`; undefined on Windows. */
  uid?: number;
  /** `os.tmpdir()`. */
  tmpDir?: string;
}

/**
 * Where emulators write their discovery files (`<dir>/avd/running/pid_<pid>.ini`). Every candidate is scanned and
 * missing ones are skipped, which also covers an emulator started with another environment than the server.
 * Platform directories, as Android Studio looks for them (computeRegistrationDirectoryContainer in
 * https://raw.githubusercontent.com/JetBrains/android/master/streaming/src/com/android/tools/idea/streaming/emulator/RunningEmulatorCatalog.kt):
 * - macOS: `~/Library/Caches/TemporaryItems` (also verified on emulator 36.6).
 * - Windows: `%LOCALAPPDATA%\Temp`.
 * - Linux: `$XDG_RUNTIME_DIR`, `/run/user/<uid>` (both also in the emulator's own Python client, below); Studio
 *   further tries `~/.android` and `<tmp>/android-$USER`.
 * Then the directories the emulator's Python client searches first: `$ANDROID_EMULATOR_HOME`,
 * `$ANDROID_SDK_HOME/.android`, `$ANDROID_AVD_HOME`, `~/.android`
 * (https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/python/aemu-grpc/src/aemu/discovery/emulator_discovery.py).
 */
export function discoveryDirectories(options: DiscoveryDirectoryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const set = (value: string | undefined) => (value?.trim() ? value.trim() : null);
  const containers: string[] = [];
  const add = (...dirs: (string | null)[]) => {
    for (const dir of dirs) if (dir) containers.push(dir);
  };
  if (platform === 'darwin') add(path.join(home, 'Library', 'Caches', 'TemporaryItems'));
  else if (platform === 'win32') {
    const localAppData = set(env.LOCALAPPDATA);
    add(localAppData && path.win32.join(localAppData, 'Temp'));
  } else {
    const uid = options.uid ?? process.getuid?.();
    const user = set(env.USER);
    add(
      set(env.XDG_RUNTIME_DIR),
      uid === undefined ? null : path.join('/run/user', String(uid)),
      path.join(home, '.android'),
      user && path.join(options.tmpDir ?? tmpdir(), `android-${user}`),
    );
  }
  const sdkHome = set(env.ANDROID_SDK_HOME);
  add(
    set(env.ANDROID_EMULATOR_HOME),
    sdkHome && path.join(sdkHome, '.android'),
    set(env.ANDROID_AVD_HOME),
    path.join(home, '.android'),
  );
  const join = platform === 'win32' ? path.win32.join : path.join;
  return [...new Set(containers.map((container) => join(container, 'avd', 'running')))];
}

const PID_FILE = /^pid_(\d{1,10})\.ini$/;
const MAX_PORT = 65535;

function portOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port <= MAX_PORT ? port : null;
}

/** null when the file lacks a console port or a usable AVD id (then it is not an emulator we can name). */
export function parseDiscoveryFile(text: string, pid: number): DiscoveredEmulator | null {
  const values = parseIni(text);
  const consolePort = portOf(values.get('port.serial'));
  const avdName = values.get('avd.id') ?? '';
  if (consolePort === null || !isValidAvdName(avdName)) return null;
  const grpcPort = portOf(values.get('grpc.port'));
  const token = values.get('grpc.token');
  return {
    pid,
    serial: `emulator-${consolePort}`,
    avdName,
    displayName: values.get('avd.name') || null,
    grpc: grpcPort !== null && token ? { port: grpcPort, token: new Secret(token) } : null,
    cmdline: values.get('cmdline') ?? '',
  };
}

/**
 * `kill(pid, 0)`: ESRCH means gone. EPERM means the pid belongs to another user: an emulator of ours never does
 * (a reused pid, or a planted file), so it counts as not alive, except on Windows where EPERM is all it says.
 */
export function isProcessAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export interface ReadDiscoveryOptions {
  isAlive?: (pid: number) => boolean;
  /** POSIX: directories and files must belong to this user (default: the server's uid; undefined on Windows). */
  owner?: number;
  /** Called once per directory that is skipped because another user could write to it. */
  onUnsafeDirectory?: (dir: string) => void;
}

const warnedDirectories = new Set<string>();

function warnUnsafeDirectory(dir: string): void {
  if (warnedDirectories.has(dir)) return;
  warnedDirectories.add(dir);
  log.warn(`Ignoring emulator discovery directory ${dir}: not a private directory of this user`);
}

/**
 * Running emulators found in `dirs`. Discovery files are trusted only from private directories of this user
 * (checkPrivateDirectory) and only as small regular files of this user (readSmallFile). Files of processes that
 * are gone (a crashed emulator leaves its file behind) and unreadable or incomplete files are skipped; a pid
 * seen twice counts once.
 */
export async function readRunningEmulators(
  dirs: readonly string[],
  options: ReadDiscoveryOptions = {},
): Promise<DiscoveredEmulator[]> {
  const isAlive = options.isAlive ?? ((pid: number) => isProcessAlive(pid));
  const owner = 'owner' in options ? options.owner : process.getuid?.();
  const onUnsafe = options.onUnsafeDirectory ?? warnUnsafeDirectory;
  const found = new Map<number, DiscoveredEmulator>();
  for (const dir of dirs) {
    const check = await checkPrivateDirectory(dir, owner);
    if (check === 'unsafe') onUnsafe(dir);
    if (check !== 'ok') continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const pid = Number(PID_FILE.exec(entry)?.[1] ?? NaN);
      if (!Number.isSafeInteger(pid) || pid <= 0 || found.has(pid) || !isAlive(pid)) continue;
      const text = await readSmallFile(path.join(dir, entry), { owner });
      const emulator = text === null ? null : parseDiscoveryFile(text, pid);
      if (emulator) found.set(pid, emulator);
    }
  }
  return [...found.values()];
}

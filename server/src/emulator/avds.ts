import { homedir } from 'node:os';
import path from 'node:path';
import { isValidAvdName } from '@lionscope/protocol';
import type { BootMode } from '@lionscope/protocol';
import { parseIni } from './ini.ts';
import { errorMessage, log } from '../log.ts';
import type { EmulatorHost } from './emulatorHost.ts';
import { readSmallFile } from './safeFile.ts';

export interface AvdHomeOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Where the AVDs live, as the emulator looks them up: $ANDROID_AVD_HOME → $ANDROID_EMULATOR_HOME/avd →
 * $ANDROID_USER_HOME/avd → ~/.android/avd.
 */
export function avdHomeDirectory(options: AvdHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const avdHome = env.ANDROID_AVD_HOME?.trim();
  if (avdHome) return avdHome;
  for (const value of [env.ANDROID_EMULATOR_HOME, env.ANDROID_USER_HOME]) {
    if (value?.trim()) return path.join(value.trim(), 'avd');
  }
  return path.join(options.home ?? homedir(), '.android', 'avd');
}

/**
 * `emulator -list-avds`: one AVD id per line. Anything else the emulator prints there (`INFO | …` lines, blank
 * lines) and names that would not be safe as an argument (AVD_NAME_PATTERN: no leading `-`) are dropped.
 */
export function parseAvdList(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const name = line.trim();
    if (isValidAvdName(name)) names.add(name);
  }
  return [...names];
}

/** Regular files of at most MAX_SMALL_FILE_BYTES only (no FIFO, device or symlink). */
async function readIni(file: string): Promise<Map<string, string> | null> {
  const text = await readSmallFile(file);
  return text === null ? null : parseIni(text);
}

/**
 * `avd.ini.displayname` from the AVD's `config.ini` (`Pixel 9a`). The AVD directory is the `path` in
 * `<avdHome>/<name>.ini`, else `<avdHome>/<name>.avd`.
 */
export async function readAvdDisplayName(avdHome: string, name: string): Promise<string | null> {
  const pointer = await readIni(path.join(avdHome, `${name}.ini`));
  const avdDir = pointer?.get('path') || path.join(avdHome, `${name}.avd`);
  const displayName = (await readIni(path.join(avdDir, 'config.ini')))?.get('avd.ini.displayname');
  return displayName || null;
}

/**
 * Headless boot with the host GPU. `-no-window` alone falls back to SwiftShader (several cores of CPU, jank
 * that has nothing to do with the app), hence `-gpu host`. Quick boot loads and saves the Quick Boot
 * snapshot (the emulator's default); cold boot skips loading it. `-port` pins the console port, and so the adb
 * serial (`emulator-<port>`), which identifies the instance this server booted. With an explicit `-port` the
 * emulator does not start its gRPC endpoint by itself (emulator 36.6, also with -grpc-use-token or
 * -grpc-use-jwt alone), so it is asked for with `-grpc <port> -grpc-use-token`: 127.0.0.1 only, token auth,
 * `grpc.token` in the discovery file (`-grpc-use-jwt` writes no token).
 */
export function bootArguments(
  avdName: string,
  mode: BootMode,
  ports: { console: number; grpc: number },
): string[] {
  const args = [
    '-avd',
    avdName,
    '-port',
    String(ports.console),
    // Never `-grpc` without `-grpc-use-token`: alone it listens on [::] without any auth (emulator 36.6).
    '-grpc',
    String(ports.grpc),
    '-grpc-use-token',
    '-no-window',
    '-gpu',
    'host',
    '-no-boot-anim',
  ];
  return mode === 'cold' ? [...args, '-no-snapshot-load'] : args;
}

/** The emulator's console ports: even, 5554-5682 (adb uses the port above each). */
export const FIRST_CONSOLE_PORT = 5554;
export const LAST_CONSOLE_PORT = 5682;
/** Preferred gRPC port = console port + 3000, like the emulator's own default (8554 for 5554)… */
export const GRPC_PORT_OFFSET = 3000;
/** …else the first free port from here on. */
export const FIRST_GRPC_PORT = 8554;
export const LAST_GRPC_PORT = 8999;

/** The first console port that nothing uses (neither it nor its adb port), or null. */
export async function pickConsolePort(
  used: ReadonlySet<number>,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let port = FIRST_CONSOLE_PORT; port <= LAST_CONSOLE_PORT; port += 2) {
    if (used.has(port) || used.has(port + 1)) continue;
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port;
  }
  return null;
}

/** The gRPC port for `consolePort`: console port + 3000 if free, else the first free one in 8554-8999, or null. */
export async function pickGrpcPort(
  consolePort: number,
  used: ReadonlySet<number>,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<number | null> {
  const candidates = [consolePort + GRPC_PORT_OFFSET];
  for (let port = FIRST_GRPC_PORT; port <= LAST_GRPC_PORT; port += 1) candidates.push(port);
  for (const port of candidates) {
    if (!used.has(port) && (await isPortFree(port))) return port;
  }
  return null;
}

export interface Avd {
  name: string;
  displayName: string | null;
}

/** `-list-avds` is reused for this long: the dashboard may ask on every refresh. */
export const AVD_LIST_TTL_MS = 2000;

/**
 * The AVDs `emulator -list-avds` names, with their display names. One listing at a time (concurrent callers
 * share it), reused for `ttlMs`; a failed listing keeps the last list.
 */
export class AvdCatalog {
  private avds: Avd[] = [];
  private listedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<Avd[]> | null = null;

  constructor(
    private readonly host: Pick<EmulatorHost, 'emulatorPath' | 'runEmulator' | 'avdHome'>,
    private readonly ttlMs = AVD_LIST_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get list(): readonly Avd[] {
    return this.avds;
  }

  refresh(): Promise<Avd[]> {
    if (!this.host.emulatorPath || this.now() - this.listedAt < this.ttlMs) return Promise.resolve(this.avds);
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<Avd[]> {
    let names: string[];
    try {
      names = parseAvdList(await this.host.runEmulator(['-list-avds']));
    } catch (error) {
      log.warn(`emulator -list-avds failed: ${errorMessage(error)}`);
      return this.avds;
    }
    this.avds = await Promise.all(
      names.map(async (name) => ({ name, displayName: await readAvdDisplayName(this.host.avdHome, name) })),
    );
    this.listedAt = this.now();
    return this.avds;
  }
}

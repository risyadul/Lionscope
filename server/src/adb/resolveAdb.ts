import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ResolveAdbOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (file: string) => boolean;
}

/** SDK roots to try, in order: $ANDROID_HOME → $ANDROID_SDK_ROOT → the default SDK location for the platform. */
export function sdkRootCandidates(options: Omit<ResolveAdbOptions, 'exists'> = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const sdkRoots: string[] = [];
  for (const value of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (value?.trim()) sdkRoots.push(value.trim());
  }
  if (platform === 'darwin') sdkRoots.push(path.join(home, 'Library', 'Android', 'sdk'));
  if (platform === 'linux') sdkRoots.push(path.join(home, 'Android', 'Sdk'));
  if (platform === 'win32' && env.LOCALAPPDATA) sdkRoots.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  return sdkRoots;
}

/**
 * Locate the adb binary: LIONSCOPE_ADB → the SDK roots of sdkRootCandidates → plain `adb` (resolved from PATH by
 * execFile/spawn).
 */
export function resolveAdbPath(options: ResolveAdbOptions = {}): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const binary = (options.platform ?? process.platform) === 'win32' ? 'adb.exe' : 'adb';

  const explicit = env.LIONSCOPE_ADB?.trim();
  if (explicit) return explicit;

  for (const root of sdkRootCandidates(options)) {
    const candidate = path.join(root, 'platform-tools', binary);
    if (exists(candidate)) return candidate;
  }
  return binary;
}

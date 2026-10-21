import { existsSync } from 'node:fs';
import path from 'node:path';
import { sdkRootCandidates } from '../adb/resolveAdb.ts';
import type { ResolveAdbOptions } from '../adb/resolveAdb.ts';

/** The emulator pieces of the Android SDK the server uses. */
export interface EmulatorToolchain {
  sdkRoot: string;
  /** `<sdk>/emulator/emulator`: lists and boots AVDs. */
  emulatorPath: string;
  /** `<sdk>/emulator/lib/emulator_controller.proto`; null on emulators too old to ship it (no mirroring). */
  protoPath: string | null;
}

export const PROTO_RELATIVE_PATH = path.join('emulator', 'lib', 'emulator_controller.proto');

/**
 * The SDK of the adb in use (`<sdk>/platform-tools/adb`), else the first of sdkRootCandidates, that has the
 * emulator installed; null when none has. adb from PATH says nothing about the SDK, so it falls through to the
 * usual locations.
 */
export function resolveEmulatorToolchain(
  adbPath: string,
  options: ResolveAdbOptions = {},
): EmulatorToolchain | null {
  const exists = options.exists ?? existsSync;
  const binary = (options.platform ?? process.platform) === 'win32' ? 'emulator.exe' : 'emulator';
  const roots: string[] = [];
  const adbDir = path.dirname(adbPath);
  if (path.basename(adbDir) === 'platform-tools') roots.push(path.dirname(adbDir));
  roots.push(...sdkRootCandidates(options));

  for (const sdkRoot of roots) {
    const emulatorPath = path.join(sdkRoot, 'emulator', binary);
    if (!exists(emulatorPath)) continue;
    const protoPath = path.join(sdkRoot, PROTO_RELATIVE_PATH);
    return { sdkRoot, emulatorPath, protoPath: exists(protoPath) ? protoPath : null };
  }
  return null;
}

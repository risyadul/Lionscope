/**
 * App setup tools for deterministic E2E reproduction and verification:
 * - `open_deep_link`: launch a validated VIEW intent URI
 * - `list_app_permissions` / `set_app_permissions`: read and grant/revoke runtime permissions
 * - `clear_app_data`: `pm clear` restricted to the session's target device and third-party package
 * - `install_apk`: `adb install -r [-g]` from a validated, symlink-rejected, descriptor-copied host `.apk` snapshot
 */
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { redactLogText, redactUrl } from '@lionscope/protocol/insights';
import { adbShellArgs } from '../adb/adb.ts';
import { errorMessage, log } from '../log.ts';
import { parsePackageList } from '../parsers/packages.ts';
import { INPUT, optionalSerial, targetSerial } from './deviceTools.ts';
import { packageInput } from './sessionTools.ts';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { invalidateUi } from './uiDump.ts';
import { truncate } from './views.ts';

const LAUNCH_TIMEOUT_MS = 30_000;
const PM_TIMEOUT_MS = 15_000;
const DUMPSYS_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 90_000;
const MAX_URI_CHARS = 2048;
const MAX_PERMISSION_CHARS = 200;
const MAX_PERMISSIONS_PER_CALL = 50;
const MAX_APK_PATH_CHARS = 4096;
/** Maximum host APK snapshot size staged to tmpdir (512 MiB). */
export const MAX_APK_SNAPSHOT_BYTES = 512 * 1024 * 1024;

/** RFC 3986 scheme followed by `:`, with no control characters or whitespace. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\x00-\x1f\x7f\s]/;

/** Android permission name: at least two dot-separated identifier segments (e.g. `android.permission.CAMERA`). */
export const PERMISSION_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function isValidDeepLinkUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > MAX_URI_CHARS) return false;
  if (CONTROL_OR_SPACE.test(uri) || !URI_SCHEME.test(uri)) return false;
  try {
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

export function isValidPermissionName(name: string): boolean {
  return name.length <= MAX_PERMISSION_CHARS && PERMISSION_NAME.test(name);
}

export const deepLinkUriInput = z
  .string()
  .min(1)
  .max(MAX_URI_CHARS)
  .refine(isValidDeepLinkUri, 'must be a valid URI with a scheme and no whitespace or control characters')
  .describe('Deep link URI with a scheme, e.g. myapp://detail/42 or https://example.com/item?id=1.');

export const permissionInput = z
  .string()
  .min(1)
  .max(MAX_PERMISSION_CHARS)
  .refine(isValidPermissionName, 'not a valid Android permission name (e.g. android.permission.CAMERA)');

/**
 * Resolves BOTH serial and package from one session snapshot and rejects any serial or package mismatch before any
 * ADB command runs. Used by mutating and privacy-sensitive tools scoped to the profiled app (`clear_app_data`,
 * `set_app_permissions`, `get_notifications`).
 */
export function requireSessionTarget(
  ctx: AgentContext,
  requested: { serial?: string | undefined; packageName?: string | undefined },
): { serial: string; packageName: string } {
  const session = ctx.sessions.getSessionState();
  if (!session.serial || !session.packageName) {
    throw new ToolError(
      'No target package is selected: call start_session first so Lionscope knows which device and app are in scope',
    );
  }
  if (requested.serial !== undefined && requested.serial !== session.serial) {
    throw new ToolError(
      `Only the session target device (${session.serial}) is allowed, not ${requested.serial}: call start_session on ${requested.serial} first`,
    );
  }
  if (requested.packageName !== undefined && requested.packageName !== session.packageName) {
    throw new ToolError(
      `Only the session target package (${session.packageName}) is allowed, not ${requested.packageName}: call start_session for ${requested.packageName} first`,
    );
  }
  const serial = targetSerial(ctx, session.serial);
  return { serial, packageName: session.packageName };
}

export interface AmStartResult {
  activity: string | null;
  status: string | null;
  launchState: string | null;
  launchMs: number | null;
  warning: string | null;
  error: string | null;
}

/** Parses `am start -W` stdout across Android API levels (23–36). */
export function parseAmStartOutput(output: string): AmStartResult {
  const errorMatch = /^(?:Error|Exception)[^\r\n]*/m.exec(output);
  const warningMatch = /^Warning:\s*([^\r\n]+)/m.exec(output);
  const activityLine = /^Activity:\s*(\S+)/m.exec(output)?.[1];
  const cmpMatch = /\bcmp=([A-Za-z][\w.]*\/[\w.$]+)/.exec(output)?.[1];
  const status = /^Status:\s*([^\r\n]+)/m.exec(output)?.[1]?.trim() ?? null;
  const launchState = /^LaunchState:\s*([^\r\n]+)/m.exec(output)?.[1]?.trim() ?? null;
  const totalTime = /^TotalTime:\s*(\d+)/m.exec(output)?.[1];
  return {
    activity: activityLine ?? cmpMatch ?? null,
    status,
    launchState,
    launchMs: totalTime === undefined ? null : Number(totalTime),
    warning: warningMatch?.[1]?.trim() ?? null,
    error: errorMatch?.[0]?.trim() ?? null,
  };
}

export interface AppPermissionEntry {
  name: string;
  granted: boolean | null;
  kind: 'runtime' | 'install' | 'requested';
  flags: string[];
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count++;
  return count;
}

/**
 * Parses `dumpsys package <packageName>` permissions across API 23–36:
 * - `requested permissions:` (all manifest-declared permissions)
 * - `install permissions:` (normal/signature permissions granted at install)
 * - `runtime permissions:` under `User 0:` (or first user section)
 * Returns null if the package section is missing (package not installed).
 */
export function parsePackagePermissions(output: string, packageName: string): AppPermissionEntry[] | null {
  const lines = output.split(/\r?\n/);
  const packageHeader = `Package [${packageName}]`;
  const pkgIndex = lines.findIndex((line) => line.trimStart().startsWith(packageHeader));
  if (pkgIndex === -1) return null;

  const entries = new Map<string, AppPermissionEntry>();
  let section: 'requested' | 'install' | 'runtime' | null = null;
  let sectionIndent = -1;
  let inOtherUser = false;
  let userIndent = -1;

  for (let i = pkgIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = leadingSpaces(line);

    // Next package block starts at the same or lesser indentation as `Package [...]`.
    if (trimmed.startsWith('Package [') && !trimmed.startsWith(packageHeader)) break;

    const userMatch = /^User (\d+):/.exec(trimmed);
    if (userMatch) {
      inOtherUser = userMatch[1] !== '0';
      userIndent = indent;
      section = null;
      sectionIndent = -1;
      continue;
    }
    if (inOtherUser && indent <= userIndent) {
      inOtherUser = false;
      userIndent = -1;
    }
    if (inOtherUser) continue;

    if (trimmed === 'requested permissions:') {
      section = 'requested';
      sectionIndent = indent;
      continue;
    }
    if (trimmed === 'install permissions:') {
      section = 'install';
      sectionIndent = indent;
      continue;
    }
    if (trimmed === 'runtime permissions:') {
      section = 'runtime';
      sectionIndent = indent;
      continue;
    }

    if (section !== null && indent <= sectionIndent) {
      section = null;
      sectionIndent = -1;
    }
    if (section === null) continue;

    const permMatch = /^([A-Za-z][A-Za-z0-9_.]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?::\s*(.*))?$/.exec(trimmed);
    if (!permMatch?.[1]) continue;
    const name = permMatch[1];
    const details = permMatch[2] ?? '';
    const grantedMatch = /\bgranted=(true|false)\b/.exec(details);
    const flagsMatch = /\bflags=\[\s*([^\]]*?)\s*\]/.exec(details);
    const flags = flagsMatch?.[1]
      ? flagsMatch[1]
          .split(/[|\s,]+/)
          .map((flag) => flag.trim())
          .filter(Boolean)
      : [];

    const existing = entries.get(name);
    if (section === 'requested') {
      if (!existing) entries.set(name, { name, granted: null, kind: 'requested', flags: [] });
    } else if (section === 'install') {
      entries.set(name, {
        name,
        granted: grantedMatch ? grantedMatch[1] === 'true' : true,
        kind: 'install',
        flags,
      });
    } else {
      entries.set(name, {
        name,
        granted: grantedMatch ? grantedMatch[1] === 'true' : false,
        kind: 'runtime',
        flags,
      });
    }
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parses `pm list permissions -d -g` output into the set of Android dangerous (runtime) permission names.
 * Requires an explicit `Dangerous Permissions:` section heading and stops parsing at any subsequent top-level
 * protection-class heading (such as `All Permissions:`, `Normal Permissions:`, or `Signature Permissions:`),
 * rejecting unfiltered catalogs. Returns null if the section is missing or empty so preflight fails clearly.
 */
export function parseDangerousPermissions(output: string): Set<string> | null {
  const result = new Set<string>();
  let inDangerous = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const isUnindented = line.length > 0 && line[0] !== ' ' && line[0] !== '\t';
    if (!inDangerous) {
      if (isUnindented && /^Dangerous Permissions:\s*$/i.test(trimmed)) {
        inDangerous = true;
      }
      continue;
    }
    // Stop at the next top-level protection-class heading (e.g. `All Permissions:`, `Normal Permissions:`),
    // while keeping `+ group:…` and `ungrouped:` entries inside `Dangerous Permissions:`.
    if (isUnindented && /^[A-Za-z][A-Za-z0-9 _-]*:\s*$/.test(trimmed) && !/^ungrouped:\s*$/i.test(trimmed)) {
      break;
    }
    const match = /^permission:([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/.exec(trimmed);
    if (match?.[1]) result.add(match[1]);
  }
  return result.size > 0 ? result : null;
}

/**
 * Removes any verbatim/encoded occurrence of the launched deep-link URI and any Intent `dat=…` value before
 * applying generic credential redaction, so opaque path tokens never leak in `am start` error text.
 */
function sanitizeDeepLinkText(text: string, uri: string): string {
  let scrubbed = text.replaceAll(uri, '<redacted>');
  const withoutQuery = uri.split(/[?#]/)[0];
  if (withoutQuery && withoutQuery.length > 0 && withoutQuery !== uri) {
    scrubbed = scrubbed.replaceAll(withoutQuery, '<redacted>');
  }
  try {
    const encoded = encodeURI(uri);
    if (encoded !== uri) scrubbed = scrubbed.replaceAll(encoded, '<redacted>');
  } catch {
    // Ignore malformed URI encoding edge cases.
  }
  scrubbed = scrubbed.replace(/\bdat=[^\s}]+/g, 'dat=<redacted>');
  return redactLogText(scrubbed);
}

/** Detects failure lines in `pm grant` / `pm revoke` output (some Android versions exit 0 on error). */
export function parsePmPermissionError(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === '') return null;
  if (
    /^(?:Operation not allowed|Exception|SecurityException|Error|Bad argument|Unknown permission)/im.test(
      trimmed,
    )
  ) {
    return trimmed.split(/\r?\n/)[0]?.slice(0, 200) ?? trimmed.slice(0, 200);
  }
  return null;
}

export const openDeepLinkTool = defineTool({
  name: 'open_deep_link',
  title: 'Open a deep link',
  description: `Launches a validated deep link URI on the device (\`am start -W -a android.intent.action.VIEW -d <uri> [package]\`) and waits until the target activity has drawn. Validates the URI scheme and rejects whitespace and control characters; passes all adb arguments as arrays without host shell interpolation. Optionally pass packageName to restrict intent resolution to one app. Returns the resolved activity, status, and Android launch time (ms). Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    uri: deepLinkUriInput,
    packageName: packageInput.optional().describe('Optional package to restrict intent resolution to.'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ uri, packageName, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const args = [
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      uri,
      ...(packageName ? [packageName] : []),
    ];
    try {
      const output = await adbShellArgs(ctx.adb, serial, args, {
        timeoutMs: LAUNCH_TIMEOUT_MS,
        signal: ctx.signal,
        redactValues: [uri],
      });
      const parsed = parseAmStartOutput(output);
      if (parsed.error) {
        throw new ToolError(
          `Could not open deep link: ${truncate(sanitizeDeepLinkText(parsed.error, uri), 200)}`,
        );
      }
      return {
        data: {
          untrusted: UNTRUSTED_NOTE,
          serial,
          uri: redactUrl(uri),
          ...(packageName ? { packageName } : {}),
          activity: parsed.activity ? sanitizeDeepLinkText(parsed.activity, uri) : null,
          status: parsed.status ? sanitizeDeepLinkText(parsed.status, uri) : null,
          ...(parsed.launchState ? { launchState: parsed.launchState } : {}),
          launchMs: parsed.launchMs,
          ...(parsed.warning ? { warning: truncate(sanitizeDeepLinkText(parsed.warning, uri), 200) } : {}),
        },
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const sanitized = sanitizeDeepLinkText(errorMessage(error), uri);
      log.warn(`open_deep_link failed on ${serial}: ${sanitized}`);
      throw new ToolError(sanitized);
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

export const listAppPermissionsTool = defineTool({
  name: 'list_app_permissions',
  title: 'List app permissions',
  description:
    "Reads an installed app's requested, install-time, and runtime permissions and their granted state from `dumpsys package <packageName>` (User 0). Defaults to the profiling session's target package when packageName is omitted. Pass runtimeOnly: true to list only runtime-grantable permissions.",
  access: 'read',
  input: z.object({
    packageName: packageInput
      .optional()
      .describe('Application id; default: the profiling session target package.'),
    runtimeOnly: z
      .boolean()
      .default(false)
      .describe('Only return runtime permissions (grantable/revocable with set_app_permissions).'),
    serial: optionalSerial,
  }),
  annotations: READ_ONLY,
  async run({ packageName: requestedPkg, runtimeOnly, serial: requestedSerial }, ctx) {
    const serial = targetSerial(ctx, requestedSerial);
    const packageName = requestedPkg ?? ctx.sessions.getSessionState().packageName;
    if (!packageName) {
      throw new ToolError('Pass packageName, or start_session first so a target package is selected');
    }
    const output = await adbShellArgs(ctx.adb, serial, ['dumpsys', 'package', packageName], {
      timeoutMs: DUMPSYS_TIMEOUT_MS,
    });
    const all = parsePackagePermissions(output, packageName);
    if (all === null) {
      throw new ToolError(`${packageName} is not installed on ${serial}`);
    }
    const permissions = runtimeOnly ? all.filter((entry) => entry.kind === 'runtime') : all;
    return {
      data: {
        serial,
        packageName,
        total: all.length,
        runtimeCount: all.filter((entry) => entry.kind === 'runtime').length,
        grantedCount: permissions.filter((entry) => entry.granted === true).length,
        permissions,
      },
    };
  },
});

export const setAppPermissionsTool = defineTool({
  name: 'set_app_permissions',
  title: 'Set app permissions',
  description:
    "Grants and/or revokes Android runtime (dangerous) permissions (`pm grant` / `pm revoke`, API 23+) for the profiling session's target device and package only. Validates every requested permission against the app's declared permissions (`dumpsys package`) and Android's runtime/dangerous protection class (`pm list permissions -d -g`) before applying the first change. Device control.",
  access: 'device',
  input: z
    .object({
      grant: z
        .array(permissionInput)
        .max(MAX_PERMISSIONS_PER_CALL)
        .default([])
        .describe('Runtime permissions to grant, e.g. ["android.permission.POST_NOTIFICATIONS"].'),
      revoke: z
        .array(permissionInput)
        .max(MAX_PERMISSIONS_PER_CALL)
        .default([])
        .describe('Runtime permissions to revoke.'),
      packageName: packageInput
        .optional()
        .describe('Must match the profiling session target package; default: session target.'),
      serial: optionalSerial.describe(
        'Must match the profiling session target device; default: session device.',
      ),
    })
    .refine((value) => value.grant.length > 0 || value.revoke.length > 0, {
      message: 'pass at least one permission in grant or revoke',
    })
    .refine(
      (value) => {
        const granted = new Set(value.grant);
        return !value.revoke.some((perm) => granted.has(perm));
      },
      { message: 'the same permission cannot be in both grant and revoke' },
    ),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run({ grant, revoke, packageName: requestedPkg, serial: requestedSerial }, ctx) {
    const { serial, packageName } = requireSessionTarget(ctx, {
      serial: requestedSerial,
      packageName: requestedPkg,
    });

    const [pkgDump, dangerousOut] = await Promise.all([
      adbShellArgs(ctx.adb, serial, ['dumpsys', 'package', packageName], {
        timeoutMs: DUMPSYS_TIMEOUT_MS,
      }),
      adbShellArgs(ctx.adb, serial, ['pm', 'list', 'permissions', '-d', '-g'], {
        timeoutMs: PM_TIMEOUT_MS,
      }),
    ]);

    const declared = parsePackagePermissions(pkgDump, packageName);
    if (declared === null) {
      throw new ToolError(`${packageName} is not installed on ${serial}`);
    }
    const byName = new Map(declared.map((entry) => [entry.name, entry]));
    const dangerous = parseDangerousPermissions(dangerousOut);
    if (dangerous === null) {
      throw new ToolError(
        `Could not classify Android runtime permissions on ${serial} via \`pm list permissions -d -g\`; refusing to modify permissions without runtime protection-class verification`,
      );
    }

    const actions: { action: 'grant' | 'revoke'; permission: string }[] = [...new Set(grant).values()].map(
      (permission) => ({ action: 'grant', permission }),
    );
    for (const permission of new Set(revoke)) {
      actions.push({ action: 'revoke', permission });
    }

    const undeclared: string[] = [];
    const nonRuntime: string[] = [];
    for (const { permission } of actions) {
      const entry = byName.get(permission);
      if (!entry) {
        undeclared.push(permission);
        continue;
      }
      const isRuntime = entry.kind !== 'install' && dangerous.has(permission);
      if (!isRuntime) {
        nonRuntime.push(permission);
      }
    }
    if (undeclared.length > 0) {
      throw new ToolError(
        `Refusing to change undeclared permission${undeclared.length === 1 ? '' : 's'} for ${packageName} on ${serial}: ${undeclared.join(', ')}`,
      );
    }
    if (nonRuntime.length > 0) {
      throw new ToolError(
        `Refusing to change non-runtime permission${nonRuntime.length === 1 ? '' : 's'} on ${packageName} (only Android dangerous/runtime permissions are allowed): ${nonRuntime.join(', ')}`,
      );
    }

    const results: { action: 'grant' | 'revoke'; permission: string; applied: boolean }[] = [];
    try {
      for (const { action, permission } of actions) {
        let output: string;
        try {
          output = await adbShellArgs(ctx.adb, serial, ['pm', action, packageName, permission], {
            timeoutMs: PM_TIMEOUT_MS,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const prefix =
            results.length > 0
              ? `Applied ${results.length}/${actions.length} permission changes before failing: `
              : '';
          throw new ToolError(`${prefix}could not ${action} ${permission} on ${packageName} (${detail})`);
        }
        const pmError = parsePmPermissionError(output);
        if (pmError !== null) {
          const prefix =
            results.length > 0
              ? `Applied ${results.length}/${actions.length} permission changes before failing: `
              : '';
          throw new ToolError(`${prefix}could not ${action} ${permission} on ${packageName}: ${pmError}`);
        }
        results.push({ action, permission, applied: true });
      }
      return { data: { serial, packageName, results } };
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

export const clearAppDataTool = defineTool({
  name: 'clear_app_data',
  title: 'Clear app data',
  description:
    "Clears all app data (`pm clear`) for the profiling session's target device and third-party package, stopping its process and resetting SharedPreferences, databases, caches, and runtime permissions. Refuses any device or package other than the session target and refuses all system packages. Stopping the app ends its SDK link until relaunched. Device control.",
  access: 'device',
  input: z.object({
    packageName: packageInput
      .optional()
      .describe('Must match the profiling session target package; default: session target.'),
    serial: optionalSerial.describe(
      'Must match the profiling session target device; default: session device.',
    ),
  }),
  annotations: INPUT,
  async run({ packageName: requestedPkg, serial: requestedSerial }, ctx) {
    const { serial, packageName } = requireSessionTarget(ctx, {
      serial: requestedSerial,
      packageName: requestedPkg,
    });

    const [systemOut, thirdPartyOut] = await Promise.all([
      adbShellArgs(ctx.adb, serial, ['pm', 'list', 'packages', '-s', packageName], {
        timeoutMs: PM_TIMEOUT_MS,
      }),
      adbShellArgs(ctx.adb, serial, ['pm', 'list', 'packages', '-3', packageName], {
        timeoutMs: PM_TIMEOUT_MS,
      }),
    ]);
    if (parsePackageList(systemOut).includes(packageName)) {
      throw new ToolError(`Refusing to clear system package ${packageName}`);
    }
    if (!parsePackageList(thirdPartyOut).includes(packageName)) {
      throw new ToolError(`${packageName} is not an installed third-party package on ${serial}`);
    }

    try {
      const output = await adbShellArgs(ctx.adb, serial, ['pm', 'clear', packageName], {
        timeoutMs: PM_TIMEOUT_MS,
      });
      if (!/\bSuccess\b/i.test(output)) {
        const detail = output.trim().slice(0, 200) || 'no confirmation from pm clear';
        throw new ToolError(`Could not clear data for ${packageName} on ${serial}: ${detail}`);
      }
      return { data: { serial, packageName, cleared: true } };
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

export function isValidApkPathFormat(apkPath: string): boolean {
  if (apkPath.length === 0 || apkPath.length > MAX_APK_PATH_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(apkPath)) return false;
  if (!path.isAbsolute(apkPath)) return false;
  return apkPath.toLowerCase().endsWith('.apk');
}

export interface StagedApkSnapshot {
  snapshotDir: string;
  snapshotPath: string;
  sizeBytes: number;
}

/**
 * Validates `apkPath` (rejecting symlinks and non-regular files), enforces `maxBytes` before and during copying,
 * honors `signal` cancellation, and stages a private mode-0600 snapshot from the single open file descriptor.
 */
export async function stageApkSnapshot(
  apkPath: string,
  options: { maxBytes?: number; signal?: AbortSignal | undefined } = {},
): Promise<StagedApkSnapshot> {
  const maxBytes = options.maxBytes ?? MAX_APK_SNAPSHOT_BYTES;
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new ToolError('APK install cancelled');
  };
  checkCancelled();

  let linkStat;
  try {
    linkStat = await lstat(apkPath);
  } catch {
    throw new ToolError(`APK file does not exist or cannot be read: ${apkPath}`);
  }
  if (linkStat.isSymbolicLink()) {
    throw new ToolError(`APK path must not be a symbolic link: ${apkPath}`);
  }
  if (!linkStat.isFile()) {
    throw new ToolError(`APK path must be a regular file, not a directory or special file: ${apkPath}`);
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let sourceHandle;
  try {
    sourceHandle = await open(apkPath, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ToolError(`APK path must not be a symbolic link: ${apkPath}`);
    }
    throw new ToolError(`APK file does not exist or cannot be read: ${apkPath}`);
  }

  let snapshotDir: string | null = null;
  let staged = false;
  try {
    checkCancelled();
    const fdStat = await sourceHandle.stat();
    if (!fdStat.isFile()) {
      throw new ToolError(`APK path must be a regular file, not a directory or special file: ${apkPath}`);
    }
    if (fdStat.size > maxBytes) {
      throw new ToolError(
        `APK file exceeds the ${maxBytes}-byte staging limit (${fdStat.size} bytes): ${apkPath}`,
      );
    }

    snapshotDir = await mkdtemp(path.join(tmpdir(), 'lionscope-apk-'));
    const snapshotPath = path.join(snapshotDir, 'install.apk');
    let copiedBytes = 0;
    const dstHandle = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        checkCancelled();
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        if (copiedBytes + bytesRead > maxBytes) {
          throw new ToolError(
            `APK file grew past the ${maxBytes}-byte staging limit while copying: ${apkPath}`,
          );
        }
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await dstHandle.write(buffer, offset, bytesRead - offset);
          offset += bytesWritten;
        }
        copiedBytes += bytesRead;
      }
    } finally {
      await dstHandle.close();
    }
    staged = true;
    return { snapshotDir, snapshotPath, sizeBytes: copiedBytes };
  } finally {
    await sourceHandle.close().catch((error: unknown) => {
      log.warn(`Closing APK source descriptor failed for ${apkPath}: ${errorMessage(error)}`);
    });
    if (!staged && snapshotDir) {
      await rm(snapshotDir, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn(`Removing incomplete APK snapshot ${snapshotDir} failed: ${errorMessage(error)}`);
      });
    }
  }
}

export const installApkTool = defineTool({
  name: 'install_apk',
  title: 'Install an APK',
  description:
    'Installs an APK from the host onto the device (`adb install -r [-g]`) for build → install → launch → verify loops. apkPath must be an absolute path to an existing regular `.apk` file on the host (symlinks, relative paths, directories, and other extensions are rejected). The file is opened once without following symlinks, copied into a bounded private temporary snapshot (up to 512 MiB) that is passed to adb, and deleted immediately afterwards. Arguments are passed as an array to adb without host shell interpolation. grantPermissions: true passes `-g` to grant all runtime permissions (API 23+). Device control.',
  access: 'device',
  input: z.object({
    apkPath: z
      .string()
      .min(1)
      .max(MAX_APK_PATH_CHARS)
      .refine(
        isValidApkPathFormat,
        'must be an absolute host file path ending in .apk with no control characters',
      )
      .describe('Absolute path to an existing regular (non-symlink) .apk file on the host machine.'),
    grantPermissions: z
      .boolean()
      .default(false)
      .describe('Pass -g to grant all runtime permissions on install (API 23+).'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ apkPath, grantPermissions, serial: requestedSerial }, ctx) {
    if (ctx.signal?.aborted) throw new ToolError('APK install cancelled');
    const serial = targetSerial(ctx, requestedSerial);
    const { snapshotDir, snapshotPath, sizeBytes } = await stageApkSnapshot(apkPath, {
      signal: ctx.signal,
    });
    let cleaned = false;
    const cleanupSnapshot = async (): Promise<string | undefined> => {
      if (cleaned) return undefined;
      cleaned = true;
      try {
        await rm(snapshotDir, { recursive: true, force: true });
        return undefined;
      } catch (error) {
        const warning = `Temporary APK snapshot ${snapshotDir} could not be removed: ${errorMessage(error)}`;
        log.warn(warning);
        return warning;
      }
    };
    try {
      if (ctx.signal?.aborted) throw new ToolError('APK install cancelled');
      const args = ['-s', serial, 'install', '-r', ...(grantPermissions ? ['-g'] : []), snapshotPath];
      const output = await ctx.adb.exec(args, { timeoutMs: INSTALL_TIMEOUT_MS, signal: ctx.signal });
      if (!/\bSuccess\b/i.test(output)) {
        const detail =
          /Failure\s*\[[^\]]+\][^\r\n]*/.exec(output)?.[0] ??
          (output.trim().slice(0, 200) || 'adb install did not report Success');
        throw new ToolError(`Installing ${path.basename(apkPath)} on ${serial} failed: ${detail}`);
      }
      const cleanupWarning = await cleanupSnapshot();
      return {
        data: {
          serial,
          apkPath,
          sizeBytes,
          replaced: true,
          grantedPermissions: grantPermissions,
          installed: true,
          ...(cleanupWarning ? { warning: cleanupWarning } : {}),
        },
      };
    } finally {
      await cleanupSnapshot();
      invalidateUi(ctx, serial);
    }
  },
});

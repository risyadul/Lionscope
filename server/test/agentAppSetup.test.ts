import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { adbShellArgs, createAdb, describeArgs, quoteShellArg } from '../src/adb/adb.ts';
import {
  isValidDeepLinkUri,
  isValidPermissionName,
  parseAmStartOutput,
  parseDangerousPermissions,
  parsePackagePermissions,
  stageApkSnapshot,
} from '../src/agent/appSetupTools.ts';
import { callTool, DEVICE_CONTROL_DISABLED } from '../src/agent/registry.ts';
import { log } from '../src/log.ts';
import { fakeAgent, PKG, RUNNING } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import { FakeAdb } from './helpers/fakes.ts';

const DUMPSYS_PACKAGE_API34 = [
  `Package [${PKG}] (a1b2c3d):`,
  '  userId=10151',
  '  requested permissions:',
  '    android.permission.INTERNET',
  '    android.permission.CAMERA',
  '    android.permission.POST_NOTIFICATIONS',
  '    android.permission.ACCESS_FINE_LOCATION',
  '    android.permission.DUMP',
  '  install permissions:',
  '    android.permission.INTERNET: granted=true',
  '  User 0: ceDataInode=1234 installed=true',
  '    runtime permissions:',
  '      android.permission.CAMERA: granted=true, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED ]',
  '      android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SENSITIVE_WHEN_DENIED ]',
  '      android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ USER_SET ]',
  '  User 10: ceDataInode=5678 installed=true',
  '    runtime permissions:',
  '      android.permission.CAMERA: granted=false',
  'Package [com.other.app] (9999):',
  '  requested permissions:',
  '    android.permission.READ_CONTACTS',
].join('\n');

const DUMPSYS_PACKAGE_API23 = [
  `Package [${PKG}] (112233):`,
  '  requested permissions:',
  '    android.permission.INTERNET',
  '    android.permission.ACCESS_FINE_LOCATION',
  '  install permissions:',
  '    android.permission.INTERNET: granted=true',
  '  User 0:  installed=true hidden=false stopped=false',
  '    runtime permissions:',
  '      android.permission.ACCESS_FINE_LOCATION: granted=false',
].join('\n');

const PM_DANGEROUS_PERMISSIONS = [
  'Dangerous Permissions:',
  '',
  '+ group:android.permission-group.CAMERA',
  '  permission:android.permission.CAMERA',
  '+ group:android.permission-group.LOCATION',
  '  permission:android.permission.ACCESS_FINE_LOCATION',
  '+ group:android.permission-group.CONTACTS',
  '  permission:android.permission.READ_CONTACTS',
  'ungrouped:',
  '  permission:android.permission.POST_NOTIFICATIONS',
].join('\n');

describe('adb shell array quoting and deep-link error sanitization', () => {
  it('leaves safe tokens unquoted and single-quotes shell metacharacters', async () => {
    expect(quoteShellArg('com.example.shop')).toBe('com.example.shop');
    expect(quoteShellArg('https://example.com/item?a=1&b=2')).toBe("'https://example.com/item?a=1&b=2'");
    expect(quoteShellArg("it's;rm")).toBe("'it'\\''s;rm'");

    const adb = new FakeAdb(() => 'ok');
    await adbShellArgs(adb, 'emulator-5554', [
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'https://shop.example/p?id=1&ref=2',
      PKG,
    ]);
    expect(adb.execCalls).toEqual([
      [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'https://shop.example/p?id=1&ref=2'",
        PKG,
      ],
    ]);
  });

  it('scopes -d redaction to am intents and strips opaque path deep-link credentials from stderr, stdout, logs, and errors', async () => {
    const secretToken = 'synthetic-secret-token-999';
    const pathSecret = 'opaque-path-secret-777';
    const bearerSecret = 'synthetic-bearer-888';
    const uri = `lionscope://auth/callback/${pathSecret}?token=${secretToken}&tab=1`;

    // Global ADB `-d` USB selector must NOT be over-redacted.
    expect(describeArgs(['-d', 'get-state'])).toBe('-d get-state');
    expect(describeArgs(['-d', 'shell', 'pm', 'list', 'packages'])).toBe('-d shell pm list packages');

    expect(
      describeArgs(['-s', 'emulator-5554', 'shell', 'am', 'start', '-d', `'${uri}'`, PKG]),
    ).not.toContain(secretToken);
    expect(
      describeArgs(['-s', 'emulator-5554', 'shell', 'am', 'start', '-d', `'${uri}'`, PKG]),
    ).not.toContain(pathSecret);

    const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-deeplink-adb-'));
    const fakeAdbPath = path.join(dir, 'adb');
    await writeFile(
      fakeAdbPath,
      [
        '#!/bin/sh',
        `echo "Error: cannot start dat=${uri} Authorization: Bearer ${bearerSecret}" >&2`,
        'exit 1',
      ].join('\n'),
    );
    await chmod(fakeAdbPath, 0o755);

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const adb = createAdb(fakeAdbPath);
      const agent = fakeAgent();
      agent.ctx.adb = adb;
      const outcome = await callTool(agent.ctx, 'open_deep_link', { uri, packageName: PKG }, true);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).not.toContain(secretToken);
        expect(outcome.error).not.toContain(pathSecret);
        expect(outcome.error).not.toContain(bearerSecret);
        expect(outcome.error).toContain('<redacted>');
      }
      expect(warnSpy).toHaveBeenCalled();
      const loggedText = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(loggedText).not.toContain(secretToken);
      expect(loggedText).not.toContain(pathSecret);
      expect(loggedText).not.toContain(bearerSecret);
    } finally {
      warnSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }

    // Stdout `Error: ...` echoing an opaque path deep link (exact real-device `am start` format) must also be stripped.
    const opaqueUri = `nohandler://x/${pathSecret}?token=${secretToken}`;
    const stdoutAdb = new FakeAdb(
      () =>
        `Starting: Intent { act=android.intent.action.VIEW dat=${opaqueUri} }\n` +
        `Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=${opaqueUri} flg=0x10000000 }\n`,
    );
    const stdoutAgent = fakeAgent({}, { adb: stdoutAdb });
    const stdoutOutcome = await callTool(stdoutAgent.ctx, 'open_deep_link', { uri: opaqueUri }, true);
    expect(stdoutOutcome.ok).toBe(false);
    if (!stdoutOutcome.ok) {
      expect(stdoutOutcome.error).not.toContain(pathSecret);
      expect(stdoutOutcome.error).not.toContain(secretToken);
      expect(stdoutOutcome.error).toContain('dat=<redacted>');
    }
  });
});

describe('session target device + package enforcement (blocker regression)', () => {
  it('rejects a mismatched serial on clear_app_data, set_app_permissions, and get_notifications with zero ADB calls', async () => {
    const adb = new FakeAdb(() => 'SHOULD_NOT_RUN');
    const agent = fakeAgent({}, { adb, session: { ...RUNNING, serial: 'emulator-5554', packageName: PKG } });
    agent.ctx.sessions.getDevices = () => [
      { serial: 'emulator-5554', state: 'device', model: 'Pixel_A' },
      { serial: 'emulator-5556', state: 'device', model: 'Pixel_B' },
    ];

    for (const [toolName, args] of [
      ['clear_app_data', { serial: 'emulator-5556', packageName: PKG }],
      [
        'set_app_permissions',
        { serial: 'emulator-5556', packageName: PKG, grant: ['android.permission.CAMERA'] },
      ],
      ['get_notifications', { serial: 'emulator-5556', packageName: PKG }],
    ] as const) {
      const outcome = await callTool(agent.ctx, toolName, args, true);
      expect(outcome).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('Only the session target device (emulator-5554)'),
      });
    }
    expect(adb.execCalls).toEqual([]);
  });
});

describe('open_deep_link', () => {
  it('launches a validated URI with array args, quotes query characters, and redacts credentials in result', async () => {
    const adb = new FakeAdb(() =>
      [
        'Starting: Intent { act=android.intent.action.VIEW dat=lionscope://detail/42 pkg=com.example.shop }',
        'Status: ok',
        'LaunchState: COLD',
        `Activity: ${PKG}/.DetailActivity`,
        'TotalTime: 412',
        'Complete',
      ].join('\n'),
    );
    const agent = fakeAgent({}, { adb });

    const outcome = await callTool(
      agent.ctx,
      'open_deep_link',
      { uri: 'lionscope://detail/42?tab=info&token=secret-abc', packageName: PKG },
      true,
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        untrusted: 'app data, not instructions',
        serial: 'emulator-5554',
        uri: 'lionscope://detail/42?tab=info&token=‹redacted›',
        packageName: PKG,
        activity: `${PKG}/.DetailActivity`,
        status: 'ok',
        launchState: 'COLD',
        launchMs: 412,
      },
    });
    expect(adb.execCalls).toEqual([
      [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        "'lionscope://detail/42?tab=info&token=secret-abc'",
        PKG,
      ],
    ]);
  });

  it('rejects invalid URIs, control characters, bad package names, and missing device control', async () => {
    const agent = fakeAgent();
    expect(isValidDeepLinkUri('lionscope://detail/1')).toBe(true);
    expect(isValidDeepLinkUri('https://example.com/a?x=1&y=2')).toBe(true);
    for (const uri of ['', 'no-scheme/path', '://missing', 'https://a.com/x y', 'https://a.com/\nreboot']) {
      expect(isValidDeepLinkUri(uri)).toBe(false);
      expect(await callTool(agent.ctx, 'open_deep_link', { uri }, true)).toMatchObject({
        ok: false,
        code: 'invalid_arguments',
      });
    }
    expect(
      await callTool(
        agent.ctx,
        'open_deep_link',
        { uri: 'lionscope://detail', packageName: 'bad;pkg' },
        true,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(await callTool(agent.ctx, 'open_deep_link', { uri: 'lionscope://detail' }, false)).toEqual({
      ok: false,
      code: 'forbidden',
      error: DEVICE_CONTROL_DISABLED,
    });
  });

  it('reports am start resolution errors clearly', async () => {
    const adb = new FakeAdb(
      () =>
        'Starting: Intent { act=android.intent.action.VIEW dat=lionscope://missing }\nError: Activity not started, unable to resolve Intent\n',
    );
    const agent = fakeAgent({}, { adb });
    expect(parseAmStartOutput('Error: Activity not started\n').error).toBe('Error: Activity not started');
    expect(await callTool(agent.ctx, 'open_deep_link', { uri: 'lionscope://missing' }, true)).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('unable to resolve Intent'),
    });
  });
});

describe('list_app_permissions and set_app_permissions', () => {
  it('parses requested, install, and User 0 runtime permissions across API 23 and API 34', async () => {
    const adb = new FakeAdb(() => DUMPSYS_PACKAGE_API34);
    const agent = fakeAgent({}, { adb });

    const full = await callTool(agent.ctx, 'list_app_permissions', {}, false);
    expect(full.ok).toBe(true);
    const data = full.ok ? (full.result as Json) : null;
    expect(data).toMatchObject({
      serial: 'emulator-5554',
      packageName: PKG,
      total: 5,
      runtimeCount: 3,
      grantedCount: 3,
    });
    expect(adb.execCalls).toEqual([['-s', 'emulator-5554', 'shell', 'dumpsys', 'package', PKG]]);

    const runtimeOnly = await callTool(agent.ctx, 'list_app_permissions', { runtimeOnly: true }, false);
    expect(runtimeOnly.ok && (runtimeOnly.result as Json).permissions.map((p: Json) => p.name)).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.CAMERA',
      'android.permission.POST_NOTIFICATIONS',
    ]);

    expect(parsePackagePermissions(DUMPSYS_PACKAGE_API23, PKG)).toEqual([
      { name: 'android.permission.ACCESS_FINE_LOCATION', granted: false, kind: 'runtime', flags: [] },
      { name: 'android.permission.INTERNET', granted: true, kind: 'install', flags: [] },
    ]);
    expect(parsePackagePermissions('Unable to find package: com.missing', 'com.missing')).toBeNull();
    const parsedDangerous = parseDangerousPermissions(PM_DANGEROUS_PERMISSIONS);
    expect(parsedDangerous?.has('android.permission.CAMERA')).toBe(true);
    expect(parsedDangerous?.has('android.permission.POST_NOTIFICATIONS')).toBe(true);
    expect(parsedDangerous?.has('android.permission.DUMP')).toBe(false);
    expect(parseDangerousPermissions('')).toBeNull();
    expect(parseDangerousPermissions('Error: unknown command')).toBeNull();
  });

  it('validates declared + dangerous runtime permissions via `pm list permissions -d -g` before applying pm grant/revoke', async () => {
    const adb = new FakeAdb((args) => {
      if (args[3] === 'dumpsys' && args[4] === 'package') return DUMPSYS_PACKAGE_API34;
      if (args[3] === 'pm' && args[4] === 'list' && args[5] === 'permissions')
        return PM_DANGEROUS_PERMISSIONS;
      return '';
    });
    const agent = fakeAgent({}, { adb });

    const outcome = await callTool(
      agent.ctx,
      'set_app_permissions',
      {
        grant: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'],
        revoke: ['android.permission.ACCESS_FINE_LOCATION'],
      },
      true,
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        packageName: PKG,
        results: [
          { action: 'grant', permission: 'android.permission.CAMERA', applied: true },
          { action: 'grant', permission: 'android.permission.POST_NOTIFICATIONS', applied: true },
          { action: 'revoke', permission: 'android.permission.ACCESS_FINE_LOCATION', applied: true },
        ],
      },
    });
    expect(adb.execCalls).toEqual([
      ['-s', 'emulator-5554', 'shell', 'dumpsys', 'package', PKG],
      ['-s', 'emulator-5554', 'shell', 'pm', 'list', 'permissions', '-d', '-g'],
      ['-s', 'emulator-5554', 'shell', 'pm', 'grant', PKG, 'android.permission.CAMERA'],
      ['-s', 'emulator-5554', 'shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS'],
      ['-s', 'emulator-5554', 'shell', 'pm', 'revoke', PKG, 'android.permission.ACCESS_FINE_LOCATION'],
    ]);
  });

  it('fails clearly with zero grant/revoke calls if `pm list permissions -d -g` returns empty, unrecognized, or unfiltered `All Permissions:` output', async () => {
    const populatedAllPermissions = [
      'All Permissions:',
      '',
      '+ group:android.permission-group.NETWORK',
      '  permission:android.permission.INTERNET',
      '  permission:android.permission.DUMP',
      '+ group:android.permission-group.CAMERA',
      '  permission:android.permission.CAMERA',
    ].join('\n');
    expect(parseDangerousPermissions(populatedAllPermissions)).toBeNull();

    // Stops at the next top-level protection-class heading after `Dangerous Permissions:`.
    const withTrailingSection = [
      'Dangerous Permissions:',
      '',
      '+ group:android.permission-group.CAMERA',
      '  permission:android.permission.CAMERA',
      'Normal Permissions:',
      '  permission:android.permission.INTERNET',
    ].join('\n');
    const dangerousOnly = parseDangerousPermissions(withTrailingSection);
    expect(dangerousOnly?.has('android.permission.CAMERA')).toBe(true);
    expect(dangerousOnly?.has('android.permission.INTERNET')).toBe(false);

    const adb = new FakeAdb((args) => {
      if (args[3] === 'dumpsys' && args[4] === 'package') return DUMPSYS_PACKAGE_API34;
      if (args[3] === 'pm' && args[4] === 'list' && args[5] === 'permissions') return populatedAllPermissions;
      return '';
    });
    const agent = fakeAgent({}, { adb });

    expect(
      await callTool(
        agent.ctx,
        'set_app_permissions',
        { grant: ['android.permission.CAMERA', 'android.permission.DUMP'] },
        true,
      ),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('pm list permissions -d -g'),
    });
    expect(adb.execCalls.some((call) => call[4] === 'grant' || call[4] === 'revoke')).toBe(false);
  });

  it('rejects undeclared and non-runtime (install or development) permissions before issuing any pm grant/revoke', async () => {
    const adb = new FakeAdb((args) => {
      if (args[3] === 'dumpsys' && args[4] === 'package') return DUMPSYS_PACKAGE_API34;
      if (args[3] === 'pm' && args[4] === 'list' && args[5] === 'permissions')
        return PM_DANGEROUS_PERMISSIONS;
      return '';
    });
    const agent = fakeAgent({}, { adb });

    // Undeclared permission paired with a valid runtime permission: neither is applied.
    expect(
      await callTool(
        agent.ctx,
        'set_app_permissions',
        { grant: ['android.permission.CAMERA', 'android.permission.READ_CONTACTS'] },
        true,
      ),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('undeclared permission'),
    });

    // Development permission (declared in requested permissions, but NOT in `pm list permissions -d`).
    expect(
      await callTool(
        agent.ctx,
        'set_app_permissions',
        { grant: ['android.permission.CAMERA', 'android.permission.DUMP'] },
        true,
      ),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('non-runtime permission'),
    });

    // Install-time normal permission.
    expect(
      await callTool(agent.ctx, 'set_app_permissions', { grant: ['android.permission.INTERNET'] }, true),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('non-runtime permission'),
    });

    // Zero pm grant or pm revoke commands were executed.
    expect(adb.execCalls.some((call) => call[4] === 'grant' || call[4] === 'revoke')).toBe(false);
  });

  it('validates permission names, enforces session target package, detects pm errors, and gates behind device control', async () => {
    const adb = new FakeAdb((args) => {
      if (args[3] === 'dumpsys' && args[4] === 'package') return DUMPSYS_PACKAGE_API34;
      if (args[3] === 'pm' && args[4] === 'list' && args[5] === 'permissions')
        return PM_DANGEROUS_PERMISSIONS;
      if (args[4] === 'grant')
        return 'Operation not allowed: java.lang.SecurityException: Permission is not a changeable permission type\n';
      return '';
    });
    const agent = fakeAgent({}, { adb });

    expect(isValidPermissionName('android.permission.CAMERA')).toBe(true);
    expect(isValidPermissionName('CAMERA')).toBe(false);
    expect(isValidPermissionName('android.permission.CAMERA;reboot')).toBe(false);

    expect(await callTool(agent.ctx, 'set_app_permissions', { grant: ['invalid_perm'] }, true)).toMatchObject(
      { ok: false, code: 'invalid_arguments' },
    );
    expect(await callTool(agent.ctx, 'set_app_permissions', {}, true)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    expect(
      await callTool(
        agent.ctx,
        'set_app_permissions',
        { grant: ['android.permission.CAMERA'], revoke: ['android.permission.CAMERA'] },
        true,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(
      await callTool(agent.ctx, 'set_app_permissions', { grant: ['android.permission.CAMERA'] }, false),
    ).toEqual({ ok: false, code: 'forbidden', error: DEVICE_CONTROL_DISABLED });
    expect(
      await callTool(
        agent.ctx,
        'set_app_permissions',
        { packageName: 'com.other.app', grant: ['android.permission.CAMERA'] },
        true,
      ),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining(`Only the session target package (${PKG})`),
    });
    expect(
      await callTool(agent.ctx, 'set_app_permissions', { grant: ['android.permission.CAMERA'] }, true),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('not a changeable permission type'),
    });
  });
});

describe('clear_app_data', () => {
  it('clears the session third-party target package only and refuses system or other packages', async () => {
    const adb = new FakeAdb((args) => {
      if (args[4] === 'list' && args[6] === '-s') return 'package:com.android.settings\n';
      if (args[4] === 'list' && args[6] === '-3') return `package:${PKG}\n`;
      if (args[4] === 'clear') return 'Success\n';
      return '';
    });
    const agent = fakeAgent({}, { adb });

    expect(await callTool(agent.ctx, 'clear_app_data', {}, true)).toEqual({
      ok: true,
      result: { serial: 'emulator-5554', packageName: PKG, cleared: true },
    });
    expect(adb.execCalls).toEqual([
      ['-s', 'emulator-5554', 'shell', 'pm', 'list', 'packages', '-s', PKG],
      ['-s', 'emulator-5554', 'shell', 'pm', 'list', 'packages', '-3', PKG],
      ['-s', 'emulator-5554', 'shell', 'pm', 'clear', PKG],
    ]);

    expect(
      await callTool(agent.ctx, 'clear_app_data', { packageName: 'com.example.other' }, true),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining(`Only the session target package (${PKG})`),
    });

    expect(await callTool(agent.ctx, 'clear_app_data', {}, false)).toEqual({
      ok: false,
      code: 'forbidden',
      error: DEVICE_CONTROL_DISABLED,
    });

    const sysAdb = new FakeAdb((args) => {
      if (args[4] === 'list' && args[6] === '-s') return 'package:com.android.settings\n';
      return '';
    });
    const sysAgent = fakeAgent(
      {},
      { adb: sysAdb, session: { ...RUNNING, packageName: 'com.android.settings' } },
    );
    expect(await callTool(sysAgent.ctx, 'clear_app_data', {}, true)).toMatchObject({
      ok: false,
      code: 'failed',
      error: 'Refusing to clear system package com.android.settings',
    });
    expect(sysAdb.execCalls.some((call) => call.includes('clear'))).toBe(false);

    const idleAgent = fakeAgent({}, { session: { ...RUNNING, status: 'idle', packageName: null } });
    expect(await callTool(idleAgent.ctx, 'clear_app_data', {}, true)).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('No target package is selected'),
    });
  });
});

describe('install_apk', () => {
  it('installs from a private descriptor snapshot, deletes it afterwards, and rejects symlinks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-apk-test-'));
    const apkPath = path.join(dir, 'sample-debug.apk');
    const apkBytes = Buffer.from('PK\x03\x04fake-apk');
    await writeFile(apkPath, apkBytes);
    const linkPath = path.join(dir, 'link.apk');
    await symlink(apkPath, linkPath);

    try {
      const seenSnapshots: string[] = [];
      let snapshotContents: Buffer | null = null;
      const adb = new FakeAdb(async (args) => {
        const passedPath = args.at(-1)!;
        seenSnapshots.push(passedPath);
        snapshotContents = await readFile(passedPath);
        return 'Performing Streamed Install\nSuccess\n';
      });
      const agent = fakeAgent({}, { adb });

      // Symbolic links are explicitly rejected with zero ADB calls.
      expect(await callTool(agent.ctx, 'install_apk', { apkPath: linkPath }, true)).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('symbolic link'),
      });
      expect(adb.execCalls).toEqual([]);

      const first = await callTool(agent.ctx, 'install_apk', { apkPath }, true);
      expect(first).toEqual({
        ok: true,
        result: {
          serial: 'emulator-5554',
          apkPath,
          sizeBytes: apkBytes.length,
          replaced: true,
          grantedPermissions: false,
          installed: true,
        },
      });
      expect(seenSnapshots).toHaveLength(1);
      expect(seenSnapshots[0]).not.toBe(apkPath);
      expect(snapshotContents).toEqual(apkBytes);
      // Snapshot is always deleted after install completes.
      await expect(stat(seenSnapshots[0]!)).rejects.toThrow();

      const second = await callTool(agent.ctx, 'install_apk', { apkPath, grantPermissions: true }, true);
      expect(second).toMatchObject({ ok: true, result: { grantedPermissions: true, installed: true } });
      expect(adb.execCalls[1]?.slice(0, 5)).toEqual(['-s', 'emulator-5554', 'install', '-r', '-g']);
      await expect(stat(seenSnapshots[1]!)).rejects.toThrow();

      // Rejects a directory even if its name ends with .apk.
      const fakeDirApk = path.join(dir, 'dir.apk');
      await mkdir(fakeDirApk);
      expect(await callTool(agent.ctx, 'install_apk', { apkPath: fakeDirApk }, true)).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('regular file'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans up temp snapshot on adb failure and rejects relative/invalid paths and missing device control', async () => {
    const agent = fakeAgent();
    for (const apkPath of ['app.apk', './app.apk', '/tmp/app.zip', '/tmp/app', '/tmp/bad\n.apk']) {
      expect(await callTool(agent.ctx, 'install_apk', { apkPath }, true)).toMatchObject({
        ok: false,
        code: 'invalid_arguments',
      });
    }
    expect(
      await callTool(agent.ctx, 'install_apk', { apkPath: '/nonexistent/path/missing.apk' }, true),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('does not exist'),
    });
    expect(await callTool(agent.ctx, 'install_apk', { apkPath: '/tmp/app.apk' }, false)).toEqual({
      ok: false,
      code: 'forbidden',
      error: DEVICE_CONTROL_DISABLED,
    });

    const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-apk-fail-'));
    const apkPath = path.join(dir, 'bad.apk');
    await writeFile(apkPath, Buffer.from('x'));
    try {
      let failedSnapshot = '';
      const failAdb = new FakeAdb((args) => {
        failedSnapshot = args.at(-1)!;
        return 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\n';
      });
      const failAgent = fakeAgent({}, { adb: failAdb });
      expect(await callTool(failAgent.ctx, 'install_apk', { apkPath }, true)).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('INSTALL_FAILED_VERSION_DOWNGRADE'),
      });
      await expect(stat(failedSnapshot)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces snapshot byte caps, honors AbortSignal before adb install, and logs/reports snapshot cleanup failures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lionscope-apk-cap-'));
    const apkPath = path.join(dir, 'sample.apk');
    await writeFile(apkPath, Buffer.alloc(1024, 0x41));
    let lockedSnapshotDir: string | null = null;
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    try {
      // 1. Byte cap enforced by stageApkSnapshot.
      await expect(stageApkSnapshot(apkPath, { maxBytes: 512 })).rejects.toThrow(
        /exceeds the 512-byte staging limit/,
      );

      // 1b. Non-regular FIFO rejected promptly without blocking (POSIX).
      if (process.platform !== 'win32') {
        const fifoPath = path.join(dir, 'pipe.apk');
        await promisify(execFile)('mkfifo', [fifoPath]);
        await expect(stageApkSnapshot(fifoPath)).rejects.toThrow(/regular file/);
      }

      // 2. AbortSignal cancels install_apk before invoking ADB (zero ADB calls).
      const abortAdb = new FakeAdb(() => 'SHOULD_NOT_RUN');
      const abortAgent = fakeAgent({}, { adb: abortAdb });
      const controller = new AbortController();
      controller.abort();
      expect(
        await callTool(abortAgent.ctx, 'install_apk', { apkPath }, true, { signal: controller.signal }),
      ).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('cancelled'),
      });
      expect(abortAdb.execCalls).toEqual([]);

      // 3. Snapshot cleanup failure is logged via log.warn and surfaced as a warning field.
      const cleanupAdb = new FakeAdb(async (args, options) => {
        expect(options?.signal).toBeDefined();
        const snapPath = args.at(-1)!;
        lockedSnapshotDir = path.dirname(snapPath);
        await chmod(lockedSnapshotDir, 0o500);
        return 'Success\n';
      });
      const cleanupAgent = fakeAgent({}, { adb: cleanupAdb });
      const activeController = new AbortController();
      const outcome = await callTool(cleanupAgent.ctx, 'install_apk', { apkPath }, true, {
        signal: activeController.signal,
      });
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          installed: true,
          warning: expect.stringContaining('could not be removed'),
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Temporary APK snapshot'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not be removed'));
    } finally {
      warnSpy.mockRestore();
      if (lockedSnapshotDir) {
        await chmod(lockedSnapshotDir, 0o700).catch(() => undefined);
        await rm(lockedSnapshotDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

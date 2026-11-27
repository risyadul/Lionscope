import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceSettings,
  parseNightMode,
  parseSettingValue,
  rotationForOrientation,
} from '../src/agent/deviceSettings.ts';
import { callTool, DEVICE_CONTROL_DISABLED } from '../src/agent/registry.ts';
import type { EmulatorHost, EmulatorProcess } from '../src/emulator/emulatorHost.ts';
import { log } from '../src/log.ts';
import { createLionscopeServer } from '../src/server.ts';
import { fakeAgent, RUNNING } from './helpers/agentFixtures.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { FakeAdb } from './helpers/fakes.ts';

function envAdb(
  options: {
    accel?: string;
    userRot?: string;
    night?: string;
    fontScale?: string;
    wmSize?: string;
    nightUnsupported?: boolean;
  } = {},
) {
  const state = {
    accel: options.accel ?? '1',
    userRot: options.userRot ?? '0',
    night: options.night ?? 'no',
    fontScale: options.fontScale ?? '1.0',
  };
  const wmSize = options.wmSize ?? 'Physical size: 1080x2400\n';
  const adb = new FakeAdb((args) => {
    const cmd = args.slice(3);
    if (cmd[0] === 'wm' && cmd[1] === 'size') return wmSize;
    if (cmd[0] === 'settings' && cmd[1] === 'get' && cmd[2] === 'system') {
      if (cmd[3] === 'accelerometer_rotation') return `${state.accel}\n`;
      if (cmd[3] === 'user_rotation') return `${state.userRot}\n`;
      if (cmd[3] === 'font_scale') return `${state.fontScale}\n`;
    }
    if (cmd[0] === 'settings' && cmd[1] === 'put' && cmd[2] === 'system') {
      if (cmd[3] === 'accelerometer_rotation') state.accel = cmd[4] ?? '';
      if (cmd[3] === 'user_rotation') state.userRot = cmd[4] ?? '';
      if (cmd[3] === 'font_scale') state.fontScale = cmd[4] ?? '';
      return '';
    }
    if (cmd[0] === 'settings' && cmd[1] === 'delete' && cmd[2] === 'system') {
      if (cmd[3] === 'accelerometer_rotation') state.accel = 'null';
      if (cmd[3] === 'user_rotation') state.userRot = 'null';
      if (cmd[3] === 'font_scale') state.fontScale = 'null';
      return 'Deleted 1 rows\n';
    }
    if (cmd[0] === 'cmd' && cmd[1] === 'uimode' && cmd[2] === 'night') {
      if (options.nightUnsupported) return 'Unknown command: night\n';
      if (cmd[3]) state.night = cmd[3];
      return `Night mode: ${state.night}\n`;
    }
    return '';
  });
  return { adb, state };
}

describe('device settings parsers', () => {
  it('normalizes settings get and preserves exact restorable cmd uimode night modes', () => {
    expect(parseSettingValue('1\n')).toBe('1');
    expect(parseSettingValue('null\n')).toBeNull();
    expect(parseSettingValue('  \n')).toBeNull();
    expect(parseNightMode('Night mode: yes\n')).toBe('yes');
    expect(parseNightMode('Night mode: no\n')).toBe('no');
    expect(parseNightMode('Night mode: auto\n')).toBe('auto');
    expect(parseNightMode('Night mode: custom_schedule\n')).toBe('custom_schedule');
    expect(parseNightMode('Night mode: custom_bedtime\n')).toBe('custom_bedtime');
    expect(parseNightMode('Night mode: custom_unknown\n')).toBeNull();
    expect(parseNightMode('Unknown command')).toBeNull();

    expect(rotationForOrientation('portrait', 'portrait')).toBe(0);
    expect(rotationForOrientation('landscape', 'portrait')).toBe(1);
    expect(rotationForOrientation('landscape', 'landscape')).toBe(0);
    expect(rotationForOrientation('portrait', 'landscape')).toBe(1);
    expect(rotationForOrientation('reverse_landscape', 'landscape')).toBe(2);
    expect(rotationForOrientation('reverse_portrait', 'landscape')).toBe(3);
  });
});

describe('set_orientation, set_display_options, and restore_device_settings', () => {
  it('derives rotation from natural display dimensions for both portrait-natural and landscape-natural screens', async () => {
    const portrait = envAdb({ accel: '1', userRot: '0', wmSize: 'Physical size: 1080x2400\n' });
    const portraitAgent = fakeAgent({}, { adb: portrait.adb });
    portraitAgent.ctx.screenshots.set('emulator-5554', {
      shot: { width: 720, height: 1600 },
      device: { width: 1080, height: 2400 },
    });

    const first = await callTool(portraitAgent.ctx, 'set_orientation', { orientation: 'landscape' }, true);
    expect(first).toMatchObject({
      ok: true,
      result: {
        serial: 'emulator-5554',
        orientation: 'landscape',
        naturalOrientation: 'portrait',
        accelerometerRotation: 0,
        userRotation: 1,
        recordedOriginal: true,
        trackedSettings: ['orientation'],
      },
    });
    expect(portrait.state).toMatchObject({ accel: '0', userRot: '1' });
    expect(portraitAgent.ctx.screenshots.has('emulator-5554')).toBe(false);

    // Second change must NOT overwrite the recorded original.
    const second = await callTool(portraitAgent.ctx, 'set_orientation', { orientation: 'auto' }, true);
    expect(second).toMatchObject({
      ok: true,
      result: { orientation: 'auto', accelerometerRotation: 1, userRotation: null, recordedOriginal: false },
    });

    // Explicit restore puts original values back idempotently.
    const restored = await callTool(portraitAgent.ctx, 'restore_device_settings', {}, true);
    expect(restored).toEqual({
      ok: true,
      result: { serial: 'emulator-5554', restored: true, settings: ['orientation'], outstanding: [] },
    });
    expect(portrait.state).toMatchObject({ accel: '1', userRot: '0' });

    const callsBefore = portrait.adb.execCalls.length;
    expect(await callTool(portraitAgent.ctx, 'restore_device_settings', {}, true)).toEqual({
      ok: true,
      result: { serial: 'emulator-5554', restored: false, settings: [], outstanding: [] },
    });
    expect(portrait.adb.execCalls.length).toBe(callsBefore);

    // Landscape-natural tablet (2560x1600): landscape=0, portrait=1, reverse_landscape=2, reverse_portrait=3.
    const tablet = envAdb({ accel: '1', userRot: '0', wmSize: 'Physical size: 2560x1600\n' });
    const tabletAgent = fakeAgent({}, { adb: tablet.adb });
    expect(
      await callTool(tabletAgent.ctx, 'set_orientation', { orientation: 'landscape' }, true),
    ).toMatchObject({
      ok: true,
      result: { orientation: 'landscape', naturalOrientation: 'landscape', userRotation: 0 },
    });
    expect(tablet.state.userRot).toBe('0');
    expect(
      await callTool(tabletAgent.ctx, 'set_orientation', { orientation: 'portrait' }, true),
    ).toMatchObject({
      ok: true,
      result: { orientation: 'portrait', naturalOrientation: 'landscape', userRotation: 1 },
    });
    expect(tablet.state.userRot).toBe('1');
  });

  it('preserves custom_schedule / custom_bedtime verbatim on restore and refuses unrestorable night modes', async () => {
    const custom = envAdb({ night: 'custom_schedule' });
    const agent = fakeAgent({}, { adb: custom.adb });

    expect(await callTool(agent.ctx, 'set_display_options', { darkMode: 'dark' }, true)).toMatchObject({
      ok: true,
      result: { applied: { darkMode: 'dark' }, recordedOriginal: true },
    });
    expect(custom.state.night).toBe('yes');

    expect(await callTool(agent.ctx, 'restore_device_settings', {}, true)).toEqual({
      ok: true,
      result: { serial: 'emulator-5554', restored: true, settings: ['darkMode'], outstanding: [] },
    });
    expect(custom.state.night).toBe('custom_schedule');

    // Unrestorable custom mode is refused before applying any write.
    const unknown = envAdb({ night: 'custom_unsupported_future' });
    const unknownAgent = fakeAgent({}, { adb: unknown.adb });
    expect(await callTool(unknownAgent.ctx, 'set_display_options', { darkMode: 'dark' }, true)).toMatchObject(
      {
        ok: false,
        code: 'failed',
        error: expect.stringContaining('cannot be restored'),
      },
    );
    expect(unknown.state.night).toBe('custom_unsupported_future');
    expect(unknownAgent.ctx.deviceSettings.hasTracked('emulator-5554')).toBe(false);
  });

  it('serializes restore behind an in-flight initial read and drains in-flight setters before close()', async () => {
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let allowReadFinish!: () => void;
    const waitRead = new Promise<void>((resolve) => {
      allowReadFinish = resolve;
    });

    const state = { fontScale: '1.0' };
    const adb = new FakeAdb(async (args) => {
      const cmd = args.slice(3);
      if (cmd[1] === 'get' && cmd[3] === 'font_scale') {
        releaseRead();
        await waitRead;
        return `${state.fontScale}\n`;
      }
      if (cmd[1] === 'put' && cmd[3] === 'font_scale') {
        state.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const settings = new DeviceSettings({ adb });

    const setPromise = settings.setDisplayOptions('emulator-5554', { fontScale: 1.5 });
    await readStarted;
    // Trigger restore WHILE the first font_scale read is still pending.
    const restorePromise = settings.restore('emulator-5554');
    allowReadFinish();

    await setPromise;
    const restoreResult = await restorePromise;
    expect(restoreResult).toEqual({
      restored: true,
      settings: ['fontScale'],
      outstanding: [],
      errors: [],
    });
    expect(state.fontScale).toBe('1.0');
    expect(settings.hasTracked('emulator-5554')).toBe(false);

    // Same serialization guarantee during close(): drains in-flight setter and restores its recorded original.
    let releaseCloseRead!: () => void;
    const closeReadStarted = new Promise<void>((resolve) => {
      releaseCloseRead = resolve;
    });
    let finishCloseRead!: () => void;
    const waitCloseRead = new Promise<void>((resolve) => {
      finishCloseRead = resolve;
    });
    const closeState = { fontScale: '1.0' };
    const closeAdb = new FakeAdb(async (args) => {
      const cmd = args.slice(3);
      if (cmd[1] === 'get' && cmd[3] === 'font_scale') {
        releaseCloseRead();
        await waitCloseRead;
        return `${closeState.fontScale}\n`;
      }
      if (cmd[1] === 'put' && cmd[3] === 'font_scale') {
        closeState.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const closeSettings = new DeviceSettings({ adb: closeAdb });
    const inFlight = closeSettings.setDisplayOptions('emulator-5554', { fontScale: 2.0 });
    await closeReadStarted;
    const closing = closeSettings.close();
    finishCloseRead();
    await inFlight;
    await closing;
    expect(closeState.fontScale).toBe('1.0');
    expect(closeSettings.hasTracked('emulator-5554')).toBe(false);
  });

  it('does not coalesce a later restore onto an earlier restore when a setter was queued in between', async () => {
    let releaseFirstRestore!: () => void;
    const firstRestoreStarted = new Promise<void>((resolve) => {
      releaseFirstRestore = resolve;
    });
    let allowFirstRestoreFinish!: () => void;
    const waitFirstRestore = new Promise<void>((resolve) => {
      allowFirstRestoreFinish = resolve;
    });

    const state = { fontScale: '1.0' };
    let restorePuts = 0;
    const adb = new FakeAdb(async (args) => {
      const cmd = args.slice(3);
      if (cmd[1] === 'get' && cmd[3] === 'font_scale') return `${state.fontScale}\n`;
      if (cmd[1] === 'put' && cmd[3] === 'font_scale') {
        if (cmd[4] === '1.0' && restorePuts === 0) {
          restorePuts += 1;
          releaseFirstRestore();
          await waitFirstRestore;
        }
        state.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const settings = new DeviceSettings({ adb });
    await settings.setDisplayOptions('emulator-5554', { fontScale: 1.4 });
    expect(state.fontScale).toBe('1.4');

    // Queue: restore -> set(1.7) -> restore. Second restore must run AFTER set(1.7), not coalesce onto restore #1.
    const firstRestore = settings.restore('emulator-5554');
    await firstRestoreStarted;
    const midSet = settings.setDisplayOptions('emulator-5554', { fontScale: 1.7 });
    const secondRestore = settings.restore('emulator-5554');
    allowFirstRestoreFinish();

    const [r1, setOutcome, r2] = await Promise.all([firstRestore, midSet, secondRestore]);
    expect(r1).toMatchObject({ restored: true, settings: ['fontScale'], outstanding: [] });
    expect(setOutcome).toMatchObject({ applied: { fontScale: 1.7 }, recordedOriginal: true });
    expect(r2).toMatchObject({ restored: true, settings: ['fontScale'], outstanding: [] });
    expect(state.fontScale).toBe('1.0');
    expect(settings.hasTracked('emulator-5554')).toBe(false);
  });

  it('acts as a restore barrier on stop_session during pending initial read, surfaces restore failure on shutdown_emulator, and reports close() timeout', async () => {
    // 1. stop_session called while first font_scale read is still pending waits for the setter and restores original.
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      readStartedResolve = resolve;
    });
    let allowRead!: () => void;
    const waitRead = new Promise<void>((resolve) => {
      allowRead = resolve;
    });
    const stopState = { fontScale: '1.0' };
    const stopAdb = new FakeAdb(async (args) => {
      const cmd = args.slice(3);
      if (cmd[1] === 'get' && cmd[3] === 'font_scale') {
        readStartedResolve();
        await waitRead;
        return `${stopState.fontScale}\n`;
      }
      if (cmd[1] === 'put' && cmd[3] === 'font_scale') {
        stopState.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const stopAgent = fakeAgent({}, { adb: stopAdb });
    const pendingSet = callTool(stopAgent.ctx, 'set_display_options', { fontScale: 1.6 }, true);
    await readStarted;
    const stopping = callTool(stopAgent.ctx, 'stop_session', {}, false);
    allowRead();

    await pendingSet;
    const stopResult = await stopping;
    expect(stopResult).toMatchObject({
      ok: true,
      result: {
        session: { status: 'idle' },
        deviceSettings: { restored: ['fontScale'], outstanding: [] },
      },
    });
    expect(stopState.fontScale).toBe('1.0');
    expect(stopAgent.ctx.deviceSettings.hasTracked('emulator-5554')).toBe(false);

    // 2. Real EmulatorManager + createLionscopeServer shutdown flow (Finding #1):
    // - Unmanaged emulator without confirm: refuses BEFORE restoring settings (font_scale stays 1.4, zero restores).
    // - With confirm: true when restore fails: single restore attempt, refuses shutdown without force, emulator stays up.
    // - With confirm: true, force: true: proceeds with shutdown and reports outstanding settings.
    const root = mkdtempSync(path.join(tmpdir(), 'lionscope-emu-unmanaged-'));
    const discoveryDir = path.join(root, 'running');
    const avdHome = path.join(root, 'avd');
    mkdirSync(discoveryDir, { mode: 0o700 });
    mkdirSync(avdHome, { mode: 0o700 });
    writeFileSync(
      path.join(discoveryDir, 'pid_99.ini'),
      'port.serial=5554\ngrpc.port=8554\ngrpc.token=tok\navd.id=Pixel_9\n',
      { mode: 0o600 },
    );
    let failRestore = true;
    let restoreAttempts = 0;
    const emuState = { fontScale: '1.0' };
    const emuAdb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice model:Pixel\n';
      if (args[2] === 'emu' && args[3] === 'avd' && args[4] === 'name') return 'Pixel_9\nOK\n';
      if (cmd[0] === 'settings' && cmd[1] === 'get' && cmd[3] === 'font_scale')
        return `${emuState.fontScale}\n`;
      if (cmd[0] === 'settings' && cmd[1] === 'put' && cmd[3] === 'font_scale') {
        if (cmd[4] === '1.0') {
          restoreAttempts += 1;
          if (failRestore) throw new Error('adb transport closed');
        }
        emuState.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const fakeClient = new FakeEmulatorClient();
    const emulatorHost: EmulatorHost = {
      emulatorPath: '/fake/emulator',
      createClient: () => fakeClient,
      avdHome,
      discoveryDirs: [discoveryDir],
      runEmulator: async () => 'Pixel_9\n',
      spawnEmulator: () =>
        Object.assign(new EventEmitter(), { pid: 99, kill: () => true }) as unknown as EmulatorProcess,
      isAlive: (pid) => pid === 99,
      isPortFree: async () => true,
    };
    const server = createLionscopeServer({
      port: 0,
      devicePort: 0,
      adb: emuAdb,
      devicePollMs: 60_000,
      emulatorPollMs: 60_000,
      emulatorHost,
    });
    try {
      await server.manager.refreshDevices();
      await server.emulators.refresh();
      const ctx = { ...server.agent, deviceControl: true, networkBodies: false };
      await callTool(ctx, 'set_display_options', { fontScale: 1.4 }, true);
      expect(emuState.fontScale).toBe('1.4');

      // Refused unmanaged shutdown without confirm MUST NOT restore or touch font_scale.
      expect(await callTool(ctx, 'shutdown_emulator', { avdName: 'Pixel_9' }, true)).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('not started by Lionscope'),
      });
      expect(restoreAttempts).toBe(0);
      expect(emuState.fontScale).toBe('1.4');
      expect(fakeClient.shutdowns).toBe(0);

      // Confirmed non-forced shutdown runs restore ONCE and refuses shutdown while settings are outstanding.
      expect(
        await callTool(ctx, 'shutdown_emulator', { avdName: 'Pixel_9', confirm: true }, true),
      ).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('fontScale'),
      });
      expect(restoreAttempts).toBe(1);
      expect(fakeClient.shutdowns).toBe(0);

      // Confirmed + forced shutdown overrides cleanup failure, shuts down emulator, and reports outstanding settings.
      expect(
        await callTool(ctx, 'shutdown_emulator', { avdName: 'Pixel_9', confirm: true, force: true }, true),
      ).toMatchObject({
        ok: true,
        result: {
          changed: true,
          deviceSettings: {
            restored: [],
            outstanding: ['fontScale'],
            errors: [expect.stringContaining('adb transport closed')],
          },
        },
      });
      expect(restoreAttempts).toBe(2);
      expect(fakeClient.shutdowns).toBe(1);
      failRestore = false;
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }

    // 3. close(timeoutMs) warns and reports abandoned serials when cleanup hits the shutdown deadline.
    const hungAdb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (cmd[1] === 'get' && cmd[3] === 'font_scale') return '1.0\n';
      if (cmd[1] === 'put' && cmd[3] === 'font_scale' && cmd[4] === '1.5') return '';
      if (cmd[1] === 'put' && cmd[3] === 'font_scale' && cmd[4] === '1.0') return new Promise(() => {});
      return '';
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const hungSettings = new DeviceSettings({ adb: hungAdb });
      await hungSettings.setDisplayOptions('emulator-5554', { fontScale: 1.5 });
      const closeOutcome = await hungSettings.close(40);
      expect(closeOutcome).toEqual({
        timedOut: true,
        abandoned: [{ serial: 'emulator-5554', inFlight: true, outstanding: ['fontScale'] }],
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('emulator-5554'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves originals after uncertain dark-mode write, surfaces partial restore failures on stop_session, and retries on reconnect', async () => {
    // 1. Uncertain dark-mode write (timeout): original darkMode remains tracked.
    let failNightPut = true;
    const nightState = { night: 'no' };
    const uncertainAdb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (cmd[0] === 'cmd' && cmd[1] === 'uimode' && cmd[2] === 'night') {
        if (!cmd[3]) return `Night mode: ${nightState.night}\n`;
        if (failNightPut) throw new Error('adb timed out');
        nightState.night = cmd[3];
        return `Night mode: ${nightState.night}\n`;
      }
      return '';
    });
    const uncertainAgent = fakeAgent({}, { adb: uncertainAdb });
    expect(
      await callTool(uncertainAgent.ctx, 'set_display_options', { darkMode: 'dark' }, true),
    ).toMatchObject({ ok: false, code: 'failed' });
    expect(uncertainAgent.ctx.deviceSettings.tracked('emulator-5554')).toEqual(['darkMode']);

    failNightPut = false;
    expect(await callTool(uncertainAgent.ctx, 'restore_device_settings', {}, true)).toEqual({
      ok: true,
      result: { serial: 'emulator-5554', restored: true, settings: ['darkMode'], outstanding: [] },
    });

    // 2. Partial restore failure surfaced by stop_session, then retried automatically when device reconnects.
    let failFontRestore = true;
    const partialState = { night: 'no', fontScale: '1.0' };
    const partialAdb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (cmd[0] === 'cmd' && cmd[1] === 'uimode' && cmd[2] === 'night') {
        if (cmd[3]) partialState.night = cmd[3];
        return `Night mode: ${partialState.night}\n`;
      }
      if (cmd[0] === 'settings' && cmd[1] === 'get' && cmd[3] === 'font_scale') {
        return `${partialState.fontScale}\n`;
      }
      if (cmd[0] === 'settings' && cmd[1] === 'put' && cmd[3] === 'font_scale') {
        if (cmd[4] === '1.0' && failFontRestore) throw new Error('device offline');
        partialState.fontScale = cmd[4] ?? '';
        return '';
      }
      return '';
    });
    const partialAgent = fakeAgent({}, { adb: partialAdb });
    await callTool(partialAgent.ctx, 'set_display_options', { darkMode: 'dark', fontScale: 1.5 }, true);

    const stopOutcome = await callTool(partialAgent.ctx, 'stop_session', {}, false);
    expect(stopOutcome).toMatchObject({
      ok: true,
      result: {
        session: { status: 'idle' },
        deviceSettings: {
          restored: ['darkMode'],
          outstanding: ['fontScale'],
          errors: [expect.stringContaining('fontScale: device offline')],
        },
      },
    });
    expect(partialState.night).toBe('no');
    expect(partialState.fontScale).toBe('1.5');

    // Device drops then reconnects -> DeviceSettings.setDevices retries restore automatically.
    const idle = { ...RUNNING, status: 'idle' as const };
    partialAgent.ctx.deviceSettings.setDevices([], () => idle);
    failFontRestore = false;
    partialAgent.ctx.deviceSettings.setDevices(
      [{ serial: 'emulator-5554', state: 'device', model: 'Pixel' }],
      () => idle,
    );
    await partialAgent.ctx.deviceSettings.restore('emulator-5554');
    expect(partialState.fontScale).toBe('1.0');
    expect(partialAgent.ctx.deviceSettings.hasTracked('emulator-5554')).toBe(false);
  });

  it('restores tracked device settings before shutting down a Lionscope-owned emulator on server close', async () => {
    const order: string[] = [];
    const root = mkdtempSync(path.join(tmpdir(), 'lionscope-emu-restore-'));
    const discoveryDir = path.join(root, 'running');
    const avdHome = path.join(root, 'avd');
    mkdirSync(discoveryDir, { mode: 0o700 });
    mkdirSync(avdHome, { mode: 0o700 });
    writeFileSync(
      path.join(discoveryDir, 'pid_42.ini'),
      'port.serial=5554\ngrpc.port=8554\ngrpc.token=tok\navd.id=Pixel_9\n',
      { mode: 0o600 },
    );

    const adb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice model:Pixel\n';
      if (args[2] === 'emu' && args[3] === 'avd' && args[4] === 'name') return 'Pixel_9\nOK\n';
      if (cmd[0] === 'settings' && cmd[1] === 'get' && cmd[3] === 'font_scale') return '1.0\n';
      if (cmd[0] === 'settings' && cmd[1] === 'put' && cmd[3] === 'font_scale') {
        if (cmd[4] === '1.0') order.push('restore_font_scale');
        return '';
      }
      return '';
    });
    const fakeClient = new FakeEmulatorClient();
    const originalShutdown = fakeClient.shutdown.bind(fakeClient);
    fakeClient.shutdown = () => {
      order.push('emulator_shutdown');
      return originalShutdown();
    };
    const emulatorHost: EmulatorHost = {
      emulatorPath: '/fake/emulator',
      createClient: () => fakeClient,
      avdHome,
      discoveryDirs: [discoveryDir],
      runEmulator: async () => 'Pixel_9\n',
      spawnEmulator: () =>
        Object.assign(new EventEmitter(), { pid: 42, kill: () => true }) as unknown as EmulatorProcess,
      isAlive: (pid) => pid === 42,
      isPortFree: async () => true,
    };

    try {
      const server = createLionscopeServer({
        port: 0,
        devicePort: 0,
        adb,
        devicePollMs: 60_000,
        emulatorPollMs: 60_000,
        emulatorHost,
      });

      await server.manager.refreshDevices();
      await server.agent.deviceSettings.setDisplayOptions('emulator-5554', { fontScale: 1.5 });
      await server.emulators.refresh();
      await server.emulators.shutdown('Pixel_9', true);
      await server.close();
      expect(order).toEqual(['restore_font_scale', 'emulator_shutdown']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes unset originals on restore, reports API < 29 clearly, and enforces validation and device control', async () => {
    const { adb, state } = envAdb({ night: 'no', fontScale: 'null' });
    const agent = fakeAgent({}, { adb });

    expect(
      await callTool(agent.ctx, 'set_display_options', { darkMode: 'dark', fontScale: 1.5 }, true),
    ).toMatchObject({
      ok: true,
      result: {
        serial: 'emulator-5554',
        applied: { darkMode: 'dark', fontScale: 1.5 },
        recordedOriginal: true,
        trackedSettings: ['darkMode', 'fontScale'],
      },
    });
    expect(await callTool(agent.ctx, 'restore_device_settings', {}, true)).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        restored: true,
        settings: ['darkMode', 'fontScale'],
        outstanding: [],
      },
    });
    expect(state).toMatchObject({ night: 'no', fontScale: 'null' });
    expect(adb.execCalls).toContainEqual([
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'delete',
      'system',
      'font_scale',
    ]);

    // Also verify stop_session deletes unset font_scale after multiple changes and never writes 1.0.
    const unsetStop = envAdb({ fontScale: 'null' });
    const unsetStopAgent = fakeAgent({}, { adb: unsetStop.adb });
    await callTool(unsetStopAgent.ctx, 'set_display_options', { fontScale: 1.5 }, true);
    await callTool(unsetStopAgent.ctx, 'set_display_options', { fontScale: 1.3 }, true);
    expect(await callTool(unsetStopAgent.ctx, 'stop_session', {}, false)).toMatchObject({
      ok: true,
      result: { deviceSettings: { restored: ['fontScale'], outstanding: [] } },
    });
    expect(unsetStop.state.fontScale).toBe('null');
    expect(unsetStop.adb.execCalls).toContainEqual([
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'delete',
      'system',
      'font_scale',
    ]);
    expect(
      unsetStop.adb.execCalls.some(
        (call) =>
          call[3] === 'settings' && call[4] === 'put' && call[6] === 'font_scale' && call[7] === '1.0',
      ),
    ).toBe(false);

    // Model Android's async writeback of `font_scale=1.0` after `settings delete system font_scale`:
    // do NOT loop on delete; read back once, treat default 1.0 as restored with an explanatory note, and
    // treat a non-default readback (still 1.5) as outstanding.
    let writebackValue = '1.0';
    let fontScale = 'null';
    let deleteCount = 0;
    const writebackAdb = new FakeAdb((args) => {
      const cmd = args.slice(3);
      if (cmd[0] === 'settings' && cmd[1] === 'get' && cmd[3] === 'font_scale') return `${fontScale}\n`;
      if (cmd[0] === 'settings' && cmd[1] === 'put' && cmd[3] === 'font_scale') {
        fontScale = cmd[4] ?? '';
        return '';
      }
      if (cmd[0] === 'settings' && cmd[1] === 'delete' && cmd[3] === 'font_scale') {
        deleteCount += 1;
        // Android's FontScaleSettingObserver rewrites default 1.0 (or fails to revert) right after delete.
        fontScale = writebackValue;
        return 'Deleted 1 rows\n';
      }
      return '';
    });
    const wbAgent = fakeAgent({}, { adb: writebackAdb });
    wbAgent.ctx.deviceSettings = new DeviceSettings({ adb: writebackAdb, fontScaleSettleMs: 0 });
    await callTool(wbAgent.ctx, 'set_display_options', { fontScale: 1.5 }, true);
    expect(await callTool(wbAgent.ctx, 'restore_device_settings', {}, true)).toEqual({
      ok: true,
      result: {
        serial: 'emulator-5554',
        restored: true,
        settings: ['fontScale'],
        outstanding: [],
        note: expect.stringContaining('persisted the default effective scale (1.0)'),
      },
    });
    expect(deleteCount).toBe(1);
    expect(wbAgent.ctx.deviceSettings.hasTracked('emulator-5554')).toBe(false);

    // Non-default readback after delete stays outstanding and reports an error.
    fontScale = 'null';
    writebackValue = '1.5';
    deleteCount = 0;
    await callTool(wbAgent.ctx, 'set_display_options', { fontScale: 1.5 }, true);
    expect(await callTool(wbAgent.ctx, 'restore_device_settings', {}, true)).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('outstanding: fontScale'),
    });
    expect(deleteCount).toBe(1);
    expect(wbAgent.ctx.deviceSettings.tracked('emulator-5554')).toEqual(['fontScale']);

    // Unsupported cmd uimode night reports a clear error without claiming an API 29+ requirement.
    const legacy = envAdb({ nightUnsupported: true });
    const legacyAgent = fakeAgent({}, { adb: legacy.adb });
    const legacyOutcome = await callTool(legacyAgent.ctx, 'set_display_options', { darkMode: 'dark' }, true);
    expect(legacyOutcome).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringContaining('cmd uimode night'),
    });
    if (!legacyOutcome.ok) expect(legacyOutcome.error).not.toContain('API 29');
    expect(legacyAgent.ctx.deviceSettings.hasTracked('emulator-5554')).toBe(false);

    expect(await callTool(agent.ctx, 'set_orientation', { orientation: 'upside_down' }, true)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    expect(await callTool(agent.ctx, 'set_display_options', {}, true)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    expect(await callTool(agent.ctx, 'set_display_options', { fontScale: 5 }, true)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    for (const [name, args] of [
      ['set_orientation', { orientation: 'landscape' }],
      ['set_display_options', { fontScale: 1.2 }],
      ['restore_device_settings', {}],
    ] as const) {
      expect(await callTool(agent.ctx, name, args, false)).toEqual({
        ok: false,
        code: 'forbidden',
        error: DEVICE_CONTROL_DISABLED,
      });
    }
  });
});

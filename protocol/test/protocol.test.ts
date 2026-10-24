// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PROTOCOL_V2,
  DEVICE_PROTOCOL_V3,
  DEVICE_PROTOCOL_V4,
  isValidAvdName,
  isValidPackageName,
  isValidProcessName,
  isValidSerial,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_DEVICE_PROTOCOL_VERSION,
  MAX_INSPECTOR_NODES,
  MAX_INSPECTOR_WINDOWS,
  MAX_SCREEN_CLIENT_MESSAGE_BYTES,
  MAX_SCREEN_CLIPBOARD_BYTES,
  MAX_SCREEN_KEY_CHARS,
  MAX_SCREEN_SOCKET_FRAME_BYTES,
  MAX_SCREEN_TEXT_CHARS,
  MAX_SCREEN_WHEEL_DELTA,
  MAX_SDK_FRAMES_PER_BATCH,
  MAX_STACK_FRAMES,
  MAX_VIEW_PATH_NODES,
  MAX_VIEW_TREE_CLASSES,
  MAX_TOUCH_POINTS,
  MIN_DEVICE_PROTOCOL_VERSION,
  parseClientMessage,
  parseDeviceMessage,
  parseScreenClientMessage,
  SCREEN_SIZES,
  STALL_THRESHOLDS_MS,
} from '../src/index.ts';
import type { DeviceMessage, SdkFrame, StackFrame } from '../src/index.ts';

const GOLDEN_LINES = readFileSync(new URL('../fixtures/device-messages.ndjson', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

describe('isValidSerial', () => {
  it.each(['emulator-5554', 'R58M123ABC', '192.168.1.5:5555', 'adb-R58M._adb-tls-connect._tcp'])(
    'accepts %s',
    (serial) => {
      expect(isValidSerial(serial)).toBe(true);
    },
  );

  it.each(['', 'a b', 'emu;rm -rf /', '$(id)', 'x'.repeat(129), "emu'1"])('rejects %j', (serial) => {
    expect(isValidSerial(serial)).toBe(false);
  });
});

describe('isValidPackageName', () => {
  it.each(['com.example.shop', 'com.google.android.apps.nexuslauncher', 'a.b', 'com.ex_ample.app1'])(
    'accepts %s',
    (name) => {
      expect(isValidPackageName(name)).toBe(true);
    },
  );

  it.each([
    '',
    'single',
    'com..app',
    '1com.app',
    'com.app;id',
    'com.app && reboot',
    'com.app$(x)',
    'com.1app',
  ])('rejects %j', (name) => {
    expect(isValidPackageName(name)).toBe(false);
  });
});

describe('parseClientMessage', () => {
  it('parses a valid startSession message', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'startSession', serial: 'emulator-5554', packageName: 'com.example.app' }),
    );
    expect(result).toEqual({
      ok: true,
      value: { type: 'startSession', serial: 'emulator-5554', packageName: 'com.example.app' },
    });
  });

  it('parses messages without payload', () => {
    expect(parseClientMessage('{"type":"stopSession"}')).toEqual({
      ok: true,
      value: { type: 'stopSession' },
    });
    expect(parseClientMessage('{"type":"refreshDevices"}')).toEqual({
      ok: true,
      value: { type: 'refreshDevices' },
    });
  });

  it('rejects invalid JSON', () => {
    expect(parseClientMessage('{nope')).toEqual({ ok: false, error: 'invalid JSON' });
  });

  it('parses setSdkOptions with any non-empty subset of the options', () => {
    const parse = (value: object) => parseClientMessage(JSON.stringify({ type: 'setSdkOptions', ...value }));
    for (const stallThresholdMs of STALL_THRESHOLDS_MS) {
      expect(parse({ stallThresholdMs })).toEqual({
        ok: true,
        value: { type: 'setSdkOptions', stallThresholdMs },
      });
    }
    expect(parse({ strictMode: true })).toEqual({
      ok: true,
      value: { type: 'setSdkOptions', strictMode: true },
    });
    expect(parse({ inflateTracking: false })).toEqual({
      ok: true,
      value: { type: 'setSdkOptions', inflateTracking: false },
    });
    expect(parse({ rxTracking: false })).toEqual({
      ok: true,
      value: { type: 'setSdkOptions', rxTracking: false },
    });
    expect(parse({ stallThresholdMs: 500, strictMode: false, inflateTracking: true }).ok).toBe(true);
  });

  it('rejects setSdkOptions without options, with an unlisted threshold or with extra fields', () => {
    const parse = (value: object) => parseClientMessage(JSON.stringify({ type: 'setSdkOptions', ...value }));
    expect(parse({})).toEqual({ ok: false, error: 'no SDK option given' });
    for (const stallThresholdMs of [0, 1, 149, 150.5, 2000, '150', null]) {
      expect(parse({ stallThresholdMs }).ok).toBe(false);
    }
    expect(parse({ strictMode: 'yes' }).ok).toBe(false);
    expect(parse({ inflateTracking: 'no' }).ok).toBe(false);
    expect(parse({ inflateTracking: 1 }).ok).toBe(false);
    expect(parse({ rxTracking: 'off' }).ok).toBe(false);
    expect(parse({ strictMode: true, extra: 1 }).ok).toBe(false);
  });

  it('rejects unknown message types', () => {
    expect(parseClientMessage('{"type":"rm"}').ok).toBe(false);
  });

  it('rejects unexpected extra fields', () => {
    expect(parseClientMessage('{"type":"stopSession","cmd":"reboot"}').ok).toBe(false);
  });

  it('rejects shell metacharacters in identifiers', () => {
    const result = parseClientMessage(
      JSON.stringify({ type: 'startSession', serial: 'emulator-5554', packageName: 'com.app;reboot' }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects oversized messages', () => {
    const result = parseClientMessage(
      `{"type":"listApps","serial":"${'a'.repeat(MAX_CLIENT_MESSAGE_BYTES)}"}`,
    );
    expect(result).toEqual({ ok: false, error: 'message too large' });
  });

  it('measures the size in UTF-8 bytes, not UTF-16 code units', () => {
    // 1500 × "é" = 1500 code units but 3000 bytes; 2100 of them exceed the 4096-byte limit.
    const fits = parseClientMessage(`{"type":"stopSession","x":"${'é'.repeat(1500)}"}`);
    expect(fits).toEqual({ ok: false, error: expect.not.stringContaining('too large') });
    const tooBig = `{"type":"stopSession","x":"${'é'.repeat(2100)}"}`;
    expect(tooBig.length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(tooBig)).toEqual({ ok: false, error: 'message too large' });
  });
});

describe('Inspector client messages', () => {
  const snapshotId = '0123456789abcdef';

  it('parses inspect and selectInspectorNode (a node or null)', () => {
    expect(parseClientMessage('{"type":"inspect","serial":"emulator-5554"}')).toEqual({
      ok: true,
      value: { type: 'inspect', serial: 'emulator-5554' },
    });
    for (const nodeId of [0, MAX_INSPECTOR_NODES - 1, null]) {
      const message = { type: 'selectInspectorNode', snapshotId, nodeId };
      expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
    }
  });

  it('parses inspectorFocus with a serial or null', () => {
    for (const serial of ['emulator-5554', 'R58M123ABC', null]) {
      const message = { type: 'inspectorFocus', serial };
      expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
    }
  });

  it('rejects bad serials, snapshot ids, node ids and extra fields', () => {
    for (const message of [
      { type: 'inspect', serial: 'emulator-5554; reboot' },
      { type: 'inspect' },
      { type: 'inspect', serial: 'emulator-5554', all: true },
      { type: 'selectInspectorNode', snapshotId: '../etc', nodeId: 1 },
      { type: 'selectInspectorNode', snapshotId: snapshotId.toUpperCase(), nodeId: 1 },
      { type: 'selectInspectorNode', snapshotId, nodeId: -1 },
      { type: 'selectInspectorNode', snapshotId, nodeId: MAX_INSPECTOR_NODES },
      { type: 'selectInspectorNode', snapshotId, nodeId: 1.5 },
      { type: 'selectInspectorNode', snapshotId },
      { type: 'inspectorFocus', serial: 'emulator-5554; reboot' },
      { type: 'inspectorFocus', serial: '' },
      { type: 'inspectorFocus' },
      { type: 'inspectorFocus', serial: 'emulator-5554', tab: 'inspector' },
    ]) {
      expect(parseClientMessage(JSON.stringify(message)).ok).toBe(false);
    }
  });
});

describe('emulator messages', () => {
  it.each(['Pixel_9a', 'Medium_Phone_API_36.1', 'tv-1080p', 'a'])('accepts the AVD name %s', (name) => {
    expect(isValidAvdName(name)).toBe(true);
  });

  it.each(['', 'Pixel 9a', '-no-window', '-wipe-data', '../evil', 'a;b', '$(id)', 'x'.repeat(129)])(
    'rejects the AVD name %j',
    (name) => {
      expect(isValidAvdName(name)).toBe(false);
    },
  );

  it('parses bootEmulator in both modes and shutdownEmulator', () => {
    for (const mode of ['quick', 'cold'] as const) {
      expect(parseClientMessage(JSON.stringify({ type: 'bootEmulator', avdName: 'Pixel_9a', mode }))).toEqual(
        {
          ok: true,
          value: { type: 'bootEmulator', avdName: 'Pixel_9a', mode },
        },
      );
    }
    expect(parseClientMessage('{"type":"shutdownEmulator","avdName":"Pixel_9a"}')).toEqual({
      ok: true,
      value: { type: 'shutdownEmulator', avdName: 'Pixel_9a' },
    });
    expect(
      parseClientMessage('{"type":"shutdownEmulator","avdName":"Pixel_9a","confirmUnmanaged":true}'),
    ).toEqual({
      ok: true,
      value: { type: 'shutdownEmulator', avdName: 'Pixel_9a', confirmUnmanaged: true },
    });
  });

  it('rejects an invalid AVD name, an unknown boot mode and extra fields', () => {
    const boot = (value: object) => parseClientMessage(JSON.stringify({ type: 'bootEmulator', ...value }));
    expect(boot({ avdName: 'Pixel 9a', mode: 'quick' })).toEqual({ ok: false, error: 'invalid AVD name' });
    expect(boot({ avdName: 'Pixel_9a', mode: 'warm' }).ok).toBe(false);
    expect(boot({ avdName: 'Pixel_9a' }).ok).toBe(false);
    expect(boot({ avdName: 'Pixel_9a', mode: 'quick', args: ['-wipe-data'] }).ok).toBe(false);
    expect(parseClientMessage('{"type":"shutdownEmulator","avdName":"$(id)"}').ok).toBe(false);
    const shutdown = (value: object) =>
      parseClientMessage(JSON.stringify({ type: 'shutdownEmulator', ...value }));
    expect(shutdown({ avdName: 'Pixel_9a', confirmUnmanaged: 'yes' }).ok).toBe(false);
    expect(boot({ avdName: '-no-snapshot-save', mode: 'quick' })).toEqual({
      ok: false,
      error: 'invalid AVD name',
    });
  });
});

describe('parseScreenClientMessage', () => {
  const parse = (value: object) => parseScreenClientMessage(JSON.stringify(value));
  const point = (id: number, extra: object = {}) => ({ id, x: 0.5, y: 0.25, pressure: 1, ...extra });

  it('parses every message type', () => {
    const messages = [
      { type: 'touch', touches: [point(0), point(1, { pressure: 0 })] },
      { type: 'wheel', x: 0, y: 1, dx: 0, dy: -120 },
      { type: 'key', key: 'Enter', eventType: 'keydown' },
      { type: 'key', key: 'a', eventType: 'keypress' },
      { type: 'text', text: 'hello world\n' },
      { type: 'nav', button: 'recents' },
      { type: 'rotate', direction: 'left' },
      { type: 'screenshot' },
      { type: 'keyFrame' },
      ...SCREEN_SIZES.map((size) => ({ type: 'setSize', size })),
    ];
    for (const message of messages) expect(parse(message)).toEqual({ ok: true, value: message });
  });

  it('accepts up to MAX_TOUCH_POINTS distinct fingers and ids 0..MAX_TOUCH_POINTS-1', () => {
    const touches = Array.from({ length: MAX_TOUCH_POINTS }, (_, id) => point(id));
    expect(parse({ type: 'touch', touches }).ok).toBe(true);
    expect(parse({ type: 'touch', touches: [...touches, point(0)] }).ok).toBe(false);
    expect(parse({ type: 'touch', touches: [] }).ok).toBe(false);
  });

  it('rejects duplicate ids, out-of-range ids, coordinates and pressures', () => {
    expect(parse({ type: 'touch', touches: [point(3), point(3)] })).toEqual({
      ok: false,
      error: 'duplicate id',
    });
    for (const bad of [
      point(-1),
      point(MAX_TOUCH_POINTS),
      point(1.5),
      point(0, { x: -0.01 }),
      point(0, { y: 1.01 }),
      point(0, { pressure: 2 }),
      point(0, { x: '0.5' }),
      point(0, { extra: true }),
    ]) {
      expect(parse({ type: 'touch', touches: [bad] }).ok).toBe(false);
    }
    // 1e999 parses to Infinity.
    expect(
      parseScreenClientMessage('{"type":"touch","touches":[{"id":0,"x":1e999,"y":0,"pressure":1}]}').ok,
    ).toBe(false);
  });

  it('bounds wheel deltas and positions', () => {
    const wheel = (value: object) => parse({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 0, ...value });
    expect(wheel({ dy: MAX_SCREEN_WHEEL_DELTA }).ok).toBe(true);
    expect(wheel({ dy: MAX_SCREEN_WHEEL_DELTA + 1 }).ok).toBe(false);
    expect(wheel({ dx: -MAX_SCREEN_WHEEL_DELTA - 1 }).ok).toBe(false);
    expect(wheel({ x: 2 }).ok).toBe(false);
  });

  it('bounds keys and text and refuses control characters', () => {
    expect(parse({ type: 'key', key: 'x'.repeat(MAX_SCREEN_KEY_CHARS), eventType: 'keyup' }).ok).toBe(true);
    expect(parse({ type: 'key', key: 'x'.repeat(MAX_SCREEN_KEY_CHARS + 1), eventType: 'keyup' }).ok).toBe(
      false,
    );
    expect(parse({ type: 'key', key: '', eventType: 'keyup' }).ok).toBe(false);
    expect(parse({ type: 'key', key: '\u0000', eventType: 'keyup' }).ok).toBe(false);
    expect(parse({ type: 'key', key: 'a', eventType: 'click' }).ok).toBe(false);
    expect(parse({ type: 'text', text: 'é'.repeat(MAX_SCREEN_TEXT_CHARS) }).ok).toBe(true);
    expect(parse({ type: 'text', text: 'x'.repeat(MAX_SCREEN_TEXT_CHARS + 1) }).ok).toBe(false);
    expect(parse({ type: 'text', text: '' }).ok).toBe(false);
    expect(parse({ type: 'text', text: 'tab\tok' }).ok).toBe(true);
    expect(parse({ type: 'text', text: 'bell\u0007' }).ok).toBe(false);
    expect(parse({ type: 'text', text: 'bidi‮' }).ok).toBe(false);
  });

  it('rejects unknown buttons, directions, sizes and types', () => {
    expect(parse({ type: 'nav', button: 'menu' }).ok).toBe(false);
    expect(parse({ type: 'rotate', direction: 'up' }).ok).toBe(false);
    expect(parse({ type: 'setSize', size: 1080 }).ok).toBe(false);
    expect(parse({ type: 'setSize', size: '540' }).ok).toBe(false);
    expect(parse({ type: 'screenshot', full: true }).ok).toBe(false);
    expect(parse({ type: 'keyFrame', now: true }).ok).toBe(false);
    expect(parse({ type: 'startSession' }).ok).toBe(false);
    expect(parseScreenClientMessage('{nope')).toEqual({ ok: false, error: 'invalid JSON' });
  });

  it('rejects messages over MAX_SCREEN_CLIENT_MESSAGE_BYTES', () => {
    const raw = JSON.stringify({ type: 'text', text: 'é'.repeat(MAX_SCREEN_CLIENT_MESSAGE_BYTES / 2) });
    expect(parseScreenClientMessage(raw)).toEqual({ ok: false, error: 'message too large' });
  });
});

describe('screen clipboard messages', () => {
  const parse = (value: object) => parseScreenClientMessage(JSON.stringify(value));

  it('parses clipboardSync, clipboard and paste with any Unicode, newlines and tabs', () => {
    for (const message of [
      { type: 'clipboardSync', enabled: true },
      { type: 'clipboardSync', enabled: false },
      { type: 'clipboard', text: 'héllo 👋\n\tworld' },
      { type: 'paste', text: '日本語\u202e' },
    ]) {
      expect(parse(message)).toEqual({ ok: true, value: message });
    }
  });

  it('caps clipboard text at MAX_SCREEN_CLIPBOARD_BYTES of UTF-8 and refuses NUL or empty text', () => {
    expect(parse({ type: 'clipboard', text: 'x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES) }).ok).toBe(true);
    expect(parse({ type: 'paste', text: 'x'.repeat(MAX_SCREEN_CLIPBOARD_BYTES + 1) }).ok).toBe(false);
    // 2 bytes each: fits in characters, not in bytes.
    const wide = 'é'.repeat(MAX_SCREEN_CLIPBOARD_BYTES / 2 + 1);
    expect(parse({ type: 'clipboard', text: wide })).toEqual({
      ok: false,
      error: 'clipboard text too large',
    });
    expect(parse({ type: 'clipboard', text: 'a\u0000b' })).toEqual({ ok: false, error: 'NUL character' });
    expect(parse({ type: 'paste', text: '' }).ok).toBe(false);
    expect(parse({ type: 'clipboardSync', enabled: 'yes' }).ok).toBe(false);
    expect(parse({ type: 'clipboard', text: 'a', extra: 1 }).ok).toBe(false);
  });

  it('allows the larger frame for clipboard and paste only', () => {
    const big = 'x'.repeat(MAX_SCREEN_CLIENT_MESSAGE_BYTES * 2);
    expect(parse({ type: 'paste', text: big }).ok).toBe(true);
    // Too large for its type, whatever the content.
    expect(parse({ type: 'text', text: 'a', pad: big })).toEqual({ ok: false, error: 'message too large' });
    expect(parse({ type: 'clipboardSync', enabled: true, pad: big })).toEqual({
      ok: false,
      error: 'message too large',
    });
    expect(
      parseScreenClientMessage(
        JSON.stringify({ type: 'paste', text: 'x'.repeat(MAX_SCREEN_SOCKET_FRAME_BYTES) }),
      ),
    ).toEqual({
      ok: false,
      error: 'message too large',
    });
  });
});

describe('isValidProcessName', () => {
  it.each(['com.example.app', 'com.example.app:remote', 'com.example.app:sync_1.x'])('accepts %s', (name) => {
    expect(isValidProcessName(name)).toBe(true);
  });

  it.each(['', 'single', 'com.example.app:', 'com.example.app:a b', ':remote', 'com.app:x;id'])(
    'rejects %j',
    (name) => {
      expect(isValidProcessName(name)).toBe(false);
    },
  );
});

const HEARTBEAT_V1 = { type: 'heartbeat', ts: 1, droppedMessages: 0 };

describe('parseDeviceMessage', () => {
  const frame: SdkFrame = {
    ts: 1792516375300,
    totalMs: 7.9,
    inputMs: 0.2,
    animationMs: 0.4,
    layoutMs: 1.1,
    drawMs: 1.6,
    syncMs: 0.3,
    commandMs: 1.2,
    swapMs: 0.5,
    delayMs: 2.6,
    gpuMs: 2.1,
    deadlineMs: 16.6,
    firstDraw: false,
  };
  const hello: DeviceMessage = {
    type: 'hello',
    protocolVersion: 1,
    sdkVersion: '0.1.0',
    packageName: 'com.example.app',
    processName: 'com.example.app',
    pid: 42,
    apiLevel: 35,
    deviceWallMs: 1792516375000,
    refreshRateHz: 120,
  };
  const framesMessage = (frames: unknown[]) =>
    JSON.stringify({ type: 'frames', window: 'com.example.MainActivity', intervalMs: 8.333, frames });
  const errorOf = (line: string) => {
    const result = parseDeviceMessage(line);
    return result.ok ? null : result.error;
  };

  it('parses every golden fixture line to exactly its JSON value', () => {
    expect(GOLDEN_LINES.length).toBeGreaterThanOrEqual(10);
    for (const line of GOLDEN_LINES) {
      expect(parseDeviceMessage(line)).toEqual({ ok: true, value: JSON.parse(line) });
    }
    const types = GOLDEN_LINES.map((line) => (JSON.parse(line) as DeviceMessage).type);
    expect(new Set(types)).toEqual(
      new Set([
        'hello',
        'screen',
        'frames',
        'heartbeat',
        'stall',
        'strictmode',
        'inflate',
        'viewtree',
        'inspectBegin',
        'inspectNodes',
        'inspectError',
        'httpRequest',
        'httpResponse',
        'mocksApplied',
        'viewPropertyResult',
      ]),
    );
  });

  it('accepts a private process name and a null screen', () => {
    expect(parseDeviceMessage(JSON.stringify({ ...hello, processName: 'com.example.app:remote' })).ok).toBe(
      true,
    );
    expect(parseDeviceMessage('{"type":"screen","ts":1,"screen":null}').ok).toBe(true);
  });

  it('rejects invalid JSON and HTTP-looking input', () => {
    expect(errorOf('{nope')).toBe('invalid JSON');
    expect(errorOf('GET / HTTP/1.1')).toBe('invalid JSON');
    expect(errorOf('POST /api HTTP/1.1\r')).toBe('invalid JSON');
    expect(errorOf('')).toBe('invalid JSON');
  });

  it('flags a JSON object with an unknown string type (a newer SDK) apart from malformed input', () => {
    expect(parseDeviceMessage('{"type":"exec","cmd":"reboot"}')).toEqual({
      ok: false,
      error: 'unknown message type',
      unknownType: 'exec',
    });
    expect(parseDeviceMessage('{"type":"constructor"}')).toMatchObject({ unknownType: 'constructor' });
    expect(parseDeviceMessage('{"type":"__proto__"}')).toMatchObject({ unknownType: '__proto__' });
    for (const line of ['{"ts":1}', '{"type":7}', '["screen"]', '"screen"', 'null', '{nope']) {
      const result = parseDeviceMessage(line);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('unknownType');
    }
    // A known type with invalid fields is malformed, not unknown.
    expect(parseDeviceMessage('{"type":"heartbeat","ts":-1,"droppedMessages":0}')).not.toHaveProperty(
      'unknownType',
    );
  });

  it(`accepts a hello protocolVersion from ${MIN_DEVICE_PROTOCOL_VERSION} to ${MAX_DEVICE_PROTOCOL_VERSION}`, () => {
    const version = (protocolVersion: unknown) => errorOf(JSON.stringify({ ...hello, protocolVersion }));
    expect(version(MIN_DEVICE_PROTOCOL_VERSION)).toBeNull();
    expect(version(5)).toBeNull(); // a future SDK
    expect(version(MAX_DEVICE_PROTOCOL_VERSION)).toBeNull();
    for (const bad of [
      MIN_DEVICE_PROTOCOL_VERSION - 1,
      -1,
      1.5,
      MAX_DEVICE_PROTOCOL_VERSION + 1,
      '1',
      null,
    ]) {
      expect(version(bad)).not.toBeNull();
    }
    // A numeric out-of-range version is reported as such; a non-number is just an invalid hello.
    expect(parseDeviceMessage(JSON.stringify({ ...hello, protocolVersion: 0 }))).toEqual({
      ok: false,
      error: 'unsupported protocol version 0',
      unsupportedVersion: 0,
    });
    expect(parseDeviceMessage(JSON.stringify({ ...hello, protocolVersion: 1001 }))).toMatchObject({
      unsupportedVersion: 1001,
    });
    expect(parseDeviceMessage(JSON.stringify({ ...hello, protocolVersion: '1' }))).not.toHaveProperty(
      'unsupportedVersion',
    );
    // Only a hello carries a protocol version.
    expect(
      parseDeviceMessage(
        JSON.stringify({ type: 'heartbeat', ts: 1, droppedMessages: 0, protocolVersion: 0 }),
      ),
    ).not.toHaveProperty('unsupportedVersion');
  });

  it('strips unknown fields at every level (forward compatible with newer SDKs)', () => {
    const parse = (value: unknown) => parseDeviceMessage(JSON.stringify(value));
    expect(parse({ ...hello, futureField: 1 })).toEqual({ ok: true, value: hello });
    const frames = parse({
      type: 'frames',
      window: 'w',
      intervalMs: 8.333,
      frames: [{ ...frame, hdr: true }],
      extra: [],
    });
    expect(frames).toEqual({
      ok: true,
      value: { type: 'frames', window: 'w', intervalMs: 8.333, frames: [frame] },
    });
    const screen = { name: 'a', className: 'b', kind: 'activity' };
    expect(parse({ type: 'screen', ts: 1, screen: { ...screen, x: 1 } })).toEqual({
      ok: true,
      value: { type: 'screen', ts: 1, screen },
    });
  });

  it('accepts the optional droppedFrames count of a frames batch', () => {
    const batch = { type: 'frames', window: 'w', intervalMs: 8.333, frames: [], droppedFrames: 3 };
    expect(parseDeviceMessage(JSON.stringify(batch))).toEqual({ ok: true, value: batch });
    expect(errorOf(JSON.stringify({ ...batch, droppedFrames: -1 }))).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...batch, droppedFrames: 1.5 }))).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...batch, droppedFrames: 1_000_000 }))).toBeNull();
    expect(errorOf(JSON.stringify({ ...batch, droppedFrames: 1_000_001 }))).not.toBeNull();
  });

  it('never carries a __proto__ key into the parsed value', () => {
    const result = parseDeviceMessage(
      '{"type":"heartbeat","ts":1,"droppedMessages":0,"__proto__":{"polluted":1}}',
    );
    expect(result.ok).toBe(true);
    const value = result.ok ? result.value : null;
    expect(Object.keys(value ?? {})).toEqual(['type', 'ts', 'droppedMessages']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts a navigation destination screen kind (v6), nothing else new', () => {
    const screen = (kind: string) =>
      JSON.stringify({
        type: 'screen',
        ts: 1,
        screen: { name: 'product/{id}', className: 'product/{id}', kind },
      });
    expect(errorOf(screen('destination'))).toBeNull();
    expect(errorOf(screen('route'))).not.toBeNull();
  });

  it('rejects control and format characters in text fields', () => {
    const screen = (name: string) =>
      JSON.stringify({ type: 'screen', ts: 1, screen: { name, className: 'a.B', kind: 'fragment' } });
    expect(errorOf(screen('home'))).toBeNull();
    expect(errorOf(screen('Ünïcödé 主页'))).toBeNull();
    for (const bad of ['a\u0000b', 'a\nb', 'evil\u202Eexe', 'zero\u200Bwidth', '\uFEFFbom']) {
      expect(errorOf(screen(bad))).toContain('control or format');
    }
    expect(errorOf(JSON.stringify({ ...hello, sdkVersion: '0.1\u0007' }))).not.toBeNull();
    expect(
      errorOf(JSON.stringify({ type: 'frames', window: 'w\u202E', intervalMs: 8, frames: [] })),
    ).not.toBeNull();
  });

  it('bounds numbers to plausible ranges', () => {
    expect(errorOf(framesMessage([{ ...frame, totalMs: 90_000 }]))).toBeNull(); // e.g. a breakpoint
    expect(errorOf(framesMessage([{ ...frame, totalMs: 3_600_000 }]))).toBeNull();
    expect(errorOf(framesMessage([{ ...frame, layoutMs: 3_600_001 }]))).not.toBeNull();
    expect(errorOf(framesMessage([{ ...frame, ts: 8.64e15 + 1 }]))).not.toBeNull();
    expect(errorOf('{"type":"heartbeat","ts":8.64e15,"droppedMessages":0}')).toBeNull();
    expect(
      errorOf(JSON.stringify({ type: 'frames', window: 'w', intervalMs: 0.5, frames: [] })),
    ).not.toBeNull();
    expect(
      errorOf(JSON.stringify({ type: 'frames', window: 'w', intervalMs: 1001, frames: [] })),
    ).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...hello, refreshRateHz: 0.5 }))).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...hello, refreshRateHz: 1001 }))).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...hello, refreshRateHz: 1 }))).toBeNull();
  });

  it('rejects invalid identifiers in hello', () => {
    expect(errorOf(JSON.stringify({ ...hello, packageName: 'com.app;reboot' }))).toContain('package');
    expect(errorOf(JSON.stringify({ ...hello, processName: 'com.app:$(id)' }))).toContain('process');
    expect(errorOf(JSON.stringify({ ...hello, pid: 1.5 }))).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...hello, sdkVersion: 'x'.repeat(65) }))).not.toBeNull();
  });

  it('rejects non-finite and negative numbers', () => {
    expect(errorOf(framesMessage([{ ...frame, totalMs: -1 }]))).not.toBeNull();
    expect(errorOf(framesMessage([frame]).replace('"totalMs":7.9', '"totalMs":1e999'))).not.toBeNull();
    expect(errorOf('{"type":"screen","ts":1e999,"screen":null}')).not.toBeNull();
    expect(errorOf('{"type":"heartbeat","ts":1,"droppedMessages":-1}')).not.toBeNull();
    expect(errorOf(JSON.stringify({ ...hello, refreshRateHz: 0 }))).not.toBeNull();
  });

  it('caps the frames per batch and string lengths', () => {
    expect(errorOf(framesMessage(Array.from({ length: MAX_SDK_FRAMES_PER_BATCH }, () => frame)))).toBeNull();
    expect(
      errorOf(framesMessage(Array.from({ length: MAX_SDK_FRAMES_PER_BATCH + 1 }, () => frame))),
    ).not.toBeNull();
    const screen = (name: string) =>
      JSON.stringify({ type: 'screen', ts: 1, screen: { name, className: 'a.B', kind: 'fragment' } });
    expect(errorOf(screen('n'.repeat(256)))).toBeNull();
    expect(errorOf(screen('n'.repeat(257)))).not.toBeNull();
    expect(errorOf(screen(''))).not.toBeNull();
    expect(
      errorOf(JSON.stringify({ type: 'frames', window: 'w'.repeat(257), intervalMs: 8, frames: [] })),
    ).not.toBeNull();
  });

  describe('v2 stall and strictmode', () => {
    const appFrame: StackFrame = {
      className: 'com.example.app.HomeViewModel',
      method: 'mapItems',
      file: 'HomeViewModel.kt',
      line: 87,
      inApp: true,
    };
    const stall = {
      type: 'stall',
      ts: 1792516378000,
      durationMs: 342.5,
      frames: [appFrame],
      samples: 6,
      truncated: false,
      screen: 'homepage',
      debugger: false,
    };
    const strictmode = {
      type: 'strictmode',
      ts: 1792516379000,
      policy: 'thread',
      violation: 'DiskReadViolation',
      message: null,
      frames: [appFrame],
      count: 3,
      screen: null,
    };
    const withFrame = (message: object, frame: Partial<StackFrame>) =>
      errorOf(JSON.stringify({ ...message, frames: [{ ...appFrame, ...frame }] }));

    it('parses both, stripping unknown fields at every level', () => {
      expect(parseDeviceMessage(JSON.stringify(stall))).toEqual({ ok: true, value: stall });
      expect(parseDeviceMessage(JSON.stringify(strictmode))).toEqual({ ok: true, value: strictmode });
      const extended = { ...stall, cpu: 1, frames: [{ ...appFrame, module: 'app' }] };
      expect(parseDeviceMessage(JSON.stringify(extended))).toEqual({ ok: true, value: stall });
      const vm = { ...strictmode, policy: 'vm', violation: 'LeakedClosableViolation', message: 'leak' };
      expect(parseDeviceMessage(JSON.stringify(vm))).toEqual({ ok: true, value: vm });
    });

    it('flags them as unnegotiated on a link negotiated below v2, without validating them', () => {
      for (const message of [stall, strictmode, { type: 'stall' }]) {
        expect(parseDeviceMessage(JSON.stringify(message), MIN_DEVICE_PROTOCOL_VERSION)).toEqual({
          ok: false,
          error: `${message.type} needs protocol version 2`,
          unnegotiated: { type: message.type, since: DEVICE_PROTOCOL_V2 },
        });
      }
      expect(parseDeviceMessage(JSON.stringify(stall), DEVICE_PROTOCOL_V2).ok).toBe(true);
      expect(parseDeviceMessage(JSON.stringify(HEARTBEAT_V1), MIN_DEVICE_PROTOCOL_VERSION).ok).toBe(true);
      // Unknown types stay unknown at any version.
      expect(parseDeviceMessage('{"type":"memory"}', MIN_DEVICE_PROTOCOL_VERSION)).toEqual({
        ok: false,
        error: 'unknown message type',
        unknownType: 'memory',
      });
    });

    it('accepts the v9 origin fields and drops a stall whose origin is out of bounds', () => {
      const frame = stall.frames[0];
      const rx = {
        task: 'io.reactivex.internal.operators.single.SingleObserveOn$ObserveOnSingleObserver',
        consumer: null,
        subscribedAt: [frame],
      };
      const v9 = { ...stall, truncated: true, outerFrames: [frame], rx, coroutine: 'refresh#4' };
      expect(parseDeviceMessage(JSON.stringify(v9))).toEqual({ ok: true, value: v9 });
      for (const bad of [
        { ...v9, outerFrames: Array.from({ length: 17 }, () => frame) },
        { ...v9, rx: { ...rx, subscribedAt: Array.from({ length: 9 }, () => frame) } },
        { ...v9, rx: { ...rx, task: '' } },
        { ...v9, rx: { task: rx.task } },
        { ...v9, coroutine: 'x'.repeat(201) },
        { ...v9, coroutine: 'refresh\u202e#4' },
      ]) {
        expect(parseDeviceMessage(JSON.stringify(bad))).toMatchObject({
          ok: false,
          invalidDiagnostic: 'stall',
        });
      }
    });

    it('flags an invalid diagnostic (skippable) apart from an invalid v1 message (fatal)', () => {
      for (const message of [{ type: 'stall' }, { ...strictmode, count: 0 }]) {
        const result = parseDeviceMessage(JSON.stringify(message), DEVICE_PROTOCOL_V2);
        expect(result).toMatchObject({ ok: false, invalidDiagnostic: message.type });
        expect(result).not.toHaveProperty('unknownType');
        expect(result).not.toHaveProperty('unnegotiated');
      }
      for (const line of [
        '{"type":"heartbeat","ts":-1,"droppedMessages":0}',
        '{"type":"screen"}',
        '{"ts":1}',
      ]) {
        expect(parseDeviceMessage(line)).not.toHaveProperty('invalidDiagnostic');
      }
    });

    it('accepts unknown (null) and native (-2) lines and files, and rejects other line values', () => {
      expect(withFrame(stall, { line: null, file: null })).toBeNull();
      expect(withFrame(stall, { line: -2 })).toBeNull();
      expect(withFrame(stall, { line: 0 })).toBeNull();
      expect(withFrame(stall, { line: 2_147_483_647 })).toBeNull();
      for (const line of [-3, 1.5, 2_147_483_648, '87']) {
        expect(withFrame(stall, { line } as unknown as Partial<StackFrame>)).not.toBeNull();
      }
      expect(withFrame(stall, { inApp: 'yes' } as unknown as Partial<StackFrame>)).not.toBeNull();
    });

    it('caps stack frames, string lengths and numbers', () => {
      const frames = (count: number) => Array.from({ length: count }, () => appFrame);
      const error = (value: object) => errorOf(JSON.stringify(value));
      expect(error({ ...stall, frames: [] })).toBeNull();
      expect(error({ ...stall, frames: frames(MAX_STACK_FRAMES) })).toBeNull();
      expect(error({ ...stall, frames: frames(MAX_STACK_FRAMES + 1) })).not.toBeNull();
      expect(error({ ...strictmode, frames: frames(64) })).toBeNull();
      expect(error({ ...strictmode, frames: frames(65) })).not.toBeNull();

      expect(withFrame(stall, { className: 'c'.repeat(256), method: 'm'.repeat(256) })).toBeNull();
      expect(withFrame(stall, { className: 'c'.repeat(257) })).not.toBeNull();
      expect(withFrame(stall, { method: '' })).not.toBeNull();
      expect(withFrame(stall, { file: 'f'.repeat(128) })).toBeNull();
      expect(withFrame(stall, { file: 'f'.repeat(129) })).not.toBeNull();
      expect(withFrame(stall, { file: '' })).not.toBeNull();
      expect(error({ ...stall, screen: 's'.repeat(257) })).not.toBeNull();
      expect(error({ ...strictmode, violation: 'v'.repeat(128) })).toBeNull();
      expect(error({ ...strictmode, violation: 'v'.repeat(129) })).not.toBeNull();
      expect(error({ ...strictmode, message: 'm'.repeat(256) })).toBeNull();
      expect(error({ ...strictmode, message: 'm'.repeat(257) })).not.toBeNull();

      expect(error({ ...stall, durationMs: 0 })).toBeNull();
      expect(error({ ...stall, durationMs: 60_000 })).toBeNull();
      for (const durationMs of [-1, 60_000.5, '342']) expect(error({ ...stall, durationMs })).not.toBeNull();
      expect(error({ ...stall, samples: 10_000 })).toBeNull();
      for (const samples of [0, 1.5, 10_001]) expect(error({ ...stall, samples })).not.toBeNull();
      expect(error({ ...strictmode, count: 1_000_000 })).toBeNull();
      for (const count of [0, 2.5, 1_000_001]) expect(error({ ...strictmode, count })).not.toBeNull();
      expect(error({ ...stall, ts: 0 })).not.toBeNull();
      expect(error({ ...strictmode, policy: 'process' })).not.toBeNull();
      expect(error({ ...stall, debugger: 1 })).not.toBeNull();
      expect(error({ ...stall, truncated: null })).not.toBeNull();
    });

    it('rejects control and format characters in stack frames and screen names', () => {
      const error = (value: object) => errorOf(JSON.stringify(value));
      for (const bad of ['a\nb', 'tab\there', 'evil\u202Eexe', 'zero\u200Bwidth']) {
        expect(withFrame(stall, { className: bad })).toContain('control or format');
        expect(withFrame(strictmode, { method: bad })).toContain('control or format');
        expect(withFrame(stall, { file: bad })).toContain('control or format');
        expect(error({ ...stall, screen: bad })).toContain('control or format');
      }
      expect(withFrame(stall, { className: 'com.example.Ünïcödé$1', method: '<init>' })).toBeNull();
    });

    it('cleans up the free text of a StrictMode violation instead of refusing it', () => {
      const parsed = (changes: object) => {
        const result = parseDeviceMessage(JSON.stringify({ ...strictmode, ...changes }));
        return result.ok && result.value.type === 'strictmode' ? result.value : null;
      };
      expect(parsed({ message: 'read\n\tfrom\u202Edisk\n' })?.message).toBe('read from disk');
      expect(parsed({ message: 'Ünïcödé 主页' })?.message).toBe('Ünïcödé 主页');
      for (const empty of ['', '  ', '\n\u200B']) expect(parsed({ message: empty })?.message).toBeNull();
      expect(parsed({ violation: '' })?.violation).toBe('Violation');
      expect(parsed({ violation: '\u0000' })?.violation).toBe('Violation');
      expect(parsed({ violation: 'Disk\u202EReadViolation' })?.violation).toBe('Disk ReadViolation');
      // Lengths are checked on the raw text.
      expect(parsed({ message: 'm'.repeat(256) })).not.toBeNull();
      expect(parsed({ message: 'm'.repeat(257) })).toBeNull();
      expect(parsed({ violation: 'v'.repeat(129) })).toBeNull();
    });
  });

  describe('v3 inflate and viewtree', () => {
    const inflate = {
      type: 'inflate',
      ts: 1792516375260,
      layout: 'fragment_home',
      label: null,
      library: false,
      nested: false,
      screen: 'homepage',
      count: 1,
      totalMs: 18.4,
      maxMs: 18.4,
      views: 42,
    };
    const viewtree = {
      type: 'viewtree',
      ts: 1792516375400,
      screen: null,
      window: 'MainActivity',
      views: 137,
      viewGroups: 41,
      maxDepth: 14,
      deepestPath: [
        { className: 'DecorView', id: null },
        { className: 'FrameLayout', id: 'content' },
      ],
      topClasses: [{ className: 'MaterialTextView', count: 38 }],
    };
    const error = (value: object) => errorOf(JSON.stringify(value));

    it('parses both, stripping unknown fields at every level', () => {
      expect(parseDeviceMessage(JSON.stringify(inflate))).toEqual({ ok: true, value: inflate });
      expect(parseDeviceMessage(JSON.stringify(viewtree))).toEqual({ ok: true, value: viewtree });
      const extended = {
        ...viewtree,
        cpu: 1,
        deepestPath: [{ className: 'DecorView', id: null, extra: true }],
      };
      expect(parseDeviceMessage(JSON.stringify(extended))).toEqual({
        ok: true,
        value: { ...viewtree, deepestPath: [{ className: 'DecorView', id: null }] },
      });
    });

    it('flags them as unnegotiated below v3, without validating them', () => {
      for (const message of [inflate, viewtree, { type: 'viewtree' }]) {
        for (const version of [MIN_DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_V2]) {
          expect(parseDeviceMessage(JSON.stringify(message), version)).toEqual({
            ok: false,
            error: `${message.type} needs protocol version 3`,
            unnegotiated: { type: message.type, since: DEVICE_PROTOCOL_V3 },
          });
        }
      }
      expect(parseDeviceMessage(JSON.stringify(inflate), DEVICE_PROTOCOL_V3).ok).toBe(true);
    });

    it('flags invalid ones as skippable diagnostics', () => {
      for (const message of [{ ...inflate, count: 0 }, { type: 'viewtree' }]) {
        expect(parseDeviceMessage(JSON.stringify(message), DEVICE_PROTOCOL_V3)).toMatchObject({
          ok: false,
          invalidDiagnostic: message.type,
        });
      }
    });

    it('bounds inflate numbers and strings', () => {
      expect(error({ ...inflate, layout: null, label: 'LinearLayout:7' })).toBeNull();
      expect(error({ ...inflate, layout: 'l'.repeat(200) })).toBeNull();
      expect(error({ ...inflate, layout: 'l'.repeat(201) })).not.toBeNull();
      expect(error({ ...inflate, layout: 'bad\nname' })).toContain('control or format');
      expect(error({ ...inflate, screen: 's'.repeat(201) })).not.toBeNull();
      expect(error({ ...inflate, count: 1_000_000 })).toBeNull();
      for (const bad of [{ count: 0 }, { count: 1_000_001 }, { count: 1.5 }]) {
        expect(error({ ...inflate, ...bad })).not.toBeNull();
      }
      expect(error({ ...inflate, totalMs: 60_000, maxMs: 0, views: 0 })).toBeNull();
      for (const bad of [
        { totalMs: 60_001 },
        { maxMs: -1 },
        { maxMs: null },
        { views: -1 },
        { views: 1.5 },
      ]) {
        expect(error({ ...inflate, ...bad })).not.toBeNull();
      }
      expect(error({ ...inflate, library: 'no' })).not.toBeNull();
      expect(error({ ...inflate, nested: true })).toBeNull();
      expect(error({ ...inflate, nested: 1 })).not.toBeNull();
      const { nested: _nested, ...withoutNested } = inflate;
      expect(error(withoutNested)).not.toBeNull();
      expect(error({ ...inflate, ts: 0 })).not.toBeNull();
    });

    it('bounds the view tree path, classes and counts', () => {
      const node = { className: 'View', id: null };
      const path = (count: number) => Array.from({ length: count }, () => node);
      expect(error({ ...viewtree, deepestPath: path(MAX_VIEW_PATH_NODES) })).toBeNull();
      expect(error({ ...viewtree, deepestPath: path(MAX_VIEW_PATH_NODES + 1) })).not.toBeNull();
      const classes = (count: number) =>
        Array.from({ length: count }, () => ({ className: 'View', count: 1 }));
      expect(error({ ...viewtree, topClasses: classes(MAX_VIEW_TREE_CLASSES) })).toBeNull();
      expect(error({ ...viewtree, topClasses: classes(MAX_VIEW_TREE_CLASSES + 1) })).not.toBeNull();
      expect(error({ ...viewtree, topClasses: [{ className: 'View', count: 0 }] })).not.toBeNull();
      expect(error({ ...viewtree, deepestPath: [{ className: 'x'.repeat(201), id: null }] })).not.toBeNull();
      expect(error({ ...viewtree, deepestPath: [{ className: 'View', id: '' }] })).not.toBeNull();
      expect(error({ ...viewtree, window: '' })).not.toBeNull();
      for (const bad of [{ views: -1 }, { viewGroups: 1_000_001 }, { maxDepth: 1.5 }]) {
        expect(error({ ...viewtree, ...bad })).not.toBeNull();
      }
    });
  });

  describe('v4 Inspector answers', () => {
    const golden = (type: string) => {
      const line = GOLDEN_LINES.find((candidate) => (JSON.parse(candidate) as DeviceMessage).type === type);
      if (!line) throw new Error(`no golden ${type} line`);
      return JSON.parse(line) as Record<string, unknown>;
    };
    const begin = golden('inspectBegin');
    const nodes = golden('inspectNodes');
    const [decor, button] = nodes.nodes as Record<string, unknown>[];
    const chunk = (node: Record<string, unknown>) => ({ ...nodes, nodes: [node] });
    const error = (value: object) => errorOf(JSON.stringify(value));

    it('flags them as unnegotiated below v4, without validating them', () => {
      for (const message of [begin, nodes, { type: 'inspectError' }]) {
        expect(parseDeviceMessage(JSON.stringify(message), DEVICE_PROTOCOL_V3)).toEqual({
          ok: false,
          error: `${String(message.type)} needs protocol version 4`,
          unnegotiated: { type: message.type, since: DEVICE_PROTOCOL_V4 },
        });
      }
    });

    it('flags invalid ones as skippable', () => {
      for (const message of [
        { ...begin, nodeCount: -1 },
        { type: 'inspectNodes' },
        { type: 'inspectError' },
      ]) {
        expect(parseDeviceMessage(JSON.stringify(message))).toMatchObject({
          ok: false,
          invalidDiagnostic: message.type,
        });
      }
    });

    it('strips unknown fields of nodes and windows', () => {
      const extended = {
        ...nodes,
        nodes: [{ ...decor, elevation: 4 }],
        extra: 1,
      };
      expect(parseDeviceMessage(JSON.stringify(extended))).toEqual({
        ok: true,
        value: { ...nodes, nodes: [decor] },
      });
    });

    it('bounds the begin: display, windows, counts and times', () => {
      expect(error({ ...begin, nodeCount: MAX_INSPECTOR_NODES })).toBeNull();
      expect(error({ ...begin, nodeCount: MAX_INSPECTOR_NODES + 1 })).not.toBeNull();
      const window = { id: 0, type: 2, bounds: [0, 0, 10, 10] };
      const windows = (count: number) => Array.from({ length: count }, (_, id) => ({ ...window, id }));
      expect(error({ ...begin, windows: windows(MAX_INSPECTOR_WINDOWS) })).toBeNull();
      expect(error({ ...begin, windows: windows(MAX_INSPECTOR_WINDOWS + 1) })).not.toBeNull();
      expect(error({ ...begin, windows: [{ ...window, type: null }] })).toBeNull();
      for (const bad of [
        { display: { width: 0, height: 2424, rotation: 0 } },
        { display: { width: 1080, height: 20_001, rotation: 0 } },
        { display: { width: 1080, height: 2424, rotation: 45 } },
        { windows: [{ ...window, bounds: [0, 0, 10] }] },
        { windows: [{ ...window, bounds: [0, 0, 10, 100_001] }] },
        { windows: [{ ...window, bounds: [0, 0, 10, 1.5] }] },
        { windows: [{ ...window, type: -1 }] },
        { requestId: -1 },
        { captureMs: -1 },
        { screen: 's'.repeat(201) },
        { compose: 'no' },
      ]) {
        expect(error({ ...begin, ...bad })).not.toBeNull();
      }
    });

    it('bounds the nodes: ids, strings, rects, layout dimensions and the count', () => {
      expect(error(chunk({ ...button, text: 't'.repeat(500) }))).toBeNull();
      expect(error(chunk({ ...button, layoutWidth: '-12px', layoutHeight: '480px' }))).toBeNull();
      expect(error(chunk({ ...button, visibleBounds: null, alpha: 0, checked: true }))).toBeNull();
      for (const bad of [
        { text: 't'.repeat(501) },
        { text: '' },
        { text: 'two\nlines' },
        { contentDescription: '\u202eevil' },
        { className: 'c'.repeat(201) },
        { resourceId: 'r'.repeat(201) },
        { id: MAX_INSPECTOR_NODES },
        { parent: -1 },
        { window: MAX_INSPECTOR_WINDOWS },
        { bounds: [0, 0, 10, -100_001] },
        { padding: [0, 0, 0] },
        { visibility: 'hidden' },
        { alpha: 1.5 },
        { layoutWidth: 'fill_parent' },
        { layoutHeight: '12dp' },
        { source: { layout: 'fragment_home', line: 0 } },
        { source: { layout: '', line: 3 } },
        { fragment: 'f'.repeat(201) },
      ]) {
        expect(error(chunk({ ...button, ...bad }))).not.toBeNull();
      }
      const many = Array.from({ length: MAX_INSPECTOR_NODES + 1 }, () => decor);
      expect(error({ ...nodes, nodes: many })).not.toBeNull();
      expect(error({ ...nodes, seq: MAX_INSPECTOR_NODES })).not.toBeNull();
    });

    it('accepts the v6 Compose fields of a node, bounded', () => {
      const composable = {
        ...button,
        className: 'Button',
        alpha: null,
        padding: null,
        layoutWidth: null,
        layoutHeight: null,
        composable: { file: 'CartScreen.kt', line: 87 },
        destination: 'product/{id}',
      };
      expect(error(chunk(composable))).toBeNull();
      expect(
        error(chunk({ ...composable, composable: { file: null, line: null }, destination: null })),
      ).toBeNull();
      expect(error(chunk({ ...decor, composition: 'read' }))).toBeNull();
      for (const draws of [true, false]) {
        expect(
          error(chunk({ ...composable, composable: { file: 'CartScreen.kt', line: 87, draws } })),
        ).toBeNull();
      }
      for (const bad of [
        { composable: { file: 'CartScreen.kt', line: 0 } },
        { composable: { file: 'CartScreen.kt', line: 3, draws: 'no' } },
        { composable: { file: 'CartScreen.kt', line: 3, draws: null } },
        { composable: { file: '', line: 3 } },
        { composable: { file: 'f'.repeat(201), line: 3 } },
        { composable: { line: 3 } },
        { composition: 'unknown' },
        { destination: 'd'.repeat(201) },
        { destination: 'two\nlines' },
      ]) {
        expect(error(chunk({ ...composable, ...bad }))).not.toBeNull();
      }
    });

    it('accepts only the listed error reasons', () => {
      for (const reason of ['background', 'no_window', 'disabled', 'failed']) {
        expect(error({ type: 'inspectError', requestId: 1, reason })).toBeNull();
      }
      expect(error({ type: 'inspectError', requestId: 1, reason: 'busy' })).not.toBeNull();
    });
  });

  it('rejects lines over MAX_DEVICE_LINE_BYTES (in UTF-8 bytes)', () => {
    const padded = (filler: string) => `{"type":"heartbeat","ts":1,"droppedMessages":0,"p":"${filler}"}`;
    expect(errorOf(padded('a'.repeat(MAX_DEVICE_LINE_BYTES)))).toBe('message too large');
    const multiByte = padded('é'.repeat(MAX_DEVICE_LINE_BYTES / 2));
    expect(multiByte.length).toBeLessThan(MAX_DEVICE_LINE_BYTES);
    expect(errorOf(multiByte)).toBe('message too large');
  });
});

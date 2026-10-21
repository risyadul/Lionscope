// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isValidPackageName,
  isValidProcessName,
  isValidSerial,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_SDK_FRAMES_PER_BATCH,
  parseClientMessage,
  parseDeviceMessage,
} from '../src/index.ts';
import type { DeviceMessage, SdkFrame } from '../src/index.ts';

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
    expect(GOLDEN_LINES.length).toBeGreaterThanOrEqual(7);
    for (const line of GOLDEN_LINES) {
      expect(parseDeviceMessage(line)).toEqual({ ok: true, value: JSON.parse(line) });
    }
    const types = GOLDEN_LINES.map((line) => (JSON.parse(line) as DeviceMessage).type);
    expect(new Set(types)).toEqual(new Set(['hello', 'screen', 'frames', 'heartbeat']));
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

  it('rejects unknown types', () => {
    expect(errorOf('{"type":"exec","cmd":"reboot"}')).not.toBeNull();
    expect(errorOf('{"ts":1}')).not.toBeNull();
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

  it('rejects lines over MAX_DEVICE_LINE_BYTES (in UTF-8 bytes)', () => {
    const padded = (filler: string) => `{"type":"heartbeat","ts":1,"droppedMessages":0,"p":"${filler}"}`;
    expect(errorOf(padded('a'.repeat(MAX_DEVICE_LINE_BYTES)))).toBe('message too large');
    const multiByte = padded('é'.repeat(MAX_DEVICE_LINE_BYTES / 2));
    expect(multiByte.length).toBeLessThan(MAX_DEVICE_LINE_BYTES);
    expect(errorOf(multiByte)).toBe('message too large');
  });
});

// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PROTOCOL_V2,
  isValidPackageName,
  isValidProcessName,
  isValidSerial,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_DEVICE_LINE_BYTES,
  MAX_DEVICE_PROTOCOL_VERSION,
  MAX_SDK_FRAMES_PER_BATCH,
  MAX_STACK_FRAMES,
  MIN_DEVICE_PROTOCOL_VERSION,
  parseClientMessage,
  parseDeviceMessage,
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
    expect(parse({ stallThresholdMs: 500, strictMode: false }).ok).toBe(true);
  });

  it('rejects setSdkOptions without options, with an unlisted threshold or with extra fields', () => {
    const parse = (value: object) => parseClientMessage(JSON.stringify({ type: 'setSdkOptions', ...value }));
    expect(parse({})).toEqual({ ok: false, error: 'no SDK option given' });
    for (const stallThresholdMs of [0, 1, 149, 150.5, 2000, '150', null]) {
      expect(parse({ stallThresholdMs }).ok).toBe(false);
    }
    expect(parse({ strictMode: 'yes' }).ok).toBe(false);
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
    expect(GOLDEN_LINES.length).toBeGreaterThanOrEqual(7);
    for (const line of GOLDEN_LINES) {
      expect(parseDeviceMessage(line)).toEqual({ ok: true, value: JSON.parse(line) });
    }
    const types = GOLDEN_LINES.map((line) => (JSON.parse(line) as DeviceMessage).type);
    expect(new Set(types)).toEqual(
      new Set(['hello', 'screen', 'frames', 'heartbeat', 'stall', 'strictmode']),
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

  it('rejects lines over MAX_DEVICE_LINE_BYTES (in UTF-8 bytes)', () => {
    const padded = (filler: string) => `{"type":"heartbeat","ts":1,"droppedMessages":0,"p":"${filler}"}`;
    expect(errorOf(padded('a'.repeat(MAX_DEVICE_LINE_BYTES)))).toBe('message too large');
    const multiByte = padded('é'.repeat(MAX_DEVICE_LINE_BYTES / 2));
    expect(multiByte.length).toBeLessThan(MAX_DEVICE_LINE_BYTES);
    expect(errorOf(multiByte)).toBe('message too large');
  });
});

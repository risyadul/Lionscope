import { describe, expect, it } from 'vitest';
import {
  backOrScreenOn,
  CLIPBOARD_TEXT_MAX_BYTES,
  CODEC_ID_H264,
  DeviceMessageParser,
  INJECT_TEXT_MAX_BYTES,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  KEY_ACTION,
  MAX_PACKET_BYTES,
  MAX_VIDEO_DIMENSION,
  MESSAGE_MAX_BYTES,
  MOTION_ACTION,
  resetVideo,
  rotateDevice,
  ScrcpyProtocolError,
  setClipboard,
  toI16FixedPoint,
  toU16FixedPoint,
  VideoStreamParser,
} from '../src/scrcpy/protocol.ts';
import type { VideoPacket } from '../src/scrcpy/protocol.ts';
import { codecId, mediaPacket, sessionPacket, videoMeta } from './helpers/fakeScrcpy.ts';

const bytes = (...values: number[]) => Buffer.from(values);
const ascii = (text: string) => [...Buffer.from(text, 'ascii')];

// Expected bytes are the vectors of app/tests/test_control_msg_serialize.c and
// server/src/test/.../ControlMessageReaderTest.java at scrcpy v5.0.1.
describe('scrcpy control messages', () => {
  it('serializes inject keycode (test_serialize_inject_keycode)', () => {
    // AKEY_EVENT_ACTION_UP, AKEYCODE_ENTER, repeat 5, AMETA_SHIFT_ON | AMETA_SHIFT_LEFT_ON
    expect(injectKeycode(KEY_ACTION.up, 66, 5, 0x41)).toEqual(
      bytes(0x00, 0x01, 0x00, 0x00, 0x00, 0x42, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x41),
    );
  });

  it('serializes inject text, cut to 300 bytes on a character boundary (test_serialize_inject_text*)', () => {
    expect(injectText('hello, world!')).toEqual(
      bytes(0x01, 0x00, 0x00, 0x00, 0x0d, ...ascii('hello, world!')),
    );
    const long = injectText('a'.repeat(INJECT_TEXT_MAX_BYTES + 10));
    expect(long.subarray(0, 5)).toEqual(bytes(0x01, 0x00, 0x00, 0x01, 0x2c));
    expect(long).toHaveLength(5 + INJECT_TEXT_MAX_BYTES);
    // "testé" of the Java test; then a 2-byte character that would straddle the limit is left out.
    expect(injectText('testé')).toEqual(bytes(0x01, 0, 0, 0, 6, ...ascii('test'), 0xc3, 0xa9));
    const straddling = injectText(`${'a'.repeat(INJECT_TEXT_MAX_BYTES - 1)}é`);
    expect(straddling.readUInt32BE(1)).toBe(INJECT_TEXT_MAX_BYTES - 1);
  });

  it('serializes inject touch (test_serialize_inject_touch_event, testParseTouchEvent)', () => {
    const position = { x: 100, y: 200, width: 1080, height: 1920 };
    expect(
      injectTouch({
        action: MOTION_ACTION.down,
        pointerId: 0x1234567887654321n,
        position,
        pressure: 1,
        actionButton: 1,
        buttons: 1,
      }),
    ).toEqual(
      bytes(
        0x02,
        0x00,
        ...[0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21],
        ...[0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8],
        ...[0x04, 0x38, 0x07, 0x80],
        ...[0xff, 0xff],
        ...[0x00, 0x00, 0x00, 0x01],
        ...[0x00, 0x00, 0x00, 0x01],
      ),
    );
    const negative = injectTouch({ action: MOTION_ACTION.up, pointerId: -42n, position, pressure: 0 });
    expect(negative.readBigInt64BE(2)).toBe(-42n);
    expect(negative.subarray(22, 32)).toEqual(Buffer.alloc(10));
  });

  it('serializes inject scroll with the [-16, 16] range (test_serialize_inject_scroll_event)', () => {
    const position = { x: 260, y: 1026, width: 1080, height: 1920 };
    expect(injectScroll({ position, hscroll: 16, vscroll: -16, buttons: 1 })).toEqual(
      bytes(
        0x03,
        ...[0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x04, 0x02],
        ...[0x04, 0x38, 0x07, 0x80],
        ...[0x7f, 0xff],
        ...[0x80, 0x00],
        ...[0x00, 0x00, 0x00, 0x01],
      ),
    );
    // testParseScrollEvent: 0 → 0x0000; out-of-range values are clamped.
    const clamped = injectScroll({ position, hscroll: 0, vscroll: -100 });
    expect(clamped.subarray(13, 21)).toEqual(bytes(0x00, 0x00, 0x80, 0x00, 0, 0, 0, 0));
  });

  it('serializes back-or-screen-on, set clipboard, rotate device and reset video', () => {
    expect(backOrScreenOn(KEY_ACTION.up)).toEqual(bytes(0x04, 0x01));
    expect(setClipboard(0x0102030405060708n, 'hello, world!', true)).toEqual(
      bytes(
        0x09,
        ...[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        0x01,
        ...[0x00, 0x00, 0x00, 0x0d],
        ...ascii('hello, world!'),
      ),
    );
    expect(setClipboard(0n, '', false)).toEqual(bytes(0x09, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0, 0, 0, 0));
    const big = setClipboard(1n, 'a'.repeat(CLIPBOARD_TEXT_MAX_BYTES + 1), true);
    expect(big).toHaveLength(MESSAGE_MAX_BYTES);
    expect(rotateDevice()).toEqual(bytes(11));
    expect(resetVideo()).toEqual(bytes(17));
  });

  it('clamps every field to its wire range instead of throwing', () => {
    const position = { x: 2 ** 40, y: -(2 ** 40), width: 70_000, height: Number.NaN };
    const touch = injectTouch({ action: 300, pointerId: 2n ** 70n, position, pressure: 1, buttons: 2 ** 33 });
    expect(touch[1]).toBe(0xff);
    expect(touch.readInt32BE(10)).toBe(0x7fff_ffff);
    expect(touch.readInt32BE(14)).toBe(-0x8000_0000);
    expect(touch.readUInt16BE(18)).toBe(0xffff);
    expect(touch.readUInt16BE(20)).toBe(0);
    expect(touch.readInt32BE(28)).toBe(0x7fff_ffff);
    expect(() =>
      injectScroll({ position, hscroll: Number.NaN, vscroll: 1e9, buttons: -(2 ** 40) }),
    ).not.toThrow();
    expect(injectKeycode(-1, 2 ** 40, Number.NaN, 1.5)).toEqual(
      bytes(0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01),
    );
    expect(backOrScreenOn(-5)).toEqual(bytes(0x04, 0x00));
  });

  it('encodes fixed point like sc_float_to_u16fp / sc_float_to_i16fp', () => {
    expect([0, 0.5, 1, 2, -1].map(toU16FixedPoint)).toEqual([0, 0x8000, 0xffff, 0xffff, 0]);
    expect([0, 0.5, 1, -0.5, -1, 3].map(toI16FixedPoint)).toEqual([
      0, 0x4000, 0x7fff, 0xc000, 0x8000, 0x7fff,
    ]);
  });
});

function collect() {
  const events: (string | VideoPacket)[] = [];
  const parser = new VideoStreamParser({
    deviceName: (name) => events.push(`name:${name}`),
    codec: (id) => events.push(`codec:${id.toString(16)}`),
    session: (width, height) => events.push(`session:${width}x${height}`),
    packet: (packet) => events.push(packet),
  });
  return { events, parser };
}

const STREAM = Buffer.concat([
  videoMeta('Pixel Fake'),
  codecId(CODEC_ID_H264),
  sessionPacket(536, 1200),
  mediaPacket({ config: true, data: Buffer.from('sps-pps') }),
  mediaPacket({ key: true, pts: 78_769_118_639, data: Buffer.from('idr') }),
  mediaPacket({ pts: 78_769_218_639, data: Buffer.from('delta') }),
  sessionPacket(1200, 536),
  mediaPacket({ pts: 2 ** 53 - 1, data: Buffer.alloc(0) }),
]);

const EXPECTED = [
  'name:Pixel Fake',
  'codec:68323634',
  'session:536x1200',
  { config: true, key: false, ptsUs: 0, data: Buffer.from('sps-pps') },
  { config: false, key: true, ptsUs: 78_769_118_639, data: Buffer.from('idr') },
  { config: false, key: false, ptsUs: 78_769_218_639, data: Buffer.from('delta') },
  'session:1200x536',
  { config: false, key: false, ptsUs: 2 ** 53 - 1, data: Buffer.alloc(0) },
];

describe('VideoStreamParser', () => {
  it('parses device meta, codec id, session packets and media packets in one chunk', () => {
    const { events, parser } = collect();
    parser.push(STREAM);
    expect(events).toEqual(EXPECTED);
  });

  it('gives the same result for byte-by-byte and uneven chunks', () => {
    const single = collect();
    for (let offset = 0; offset < STREAM.length; offset += 1)
      single.parser.push(STREAM.subarray(offset, offset + 1));
    expect(single.events).toEqual(EXPECTED);
    const uneven = collect();
    for (let offset = 0, size = 1; offset < STREAM.length; offset += size, size = (size * 7) % 23 || 5) {
      uneven.parser.push(STREAM.subarray(offset, offset + size));
    }
    expect(uneven.events).toEqual(EXPECTED);
  });

  it('keeps the name up to its NUL, and a full 64-byte name', () => {
    const { events, parser } = collect();
    parser.push(Buffer.alloc(64, 0x41));
    expect(events).toEqual([`name:${'A'.repeat(64)}`]);
  });

  it('refuses video sizes of 0 or beyond MAX_VIDEO_DIMENSION', () => {
    for (const [width, height] of [
      [0, 1200],
      [540, 0],
      [MAX_VIDEO_DIMENSION + 1, 1200],
      [70_000, 1200],
    ] as const) {
      const { parser } = collect();
      expect(() =>
        parser.push(Buffer.concat([videoMeta(), codecId(), sessionPacket(width, height)])),
      ).toThrow(ScrcpyProtocolError);
    }
    const { events, parser } = collect();
    parser.push(Buffer.concat([videoMeta(), codecId(), sessionPacket(MAX_VIDEO_DIMENSION, 1)]));
    expect(events.at(-1)).toBe(`session:${MAX_VIDEO_DIMENSION}x1`);
  });

  it('refuses a packet size no access unit has', () => {
    const { parser } = collect();
    const header = Buffer.alloc(12);
    header.writeUInt32BE(MAX_PACKET_BYTES + 1, 8);
    expect(() => parser.push(Buffer.concat([videoMeta(), codecId(), header]))).toThrow(ScrcpyProtocolError);
  });
});

describe('DeviceMessageParser', () => {
  const clipboard = (text: string) => {
    const data = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(5);
    header.writeUInt32BE(data.length, 1);
    return Buffer.concat([header, data]);
  };

  it('reads clipboard text (test_deserialize_clipboard, DeviceMessageWriterTest) and skips the other types', () => {
    const texts: string[] = [];
    const parser = new DeviceMessageParser({ clipboard: (text) => texts.push(text) });
    const stream = Buffer.concat([
      bytes(0x00, 0x00, 0x00, 0x00, 0x03, 0x41, 0x42, 0x43),
      bytes(0x01, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08),
      bytes(0x02, 0, 42, 0, 5, 1, 2, 3, 4, 5),
      clipboard('aéûoç'),
    ]);
    for (let offset = 0; offset < stream.length; offset += 3)
      parser.push(stream.subarray(offset, offset + 3));
    expect(texts).toEqual(['ABC', 'aéûoç']);
  });

  it('refuses unknown types and oversized messages', () => {
    const parser = new DeviceMessageParser({ clipboard: () => undefined });
    expect(() => parser.push(bytes(7))).toThrow(ScrcpyProtocolError);
    const oversized = new DeviceMessageParser({ clipboard: () => undefined });
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MESSAGE_MAX_BYTES, 1);
    expect(() => oversized.push(header)).toThrow(/clipboard message/);
  });
});

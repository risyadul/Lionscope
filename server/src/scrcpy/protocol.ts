/**
 * The client side of the scrcpy-server v5.0.1 wire protocol. Layouts are taken from the sources at the tag
 * (control/ControlMessageReader.java, control/DeviceMessageWriter.java, device/DesktopConnection.java,
 * device/Streamer.java, app/src/control_msg.c) and checked against their tests. Everything is big-endian.
 */

/** The version argument of `com.genymobile.scrcpy.Server`: it must equal the server's version exactly. */
export const SCRCPY_VERSION = '5.0.1';

/** ControlMessage.TYPE_* (client → device, on the control socket). */
export const CONTROL_TYPE = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  backOrScreenOn: 4,
  setClipboard: 9,
  rotateDevice: 11,
  resetVideo: 17,
} as const;

/** DeviceMessage.TYPE_* (device → client, on the control socket). */
export const DEVICE_MESSAGE_TYPE = { clipboard: 0, ackClipboard: 1, uhidOutput: 2 } as const;

/** android.view.KeyEvent.ACTION_* */
export const KEY_ACTION = { down: 0, up: 1 } as const;
/** android.view.MotionEvent.ACTION_* (the server turns them into ACTION_POINTER_* for secondary pointers). */
export const MOTION_ACTION = { down: 0, up: 1, move: 2 } as const;

/** ControlMessageReader.INJECT_TEXT_MAX_LENGTH, in UTF-8 bytes. */
export const INJECT_TEXT_MAX_BYTES = 300;
/** Control and device messages are at most 256 KiB (MESSAGE_MAX_SIZE). */
export const MESSAGE_MAX_BYTES = 1 << 18;
/** ControlMessageReader.CLIPBOARD_TEXT_MAX_LENGTH: type, sequence, paste flag and length take 14 bytes. */
export const CLIPBOARD_TEXT_MAX_BYTES = MESSAGE_MAX_BYTES - 14;

/** DesktopConnection: the device name field of the device meta, NUL-padded. */
export const DEVICE_NAME_FIELD_BYTES = 64;
/** VideoCodec.H264 id ("h264" in ASCII); 0 = stream disabled, 1 = configuration error (Streamer). */
export const CODEC_ID_H264 = 0x68_32_36_34;
export const CODEC_ID_DISABLED = 0;
export const CODEC_ID_ERROR = 1;
/** Session and media packet headers (Streamer.writeSessionMeta / writeFrameMeta). */
export const PACKET_HEADER_BYTES = 12;
const PTS_MASK = (1n << 61n) - 1n;
/** No Annex B access unit comes anywhere near this; a larger size means the stream is out of sync. */
export const MAX_PACKET_BYTES = 32 * 1024 * 1024;
/** Video sizes beyond this (or 0) are refused: positions carry the size as u16, and no display is larger. */
export const MAX_VIDEO_DIMENSION = 16_384;

const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

/** `value` as an integer within [min, max] (min for NaN): the serializers never throw on a range. */
function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

const u8 = (value: number) => clampInt(value, 0, 0xff);
const u16 = (value: number) => clampInt(value, 0, 0xffff);
const i32 = (value: number) => clampInt(value, INT32_MIN, INT32_MAX);

/** `string` cut to at most `maxBytes` of UTF-8, on a character boundary. */
function utf8Truncated(text: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  // Back off a character cut in two (continuation bytes are 10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

/** sc_float_to_u16fp: 0..1 → u16 fixed point, 1 → 0xffff. */
export function toU16FixedPoint(value: number): number {
  const f = Math.fround(Math.min(Math.max(value, 0), 1));
  return Math.min(Math.trunc(f * 0x1_0000), 0xffff);
}

/** sc_float_to_i16fp: -1..1 → i16 fixed point (as its u16 bit pattern), 1 → 0x7fff. */
export function toI16FixedPoint(value: number): number {
  const f = Math.fround(Math.min(Math.max(value, -1), 1));
  return Math.min(Math.trunc(f * 0x8000), 0x7fff) & 0xffff;
}

/** A point in the current video frame, with that frame's size (the server ignores events for another size). */
export interface ScrcpyPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

function writePosition(buffer: Buffer, offset: number, position: ScrcpyPosition): void {
  buffer.writeInt32BE(i32(position.x), offset);
  buffer.writeInt32BE(i32(position.y), offset + 4);
  buffer.writeUInt16BE(u16(position.width), offset + 8);
  buffer.writeUInt16BE(u16(position.height), offset + 10);
}

export function injectKeycode(action: number, keycode: number, repeat = 0, metaState = 0): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(CONTROL_TYPE.injectKeycode, 0);
  buffer.writeUInt8(u8(action), 1);
  buffer.writeInt32BE(i32(keycode), 2);
  buffer.writeInt32BE(i32(repeat), 6);
  buffer.writeInt32BE(i32(metaState), 10);
  return buffer;
}

/** Text is cut to INJECT_TEXT_MAX_BYTES on a character boundary, like the client does. */
export function injectText(text: string): Buffer {
  const bytes = utf8Truncated(text, INJECT_TEXT_MAX_BYTES);
  const buffer = Buffer.alloc(5 + bytes.length);
  buffer.writeUInt8(CONTROL_TYPE.injectText, 0);
  buffer.writeUInt32BE(bytes.length, 1);
  bytes.copy(buffer, 5);
  return buffer;
}

export interface TouchEvent {
  action: number;
  /** Any 64-bit id; -1 (mouse), -2 (generic finger) and -3 (virtual finger) are special to the server. */
  pointerId: bigint;
  position: ScrcpyPosition;
  /** 0..1 */
  pressure: number;
  actionButton?: number;
  buttons?: number;
}

export function injectTouch(event: TouchEvent): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(CONTROL_TYPE.injectTouch, 0);
  buffer.writeUInt8(u8(event.action), 1);
  buffer.writeBigInt64BE(BigInt.asIntN(64, event.pointerId), 2);
  writePosition(buffer, 10, event.position);
  buffer.writeUInt16BE(toU16FixedPoint(event.pressure), 22);
  buffer.writeInt32BE(i32(event.actionButton ?? 0), 24);
  buffer.writeInt32BE(i32(event.buttons ?? 0), 28);
  return buffer;
}

export interface ScrollEvent {
  position: ScrcpyPosition;
  /** Scroll amounts in notches, clamped to -16..16 (positive vscroll: wheel away from the user, scroll up). */
  hscroll: number;
  vscroll: number;
  buttons?: number;
}

export function injectScroll(event: ScrollEvent): Buffer {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt8(CONTROL_TYPE.injectScroll, 0);
  writePosition(buffer, 1, event.position);
  // The range is [-16, 16], normalized to [-1, 1] for the fixed-point encoding.
  buffer.writeUInt16BE(toI16FixedPoint(event.hscroll / 16), 13);
  buffer.writeUInt16BE(toI16FixedPoint(event.vscroll / 16), 15);
  buffer.writeInt32BE(i32(event.buttons ?? 0), 17);
  return buffer;
}

/** BACK, or POWER when the screen is off (on the down action only). */
export function backOrScreenOn(action: number): Buffer {
  return Buffer.from([CONTROL_TYPE.backOrScreenOn, u8(action)]);
}

/** `sequence` 0 asks for no acknowledgement; `paste` also presses PASTE (Android 7+). */
export function setClipboard(sequence: bigint, text: string, paste: boolean): Buffer {
  const bytes = utf8Truncated(text, CLIPBOARD_TEXT_MAX_BYTES);
  const buffer = Buffer.alloc(14 + bytes.length);
  buffer.writeUInt8(CONTROL_TYPE.setClipboard, 0);
  buffer.writeBigUInt64BE(BigInt.asUintN(64, sequence), 1);
  buffer.writeUInt8(paste ? 1 : 0, 9);
  buffer.writeUInt32BE(bytes.length, 10);
  bytes.copy(buffer, 14);
  return buffer;
}

/** Toggles between portrait and landscape (best effort: apps may lock their orientation). */
export function rotateDevice(): Buffer {
  return Buffer.from([CONTROL_TYPE.rotateDevice]);
}

/** Restart the capture: a new session packet, config packet and key frame follow. */
export function resetVideo(): Buffer {
  return Buffer.from([CONTROL_TYPE.resetVideo]);
}

/** Byte accumulator for the stream parsers: chunks may split or coalesce messages arbitrarily. */
class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The next `count` bytes without consuming them (count ≤ size). */
  peek(count: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= count) return first.subarray(0, count);
    const joined = Buffer.concat(this.chunks, this.length);
    this.chunks = [joined];
    return joined.subarray(0, count);
  }

  take(count: number): Buffer {
    const bytes = this.peek(count);
    this.skip(count);
    return bytes;
  }

  private skip(count: number): void {
    this.length -= count;
    let remaining = count;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= remaining) {
        this.chunks.shift();
        remaining -= first.length;
      } else {
        this.chunks[0] = first.subarray(remaining);
        remaining = 0;
      }
    }
  }
}

export class ScrcpyProtocolError extends Error {}

export interface VideoPacket {
  config: boolean;
  key: boolean;
  /** Presentation time in microseconds; 0 for config packets. */
  ptsUs: number;
  /** H.264 Annex B data (start codes included). */
  data: Buffer;
}

export interface VideoStreamHandlers {
  deviceName(name: string): void;
  codec(id: number): void;
  /** The capture (re)started at this video size: on start, rotation, display change or RESET_VIDEO. */
  session(width: number, height: number): void;
  packet(packet: VideoPacket): void;
}

type VideoState = 'meta' | 'codec' | 'header' | 'payload';

/**
 * The video socket after the dummy byte: device meta (64-byte name), codec id (u32), then 12-byte headers. A
 * header with the top bit set is a session packet (flags u32, width u32, height u32); otherwise it is a media
 * packet (u64 PTS with the config / key-frame flags in bits 62 / 61, u32 size) followed by its payload.
 */
export class VideoStreamParser {
  private readonly queue = new ByteQueue();
  private state: VideoState = 'meta';
  private pending: Omit<VideoPacket, 'data'> & { size: number } = {
    config: false,
    key: false,
    ptsUs: 0,
    size: 0,
  };

  constructor(private readonly handlers: VideoStreamHandlers) {}

  /** Throws ScrcpyProtocolError on a stream it can't follow (the parser is then unusable). */
  push(chunk: Buffer): void {
    this.queue.push(chunk);
    while (this.step()) {
      // Each step consumes one complete element.
    }
  }

  private step(): boolean {
    switch (this.state) {
      case 'meta': {
        if (this.queue.size < DEVICE_NAME_FIELD_BYTES) return false;
        const field = this.queue.take(DEVICE_NAME_FIELD_BYTES);
        const end = field.indexOf(0);
        this.state = 'codec';
        this.handlers.deviceName(field.subarray(0, end === -1 ? field.length : end).toString('utf8'));
        return true;
      }
      case 'codec': {
        if (this.queue.size < 4) return false;
        this.state = 'header';
        this.handlers.codec(this.queue.take(4).readUInt32BE(0));
        return true;
      }
      case 'header': {
        if (this.queue.size < PACKET_HEADER_BYTES) return false;
        const header = this.queue.take(PACKET_HEADER_BYTES);
        if ((header[0] ?? 0) & 0x80) {
          const width = header.readUInt32BE(4);
          const height = header.readUInt32BE(8);
          const valid = (size: number) => size >= 1 && size <= MAX_VIDEO_DIMENSION;
          if (!valid(width) || !valid(height)) throw new ScrcpyProtocolError(`video size ${width}x${height}`);
          this.handlers.session(width, height);
          return true;
        }
        const ptsAndFlags = header.readBigUInt64BE(0);
        const size = header.readUInt32BE(8);
        if (size > MAX_PACKET_BYTES) throw new ScrcpyProtocolError(`video packet of ${size} bytes`);
        const config = ((ptsAndFlags >> 62n) & 1n) === 1n;
        this.pending = {
          config,
          key: ((ptsAndFlags >> 61n) & 1n) === 1n,
          ptsUs: config ? 0 : Number(ptsAndFlags & PTS_MASK),
          size,
        };
        this.state = 'payload';
        return true;
      }
      case 'payload': {
        const { size, ...packet } = this.pending;
        if (this.queue.size < size) return false;
        const data = this.queue.take(size);
        this.state = 'header';
        this.handlers.packet({ ...packet, data });
        return true;
      }
    }
  }
}

export interface DeviceMessageHandlers {
  clipboard(text: string): void;
}

/**
 * Device → client messages on the control socket (DeviceMessageWriter): clipboard (u32 length + UTF-8), clipboard
 * acknowledgement (u64 sequence) and UHID output (u16 id, u16 length, data). Only clipboard text is reported.
 */
export class DeviceMessageParser {
  private readonly queue = new ByteQueue();

  constructor(private readonly handlers: DeviceMessageHandlers) {}

  /** Throws ScrcpyProtocolError on an unknown type or an oversized message. */
  push(chunk: Buffer): void {
    this.queue.push(chunk);
    while (this.step()) {
      // Each step consumes one complete message.
    }
  }

  private step(): boolean {
    if (this.queue.size < 1) return false;
    const type = this.queue.peek(1)[0];
    switch (type) {
      case DEVICE_MESSAGE_TYPE.clipboard: {
        if (this.queue.size < 5) return false;
        const length = this.queue.peek(5).readUInt32BE(1);
        if (length > MESSAGE_MAX_BYTES - 5)
          throw new ScrcpyProtocolError(`clipboard message of ${length} bytes`);
        if (this.queue.size < 5 + length) return false;
        const text = this.queue
          .take(5 + length)
          .subarray(5)
          .toString('utf8');
        this.handlers.clipboard(text);
        return true;
      }
      case DEVICE_MESSAGE_TYPE.ackClipboard:
        if (this.queue.size < 9) return false;
        this.queue.take(9);
        return true;
      case DEVICE_MESSAGE_TYPE.uhidOutput: {
        if (this.queue.size < 5) return false;
        const length = this.queue.peek(5).readUInt16BE(3);
        if (this.queue.size < 5 + length) return false;
        this.queue.take(5 + length);
        return true;
      }
      default:
        throw new ScrcpyProtocolError(`unknown device message type ${type}`);
    }
  }
}

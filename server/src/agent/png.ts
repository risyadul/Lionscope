/**
 * Just enough PNG to shrink a `screencap -p` screenshot for an AI (8-bit RGB / RGBA, not interlaced, which is
 * what Android writes): decode, box-average down, encode as RGB. Anything else is passed through unscaled.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { Size } from '../emulator/screenInput.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel by IHDR color type (8-bit samples). */
const CHANNELS: Readonly<Record<number, number>> = { 2: 3, 6: 4 };
const FILTER_SUB = 1;

export function isPng(data: Buffer): boolean {
  return data.length > 33 && data.subarray(0, 8).equals(SIGNATURE);
}

/** Width and height from the IHDR chunk. */
export function pngSize(data: Buffer): Size {
  if (!isPng(data) || data.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** The size that fits `size` with its short edge at most `maxShortEdge` (never upscaled). */
export function fitShortEdge(size: Size, maxShortEdge: number): Size {
  const scale = Math.min(1, maxShortEdge / Math.min(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the per-row filters (PNG spec, section 9) into tightly packed pixels. */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (pixels[row + x - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[prev + x] ?? 0) : 0;
      const c = y > 0 && x >= channels ? (pixels[prev + x - channels] ?? 0) : 0;
      const value = raw[src + x] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }
  return pixels;
}

/** Tightly packed 8-bit pixels; null when the PNG is not something this decoder handles. */
export function decodePng(data: Buffer): DecodedPng | null {
  const { width, height } = pngSize(data);
  const bitDepth = data[24];
  const channels = CHANNELS[data[25] ?? -1];
  const interlace = data[28];
  if (bitDepth !== 8 || channels === undefined || interlace !== 0) return null;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(data.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return {
    width,
    height,
    channels,
    pixels: unfilter(inflateSync(Buffer.concat(idat)), width, height, channels),
  };
}

/** Box average of `image` into `target` (RGB out; alpha is dropped, screenshots are opaque). */
function downscale(image: DecodedPng, target: Size): Buffer {
  const { width, height, channels, pixels } = image;
  const out = Buffer.alloc(target.width * target.height * 3);
  for (let ty = 0; ty < target.height; ty++) {
    const y0 = Math.floor((ty * height) / target.height);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / target.height));
    for (let tx = 0; tx < target.width; tx++) {
      const x0 = Math.floor((tx * width) / target.width);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / target.width));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * channels;
          r += pixels[at] ?? 0;
          g += pixels[at + 1] ?? 0;
          b += pixels[at + 2] ?? 0;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (ty * target.width + tx) * 3;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
    }
  }
  return out;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** RGB pixels as a PNG, every row Sub-filtered (flat UI areas compress to almost nothing). */
function encodeRgb(rgb: Buffer, size: Size): Buffer {
  const stride = size.width * 3;
  const raw = Buffer.alloc((stride + 1) * size.height);
  for (let y = 0; y < size.height; y++) {
    const row = y * (stride + 1);
    raw[row] = FILTER_SUB;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? (rgb[y * stride + x - 3] ?? 0) : 0;
      raw[row + 1 + x] = ((rgb[y * stride + x] ?? 0) - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size.width, 0);
  ihdr.writeUInt32BE(size.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The PNG with its short edge scaled down to at most `maxShortEdge`, and its new size. */
export function scalePng(data: Buffer, maxShortEdge: number): { png: Buffer; size: Size } {
  const size = pngSize(data);
  const target = fitShortEdge(size, maxShortEdge);
  if (target.width === size.width && target.height === size.height) return { png: data, size };
  const image = decodePng(data);
  if (!image) return { png: data, size };
  return { png: encodeRgb(downscale(image, target), target), size: target };
}

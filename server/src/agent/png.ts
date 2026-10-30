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

/**
 * The PNG with its short edge scaled down to at most `maxShortEdge`, and its new size. `decoded`: the PNG already
 * decoded (null: not decodable), to decode it only once.
 */
export function scalePng(
  data: Buffer,
  maxShortEdge: number,
  decoded?: DecodedPng | null,
): { png: Buffer; size: Size } {
  const size = pngSize(data);
  const target = fitShortEdge(size, maxShortEdge);
  if (target.width === size.width && target.height === size.height) return { png: data, size };
  const image = decoded === undefined ? decodePng(data) : decoded;
  if (!image) return { png: data, size };
  return { png: encodeRgb(downscale(image, target), target), size: target };
}

/**
 * The part of a PNG inside `rect` ([left, top, right, bottom] in its pixels, clamped to the image) as a new PNG,
 * scaled down so its long edge is at most `maxLongEdge`; null when the PNG can't be decoded or the rect is empty.
 */
export function cropPng(
  data: Buffer,
  rect: readonly [number, number, number, number],
  maxLongEdge: number,
): { png: Buffer; size: Size } | null {
  const image = decodePng(data);
  if (!image) return null;
  const left = Math.max(0, Math.floor(rect[0]));
  const top = Math.max(0, Math.floor(rect[1]));
  const right = Math.min(image.width, Math.ceil(rect[2]));
  const bottom = Math.min(image.height, Math.ceil(rect[3]));
  if (right <= left || bottom <= top) return null;
  const width = right - left;
  const height = bottom - top;
  const stride = width * image.channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * image.channels;
    image.pixels.copy(pixels, y * stride, from, from + stride);
  }
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  const target = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  const cropped: DecodedPng = { width, height, channels: image.channels, pixels };
  return { png: encodeRgb(downscale(cropped, target), target), size: target };
}

/** Pixels with a luma at most this (of 255) count as black: video black is 16 (limited range), true black 0. */
export const BLACK_LUMA = 24;
/**
 * A screen whose most common colour covers this share of its pixels is blank (one colour; a few icons allowed).
 * Measured at 1080×2424: Settings' main list 0.958, the black Clock screen saver (a clock and date) 0.99, screen off 1.
 */
export const BLANK_DOMINANT_RATIO = 0.98;
/** About this many pixels are sampled, one at a pseudo-random spot of each cell of a grid. */
const STATS_SAMPLES = 1 << 17;
/** Colour buckets: 4 bits per channel, plus one for every black pixel. */
const BLACK_BUCKET = 4096;

export interface ScreenStats {
  /** Mean Rec. 709 luma, 0 (black) to 1 (white). */
  meanLuminance: number;
  /** Share of pixels brighter than BLACK_LUMA. */
  nonBlackRatio: number;
  /**
   * Share of pixels of the most common colour: 4 bits per channel, and all black (luma ≤ BLACK_LUMA) as one, so
   * noise, dithering and black next to video black count as one colour.
   */
  dominantRatio: number;
  /** dominantRatio ≥ BLANK_DOMINANT_RATIO: the screen is essentially one colour (black, white or any other). */
  blank: boolean;
}

/**
 * Brightness and uniformity of a screenshot, from about STATS_SAMPLES of its pixels: one per cell of a grid, at a
 * pseudo-random (but fixed) spot in the cell, so a regular pattern such as a checkerboard or striped rows is not
 * read as one of its colours.
 */
export function screenStats(image: DecodedPng): ScreenStats {
  const { width, height, channels, pixels } = image;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / STATS_SAMPLES)));
  const colors = new Uint32Array(BLACK_BUCKET + 1);
  let seed = 0x2545f491;
  /** xorshift32: a spot in the cell, the same for every call. */
  const jitter = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % step;
  };
  let samples = 0;
  let lumaSum = 0;
  let nonBlack = 0;
  for (let cellY = 0; cellY < height; cellY += step) {
    for (let cellX = 0; cellX < width; cellX += step) {
      // Clamped: the last row and column of cells may be cut off by the edge.
      const y = Math.min(height - 1, cellY + jitter());
      const x = Math.min(width - 1, cellX + jitter());
      const at = (y * width + x) * channels;
      const r = pixels[at] ?? 0;
      const g = pixels[at + 1] ?? 0;
      const b = pixels[at + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      const black = luma <= BLACK_LUMA;
      if (!black) nonBlack++;
      const color = black ? BLACK_BUCKET : ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      colors[color] = (colors[color] ?? 0) + 1;
      samples++;
    }
  }
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const dominantRatio = round(Math.max(...colors) / samples);
  return {
    meanLuminance: round(lumaSum / samples / 255),
    nonBlackRatio: round(nonBlack / samples),
    dominantRatio,
    // From the rounded value, so the two never disagree.
    blank: dominantRatio >= BLANK_DOMINANT_RATIO,
  };
}

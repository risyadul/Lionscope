/**
 * Pure input mapping for the mirrored emulator screen: canvas pixels → normalized frame coordinates,
 * touch slots, the Alt-drag pinch, wheel units and keyboard keys → `ScreenClientMessage`s.
 */
import type { ScreenClientMessage } from '@lionscope/protocol/wire';
import { MAX_SCREEN_KEY_CHARS, MAX_SCREEN_TEXT_CHARS, MAX_TOUCH_POINTS } from '@lionscope/protocol/wire';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FramePoint {
  /** 0..1 across the frame as shown. */
  x: number;
  y: number;
}

/** Where a `frameWidth × frameHeight` image lands inside a box with `object-fit: contain` (letterboxed). */
export function containRect(box: Rect, frameWidth: number, frameHeight: number): Rect {
  if (frameWidth <= 0 || frameHeight <= 0 || box.width <= 0 || box.height <= 0) {
    return { ...box, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / frameWidth, box.height / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/** Largest `aspect` (width / height) box that fits `width × height`, in whole CSS pixels. */
export function fitSize(width: number, height: number, aspect: number): { width: number; height: number } {
  if (width <= 0 || height <= 0 || !(aspect > 0)) return { width: 0, height: 0 };
  const byWidth = { width, height: width / aspect };
  const fitted = byWidth.height <= height ? byWidth : { width: height * aspect, height };
  return { width: Math.floor(fitted.width), height: Math.floor(fitted.height) };
}

/** Bezel padding around the glass, on each side (matches `.device-bezel`). */
export const BEZEL_PX = 7;
/** Room around the bezel for its 1 px ring and the 3 px focus ring, so neither is clipped. */
export const FRAME_MARGIN_PX = 4;

/**
 * Glass (screen) size so the whole device frame — glass, bezel padding and rings — fits the stage's
 * content box, in portrait and landscape.
 */
export function fitDeviceGlass(stageWidth: number, stageHeight: number, aspect: number) {
  const inset = 2 * (BEZEL_PX + FRAME_MARGIN_PX);
  return fitSize(stageWidth - inset, stageHeight - inset, aspect);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface NormalizedPoint extends FramePoint {
  /** False in the letterbox bars: a gesture can't start there. */
  inside: boolean;
}

/** A client (viewport) position on the canvas → frame coordinates, clamped to the frame. */
export function normalizePoint(
  clientX: number,
  clientY: number,
  canvasRect: Rect,
  frameWidth: number,
  frameHeight: number,
): NormalizedPoint | null {
  const content = containRect(canvasRect, frameWidth, frameHeight);
  if (content.width === 0 || content.height === 0) return null;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  return { x: clamp01(x), y: clamp01(y), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

/** Alt-drag pinch: the second finger mirrors the first around the screen centre (as in Android Studio). */
export function mirrorPoint(point: FramePoint): FramePoint {
  return { x: 1 - point.x, y: 1 - point.y };
}

/**
 * Hands out touch ids 0..MAX_TOUCH_POINTS-1, lowest free first. Ids are reused once released, so a finger
 * lifted and put down again gets a small id the emulator accepts.
 */
export function createTouchSlots(max = MAX_TOUCH_POINTS) {
  const used = new Set<number>();
  return {
    acquire(): number | null {
      for (let id = 0; id < max; id++) {
        if (!used.has(id)) {
          used.add(id);
          return id;
        }
      }
      return null;
    },
    release(id: number): void {
      used.delete(id);
    },
    get size(): number {
      return used.size;
    },
  };
}

export type TouchSlots = ReturnType<typeof createTouchSlots>;

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

/** `WheelEvent.deltaMode` units → 120ths of a notch. Browsers report ~100 px or 3 lines per notch. */
export const WHEEL_NOTCH = 120;
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/**
 * Wheel deltas in emulator units: 120 per notch. The browser's positive `deltaY` scrolls down (wheel
 * toward the user); the contract's positive `dy` is the wheel turned away, so the sign flips. `dx` keeps
 * the browser's sign (positive = right).
 */
export function wheelDelta({ deltaX, deltaY, deltaMode }: WheelInput): { dx: number; dy: number } {
  const perUnit =
    deltaMode === DOM_DELTA_PAGE
      ? WHEEL_NOTCH
      : deltaMode === DOM_DELTA_LINE
        ? WHEEL_NOTCH / LINES_PER_NOTCH
        : WHEEL_NOTCH / PIXELS_PER_NOTCH;
  return { dx: deltaX * perUnit, dy: deltaY === 0 ? 0 : -deltaY * perUnit };
}

/** Sums fractional wheel deltas and hands out whole units, keeping the remainder for the next frame. */
export function createWheelAccumulator() {
  let dx = 0;
  let dy = 0;
  return {
    add(delta: { dx: number; dy: number }): void {
      dx += delta.dx;
      dy += delta.dy;
    },
    take(): { dx: number; dy: number } | null {
      const wholeX = Math.trunc(dx);
      const wholeY = Math.trunc(dy);
      dx -= wholeX;
      dy -= wholeY;
      return wholeX === 0 && wholeY === 0 ? null : { dx: wholeX, dy: wholeY };
    },
  };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * Named keys forwarded as key events (W3C `key` values). Tab is left out on purpose: it moves focus out of
 * the screen, so keyboard users are never trapped. Modifiers alone are not forwarded (Alt drives the pinch).
 */
export const FORWARDED_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  /** AltGr (Windows / Linux) reports Ctrl+Alt; the character it types is still ours. */
  altGraph?: boolean;
}

/**
 * `null`: not ours, the browser keeps it (Cmd+R, Cmd+T, Tab, Cmd/Ctrl+V → a `paste` event…).
 * `{ msg: null }`: ours, nothing to send (the keyup of a typed character or of Escape).
 */
export type KeyAction = { msg: ScreenClientMessage | null } | null;

export function keyAction(event: KeyInput, eventType: 'keydown' | 'keyup'): KeyAction {
  if (event.isComposing) return null;
  // Browser and OS shortcuts stay with the browser; paste arrives as a `paste` event instead.
  if ((event.metaKey || event.ctrlKey) && !event.altGraph) return null;
  if (event.key === 'Escape') {
    return { msg: eventType === 'keydown' ? { type: 'nav', button: 'back' } : null };
  }
  if ([...event.key].length === 1) {
    return { msg: eventType === 'keydown' ? { type: 'text', text: event.key } : null };
  }
  if (FORWARDED_KEYS.has(event.key) && event.key.length <= MAX_SCREEN_KEY_CHARS) {
    return { msg: { type: 'key', key: event.key, eventType } };
  }
  return null;
}

/** Pasted text as `text` messages of at most MAX_SCREEN_TEXT_CHARS code points each. */
export function textMessages(text: string, max = MAX_SCREEN_TEXT_CHARS): ScreenClientMessage[] {
  const chars = [...text];
  const messages: ScreenClientMessage[] = [];
  for (let at = 0; at < chars.length; at += max) {
    messages.push({ type: 'text', text: chars.slice(at, at + max).join('') });
  }
  return messages;
}

/** Pastes beyond this many UTF-8 bytes are cut (the server rate-limits input; 4 KB is 16 text messages). */
export const MAX_PASTE_BYTES = 4096;

/** The longest prefix of whole code points within `maxBytes` of UTF-8. */
export function limitPaste(text: string, maxBytes = MAX_PASTE_BYTES): { text: string; isTruncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) return { text: text.slice(0, end), isTruncated: true };
    bytes += size;
    end += char.length;
  }
  return { text, isTruncated: false };
}

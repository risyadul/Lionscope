import { describe, expect, it } from 'vitest';
import {
  BEZEL_PX,
  containRect,
  createTouchSlots,
  fitDeviceGlass,
  FRAME_MARGIN_PX,
  createWheelAccumulator,
  fitSize,
  keyAction,
  limitPaste,
  MAX_PASTE_BYTES,
  mirrorPoint,
  normalizePoint,
  textMessages,
  wheelDelta,
} from '../src/lib/screenInput.ts';

const NO_MODS = { metaKey: false, ctrlKey: false };

describe('containRect / fitSize', () => {
  it('letterboxes a portrait frame in a wider box, centred', () => {
    expect(containRect({ left: 0, top: 0, width: 400, height: 600 }, 540, 1200)).toEqual({
      left: 65,
      top: 0,
      width: 270,
      height: 600,
    });
  });

  it('pillarboxes a landscape frame in a taller box', () => {
    const rect = containRect({ left: 10, top: 10, width: 300, height: 300 }, 1200, 540);
    expect(rect.width).toBe(300);
    expect(rect.height).toBeCloseTo(135);
    expect(rect.top).toBeCloseTo(10 + 82.5);
  });

  it('has no content for an empty frame or box', () => {
    expect(containRect({ left: 0, top: 0, width: 100, height: 100 }, 0, 0).width).toBe(0);
    expect(containRect({ left: 0, top: 0, width: 0, height: 100 }, 540, 1200).width).toBe(0);
  });

  it('fits the largest box of the aspect ratio in whole pixels', () => {
    expect(fitSize(340, 900, 9 / 20)).toEqual({ width: 340, height: 755 });
    expect(fitSize(340, 600, 9 / 20)).toEqual({ width: 270, height: 600 });
    expect(fitSize(0, 600, 9 / 20)).toEqual({ width: 0, height: 0 });
  });
});

describe('fitDeviceGlass', () => {
  const frame = (glass: { width: number; height: number }) => ({
    width: glass.width + 2 * (BEZEL_PX + FRAME_MARGIN_PX),
    height: glass.height + 2 * (BEZEL_PX + FRAME_MARGIN_PX),
  });

  it('keeps the whole frame (bezel and rings) inside the stage, portrait and landscape', () => {
    for (const [width, height, aspect] of [
      [322, 700, 540 / 1212],
      [322, 400, 540 / 1212],
      [560, 300, 1212 / 540],
      [300, 900, 1212 / 540],
    ] as const) {
      const outer = frame(fitDeviceGlass(width, height, aspect));
      expect(outer.width).toBeLessThanOrEqual(width);
      expect(outer.height).toBeLessThanOrEqual(height);
      // And it uses the room: one side touches the stage.
      expect(Math.max(width - outer.width, height - outer.height)).toBeGreaterThan(0);
      expect(Math.min(width - outer.width, height - outer.height)).toBeLessThanOrEqual(1);
    }
  });

  it('is empty before the stage is measured', () => {
    expect(fitDeviceGlass(0, 0, 0.45)).toEqual({ width: 0, height: 0 });
  });
});

describe('normalizePoint', () => {
  const canvas = { left: 100, top: 50, width: 400, height: 600 };

  it('maps client pixels to frame coordinates inside the letterboxed content', () => {
    // Content: 270 × 600 at x = 165.
    expect(normalizePoint(165, 50, canvas, 540, 1200)).toEqual({ x: 0, y: 0, inside: true });
    expect(normalizePoint(300, 350, canvas, 540, 1200)).toEqual({ x: 0.5, y: 0.5, inside: true });
    expect(normalizePoint(435, 650, canvas, 540, 1200)).toEqual({ x: 1, y: 1, inside: true });
  });

  it('clamps points in the letterbox bars and marks them outside', () => {
    expect(normalizePoint(120, 350, canvas, 540, 1200)).toEqual({ x: 0, y: 0.5, inside: false });
    expect(normalizePoint(480, 10, canvas, 540, 1200)).toEqual({ x: 1, y: 0, inside: false });
  });

  it('returns null before the first frame', () => {
    expect(normalizePoint(10, 10, canvas, 0, 0)).toBeNull();
  });
});

describe('Alt pinch and touch slots', () => {
  it('mirrors the anchor around the screen centre', () => {
    expect(mirrorPoint({ x: 0.25, y: 0.8 })).toEqual({ x: 0.75, y: expect.closeTo(0.2) as number });
    expect(mirrorPoint({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('hands out the lowest free id, reuses released ones, and stops at the limit', () => {
    const slots = createTouchSlots(3);
    expect([slots.acquire(), slots.acquire(), slots.acquire()]).toEqual([0, 1, 2]);
    expect(slots.acquire()).toBeNull();
    slots.release(1);
    expect(slots.acquire()).toBe(1);
    expect(slots.size).toBe(3);
  });

  it('defaults to the emulator’s ten touch points', () => {
    const slots = createTouchSlots();
    const ids = Array.from({ length: 11 }, () => slots.acquire());
    expect(ids.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ids[10]).toBeNull();
  });
});

describe('wheel', () => {
  it('turns one notch in any delta mode into 120, wheel away from the user positive', () => {
    // Wheel away from the user scrolls up: the browser reports negative deltaY.
    expect(wheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toEqual({ dx: 0, dy: 120 });
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: -120 });
    expect(wheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 })).toEqual({ dx: 0, dy: 120 });
    expect(wheelDelta({ deltaX: 50, deltaY: 0, deltaMode: 0 })).toEqual({ dx: 60, dy: 0 });
  });

  it('accumulates trackpad fractions and keeps the remainder', () => {
    const wheel = createWheelAccumulator();
    wheel.add({ dx: 0, dy: 0.6 });
    expect(wheel.take()).toBeNull();
    wheel.add({ dx: 0, dy: 0.6 });
    expect(wheel.take()).toEqual({ dx: 0, dy: 1 });
    wheel.add({ dx: -2.5, dy: 0 });
    expect(wheel.take()).toEqual({ dx: -2, dy: 0 });
  });
});

describe('keyAction', () => {
  it('types printable characters as text on keydown only', () => {
    expect(keyAction({ key: 'a', ...NO_MODS }, 'keydown')).toEqual({ msg: { type: 'text', text: 'a' } });
    expect(keyAction({ key: 'A', ...NO_MODS }, 'keydown')).toEqual({ msg: { type: 'text', text: 'A' } });
    expect(keyAction({ key: ' ', ...NO_MODS }, 'keydown')).toEqual({ msg: { type: 'text', text: ' ' } });
    expect(keyAction({ key: '😀', ...NO_MODS }, 'keydown')).toEqual({ msg: { type: 'text', text: '😀' } });
    expect(keyAction({ key: 'a', ...NO_MODS }, 'keyup')).toEqual({ msg: null });
  });

  it('sends named keys as key down / up with their W3C names', () => {
    expect(keyAction({ key: 'Enter', ...NO_MODS }, 'keydown')).toEqual({
      msg: { type: 'key', key: 'Enter', eventType: 'keydown' },
    });
    expect(keyAction({ key: 'ArrowLeft', ...NO_MODS }, 'keyup')).toEqual({
      msg: { type: 'key', key: 'ArrowLeft', eventType: 'keyup' },
    });
    expect(keyAction({ key: 'Backspace', ...NO_MODS }, 'keydown')?.msg).toMatchObject({ key: 'Backspace' });
  });

  it('maps Escape to Back', () => {
    expect(keyAction({ key: 'Escape', ...NO_MODS }, 'keydown')).toEqual({
      msg: { type: 'nav', button: 'back' },
    });
    expect(keyAction({ key: 'Escape', ...NO_MODS }, 'keyup')).toEqual({ msg: null });
  });

  it('leaves browser shortcuts, Tab, modifiers and IME composition to the browser', () => {
    expect(keyAction({ key: 'r', metaKey: true, ctrlKey: false }, 'keydown')).toBeNull();
    expect(keyAction({ key: 't', metaKey: false, ctrlKey: true }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'v', metaKey: true, ctrlKey: false }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'Tab', ...NO_MODS }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'Shift', ...NO_MODS }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'Alt', ...NO_MODS }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'F5', ...NO_MODS }, 'keydown')).toBeNull();
    expect(keyAction({ key: 'a', ...NO_MODS, isComposing: true }, 'keydown')).toBeNull();
  });
});

describe('AltGr and paste limits', () => {
  it('types AltGr characters (reported as Ctrl+Alt on Windows)', () => {
    expect(keyAction({ key: '@', metaKey: false, ctrlKey: true, altGraph: true }, 'keydown')).toEqual({
      msg: { type: 'text', text: '@' },
    });
    expect(keyAction({ key: '@', metaKey: false, ctrlKey: true, altGraph: false }, 'keydown')).toBeNull();
  });

  it('cuts pastes to 4 KB of UTF-8 on a code point boundary', () => {
    expect(limitPaste('hello')).toEqual({ text: 'hello', isTruncated: false });
    const long = limitPaste('x'.repeat(MAX_PASTE_BYTES + 10));
    expect(long).toEqual({ text: 'x'.repeat(MAX_PASTE_BYTES), isTruncated: true });
    // 'é' is 2 bytes, '😀' 4: nothing is split in half.
    expect(limitPaste('ééé', 5)).toEqual({ text: 'éé', isTruncated: true });
    expect(limitPaste('a😀', 4)).toEqual({ text: 'a', isTruncated: true });
    expect(limitPaste('😀', 4)).toEqual({ text: '😀', isTruncated: false });
  });
});

describe('textMessages', () => {
  it('splits pasted text into chunks of whole code points', () => {
    expect(textMessages('hello', 2)).toEqual([
      { type: 'text', text: 'he' },
      { type: 'text', text: 'll' },
      { type: 'text', text: 'o' },
    ]);
    expect(textMessages('😀😀😀', 2)).toEqual([
      { type: 'text', text: '😀😀' },
      { type: 'text', text: '😀' },
    ]);
    expect(textMessages('')).toEqual([]);
    expect(textMessages('x'.repeat(600))).toHaveLength(3);
  });
});

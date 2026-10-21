import type { ScreenRotation } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import {
  frameBox,
  keyEvent,
  liftEvent,
  nextRotationZ,
  rotatedSize,
  rotationForZ,
  rotationOf,
  toNative,
  TOUCH_PRESSURE_MAX,
  touchEvent,
  touchSlopPx,
  DEFAULT_TOUCH_SLOP_PX,
  wheelDrag,
  WHEEL_DRAG_MIN_PX,
  WHEEL_DRAG_STEPS,
} from '../src/emulator/screenInput.ts';

/** Pixel 9a. */
const DISPLAY = { width: 1080, height: 2424 };
const ROTATIONS: ScreenRotation[] = [0, 90, 180, 270];

/** Where native pixel (x, y) shows up in a full-size frame of `rotation` (the inverse of toNative). */
function toFrame(rotation: ScreenRotation, x: number, y: number): { fx: number; fy: number } {
  const { width: w, height: h } = DISPLAY;
  switch (rotation) {
    case 0:
      return { fx: x, fy: y };
    case 90:
      return { fx: h - y, fy: x };
    case 180:
      return { fx: w - x, fy: h - y };
    case 270:
      return { fx: y, fy: w - x };
  }
}

describe('rotation', () => {
  it('maps the emulator skin rotation to degrees clockwise', () => {
    expect(rotationOf('PORTRAIT')).toBe(0);
    expect(rotationOf('REVERSE_LANDSCAPE')).toBe(90);
    expect(rotationOf('REVERSE_PORTRAIT')).toBe(180);
    expect(rotationOf('LANDSCAPE')).toBe(270);
    expect(rotationOf(undefined)).toBe(0);
    expect(rotationOf('SIDEWAYS')).toBe(0);
  });

  it('swaps the frame size on quarter turns', () => {
    expect(rotatedSize(DISPLAY, 0)).toEqual(DISPLAY);
    expect(rotatedSize(DISPLAY, 180)).toEqual(DISPLAY);
    expect(rotatedSize(DISPLAY, 90)).toEqual({ width: 2424, height: 1080 });
    expect(rotatedSize(DISPLAY, 270)).toEqual({ width: 2424, height: 1080 });
  });
});

describe('frameBox', () => {
  it('puts the preset on the short edge in both orientations and sets both sides', () => {
    expect(frameBox(DISPLAY, 0, 540)).toEqual({ width: 540, height: 1212 });
    expect(frameBox(DISPLAY, 180, 360)).toEqual({ width: 360, height: 808 });
    expect(frameBox(DISPLAY, 90, 540)).toEqual({ width: 1212, height: 540 });
    expect(frameBox(DISPLAY, 270, 720)).toEqual({ width: 1616, height: 720 });
  });

  it('never scales up past the display', () => {
    expect(frameBox({ width: 480, height: 800 }, 0, 720)).toEqual({ width: 480, height: 800 });
    expect(frameBox({ width: 480, height: 800 }, 90, 540)).toEqual({ width: 800, height: 480 });
  });
});

describe('toNative', () => {
  it('matches the verified REVERSE_LANDSCAPE case: nativeX = frameY, nativeY = H − frameX', () => {
    // Frame 2424×1080: the point 1/4 across, 3/4 down.
    const frame = { x: 0.25 * 2424, y: 0.75 * 1080 };
    expect(toNative(DISPLAY, 90, 0.25, 0.75)).toEqual({
      x: Math.round(frame.y),
      y: Math.round(2424 - frame.x),
    });
  });

  it.each(ROTATIONS)('round-trips native points through a frame at %i°', (rotation) => {
    const frame = rotatedSize(DISPLAY, rotation);
    for (const [x, y] of [
      [100, 200],
      [540, 1212],
      [1000, 2300],
      [0, 0],
    ] as const) {
      const { fx, fy } = toFrame(rotation, x, y);
      expect(toNative(DISPLAY, rotation, fx / frame.width, fy / frame.height)).toEqual({
        x: Math.min(x, DISPLAY.width - 1),
        y: Math.min(y, DISPLAY.height - 1),
      });
    }
  });

  it('keeps the corners inside the display', () => {
    for (const rotation of ROTATIONS) {
      for (const [u, v] of [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
      ] as const) {
        const { x, y } = toNative(DISPLAY, rotation, u, v);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(DISPLAY.width - 1);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(DISPLAY.height - 1);
      }
    }
  });
});

describe('input events', () => {
  it('maps touches with their finger ids and scales pressure; 0 lifts', () => {
    expect(
      touchEvent(DISPLAY, 0, [
        { id: 0, x: 0.5, y: 0.5, pressure: 1 },
        { id: 3, x: 0.1, y: 0.9, pressure: 0.0001 },
        { id: 7, x: 0, y: 0, pressure: 0 },
      ]),
    ).toEqual({
      touch_event: {
        touches: [
          { x: 540, y: 1212, identifier: 0, pressure: TOUCH_PRESSURE_MAX },
          { x: 108, y: 2182, identifier: 3, pressure: 1 },
          { x: 0, y: 0, identifier: 7, pressure: 0 },
        ],
        display: 0,
      },
    });
  });

  it('lifts every finger still down', () => {
    expect(liftEvent(new Set([1, 4]))).toEqual({
      touch_event: {
        touches: [
          { x: 0, y: 0, identifier: 1, pressure: 0 },
          { x: 0, y: 0, identifier: 4, pressure: 0 },
        ],
        display: 0,
      },
    });
  });

  it('sends keys by W3C value, text as text and navigation buttons as Android keys', () => {
    expect(keyEvent({ type: 'key', key: 'Enter', eventType: 'keydown' })).toEqual({
      key_event: { eventType: 'keydown', key: 'Enter' },
    });
    expect(keyEvent({ type: 'text', text: 'hi there' })).toEqual({ key_event: { text: 'hi there' } });
    const nav = (button: 'back' | 'home' | 'recents' | 'power') => keyEvent({ type: 'nav', button });
    expect(nav('back')).toEqual({ key_event: { eventType: 'keypress', key: 'GoBack' } });
    expect(nav('home')).toEqual({ key_event: { eventType: 'keypress', key: 'GoHome' } });
    expect(nav('recents')).toEqual({ key_event: { eventType: 'keypress', key: 'AppSwitch' } });
    expect(nav('power')).toEqual({ key_event: { eventType: 'keypress', key: 'Power' } });
  });
});

describe('nextRotationZ', () => {
  it('turns a quarter left (+90) or right (-90) and wraps within [-180, 180]', () => {
    expect(nextRotationZ(0, 'right')).toBe(-90);
    expect(nextRotationZ(-90, 'right')).toBe(180);
    expect(nextRotationZ(180, 'right')).toBe(90);
    expect(nextRotationZ(90, 'right')).toBe(0);
    expect(nextRotationZ(0, 'left')).toBe(90);
    expect(nextRotationZ(90, 'left')).toBe(180);
    expect(nextRotationZ(180, 'left')).toBe(-90);
    expect(nextRotationZ(-180, 'left')).toBe(-90);
  });

  it('snaps an in-between angle first', () => {
    expect(nextRotationZ(-89.6, 'left')).toBe(0);
    expect(nextRotationZ(44, 'right')).toBe(-90);
    expect(nextRotationZ(Number.NaN, 'left')).toBe(90);
  });
});

describe('rotationForZ', () => {
  it('names the frame rotation the emulator reports for a device rotation', () => {
    expect(rotationForZ(0)).toBe(0);
    expect(rotationForZ(-90)).toBe(rotationOf('REVERSE_LANDSCAPE'));
    expect(rotationForZ(90)).toBe(rotationOf('LANDSCAPE'));
    expect(rotationForZ(180)).toBe(rotationOf('REVERSE_PORTRAIT'));
    expect(rotationForZ(-180)).toBe(180);
    expect(rotationForZ(-89.7)).toBe(90);
    expect(rotationForZ(270)).toBe(90);
  });
});

describe('wheelDrag', () => {
  const px = (points: { x: number; y: number }[] | null, frame = DISPLAY) =>
    points?.map((point) => [Math.round(point.x * frame.width), Math.round(point.y * frame.height)]);

  it('drags the finger down for wheel away (scroll up): 12% of the short edge per notch plus the touch slop', () => {
    // 0.12 × 1080 + 24 (default slop) = 153.6 px.
    const points = wheelDrag(DISPLAY, 0, { x: 0.5, y: 0.5, dx: 0, dy: 120 });
    expect(points).toHaveLength(WHEEL_DRAG_STEPS + 1);
    expect(px(points)).toEqual([
      [540, 1212],
      [540, 1250],
      [540, 1289],
      [540, 1327],
      [540, 1366],
    ]);
    expect(px(wheelDrag(DISPLAY, 0, { x: 0.5, y: 0.5, dx: 0, dy: -240 }))?.at(-1)).toEqual([540, 929]);
    // 420 dpi: slop 21 px.
    expect(px(wheelDrag(DISPLAY, 0, { x: 0.5, y: 0.5, dx: 0, dy: 120 }, touchSlopPx(420)))?.at(-1)).toEqual([
      540, 1363,
    ]);
  });

  it('converts the 8 dp touch slop to pixels, 24 px when the density is unknown', () => {
    expect(touchSlopPx(420)).toBe(21);
    expect(touchSlopPx(160)).toBe(8);
    expect(touchSlopPx(640)).toBe(32);
    expect(touchSlopPx(null)).toBe(DEFAULT_TOUCH_SLOP_PX);
    expect(touchSlopPx(0)).toBe(24);
  });

  it('drags horizontally for dx, in the frame as shown', () => {
    const frame = { width: 2424, height: 1080 };
    expect(px(wheelDrag(DISPLAY, 90, { x: 0.5, y: 0.5, dx: 120, dy: 0 }), frame)).toEqual([
      [1212, 540],
      [1250, 540],
      [1289, 540],
      [1327, 540],
      [1366, 540],
    ]);
  });

  it('is never shorter than the minimum (no tap) nor longer than most of the screen', () => {
    const tiny = px(wheelDrag(DISPLAY, 0, { x: 0.5, y: 0.5, dx: 0, dy: 1 }));
    expect((tiny?.at(-1)?.[1] ?? 0) - (tiny?.[0]?.[1] ?? 0)).toBe(WHEEL_DRAG_MIN_PX);
    const huge = px(wheelDrag(DISPLAY, 0, { x: 0.5, y: 0, dx: 0, dy: 12_000 }));
    expect((huge?.at(-1)?.[1] ?? 0) - (huge?.[0]?.[1] ?? 0)).toBe(Math.round(2424 * 0.8));
  });

  it('starts further in when the drag would leave the screen', () => {
    const points = px(wheelDrag(DISPLAY, 0, { x: 1, y: 1, dx: 120, dy: 120 }));
    expect(points?.at(-1)).toEqual([1079, 2423]);
    expect(points?.[0]).toEqual([925, 2269]);
    expect(px(wheelDrag(DISPLAY, 0, { x: 0, y: 0, dx: -120, dy: -120 }))?.at(-1)).toEqual([0, 0]);
  });

  it('is null without movement', () => {
    expect(wheelDrag(DISPLAY, 0, { x: 0.5, y: 0.5, dx: 0, dy: 0 })).toBeNull();
  });
});

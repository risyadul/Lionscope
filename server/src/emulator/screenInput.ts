import { MAX_TOUCH_POINTS } from '@lionscope/protocol';
import type {
  ScreenClientMessage,
  ScreenNavButton,
  ScreenRotation,
  ScreenTouchPoint,
} from '@lionscope/protocol';

/** Width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** The main display: natural size, and its density when the emulator reports it. */
export interface DisplaySize extends Size {
  dpi: number | null;
}

/** The subset of the emulator's `InputEvent` (emulator_controller.proto, field names as in the proto) we send. */
export type EmulatorInputEvent =
  | { touch_event: { touches: { x: number; y: number; identifier: number; pressure: number }[]; display: 0 } }
  | { key_event: { eventType: 'keydown' | 'keyup' | 'keypress'; key: string } }
  | { key_event: { text: string } };

/**
 * `Rotation.SkinRotation` of a frame → degrees clockwise the frame is turned from the display's natural image.
 * Verified: REVERSE_LANDSCAPE (device rotated to z = -90°) shows native (x, y) at frame (H − y, x), i.e. turned
 * 90° clockwise. LANDSCAPE and REVERSE_PORTRAIT follow by symmetry (to verify on a device).
 */
export function rotationOf(skinRotation: string | undefined): ScreenRotation {
  switch (skinRotation) {
    case 'LANDSCAPE':
      return 270;
    case 'REVERSE_PORTRAIT':
      return 180;
    case 'REVERSE_LANDSCAPE':
      return 90;
    default:
      return 0;
  }
}

/** A frame turned by a quarter turn shows the display's width as its height. */
export function isQuarterTurn(rotation: ScreenRotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** The display's natural size as a frame shows it (unscaled). */
export function rotatedSize(display: Size, rotation: ScreenRotation): Size {
  return isQuarterTurn(rotation) ? { width: display.height, height: display.width } : display;
}

/**
 * The `ImageFormat` bounding box for `shortEdge` pixels along the frame's short side, in the frame's
 * orientation. The emulator scales only when BOTH width and height are set, and keeps the aspect ratio inside
 * the box. Never larger than the display.
 */
export function frameBox(display: Size, rotation: ScreenRotation, shortEdge: number): Size {
  const full = rotatedSize(display, rotation);
  const scale = Math.min(1, shortEdge / Math.min(full.width, full.height));
  return { width: Math.round(full.width * scale), height: Math.round(full.height * scale) };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(Math.round(value), 0), max);
}

/**
 * Normalized frame coordinates (0..1 of the frame as shown) → native, unrotated display pixels: touches are
 * always injected in the display's natural orientation.
 */
export function toNative(
  display: Size,
  rotation: ScreenRotation,
  u: number,
  v: number,
): { x: number; y: number } {
  const { width: w, height: h } = display;
  const [nx, ny] =
    rotation === 90 ? [v, 1 - u] : rotation === 180 ? [1 - u, 1 - v] : rotation === 270 ? [1 - v, u] : [u, v];
  return { x: clamp(nx * w, w - 1), y: clamp(ny * h, h - 1) };
}

/** The emulator's multi-touch pressure range (MTS_PRESSURE_RANGE_MAX); 0 lifts the finger. */
export const TOUCH_PRESSURE_MAX = 0x400;

export function touchEvent(
  display: Size,
  rotation: ScreenRotation,
  touches: readonly ScreenTouchPoint[],
): EmulatorInputEvent {
  return {
    touch_event: {
      touches: touches.map((touch) => ({
        ...toNative(display, rotation, touch.x, touch.y),
        identifier: touch.id,
        pressure: touch.pressure > 0 ? Math.max(1, Math.round(touch.pressure * TOUCH_PRESSURE_MAX)) : 0,
      })),
      display: 0,
    },
  };
}

/** Lift fingers that are still down (e.g. when the socket closes mid-gesture). */
export function liftEvent(ids: Iterable<number>): EmulatorInputEvent {
  return {
    touch_event: { touches: [...ids].map((id) => ({ x: 0, y: 0, identifier: id, pressure: 0 })), display: 0 },
  };
}

/** W3C key values the emulator maps to Android's navigation keys. */
export const NAV_KEYS: Readonly<Record<ScreenNavButton, string>> = {
  back: 'GoBack',
  home: 'GoHome',
  recents: 'AppSwitch',
  power: 'Power',
};

/** Wheel input within this window becomes one drag. */
export const WHEEL_BATCH_MS = 30;
/**
 * A wheel drag moves every WHEEL_STEP_MS, then holds still before lifting: Android takes a pointer that has not
 * moved for 40 ms as stopped, so the drag scrolls without a fling. The whole drag stays well under 150 ms.
 */
export const WHEEL_STEP_MS = 12;
export const WHEEL_HOLD_MS = 60;
/**
 * The synthetic wheel finger. Wheel drags only run while no user finger is down, and the dashboard gives fingers
 * the lowest free ids, so a user finger rarely gets this one during a drag (it would share the slot briefly).
 */
export const WHEEL_FINGER_ID = MAX_TOUCH_POINTS - 1;
/** Wheel units per notch. */
export const WHEEL_NOTCH = 120;
/** Scroll per notch, as a share of the screen's short edge (about one browser notch of scrolling). */
export const WHEEL_DRAG_PER_NOTCH = 0.12;
/**
 * Android's touch slop (ViewConfiguration: 8 dp): a drag scrolls only by what it moves beyond it, so it is
 * added to every drag. In pixels at `dpi`; DEFAULT_TOUCH_SLOP_PX when the density is unknown.
 */
export const TOUCH_SLOP_DP = 8;
export const DEFAULT_TOUCH_SLOP_PX = 24;

export function touchSlopPx(dpi: number | null): number {
  return dpi && dpi > 0 ? Math.round((TOUCH_SLOP_DP * dpi) / 160) : DEFAULT_TOUCH_SLOP_PX;
}
/** Never shorter than ~3× the touch slop, so a drag can't register as a tap or a long press. */
export const WHEEL_DRAG_MIN_PX = 48;
/** At most this share of the screen per drag. */
const WHEEL_DRAG_MAX_SHARE = 0.8;
export const WHEEL_DRAG_STEPS = 4;

function dragLength(delta: number, frameLength: number, shortEdge: number, slopPx: number): number {
  if (delta === 0) return 0;
  const scroll = (Math.abs(delta) / WHEEL_NOTCH) * WHEEL_DRAG_PER_NOTCH * shortEdge;
  const length = Math.max(WHEEL_DRAG_MIN_PX, slopPx + scroll);
  return Math.sign(delta) * Math.min(length, frameLength * WHEEL_DRAG_MAX_SHARE);
}

/** Start at `position`, moved back where needed so a drag of `move` stays on the screen. */
function dragStart(position: number, move: number, frameLength: number): number {
  return Math.min(Math.max(position, Math.max(0, -move)), frameLength - 1 - Math.max(0, move));
}

/**
 * AVDs have no mouse or rotary input device, so a wheel turn becomes a short touch drag at the pointer:
 * WHEEL_DRAG_STEPS + 1 points in normalized frame coordinates (down at the first, up at the last). Positive dy
 * (wheel away, scroll up) moves the content, and so the finger, down; dx likewise to the right. The drag is the
 * scroll plus `slopPx` (touchSlopPx). null: no movement.
 */
export function wheelDrag(
  display: Size,
  rotation: ScreenRotation,
  message: Pick<Extract<ScreenClientMessage, { type: 'wheel' }>, 'x' | 'y' | 'dx' | 'dy'>,
  slopPx: number = DEFAULT_TOUCH_SLOP_PX,
): { x: number; y: number }[] | null {
  const frame = rotatedSize(display, rotation);
  const shortEdge = Math.min(frame.width, frame.height);
  const moveX = dragLength(message.dx, frame.width, shortEdge, slopPx);
  const moveY = dragLength(message.dy, frame.height, shortEdge, slopPx);
  if (moveX === 0 && moveY === 0) return null;
  const startX = dragStart(message.x * frame.width, moveX, frame.width);
  const startY = dragStart(message.y * frame.height, moveY, frame.height);
  return Array.from({ length: WHEEL_DRAG_STEPS + 1 }, (_, step) => ({
    x: (startX + (moveX * step) / WHEEL_DRAG_STEPS) / frame.width,
    y: (startY + (moveY * step) / WHEEL_DRAG_STEPS) / frame.height,
  }));
}

/** The input events for a key, text or navigation message. */
export function keyEvent(
  message: Extract<ScreenClientMessage, { type: 'key' | 'text' | 'nav' }>,
): EmulatorInputEvent {
  switch (message.type) {
    case 'key':
      return { key_event: { eventType: message.eventType, key: message.key } };
    case 'text':
      return { key_event: { text: message.text } };
    case 'nav':
      return { key_event: { eventType: 'keypress', key: NAV_KEYS[message.button] } };
  }
}

/**
 * The next device rotation (physical model ROTATION, z in degrees within [-180, 180]). Turning the device left
 * (counter-clockwise) is +90°, right is -90° (z = -90° gives REVERSE_LANDSCAPE). z is first snapped to a
 * quarter turn.
 */
export function nextRotationZ(z: number, direction: 'left' | 'right'): number {
  const snapped = Math.round((Number.isFinite(z) ? z : 0) / 90) * 90;
  const next = snapped + (direction === 'left' ? 90 : -90);
  const wrapped = ((((next + 180) % 360) + 360) % 360) - 180;
  // 180 and -180 are the same; keep 180 like the emulator's own controls.
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * The frame rotation the emulator reports for device rotation z: the inverse of the turns above (z = -90 →
 * REVERSE_LANDSCAPE = 90, z = 90 → LANDSCAPE = 270, z = ±180 → REVERSE_PORTRAIT = 180).
 */
export function rotationForZ(z: number): ScreenRotation {
  const quarter = (((Math.round(z / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return ([0, 270, 180, 90] as const)[quarter];
}

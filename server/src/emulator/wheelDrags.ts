import type { ScreenClientMessage, ScreenRotation } from '@lionscope/protocol';
import { touchSlopPx, WHEEL_BATCH_MS, WHEEL_HOLD_MS, WHEEL_STEP_MS, wheelDrag } from './screenInput.ts';
import type { DisplaySize } from './screenInput.ts';

type WheelMessage = Pick<Extract<ScreenClientMessage, { type: 'wheel' }>, 'x' | 'y' | 'dx' | 'dy'>;

/** What wheel drags need of their screen session. */
export interface WheelDragTarget {
  /** The display and the rotation shown; null before the display size is known. */
  geometry(): { display: DisplaySize; rotation: ScreenRotation } | null;
  /** Fingers are down (wheel input is dropped then). */
  isTouching(): boolean;
  /** One point of a drag, normalized frame coordinates; `pressure` 0 lifts. */
  touch(
    geometry: { display: DisplaySize; rotation: ScreenRotation },
    point: { x: number; y: number },
    pressure: number,
    droppable: boolean,
  ): void;
  /** Run `action` after `delayMs` unless the session closed meanwhile. */
  later(delayMs: number, action: () => void): void;
}

/**
 * Wheel input as touch drags (wheelDrag): input within WHEEL_BATCH_MS is summed into one drag; input during a
 * drag waits for it; input while fingers are down is dropped.
 */
export class WheelDrags {
  private pending: WheelMessage | null = null;
  private scheduled = false;
  private dragging = false;

  constructor(private readonly target: WheelDragTarget) {}

  add(message: WheelMessage): void {
    this.pending = {
      x: message.x,
      y: message.y,
      dx: (this.pending?.dx ?? 0) + message.dx,
      dy: (this.pending?.dy ?? 0) + message.dy,
    };
    this.schedule(WHEEL_BATCH_MS);
  }

  private schedule(delayMs: number): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.target.later(delayMs, () => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    const geometry = this.target.geometry();
    const wheel = this.pending;
    if (!geometry || !wheel || this.dragging) return;
    this.pending = null;
    if (this.target.isTouching()) return;
    const points = wheelDrag(geometry.display, geometry.rotation, wheel, touchSlopPx(geometry.display.dpi));
    if (!points) return;
    this.dragging = true;
    points.forEach((point, step) => {
      if (step === 0) this.target.touch(geometry, point, 1, false);
      else this.target.later(step * WHEEL_STEP_MS, () => this.target.touch(geometry, point, 1, true));
    });
    const last = points[points.length - 1] ?? points[0];
    this.target.later((points.length - 1) * WHEEL_STEP_MS + WHEEL_HOLD_MS, () => {
      if (last) this.target.touch(geometry, last, 0, false);
      this.dragging = false;
      if (this.pending) this.schedule(0);
    });
  }
}

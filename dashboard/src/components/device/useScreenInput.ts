import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { ScreenClientMessage, ScreenTouchPoint } from '@lionscope/protocol/wire';
import { limitClipboardText } from '../../lib/clipboard.ts';
import {
  createTouchSlots,
  createWheelAccumulator,
  keyAction,
  mirrorPoint,
  normalizePoint,
  wheelDelta,
  type FramePoint,
} from '../../lib/screenInput.ts';

/** One pointer's gesture: its touch ids (two for an Alt-drag pinch) and where it last was. */
interface Gesture {
  ids: number[];
  last: FramePoint;
}

function touchesFor(gesture: Gesture, point: FramePoint, pressure: number): ScreenTouchPoint[] {
  return gesture.ids.map((id, i) => {
    const at = i === 0 ? point : mirrorPoint(point);
    return { id, x: at.x, y: at.y, pressure };
  });
}

function keyInput(event: KeyboardEvent<HTMLCanvasElement>) {
  const { key, metaKey, ctrlKey } = event;
  const altGraph = event.getModifierState('AltGraph');
  return { key, metaKey, ctrlKey, altGraph, isComposing: event.nativeEvent.isComposing };
}

/** How long the "pasted the first 32 KB" note stays. */
const PASTE_NOTE_MS = 4000;
export const PASTE_TRUNCATED_NOTE = 'Pasted the first 32 KB';

function framePoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  return normalizePoint(clientX, clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
}

export interface ScreenInputHandlers {
  onPointerDown: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLCanvasElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLCanvasElement>) => void;
  onBlur: () => void;
}

export interface ScreenInput {
  handlers: ScreenInputHandlers;
  /** The Alt-pinch anchor while Alt is held over the screen (its mirror is drawn around the centre). */
  pinchHint: FramePoint | null;
  /** Shown briefly when a paste was cut to MAX_SCREEN_CLIPBOARD_BYTES. */
  pasteNote: string | null;
}

/**
 * Canvas input → screen messages. Touch moves and wheel turns are coalesced to one message per animation
 * frame; downs and lifts go out at once (after any queued move) so a quick tap is never merged away.
 */
export function useScreenInput(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  send: (msg: ScreenClientMessage) => boolean,
  isActive: boolean,
): ScreenInput {
  const [pinchHint, setPinchHint] = useState<FramePoint | null>(null);
  const slots = useRef(createTouchSlots());
  const gestures = useRef(new Map<number, Gesture>());
  const moves = useRef(new Map<number, ScreenTouchPoint>());
  const wheel = useRef(createWheelAccumulator());
  const wheelAt = useRef<FramePoint>({ x: 0.5, y: 0.5 });
  const hover = useRef<FramePoint | null>(null);
  const frame = useRef<number | null>(null);
  /** Named keys sent down and not yet up: released when input stops, so none stays held on the device. */
  const heldKeys = useRef(new Set<string>());
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (moves.current.size > 0) {
      send({ type: 'touch', touches: [...moves.current.values()] });
      moves.current.clear();
    }
    const turned = wheel.current.take();
    if (turned) send({ type: 'wheel', ...wheelAt.current, ...turned });
  }, [send]);

  const schedule = useCallback(() => {
    frame.current ??= requestAnimationFrame(flush);
  }, [flush]);

  const end = useCallback(
    (pointerId: number) => {
      const gesture = gestures.current.get(pointerId);
      if (!gesture) return;
      gestures.current.delete(pointerId);
      flush();
      send({ type: 'touch', touches: touchesFor(gesture, gesture.last, 0) });
      for (const id of gesture.ids) slots.current.release(id);
      if (gesture.ids.length > 1) setPinchHint(null);
    },
    [flush, send],
  );

  const endAll = useCallback(() => {
    for (const pointerId of [...gestures.current.keys()]) end(pointerId);
    for (const key of heldKeys.current) send({ type: 'key', key, eventType: 'keyup' });
    heldKeys.current.clear();
  }, [end, send]);

  // A finger or key must never stay down on the device: release everything when input stops or the panel goes.
  useEffect(() => {
    if (!isActive) endAll();
    return endAll;
  }, [isActive, endAll]);

  useEffect(() => {
    if (pasteNote === null) return;
    const timer = setTimeout(() => setPasteNote(null), PASTE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [pasteNote]);

  // Firefox fires Cmd/Ctrl+V on <body> even with the canvas focused, Chrome on the canvas (then it bubbles):
  // one document listener sees both, once, and leaves pastes into other inputs alone.
  useEffect(() => {
    if (!isActive) return;
    const onPaste = (event: ClipboardEvent) => {
      if (canvasRef.current === null || document.activeElement !== canvasRef.current) return;
      const raw = event.clipboardData?.getData('text/plain') ?? '';
      if (raw === '') return;
      event.preventDefault();
      // One message: the server puts it on Android's clipboard and presses Paste (Unicode-safe).
      const { text, isTruncated } = limitClipboardText(raw);
      setPasteNote(isTruncated ? PASTE_TRUNCATED_NOTE : null);
      send({ type: 'paste', text });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canvasRef, isActive, send]);

  // React registers wheel listeners as passive; this one must cancel page scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isActive) return;
    const onWheel = (event: WheelEvent) => {
      // Ctrl+wheel is the browser's zoom (and trackpad pinch): leave it alone.
      if (event.ctrlKey) return;
      const point = framePoint(canvas, event.clientX, event.clientY);
      if (!point?.inside) return;
      event.preventDefault();
      wheelAt.current = { x: point.x, y: point.y };
      wheel.current.add(wheelDelta(event));
      schedule();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef, isActive, schedule]);

  const handlers: ScreenInputHandlers = {
    onPointerDown(event) {
      if (!isActive || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const canvas = event.currentTarget;
      const point = framePoint(canvas, event.clientX, event.clientY);
      if (!point?.inside) return;
      // A second down for the same pointer (no up in between) replaces its gesture instead of leaking ids.
      end(event.pointerId);
      const first = slots.current.acquire();
      if (first === null) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture?.(event.pointerId);
      const ids = [first];
      if (event.pointerType === 'mouse' && event.altKey) {
        const second = slots.current.acquire();
        if (second !== null) ids.push(second);
      }
      const gesture: Gesture = { ids, last: { x: point.x, y: point.y } };
      gestures.current.set(event.pointerId, gesture);
      flush();
      send({ type: 'touch', touches: touchesFor(gesture, gesture.last, 1) });
      if (ids.length > 1) setPinchHint(gesture.last);
    },
    onPointerMove(event) {
      const point = framePoint(event.currentTarget, event.clientX, event.clientY);
      if (!point) return;
      const at = { x: point.x, y: point.y };
      hover.current = point.inside ? at : null;
      const gesture = gestures.current.get(event.pointerId);
      if (gesture) {
        gesture.last = at;
        for (const touch of touchesFor(gesture, at, 1)) moves.current.set(touch.id, touch);
        schedule();
        if (gesture.ids.length > 1) setPinchHint(at);
        return;
      }
      if (event.pointerType === 'mouse') setPinchHint(event.altKey && isActive && point.inside ? at : null);
    },
    onPointerUp: (event) => end(event.pointerId),
    onPointerCancel: (event) => end(event.pointerId),
    onLostPointerCapture: (event) => end(event.pointerId),
    onPointerLeave() {
      hover.current = null;
      if (gestures.current.size === 0) setPinchHint(null);
    },
    onKeyDown(event) {
      if (!isActive) return;
      if (event.key === 'Alt') {
        event.preventDefault();
        setPinchHint(hover.current);
        return;
      }
      const action = keyAction(keyInput(event), 'keydown');
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.msg?.type === 'key') heldKeys.current.add(action.msg.key);
      if (action.msg) send(action.msg);
    },
    onKeyUp(event) {
      if (!isActive) return;
      if (event.key === 'Alt') {
        // Alt is the pinch modifier here: its keyup must not open the browser's menu bar.
        event.preventDefault();
        if (gestures.current.size === 0) setPinchHint(null);
        return;
      }
      const action = keyAction(keyInput(event), 'keyup');
      if (action === null) return;
      event.preventDefault();
      if (action.msg?.type === 'key') heldKeys.current.delete(action.msg.key);
      if (action.msg) send(action.msg);
    },
    onBlur() {
      endAll();
      setPinchHint(null);
    },
  };

  return { handlers, pinchHint, pasteNote };
}

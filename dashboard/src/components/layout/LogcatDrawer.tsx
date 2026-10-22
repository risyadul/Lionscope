import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { DrawerSlotContext } from './drawerSlot.ts';
import { useElementSize } from '../../hooks/useElementSize.ts';
import { useStoredState } from '../../hooks/useStoredState.ts';
import {
  clampDrawerHeight,
  drawerMaxHeight,
  LAYOUT_KEYS,
  defaultDrawerHeight,
  LOGCAT_KEY_STEP,
  LOGCAT_MIN_HEIGHT,
  parseBoolean,
  parsePositiveInt,
} from '../../lib/layoutPrefs.ts';
import './layout.css';

const DRAWER_ID = 'logcat-drawer';
/** What the observed bar content box leaves out: `.drawer-bar` padding (4 + 4) and the drawer's 1 px top border. */
const BAR_CHROME_PX = 9;
/** Pressing these starts their own action, not a resize. */
const CONTROL_SELECTOR = 'button, input, select, textarea, a, label, [role="radio"]';

const parseCollapsed = (raw: string | null) => parseBoolean(raw, false);
/** null until the user resizes the drawer: the default then follows the column height. */
const parseHeight = (raw: string | null) => parsePositiveInt(raw, null);

const isControl = (target: EventTarget) =>
  target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;

type Props = {
  /** The instrument column, whose height bounds the drawer. */
  columnRef: RefObject<HTMLElement | null>;
  /** The panel portals its toolbar into the bar (see `useDrawerSlot`). */
  children: ReactNode;
};

type DragState = { startY: number; startHeight: number; height: number | null };

/**
 * Logcat under the timeline. The whole bar is the resize handle (drag anywhere but on its controls;
 * double-click toggles maximum and the previous height); the grip in it is the WAI-ARIA window splitter
 * (arrows, Page Up/Down, Home/End; Enter collapses). The drawer body stays mounted while collapsed, so
 * filters and scroll position survive. Height and collapsed state are remembered per viewer.
 */
export function LogcatDrawer({ columnRef, children }: Props) {
  const [isCollapsed, setIsCollapsed] = useStoredState(LAYOUT_KEYS.logcatCollapsed, parseCollapsed);
  const [storedHeight, setHeight] = useStoredState<number | null>(LAYOUT_KEYS.logcatHeight, parseHeight);
  const columnHeight = useElementSize(columnRef).height;
  const barRef = useRef<HTMLDivElement>(null);
  const barHeight = useElementSize(barRef).height + BAR_CHROME_PX;
  const clamp = (value: number) => clampDrawerHeight(value, columnHeight, barHeight);
  const height = storedHeight ?? defaultDrawerHeight(columnHeight);
  const drag = useRef<DragState | null>(null);
  /** Height before a double-click maximised the drawer. */
  const restoreHeight = useRef<number | null>(null);
  /** Height while dragging; stored (and remembered) once the drag ends. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const bindSlot = useCallback((node: HTMLElement | null) => setSlot(node), []);
  const shown = dragHeight ?? clamp(height);
  const max = drawerMaxHeight(columnHeight, barHeight);

  const resize = (next: number) => {
    const clamped = clamp(next);
    if (isCollapsed) setIsCollapsed(false);
    if (clamped !== shown) setHeight(clamped);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Partial<Record<string, number>> = {
      ArrowUp: LOGCAT_KEY_STEP,
      ArrowDown: -LOGCAT_KEY_STEP,
      PageUp: 4 * LOGCAT_KEY_STEP,
      PageDown: -4 * LOGCAT_KEY_STEP,
    };
    const step = steps[event.key];
    if (step !== undefined) resize((isCollapsed ? LOGCAT_MIN_HEIGHT : shown) + step);
    else if (event.key === 'Home') resize(LOGCAT_MIN_HEIGHT);
    else if (event.key === 'End') resize(max);
    else if (event.key === 'Enter') setIsCollapsed(!isCollapsed);
    else return;
    event.preventDefault();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isControl(event.target)) return;
    // No text selection (or native drag) while resizing.
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      startY: event.clientY,
      startHeight: isCollapsed ? LOGCAT_MIN_HEIGHT : shown,
      height: null,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    // The button came up somewhere we never heard about (outside the window, capture lost).
    if (event.buttons === 0) {
      endDrag();
      return;
    }
    // Dragging up grows the drawer. A drag that never moves (a click) changes nothing.
    const next = clamp(state.startHeight + state.startY - event.clientY);
    state.height = next;
    if (isCollapsed) setIsCollapsed(false);
    setDragHeight(next);
  };

  const endDrag = () => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    if (state.height !== null) setHeight(state.height);
    setDragHeight(null);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isControl(event.target)) return;
    if (isCollapsed) {
      setIsCollapsed(false);
    } else if (shown >= max) {
      // Already at full height (maximised earlier, or dragged there): go back to what it was, else the default.
      setHeight(clamp(restoreHeight.current ?? defaultDrawerHeight(columnHeight)));
      restoreHeight.current = null;
    } else {
      restoreHeight.current = shown;
      setHeight(max);
    }
  };

  const isDragging = dragHeight !== null;

  return (
    // Not a landmark of its own: the logcat panel inside is the "Logcat" region.
    <div
      className="logcat-drawer"
      data-collapsed={isCollapsed || undefined}
      data-dragging={isDragging || undefined}
    >
      <div
        ref={barRef}
        className="drawer-bar"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="drawer-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize logcat"
          aria-controls={DRAWER_ID}
          aria-valuemin={LOGCAT_MIN_HEIGHT}
          aria-valuemax={max}
          aria-valuenow={isCollapsed ? LOGCAT_MIN_HEIGHT : shown}
          aria-valuetext={isCollapsed ? 'Collapsed' : `${shown} px`}
          title="Drag the bar to resize; double-click for full height"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
            <g fill="currentColor">
              <circle cx="2.5" cy="3" r="1.15" />
              <circle cx="7.5" cy="3" r="1.15" />
              <circle cx="2.5" cy="8" r="1.15" />
              <circle cx="7.5" cy="8" r="1.15" />
              <circle cx="2.5" cy="13" r="1.15" />
              <circle cx="7.5" cy="13" r="1.15" />
            </g>
          </svg>
        </div>
        <div className="drawer-slot" ref={bindSlot} />
        <button
          type="button"
          className="btn btn--icon drawer-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={DRAWER_ID}
          aria-label={isCollapsed ? 'Show logcat' : 'Hide logcat'}
          title={isCollapsed ? 'Show logcat' : 'Hide logcat'}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="m2 6.5 3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <div id={DRAWER_ID} className="drawer-body" hidden={isCollapsed} style={{ height: `${shown}px` }}>
        <DrawerSlotContext value={slot}>{children}</DrawerSlotContext>
      </div>
    </div>
  );
}

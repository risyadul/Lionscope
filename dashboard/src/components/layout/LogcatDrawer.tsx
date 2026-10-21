import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
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

const parseCollapsed = (raw: string | null) => parseBoolean(raw, false);
/** null until the user resizes the drawer: the default then follows the column height. */
const parseHeight = (raw: string | null) => parsePositiveInt(raw, null);

type Props = {
  /** The instrument column, whose height bounds the drawer. */
  columnRef: RefObject<HTMLElement | null>;
  /** Shown in the bar, e.g. the line count. */
  meta?: ReactNode;
  children: ReactNode;
};

/**
 * Logcat under the timeline: a WAI-ARIA window splitter (drag, arrows, Page Up/Down, Home/End; Enter
 * collapses) above a drawer that stays mounted while collapsed, so filters and scroll position survive.
 * Height and collapsed state are remembered per viewer.
 */
export function LogcatDrawer({ columnRef, meta, children }: Props) {
  const [isCollapsed, setIsCollapsed] = useStoredState(LAYOUT_KEYS.logcatCollapsed, parseCollapsed);
  const [storedHeight, setHeight] = useStoredState<number | null>(LAYOUT_KEYS.logcatHeight, parseHeight);
  const columnHeight = useElementSize(columnRef).height;
  const height = storedHeight ?? defaultDrawerHeight(columnHeight);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  /** Height while dragging; stored (and remembered) once the drag ends. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const shown = dragHeight ?? clampDrawerHeight(height, columnHeight);
  const max = drawerMaxHeight(columnHeight);

  const resize = (next: number) => {
    const clamped = clampDrawerHeight(next, columnHeight);
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
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startHeight = isCollapsed ? LOGCAT_MIN_HEIGHT : shown;
    drag.current = { startY: event.clientY, startHeight };
    if (isCollapsed) setIsCollapsed(false);
    setDragHeight(startHeight);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    // The button came up somewhere we never heard about (outside the window, capture lost).
    if (event.buttons === 0) {
      endDrag();
      return;
    }
    // Dragging up grows the drawer.
    setDragHeight(clampDrawerHeight(state.startHeight + state.startY - event.clientY, columnHeight));
  };

  const endDrag = () => {
    if (drag.current === null) return;
    drag.current = null;
    if (dragHeight !== null) setHeight(dragHeight);
    setDragHeight(null);
  };

  return (
    // Not a landmark of its own: the logcat panel inside is the "Logcat" region.
    <div className="logcat-drawer" data-collapsed={isCollapsed || undefined}>
      <div
        className="drawer-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize logcat"
        aria-controls={DRAWER_ID}
        aria-valuemin={LOGCAT_MIN_HEIGHT}
        aria-valuemax={max}
        aria-valuenow={isCollapsed ? LOGCAT_MIN_HEIGHT : shown}
        aria-valuetext={isCollapsed ? 'Collapsed' : `${shown} px`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="drawer-bar">
        <span className="drawer-title" aria-hidden="true">
          Logcat
        </span>
        {meta}
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
        {children}
      </div>
    </div>
  );
}

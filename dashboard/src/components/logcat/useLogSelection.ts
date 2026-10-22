import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { LogRecord } from '../../lib/store.ts';

const NONE: ReadonlySet<number> = new Set();

/** True while the user has dragged out a native text selection inside `element` (a click must not hijack it). */
function hasTextSelectionIn(element: HTMLElement): boolean {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed && element.contains(selection.anchorNode);
}

/**
 * Row selection by `seq`: click selects one (again to deselect), shift-click extends a range from the
 * anchor, Cmd/Ctrl-click toggles. `rows` is read at click time so the callbacks stay stable and the
 * memoised rows don't re-render on every incoming line.
 */
export function useLogSelection(rows: readonly LogRecord[]) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(NONE);
  const anchor = useRef<number | null>(null);
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });

  const select = useCallback((record: LogRecord, event: MouseEvent<HTMLElement>) => {
    if (hasTextSelectionIn(event.currentTarget)) return;
    const { seq } = record;
    if (event.shiftKey && anchor.current !== null) {
      const list = rowsRef.current;
      const from = list.findIndex((r) => r.seq === anchor.current);
      const to = list.findIndex((r) => r.seq === seq);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(list.slice(lo, hi + 1).map((r) => r.seq)));
        return;
      }
    }
    anchor.current = seq;
    setSelected((current) => {
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(current);
        if (!next.delete(seq)) next.add(seq);
        return next;
      }
      return current.size === 1 && current.has(seq) ? NONE : new Set([seq]);
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(rowsRef.current.map((r) => r.seq)));
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(NONE);
  }, []);

  return { selected, select, selectAll, clear };
}

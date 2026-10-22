import { useEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** A box that moved by less than this (sub-pixel layout noise) keeps its previous size. */
const MIN_CHANGE_PX = 1;

/**
 * Content-box size of `ref`'s element (padding excluded), kept current with a ResizeObserver (0 × 0 until
 * measured). Whole pixels, and a sub-pixel wobble across a pixel boundary isn't reported as a resize.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  // A passive effect: refs attach after children's layout effects, so a child measuring its ancestor
  // (the logcat drawer and the instrument column) would still find the ref empty in a layout effect.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (!box) return;
      setSize((prev) =>
        Math.abs(box.width - prev.width) < MIN_CHANGE_PX && Math.abs(box.height - prev.height) < MIN_CHANGE_PX
          ? prev
          : { width: Math.floor(box.width), height: Math.floor(box.height) },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

import { useLayoutEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Content-box size of `ref`'s element (padding excluded), kept current with a ResizeObserver (0 × 0 until
 * measured).
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (!box) return;
      const width = Math.floor(box.width);
      const height = Math.floor(box.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

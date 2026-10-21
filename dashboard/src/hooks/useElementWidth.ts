import { useLayoutEffect, useState, type RefObject } from 'react';

/** Content-box width of `ref`'s element, kept current with a ResizeObserver (0 until measured). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

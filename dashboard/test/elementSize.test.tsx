import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementSize, type ElementSize } from '../src/hooks/useElementSize.ts';

let emit: (width: number, height: number) => void = () => {};

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    emit = (width, height) =>
      this.callback(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  observe() {}
  disconnect() {}
}

function Probe({ sizes }: { sizes: ElementSize[] }) {
  const ref = useRef<HTMLDivElement>(null);
  sizes.push(useElementSize(ref));
  return <div ref={ref} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useElementSize', () => {
  it('ignores sub-pixel wobble across a pixel boundary but reports a whole-pixel resize', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const sizes: ElementSize[] = [];
    render(<Probe sizes={sizes} />);

    act(() => emit(346.4, 700.2));
    expect(sizes.at(-1)).toEqual({ width: 346, height: 700 });
    const measured = sizes.at(-1);

    // A 0.6 px header wobble would floor to 699 and re-fit the canvas: the size must stay the same object.
    act(() => emit(346.4, 699.6));
    act(() => emit(345.9, 700.5));
    expect(sizes.at(-1)).toBe(measured);

    act(() => emit(346.4, 660));
    expect(sizes.at(-1)).toEqual({ width: 346, height: 660 });
  });
});

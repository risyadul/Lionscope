import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestList, ROW_PX } from '../src/components/network/RequestList.tsx';
import { exchange } from './fixtures.ts';

let emit: (height: number) => void = () => {};

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    emit = (height) =>
      this.callback(
        [{ contentRect: { width: 360, height } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequestList following the newest request', () => {
  it('scrolls to the bottom again when the list gets shorter, so no blank space shows above the rows', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const rows = Array.from({ length: 40 }, (_, i) => exchange(i + 1, 1_000 + i));
    const writes: number[] = [];
    // jsdom has no layout: the list reports its content height and records where it is scrolled to.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('net-list') ? rows.length * ROW_PX : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
      this: HTMLElement,
      v: number,
    ) {
      if (this.classList.contains('net-list')) writes.push(v);
    });
    render(
      <RequestList
        rows={rows}
        selectedId={null}
        onSelect={() => {}}
        isFollowing
        onFollowChange={() => {}}
        unseen={0}
      />,
    );
    act(() => emit(480));
    const before = writes.length;
    // The detail opened under the list.
    act(() => emit(200));
    expect(writes.length).toBeGreaterThan(before);
    expect(writes.at(-1)).toBe(rows.length * ROW_PX);
  });
});

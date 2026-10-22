import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogcatDrawer } from '../src/components/layout/LogcatDrawer.tsx';
import { LAYOUT_KEYS, LOGCAT_DEFAULT_HEIGHT, LOGCAT_MIN_HEIGHT } from '../src/lib/layoutPrefs.ts';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const columnRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={columnRef}>
      <LogcatDrawer columnRef={columnRef}>
        <p>log lines</p>
      </LogcatDrawer>
    </div>
  );
}

const splitter = () => screen.getByRole('separator', { name: 'Resize logcat' });
const value = () => Number(splitter().getAttribute('aria-valuenow'));
const bar = () => splitter().closest('.drawer-bar') as HTMLElement;
const body = () => screen.getByText('log lines').parentElement as HTMLElement;

describe('LogcatDrawer', () => {
  it('starts at the default height and resizes with the keyboard', () => {
    render(<Harness />);
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT);
    expect(body().style.height).toBe(`${LOGCAT_DEFAULT_HEIGHT}px`);
    fireEvent.keyDown(splitter(), { key: 'ArrowUp' });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 24);
    fireEvent.keyDown(splitter(), { key: 'PageDown' });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 24 - 96);
    fireEvent.keyDown(splitter(), { key: 'Home' });
    expect(value()).toBe(LOGCAT_MIN_HEIGHT);
    fireEvent.keyDown(splitter(), { key: 'End' });
    expect(value()).toBe(Number(splitter().getAttribute('aria-valuemax')));
    expect(window.localStorage.getItem(LAYOUT_KEYS.logcatHeight)).toBe(String(value()));
  });

  it('collapses with Enter or the toggle, keeping the panel mounted, and remembers it', () => {
    const view = render(<Harness />);
    fireEvent.keyDown(splitter(), { key: 'Enter' });
    expect(body().hidden).toBe(true);
    expect(splitter().getAttribute('aria-valuetext')).toBe('Collapsed');
    const toggle = screen.getByRole('button', { name: 'Show logcat' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem(LAYOUT_KEYS.logcatCollapsed)).toBe('true');

    view.unmount();
    render(<Harness />);
    expect(body().hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show logcat' }));
    expect(body().hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide logcat' })).toBeTruthy();
  });

  it('an arrow key on a collapsed drawer reopens it from the minimum', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide logcat' }));
    fireEvent.keyDown(splitter(), { key: 'ArrowUp' });
    expect(body().hidden).toBe(false);
    expect(value()).toBe(LOGCAT_MIN_HEIGHT + 24);
  });

  it('drags: up grows, the height is stored when the drag ends', () => {
    render(<Harness />);
    fireEvent.pointerDown(splitter(), { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(splitter(), { pointerId: 1, buttons: 1, clientY: 400 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 100);
    expect(window.localStorage.getItem(LAYOUT_KEYS.logcatHeight)).toBeNull();
    fireEvent.pointerMove(splitter(), { pointerId: 1, buttons: 1, clientY: 900 });
    expect(value()).toBe(LOGCAT_MIN_HEIGHT);
    fireEvent.pointerUp(splitter(), { pointerId: 1, clientY: 900 });
    expect(window.localStorage.getItem(LAYOUT_KEYS.logcatHeight)).toBe(String(LOGCAT_MIN_HEIGHT));
  });

  it('drags from anywhere on the bar, but not from its controls', () => {
    render(<Harness />);
    fireEvent.pointerDown(bar(), { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(bar(), { pointerId: 1, buttons: 1, clientY: 450 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 50);
    expect(bar().closest('.logcat-drawer')?.hasAttribute('data-dragging')).toBe(true);
    fireEvent.pointerUp(bar(), { pointerId: 1, clientY: 450 });
    expect(bar().closest('.logcat-drawer')?.hasAttribute('data-dragging')).toBe(false);

    const toggle = screen.getByRole('button', { name: 'Hide logcat' });
    fireEvent.pointerDown(toggle, { pointerId: 2, button: 0, clientY: 500 });
    fireEvent.pointerMove(bar(), { pointerId: 2, buttons: 1, clientY: 300 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 50);
  });

  it('a press without movement neither resizes nor reopens a collapsed drawer', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide logcat' }));
    fireEvent.pointerDown(bar(), { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerUp(bar(), { pointerId: 1, clientY: 500 });
    expect(body().hidden).toBe(true);
    fireEvent.pointerDown(bar(), { pointerId: 2, button: 0, clientY: 500 });
    fireEvent.pointerMove(bar(), { pointerId: 2, buttons: 1, clientY: 440 });
    fireEvent.pointerUp(bar(), { pointerId: 2, clientY: 440 });
    expect(body().hidden).toBe(false);
    expect(value()).toBe(LOGCAT_MIN_HEIGHT + 60);
  });

  it('double-click on the bar toggles maximum height and the previous height', () => {
    render(<Harness />);
    fireEvent.doubleClick(bar());
    const max = Number(splitter().getAttribute('aria-valuemax'));
    expect(value()).toBe(max);
    fireEvent.doubleClick(bar());
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Hide logcat' }));
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT);
  });

  it('keeps the separator on the grip alone, never on a container of controls', () => {
    render(<Harness />);
    expect(splitter().querySelector('button, input')).toBeNull();
    expect(splitter().tabIndex).toBe(0);
  });

  it('defaults to a quarter of the measured column, and a saved height wins', () => {
    class SizedResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // The drawer bar is measured too: give it its one-row height.
        const height = target.classList.contains('drawer-bar') ? 32 : 840;
        const entry = { contentRect: { width: 1000, height } } as ResizeObserverEntry;
        this.callback([entry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
    const view = render(<Harness />);
    expect(value()).toBe(210);
    view.unmount();
    window.localStorage.setItem(LAYOUT_KEYS.logcatHeight, '330');
    render(<Harness />);
    expect(value()).toBe(330);
  });

  it('ends a drag when pointer capture is lost or the button is already up', () => {
    render(<Harness />);
    fireEvent.pointerDown(splitter(), { pointerId: 1, button: 0, clientY: 500 });
    fireEvent.pointerMove(splitter(), { pointerId: 1, buttons: 1, clientY: 450 });
    fireEvent.lostPointerCapture(splitter(), { pointerId: 1 });
    expect(window.localStorage.getItem(LAYOUT_KEYS.logcatHeight)).toBe(String(LOGCAT_DEFAULT_HEIGHT + 50));
    fireEvent.pointerMove(splitter(), { pointerId: 1, buttons: 1, clientY: 300 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 50);

    fireEvent.pointerDown(splitter(), { pointerId: 2, button: 0, clientY: 500 });
    // Released outside the window: the next move arrives with no button down.
    fireEvent.pointerMove(splitter(), { pointerId: 2, buttons: 0, clientY: 300 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 50);
    fireEvent.pointerMove(splitter(), { pointerId: 2, buttons: 1, clientY: 200 });
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT + 50);
  });

  it('ignores a stored height that is not a number', () => {
    window.localStorage.setItem(LAYOUT_KEYS.logcatHeight, 'huge');
    render(<Harness />);
    expect(value()).toBe(LOGCAT_DEFAULT_HEIGHT);
  });
});

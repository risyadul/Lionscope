import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogcatPanel } from '../src/components/logcat/LogcatPanel.tsx';
import { LogcatDrawer } from '../src/components/layout/LogcatDrawer.tsx';
import { formatClock } from '../src/lib/format.ts';
import { createSignal } from '../src/lib/signal.ts';
import type { LogRecord } from '../src/lib/store.ts';
import { log, T0 } from './fixtures.ts';

afterEach(() => cleanup());

function records(count: number, startSeq = 0, startTs = T0): LogRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    ...log(startTs + i * 1000, { message: `line ${i}` }),
    seq: startSeq + i,
  }));
}

/** jsdom has no layout: give the list a fixed scrollable geometry. */
function fakeScrollGeometry(list: HTMLElement, scrollHeight = 2000, clientHeight = 200) {
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => clientHeight });
}

function renderPanel(logs: LogRecord[]) {
  const probeTs = createSignal<number | null>(null);
  const view = render(<LogcatPanel logs={logs} pid={4821} probeTs={probeTs} />);
  const rerender = (next: LogRecord[]) =>
    view.rerender(<LogcatPanel logs={next} pid={4821} probeTs={probeTs} />);
  return { rerender, probeTs };
}

const list = () => screen.getByRole('list', { name: /Log lines/ });
const messages = () =>
  within(list())
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.log-msg')?.textContent);

describe('LogcatPanel', () => {
  it('follows new lines while at the bottom', () => {
    const logs = records(3);
    const { rerender } = renderPanel(logs);
    fakeScrollGeometry(list());
    rerender([...logs, ...records(1, 3, T0 + 3000)]);
    expect(list().scrollTop).toBe(2000);
    expect(messages()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('freezes the view when scrolled up and offers a jump with the unseen count', () => {
    const logs = records(3);
    const { rerender } = renderPanel(logs);
    fakeScrollGeometry(list());
    list().scrollTop = 0;
    fireEvent.scroll(list());

    const more = [...logs, ...records(2, 3, T0 + 3000)];
    rerender(more);
    expect(messages()).toEqual(['line 0', 'line 1', 'line 2']);
    const jump = screen.getByRole('button', { name: /Jump to latest/ });
    expect(jump.textContent).toContain('+2');

    fireEvent.click(jump);
    expect(messages()).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('resumes following when scrolled back to the bottom', () => {
    const logs = records(3);
    const { rerender } = renderPanel(logs);
    fakeScrollGeometry(list());
    list().scrollTop = 0;
    fireEvent.scroll(list());
    list().scrollTop = 1800;
    fireEvent.scroll(list());
    rerender([...logs, ...records(1, 3, T0 + 3000)]);
    expect(messages()).toHaveLength(4);
  });

  it('keeps cleared lines hidden even when a reconnect re-sends them with new sequence numbers', () => {
    const logs = records(3);
    const { rerender } = renderPanel(logs);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('No log lines yet')).toBeTruthy();

    // Snapshot after reconnect: same lines, fresh seqs.
    rerender(records(3, 100));
    expect(screen.getByText('No log lines yet')).toBeTruthy();

    rerender([...records(3, 100), ...records(1, 200, T0 + 10_000)]);
    expect(messages()).toEqual(['line 0']);
  });

  it('filters by minimum level and reports the hovered line time', () => {
    const logs: LogRecord[] = [
      { ...log(T0, { level: 'V', message: 'verbose' }), seq: 0 },
      { ...log(T0 + 1, { level: 'E', message: 'error' }), seq: 1 },
    ];
    const { probeTs } = renderPanel(logs);
    expect(messages()).toEqual(['error']);
    fireEvent.click(screen.getByRole('radio', { name: 'V' }));
    expect(messages()).toEqual(['verbose', 'error']);

    fireEvent.mouseEnter(within(list()).getAllByRole('listitem')[1]!);
    expect(probeTs.get()).toBe(T0 + 1);
    fireEvent.mouseLeave(list());
    expect(probeTs.get()).toBeNull();
  });

  it('renders a placeholder time for a non-finite timestamp instead of crashing', () => {
    renderPanel([{ ...log(Number.NaN, { message: 'bad clock' }), seq: 0 }]);
    expect(screen.getByText('--:--:--.---')).toBeTruthy();
    expect(screen.getByText('bad clock')).toBeTruthy();
  });

  it('shows one count: matched of the buffer, or just the buffer when unfiltered', () => {
    const logs: LogRecord[] = [
      { ...log(T0, { level: 'V', message: 'verbose' }), seq: 0 },
      { ...log(T0 + 1, { level: 'E', message: 'error' }), seq: 1 },
      { ...log(T0 + 2, { level: 'I', message: 'info' }), seq: 2 },
    ];
    renderPanel(logs);
    expect(document.querySelector('.logcat-count')?.textContent).toBe('2 of 3');
    fireEvent.click(screen.getByRole('radio', { name: 'V' }));
    expect(document.querySelector('.logcat-count')?.textContent).toBe('3');
  });

  describe('selection and copy', () => {
    const items = () => within(list()).getAllByRole('listitem');
    const selectedCount = () => items().filter((li) => li.hasAttribute('data-selected')).length;
    let written: string[];

    function stubClipboard(writeText?: (text: string) => Promise<void>) {
      written = [];
      vi.stubGlobal('navigator', {
        ...navigator,
        clipboard: {
          writeText:
            writeText ??
            ((text: string) => {
              written.push(text);
              return Promise.resolve();
            }),
        },
      });
    }
    const flush = () => act(() => Promise.resolve());

    afterEach(() => vi.unstubAllGlobals());

    it('click selects, shift extends a range, Cmd-click toggles, Escape clears', () => {
      renderPanel(records(5));
      fireEvent.click(items()[1]!);
      expect(selectedCount()).toBe(1);
      fireEvent.click(items()[3]!, { shiftKey: true });
      expect(selectedCount()).toBe(3);
      fireEvent.click(items()[4]!, { metaKey: true });
      expect(selectedCount()).toBe(4);
      fireEvent.click(items()[1]!, { ctrlKey: true });
      expect(selectedCount()).toBe(3);
      expect(screen.getByText('3 selected')).toBeTruthy();
      fireEvent.keyDown(list(), { key: 'Escape' });
      expect(selectedCount()).toBe(0);
      expect(screen.queryByText(/selected/)).toBeNull();
    });

    it('copies the selected rows as `HH:MM:SS.mmm L Tag: message`, keeping multi-line messages', async () => {
      stubClipboard();
      const logs: LogRecord[] = [
        { ...log(T0, { level: 'I', tag: 'Shop', message: 'first' }), seq: 0 },
        { ...log(T0 + 1000, { level: 'E', tag: 'Net', message: 'boom\n  at a.b(C.kt:1)' }), seq: 1 },
        { ...log(T0 + 2000, { level: 'W', tag: 'Db', message: 'third' }), seq: 2 },
      ];
      renderPanel(logs);
      fireEvent.click(items()[0]!);
      fireEvent.click(items()[1]!, { shiftKey: true });
      fireEvent.keyDown(list(), { key: 'c', metaKey: true });
      await flush();
      expect(written).toEqual([
        `${formatClock(T0)} I Shop: first\n${formatClock(T0 + 1000)} E Net: boom\n  at a.b(C.kt:1)`,
      ]);
      expect(screen.getByText('Copied 2 lines')).toBeTruthy();
    });

    it('leaves Cmd+C alone when no rows are selected', () => {
      stubClipboard();
      renderPanel(records(2));
      const notCancelled = fireEvent.keyDown(list(), { key: 'c', ctrlKey: true });
      expect(notCancelled).toBe(true);
      expect(written).toEqual([]);
    });

    it('the row button copies that one line without selecting it', async () => {
      stubClipboard();
      renderPanel(records(3));
      fireEvent.click(within(items()[2]!).getByRole('button', { name: 'Copy line' }));
      await flush();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/ line 2$/);
      expect(selectedCount()).toBe(0);
      expect(screen.getByText('Copied 1 line')).toBeTruthy();
    });

    it('says so when the browser refuses, or has no clipboard', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      renderPanel(records(2));
      fireEvent.click(within(items()[0]!).getByRole('button', { name: 'Copy line' }));
      await flush();
      expect(screen.getByText('Copying isn’t allowed here')).toBeTruthy();
    });

    it('selecting does not disturb follow mode', () => {
      const logs = records(3);
      const { rerender } = renderPanel(logs);
      fakeScrollGeometry(list());
      fireEvent.click(items()[0]!);
      rerender([...logs, ...records(1, 3, T0 + 3000)]);
      expect(list().scrollTop).toBe(2000);
      expect(items()).toHaveLength(4);
      expect(selectedCount()).toBe(1);
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    });
  });

  it('draws its toolbar inside the drawer bar, so the filters stay reachable when collapsed', () => {
    window.localStorage.clear();
    window.localStorage.setItem('lionscope.layout.logcatCollapsed', 'true');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    function Host() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <LogcatDrawer columnRef={ref}>
            <LogcatPanel logs={records(3)} pid={7} probeTs={createSignal<number | null>(null)} />
          </LogcatDrawer>
        </div>
      );
    }
    render(<Host />);
    const bar = screen
      .getByRole('separator', { name: 'Resize logcat' })
      .closest('.drawer-bar') as HTMLElement;
    expect(within(bar).getByRole('radio', { name: 'V' })).toBeTruthy();
    expect(within(bar).getByRole('searchbox')).toBeTruthy();
    expect(within(bar).getByText('pid 7')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

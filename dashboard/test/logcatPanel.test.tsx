import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LogcatPanel } from '../src/components/logcat/LogcatPanel.tsx';
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
});

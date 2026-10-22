import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenPanel } from '../src/components/screens/ScreenPanel.tsx';
import type { ScreenRow } from '../src/lib/screenStats.ts';

afterEach(() => cleanup());

const STAGES = {
  input: 0,
  animation: 0,
  layout: 0,
  draw: 2.1,
  sync: 0,
  command: 0,
  swap: 0,
  delay: 0.8,
  gpu: 14,
};

function row(name: string, jankPercent: number): ScreenRow {
  return {
    name,
    frames: 1284,
    jankFrames: Math.round(12.84 * jankPercent),
    slowFrames: 0,
    jankPercent,
    slowPercent: 0,
    typicalP90Ms: 18.2,
    worstP90Ms: 44,
    stageMs: STAGES,
    dominant: { stage: 'gpu', ms: 14 },
    stallCount: 0,
    stallMs: 0,
    inflateMs: 0,
    inflateCount: 0,
    slowestInflate: null,
    viewTree: null,
  };
}

describe('ScreenPanel table', () => {
  it('keeps Dominant its own column, read with its header, even where narrow panels fold it under the name', () => {
    const onSelect = vi.fn();
    render(
      <ScreenPanel
        rows={[row('JankListFragment', 42.3), row('home_tab', 0.4)]}
        empty={null}
        selected={null}
        onSelect={onSelect}
        showStalls
      />,
    );
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Screen', 'Frames', 'Jank', 'Slow', 'p90 typ', 'Stalls', 'Dominant']);

    const [, first] = within(table).getAllByRole('row');
    const cells = within(first as HTMLElement).getAllByRole('cell');
    expect(cells.at(-1)?.textContent).toBe('GPU14.0');
    // The stage isn't part of the row header's button: its name stays the screen name.
    const name = within(first as HTMLElement).getByRole('button', { name: 'JankListFragment' });
    fireEvent.click(name);
    expect(onSelect).toHaveBeenCalledWith('JankListFragment');
  });
});

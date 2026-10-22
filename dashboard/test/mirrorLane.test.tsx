import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MirrorSpan } from '@lionscope/protocol/wire';
import { MIRROR_HINT, MIRROR_LEGEND_LABEL, MirrorLane } from '../src/components/timeline/MirrorLane.tsx';
import { T0 } from './fixtures.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

afterEach(() => cleanup());

const span = (start: number, end: number | null): MirrorSpan => ({ serial: 'R58M123ABC', start, end });

function renderLane(spans: MirrorSpan[], { isLive = true }: { isLive?: boolean } = {}) {
  const fromTs = T0;
  const toTs = T0 + 60_000;
  render(<MirrorLane spans={spans} fromTs={fromTs} toTs={toTs} openEnd={toTs} isLive={isLive} />);
  return screen.getByRole('figure', { name: 'Mirroring' });
}

describe('MirrorLane', () => {
  it('places each span on the shared x axis as a percentage of the window', () => {
    const lane = renderLane([span(T0 + 6000, T0 + 12_000), span(T0 + 30_000, null)]);
    const runs = within(lane).getAllByRole('img');
    expect(runs.map((r) => [r.style.left, r.style.width])).toEqual([
      ['10%', '10%'],
      ['50%', '50%'],
    ]);
    expect(runs[1]?.hasAttribute('data-open')).toBe(true);
    expect(runs[0]?.hasAttribute('data-open')).toBe(false);
  });

  it('labels the legend "Mirroring on" and explains the encoder cost in aria text and tooltips', () => {
    const lane = renderLane([span(T0 + 30_000, null)]);
    expect(within(lane).getByText(MIRROR_LEGEND_LABEL)).toBeTruthy();
    expect(within(lane).getByText('now')).toBeTruthy();
    const run = within(lane).getByRole('img');
    expect(run.getAttribute('aria-label')).toMatch(/^Mirroring on, 30 s, \d{2}:\d{2}:\d{2} – now\. /);
    expect(run.getAttribute('aria-label')).toContain(MIRROR_HINT);
    expect(run.title).toContain(MIRROR_HINT);
    expect(within(lane).getByRole('note').getAttribute('aria-label')).toBe(MIRROR_HINT);
  });

  it('draws nothing for spans outside the window and says nothing is on now', () => {
    const lane = renderLane([span(T0 - 20_000, T0 - 10_000)]);
    expect(within(lane).queryAllByRole('img')).toEqual([]);
    expect(within(lane).queryByText('now')).toBeNull();
  });

  it('says "now" only while the window follows the clock (not paused or stopped)', () => {
    const lane = renderLane([span(T0 + 30_000, null)], { isLive: false });
    expect(within(lane).queryByText('now')).toBeNull();
    expect(within(lane).getByRole('img').getAttribute('aria-label')).not.toContain('– now');
  });
});

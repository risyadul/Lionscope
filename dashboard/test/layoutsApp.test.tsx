import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, SdkStatus, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { createSignal } from '../src/lib/signal.ts';
import { INFLATE_UPDATE_HINT } from '../src/components/stalls/StallControls.tsx';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { breakdown, frame, inflate, SDK_V2, SDK_V3, session, span, viewTree } from './fixtures.ts';
import { plots, resetPlots } from './uplotMock.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

beforeAll(() => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => resetPlots());
afterEach(() => cleanup());

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const EMULATOR: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.2.0',
  bufferWindowMs: 600_000,
};

function setup(messages: ServerMessage[]) {
  const store = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const sent: ClientMessage[] = [];
  const services: DashboardServices = {
    store,
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    probeTs: createSignal<number | null>(null),
    cursorX: createSignal<number | null>(null),
  };
  store.dispatch({ kind: 'connection', connection: OPEN });
  for (const msg of messages) store.dispatch({ kind: 'server', msg });
  store.flush();
  render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  const push = (...msgs: ServerMessage[]) =>
    act(() => {
      for (const msg of msgs) store.dispatch({ kind: 'server', msg });
      store.flush();
    });
  return { sent, push };
}

function running(sdk: SdkStatus, now: number, extra: ServerMessage[] = []): ServerMessage[] {
  return [
    hello,
    { type: 'devices', devices: [EMULATOR] },
    { type: 'session', session: session({ startedAt: now - 60_000, sdk }) },
    { type: 'frames', sample: frame(now - 1000, { source: 'sdk' }) },
    ...extra,
  ];
}

function withLayouts(now: number, sdk: SdkStatus = SDK_V3): ServerMessage[] {
  return running(sdk, now, [
    { type: 'screen', span: span(now - 50_000, null, 'homepage') },
    { type: 'breakdown', sample: breakdown(now - 40_000, 'homepage') },
    {
      type: 'inflate',
      sample: inflate(now - 40_000, { layout: 'fragment_home', totalMs: 38, maxMs: 38, views: 90 }),
    },
    {
      type: 'inflate',
      sample: inflate(now - 30_000, { layout: 'item_row', count: 12, totalMs: 30, maxMs: 4, views: 9 }),
    },
    {
      type: 'inflate',
      sample: inflate(now - 20_000, { layout: 'abc_dialog', library: true, totalMs: 2, maxMs: 2 }),
    },
    {
      type: 'inflate',
      sample: inflate(now - 10_000, { layout: null, label: 'Button:12', totalMs: 1, maxMs: 1 }),
    },
    { type: 'viewtree', sample: viewTree(now - 39_000) },
  ]);
}

const options = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'setSdkOptions');
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const panel = (name: RegExp) => screen.getByRole('tabpanel', { name });
const openLayouts = () => fireEvent.click(tab(/Layouts/));
const layoutsPanel = () => panel(/Layouts/);
const layoutNames = () =>
  within(layoutsPanel())
    .getAllByRole('rowheader')
    .map((el) => el.querySelector('.layout-name')?.textContent);

type FakePlot = (typeof plots)[number];
const PLOT_WIDTH = 1000;
function stallPlot(): FakePlot {
  const plot = plots.find(
    (p) =>
      !p.destroyed && (p.opts as unknown as { series: { label?: string }[] }).series[1]?.label === 'Stall',
  );
  if (!plot) throw new Error('no Main thread chart');
  plot.over.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: PLOT_WIDTH,
    height: 60,
    right: PLOT_WIDTH,
    bottom: 60,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return plot;
}
/** Client x of epoch-ms `ts` (+2 px, inside the mark) on the fake plot. */
function clientXAt(plot: FakePlot, ts: number): number {
  const [from, to] = plot.xRange();
  return ((ts / 1000 - from) / (to - from)) * PLOT_WIDTH + 2;
}
/** The inflation row of the 60 px plot: the rail's upper half (22 px rail → 38..49). */
const INFLATE_ROW_Y = 42;

describe('Layouts tab', () => {
  it('lists layouts by total time with a count on the tab, library layouts hidden', () => {
    setup(withLayouts(Date.now()));
    expect(tab(/Layouts/).textContent).toBe('Layouts3');
    openLayouts();
    expect(layoutNames()).toEqual(['fragment_home', 'item_row', 'Button:12']);
    const row = within(layoutsPanel()).getByText('item_row').closest('tr')!;
    expect(row.textContent).toContain('12');
    expect(within(layoutsPanel()).getByText('Button:12').getAttribute('data-label')).toBe('true');
    // 38 ms is over the slow mark: its Max cell is flagged.
    const home = within(layoutsPanel()).getByText('fragment_home').closest('tr')!;
    expect(home.querySelector('.inflate-max')?.hasAttribute('data-slow')).toBe(true);
    expect(row.querySelector('.inflate-max')?.hasAttribute('data-slow')).toBe(false);
  });

  it('marks nested layouts as part of the layout around them', () => {
    const now = Date.now();
    setup(
      running(SDK_V3, now, [
        { type: 'inflate', sample: inflate(now - 5000, { layout: 'fragment_home', totalMs: 30, maxMs: 30 }) },
        {
          type: 'inflate',
          sample: inflate(now - 5000, { layout: 'view_banner', nested: true, totalMs: 12, maxMs: 12 }),
        },
      ]),
    );
    openLayouts();
    expect(layoutNames()).toEqual(['fragment_home', 'view_banner']);
    const banner = within(layoutsPanel()).getByText('view_banner').closest('th')!;
    expect(banner.querySelector('.layout-badge')?.textContent).toBe('nested');
    expect(banner.querySelector('.layout-badge')?.getAttribute('title')).toContain('already part of');
    const home = within(layoutsPanel()).getByText('fragment_home').closest('th')!;
    expect(home.querySelector('.layout-badge')).toBeNull();
  });

  it('shows library layouts with a badge when asked', () => {
    setup(withLayouts(Date.now()));
    openLayouts();
    const toggle = within(layoutsPanel()).getByRole('switch', { name: /Show library layouts/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(layoutNames()).toContain('abc_dialog');
    expect(within(layoutsPanel()).getByText('lib')).toBeTruthy();
  });

  it('sorts by a clicked column and flips on a second click', () => {
    setup(withLayouts(Date.now()));
    openLayouts();
    const count = within(layoutsPanel()).getByRole('button', { name: /^Count/ });
    fireEvent.click(count);
    expect(layoutNames()[0]).toBe('item_row');
    fireEvent.click(count);
    expect(layoutNames()[2]).toBe('item_row');
    expect(
      within(layoutsPanel()).getByRole('columnheader', { name: /Count/ }).getAttribute('aria-sort'),
    ).toBe('ascending');
  });

  it('says only library layouts were inflated, with a way to show them', () => {
    const now = Date.now();
    setup(
      running(SDK_V3, now, [
        { type: 'inflate', sample: inflate(now - 5000, { library: true, layout: 'abc_x' }) },
      ]),
    );
    openLayouts();
    expect(within(layoutsPanel()).getByText('Only library layouts in this window')).toBeTruthy();
    fireEvent.click(within(layoutsPanel()).getByRole('button', { name: 'Show library layouts' }));
    expect(layoutNames()).toEqual(['abc_x']);
  });

  it('explains Android below 10 and points at the view trees', () => {
    setup(running({ ...SDK_V3, apiLevel: 28 }, Date.now()));
    openLayouts();
    expect(within(layoutsPanel()).getByText('Layout inflation needs Android 10+')).toBeTruthy();
    expect(within(layoutsPanel()).getByText(/View trees still work/)).toBeTruthy();
  });

  it('explains an SDK that predates layout timing', () => {
    setup(running(SDK_V2, Date.now()));
    openLayouts();
    expect(within(layoutsPanel()).getByText('This SDK can’t time layouts')).toBeTruthy();
  });

  it('explains the waiting state and the no-session state', () => {
    setup(running(SDK_V3, Date.now()));
    openLayouts();
    expect(within(layoutsPanel()).getByText('No layouts inflated yet')).toBeTruthy();
    expect(within(layoutsPanel()).getByText(/opted out in its manifest.*AppCompatActivity/)).toBeTruthy();
  });

  it('with tracking off offers to turn it back on', () => {
    const { sent: all } = setup(
      running({ ...SDK_V3, options: { ...SDK_V3.options!, inflateTracking: false } }, Date.now()),
    );
    openLayouts();
    expect(within(layoutsPanel()).getByText('Inflation tracking is off')).toBeTruthy();
    fireEvent.click(within(layoutsPanel()).getByRole('button', { name: 'Turn on inflation tracking' }));
    expect(options(all)).toEqual([{ type: 'setSdkOptions', inflateTracking: true }]);
  });

  it('keeps recorded rows when tracking is turned off, with a note', () => {
    const now = Date.now();
    setup(withLayouts(now, { ...SDK_V3, options: { ...SDK_V3.options!, inflateTracking: false } }));
    openLayouts();
    expect(layoutNames()).toContain('fragment_home');
    expect(within(layoutsPanel()).getByText(/Inflation tracking is off: no new layouts/)).toBeTruthy();
  });

  it('reads options from an older server (no inflateTracking) as on', () => {
    const legacy = { stallThresholdMs: 150, strictMode: false } as unknown as NonNullable<
      SdkStatus['options']
    >;
    setup(running({ ...SDK_V3, options: legacy }, Date.now()));
    fireEvent.click(tab(/Stalls/));
    expect(
      within(panel(/Stalls/))
        .getByRole('switch', { name: 'Inflation tracking' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('Inflation tracking toggle', () => {
  const toggle = () => within(panel(/Stalls/)).getByRole('switch', { name: 'Inflation tracking' });

  it('sits next to StrictMode and sends setSdkOptions', () => {
    const { sent: all } = setup(withLayouts(Date.now()));
    fireEvent.click(tab(/Stalls/));
    const names = within(panel(/Stalls/))
      .getAllByRole('switch')
      .map((el) => el.textContent);
    expect(names).toEqual(['StrictMode', 'Inflation tracking']);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle());
    expect(options(all)).toEqual([{ type: 'setSdkOptions', inflateTracking: false }]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('is disabled with a hint on a link below protocol v3', () => {
    setup(running(SDK_V2, Date.now()));
    fireEvent.click(tab(/Stalls/));
    // StrictMode is usable on v2; layout timing is not.
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(
      within(panel(/Stalls/))
        .getByRole('switch', { name: 'StrictMode' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(within(panel(/Stalls/)).getByText(INFLATE_UPDATE_HINT)).toBeTruthy();
  });
});

describe('Screens table', () => {
  it('adds Inflate and Views columns with tooltips for a v3 link', () => {
    setup(withLayouts(Date.now()));
    const table = within(panel(/Screens/)).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Inflate/ })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: /Views/ })).toBeTruthy();
    const row = within(table).getByText('homepage').closest('tr')!;
    const inflateCell = row.querySelector('td[data-col="inflateMs"]')!;
    // 38 + 30 + 2 + 1 ms over 15 inflations.
    expect(inflateCell.textContent).toContain('71.0');
    expect(inflateCell.textContent).toContain('×15');
    expect(inflateCell.getAttribute('title')).toContain('Slowest: fragment_home, 38.0 ms');
    const viewsCell = row.querySelector('td[data-col="views"]')!;
    expect(viewsCell.textContent).toContain('142');
    expect(viewsCell.textContent).toContain('depth 14');
    expect(viewsCell.getAttribute('title')).toContain(
      'DecorView › ConstraintLayout#content › TextView#title',
    );
    expect(table.getAttribute('data-layouts')).toBe('true');
  });

  it('leaves the table as it was for a v2 link without layout data', () => {
    setup(
      running(SDK_V2, Date.now(), [
        { type: 'screen', span: span(Date.now() - 50_000, null, 'homepage') },
        { type: 'breakdown', sample: breakdown(Date.now() - 40_000, 'homepage') },
      ]),
    );
    const table = within(panel(/Screens/)).getByRole('table');
    expect(within(table).queryByRole('columnheader', { name: /Inflate/ })).toBeNull();
    expect(table.hasAttribute('data-layouts')).toBe(false);
  });
});

describe('Main thread lane inflation markers', () => {
  it('counts slow inflations (not fast ones) in the legend', () => {
    setup(withLayouts(Date.now()));
    const lane = screen.getByRole('figure', { name: 'Main thread' });
    const legend = within(lane).getByRole('list', { name: 'Main thread in this window' });
    expect(legend.textContent).toContain('Inflate1max 38.0 ms');
  });

  it('shows a tooltip with layout, time, views and screen when hovering a marker', () => {
    const now = Date.now();
    setup(withLayouts(now));
    const plot = stallPlot();
    fireEvent.mouseMove(plot.over, { clientX: clientXAt(plot, now - 40_000), clientY: INFLATE_ROW_Y });
    const lane = screen.getByRole('figure', { name: 'Main thread' });
    const tip = lane.querySelector('.stall-tip')!;
    expect(tip.textContent).toContain('38.0 ms');
    expect(tip.textContent).toContain('layout inflated');
    expect(tip.textContent).toContain('fragment_home');
    expect(tip.textContent).toContain('90 views');
    expect(tip.textContent).toContain('homepage');
    fireEvent.mouseMove(plot.over, { clientX: clientXAt(plot, now - 25_000), clientY: INFLATE_ROW_Y });
    expect(lane.querySelector('.stall-tip')).toBeNull();
  });

  it('opens the Layouts tab on a click', () => {
    const now = Date.now();
    setup(withLayouts(now));
    const plot = stallPlot();
    fireEvent.click(plot.over, { clientX: clientXAt(plot, now - 40_000), clientY: INFLATE_ROW_Y });
    expect(tab(/Layouts/).getAttribute('aria-selected')).toBe('true');
  });

  it('the lane exists for slow inflations alone, even on an SDK that is no longer linked', () => {
    const now = Date.now();
    setup([
      hello,
      { type: 'devices', devices: [EMULATOR] },
      { type: 'inflate', sample: inflate(now - 5000, { maxMs: 40 }) },
    ]);
    expect(screen.getByRole('figure', { name: 'Main thread' })).toBeTruthy();
  });
});

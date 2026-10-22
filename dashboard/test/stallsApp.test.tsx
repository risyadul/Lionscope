import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, SdkStatus, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { DEVICE_OVERLAY_QUERY } from '../src/hooks/useDeviceColumn.ts';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { createSignal } from '../src/lib/signal.ts';
import { stackText } from '../src/lib/stalls.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { SDK_UPDATE_HINT } from '../src/lib/viewState.ts';
import { breakdown, CART_STACK, frame, SDK_V2, session, span, stall, violation } from './fixtures.ts';
import { binaryMessage, emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';
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
const V1: SdkStatus = { ...SDK_V2, sdkVersion: '0.1.1', protocolVersion: 1 };

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

function withStalls(now: number): ServerMessage[] {
  return running(SDK_V2, now, [
    { type: 'screen', span: span(now - 50_000, null, 'homepage') },
    { type: 'breakdown', sample: breakdown(now - 40_000, 'homepage') },
    { type: 'stall', sample: stall(now - 40_000, 300) },
    { type: 'stall', sample: stall(now - 30_000, 450) },
    { type: 'stall', sample: stall(now - 20_000, 1200, { frames: CART_STACK, screen: 'CartFragment' }) },
    { type: 'strictmode', sample: violation(now - 10_000, { count: 3 }) },
  ]);
}

const stallsTab = () => screen.getByRole('tab', { name: /Stalls/ });
const stallsPanel = () => screen.getByRole('tabpanel', { name: /Stalls/ });
const openStalls = () => fireEvent.click(stallsTab());

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
/** Client x of epoch-ms `ts` (+2 px, inside the bar) on the fake plot. */
function clientXAt(plot: FakePlot, ts: number): number {
  const [from, to] = plot.xRange();
  return ((ts / 1000 - from) / (to - from)) * PLOT_WIDTH + 2;
}
const clickAt = (plot: FakePlot, ts: number) =>
  fireEvent.click(plot.over, { clientX: clientXAt(plot, ts), clientY: 10 });
const hoverAt = (plot: FakePlot, ts: number) =>
  fireEvent.mouseMove(plot.over, { clientX: clientXAt(plot, ts), clientY: 10 });

describe('Main thread lane', () => {
  it('is shown for a v2 link and sums the window', () => {
    setup(withStalls(Date.now()));
    const lane = screen.getByRole('figure', { name: 'Main thread' });
    const legend = within(lane).getByRole('list', { name: 'Main thread in this window' });
    expect(legend.textContent).toContain('Stalls3');
    expect(legend.textContent).toContain('Blocked1.95 s');
    expect(legend.textContent).toContain('Worst1.20 s');
    // One violation report coalescing three occurrences.
    expect(legend.textContent).toContain('StrictMode1×3');
    const plot = plots.find(
      (p) =>
        !p.destroyed && (p.opts as unknown as { series: { label?: string }[] }).series[1]?.label === 'Stall',
    );
    expect(plot).toBeDefined();
    expect(stallsTab().textContent).toBe('Stalls4');
  });

  it('is hidden for a v1 link without stall data, and says what is missing in the tab', () => {
    setup(running(V1, Date.now()));
    expect(screen.queryByRole('figure', { name: 'Main thread' })).toBeNull();
    openStalls();
    expect(within(stallsPanel()).getByText('This SDK can’t detect stalls')).toBeTruthy();
    expect(within(stallsPanel()).getByText(SDK_UPDATE_HINT)).toBeTruthy();
    expect(within(stallsPanel()).getByRole('switch', { name: 'StrictMode' }).hasAttribute('disabled')).toBe(
      true,
    );
    const thresholds = within(stallsPanel()).getByRole('radiogroup', { name: /Watchdog threshold/ });
    expect(
      within(thresholds)
        .getAllByRole('radio')
        .every((b) => b.hasAttribute('disabled')),
    ).toBe(true);
  });

  it('an empty v2 window names the threshold in the lane and the tab', () => {
    setup(running(SDK_V2, Date.now()));
    expect(screen.getByText('No main-thread blocks ≥ 150 ms in this window')).toBeTruthy();
    openStalls();
    expect(within(stallsPanel()).getByText(/Main thread blocks ≥ 150 ms will appear here/)).toBeTruthy();
  });

  it('clicking a bar selects that stall in the Stalls tab', () => {
    const now = Date.now();
    setup(withStalls(now));
    clickAt(stallPlot(), now - 20_000);
    expect(stallsTab().getAttribute('aria-selected')).toBe('true');
    expect(within(stallsPanel()).getByText('1.20 s')).toBeTruthy();
    expect(within(stallsPanel()).getAllByText('CartRepository.kt:41').length).toBeGreaterThan(0);
  });
});

describe('Stalls tab', () => {
  it('ranks offenders by blocked time and filters the list to one line', () => {
    setup(withStalls(Date.now()));
    openStalls();
    const panel = stallsPanel();
    const table = within(panel).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelector('.offender-line')?.textContent)).toEqual([
      'CartRepository.kt:41',
      'HomeViewModel.kt:87',
    ]);
    expect(rows[1]?.textContent).toContain('750 ms');
    const events = () => within(panel).getByRole('list', { name: 'Events, newest first' }).children.length;
    expect(events()).toBe(4);
    fireEvent.click(within(rows[1]!).getByRole('button', { pressed: false }));
    expect(events()).toBe(2);
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear line filter: HomeViewModel.kt:87' }));
    expect(events()).toBe(4);
    fireEvent.click(within(panel).getByRole('radio', { name: 'StrictMode' }));
    expect(events()).toBe(1);
  });

  it('opens a stall: culprit, collapsed framework frames, copy, Escape back', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup(withStalls(Date.now()));
    openStalls();
    const panel = stallsPanel();
    fireEvent.click(within(panel).getByRole('button', { name: /blocked 450 ms/ }));
    expect(within(panel).getByText('450 ms')).toBeTruthy();
    expect(within(panel).getByRole('region', { name: 'Culprit' }).textContent).toContain(
      'HomeViewModel.kt:87',
    );
    const toggle = within(panel).getByRole('button', { name: '+2 framework frames' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(panel).queryByText('Arrays.sort')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel).getByText('Arrays.sort')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Copy stack' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(stackText(stall(0, 0).frames));
    expect(within(panel).getByText('Copied')).toBeTruthy();
    // Older / newer step through the list.
    expect(within(panel).getByText('3 / 4')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Newer event' }));
    expect(within(panel).getByText('1.20 s')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(panel).getByRole('list', { name: 'Events, newest first' })).toBeTruthy();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('opens a StrictMode violation with its policy and count', () => {
    setup(withStalls(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /StrictMode DiskReadViolation/ }));
    expect(within(stallsPanel()).getByText('DiskReadViolation')).toBeTruthy();
    expect(within(stallsPanel()).getByText('×3')).toBeTruthy();
    expect(within(stallsPanel()).getByText(/thread policy/)).toBeTruthy();
  });

  it('pausing freezes stalls with the rest of the timeline', () => {
    const now = Date.now();
    const { push } = setup(withStalls(now));
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    push({ type: 'stall', sample: stall(now - 5000, 800) });
    expect(stallsTab().textContent).toBe('Stalls4');
    fireEvent.click(screen.getByRole('button', { name: /Live/ }));
    expect(stallsTab().textContent).toBe('Stalls5');
  });
});

describe('Screens table', () => {
  it('gains a Stalls column with the blocked time under the count', () => {
    setup(withStalls(Date.now()));
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    const panel = screen.getByRole('tabpanel', { name: /Screens/ });
    expect(within(panel).getByRole('button', { name: 'Stalls' })).toBeTruthy();
    const cell = panel.querySelector('td[data-col="stallCount"]') as HTMLElement;
    expect(cell.textContent).toBe('2, 750 ms blocked');
    // Blocked time is a visible second line, not only a hover title.
    expect(cell.querySelector('.stall-blocked')?.textContent).toBe(', 750 ms blocked');
    expect(cell.title).toBe('750 ms blocked');
  });

  it('has no Stalls column for a v1 link', () => {
    setup(running(V1, Date.now(), [{ type: 'breakdown', sample: breakdown(Date.now() - 5000, 'homepage') }]));
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    expect(
      screen.getByRole('tabpanel', { name: /Screens/ }).querySelector('td[data-col="stallCount"]'),
    ).toBeNull();
  });
});

describe('stalls without a stack', () => {
  it('rank as "(no stack captured)" and explain the missing stack in the detail', () => {
    const now = Date.now();
    setup(
      running(SDK_V2, now, [{ type: 'stall', sample: stall(now - 10_000, 640, { frames: [], samples: 0 }) }]),
    );
    openStalls();
    const panel = stallsPanel();
    const row = within(within(panel).getByRole('table')).getAllByRole('row')[1]!;
    expect(row.querySelector('.offender-line')?.textContent).toBe('(no stack captured)');
    expect(row.querySelector('.offender-method')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { pressed: false }));
    expect(within(panel).getByRole('list', { name: 'Events, newest first' }).children).toHaveLength(1);
    fireEvent.click(within(panel).getByRole('button', { name: /blocked 640 ms.*\(no stack captured\)/ }));
    const stack = within(panel).getByRole('region', { name: 'Main thread stack' });
    expect(stack.textContent).toContain('couldn’t sample the main thread');
    expect(within(panel).queryByRole('region', { name: 'Culprit' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Copy stack' })).toBeNull();
  });
});

const reply = (
  now: number,
  options: { stallThresholdMs: number; strictMode: boolean; inflateTracking?: boolean },
): ServerMessage => ({
  type: 'session',
  session: session({
    startedAt: now - 60_000,
    sdk: { ...SDK_V2, options: { inflateTracking: true, ...options } },
  }),
});
const optionRequests = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'setSdkOptions');
const checked = (name: string) =>
  within(stallsPanel()).getByRole('radio', { name }).getAttribute('aria-checked') === 'true';
const strictModeSwitch = () => within(stallsPanel()).getByRole('switch', { name: 'StrictMode' });
const sendingStatus = () =>
  within(stallsPanel())
    .getAllByRole('status')
    .find((el) => el.closest('.stall-controls') !== null)!;

describe('SDK option requests', () => {
  it('keep one request in flight and send the merged rest when it is answered', () => {
    const now = Date.now();
    const { sent, push } = setup(withStalls(now));
    openStalls();
    const panel = stallsPanel();
    fireEvent.click(within(panel).getByRole('radio', { name: '500' }));
    fireEvent.click(within(panel).getByRole('radio', { name: '250' }));
    fireEvent.click(strictModeSwitch());
    expect(optionRequests(sent)).toEqual([{ type: 'setSdkOptions', stallThresholdMs: 500 }]);
    expect(checked('250')).toBe(true);
    expect(strictModeSwitch().getAttribute('aria-checked')).toBe('true');
    // The answer to the first request releases the queued changes as one message.
    push(reply(now, { stallThresholdMs: 500, strictMode: false }));
    expect(optionRequests(sent).slice(1)).toEqual([
      { type: 'setSdkOptions', stallThresholdMs: 250, strictMode: true },
    ]);
    // No flicker back to the first answer while the second is out.
    expect(checked('250')).toBe(true);
    expect(sendingStatus().textContent).toBe('Sending to the app…');
    push(reply(now, { stallThresholdMs: 250, strictMode: true }));
    expect(sendingStatus().textContent).toBe('');
    expect(checked('250')).toBe(true);
    expect(optionRequests(sent)).toHaveLength(2);
  });

  it('skips a change to the value already shown', () => {
    const { sent } = setup(withStalls(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('radio', { name: '150' }));
    expect(optionRequests(sent)).toEqual([]);
  });

  it('held arrow keys do not step the watchdog threshold', () => {
    const { sent } = setup(withStalls(Date.now()));
    openStalls();
    const current = within(stallsPanel()).getByRole('radio', { name: '150' });
    fireEvent.keyDown(current, { key: 'ArrowRight', repeat: true });
    expect(optionRequests(sent)).toEqual([]);
    fireEvent.keyDown(current, { key: 'ArrowRight' });
    expect(optionRequests(sent)).toEqual([{ type: 'setSdkOptions', stallThresholdMs: 250 }]);
  });

  it('an unrelated session broadcast does not end the optimistic state; a matching one does', () => {
    const now = Date.now();
    const { push } = setup(withStalls(now));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('radio', { name: '1 s' }));
    push(reply(now, { stallThresholdMs: 150, strictMode: false }));
    expect(checked('1 s')).toBe(true);
    push(reply(now, { stallThresholdMs: 1000, strictMode: false }));
    expect(checked('1 s')).toBe(true);
    expect(sendingStatus().textContent).toBe('');
  });

  it('after 2 s without a matching answer the server’s options win', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const now = Date.now();
      const { push } = setup(withStalls(now));
      openStalls();
      fireEvent.click(within(stallsPanel()).getByRole('radio', { name: '500' }));
      push(reply(now, { stallThresholdMs: 250, strictMode: false }));
      expect(checked('500')).toBe(true);
      act(() => vi.advanceTimersByTime(1900));
      expect(checked('500')).toBe(true);
      act(() => vi.advanceTimersByTime(100));
      // The server settled on 250 (e.g. it clamped the request): that is what the app runs with.
      expect(checked('250')).toBe(true);
      expect(sendingStatus().textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an error (e.g. no_session) ends the optimistic state and drops queued changes', () => {
    const { sent, push } = setup(withStalls(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('radio', { name: '1 s' }));
    fireEvent.click(strictModeSwitch());
    push({ type: 'error', code: 'no_session', message: 'No session is running.' });
    expect(checked('150')).toBe(true);
    expect(strictModeSwitch().getAttribute('aria-checked')).toBe('false');
    expect(optionRequests(sent)).toHaveLength(1);
  });

  it('announces sending through a live region that is always in the page', () => {
    setup(withStalls(Date.now()));
    openStalls();
    const status = sendingStatus();
    expect(status.textContent).toBe('');
    fireEvent.click(within(stallsPanel()).getByRole('radio', { name: '500' }));
    expect(sendingStatus()).toBe(status);
    expect(status.textContent).toBe('Sending to the app…');
  });
});

describe('Escape and focus', () => {
  it('one Escape closes the stall detail and keeps the screen selection; the next clears the screen', () => {
    setup(withStalls(Date.now()));
    fireEvent.click(screen.getByRole('button', { name: /^homepage, Fragment/ }));
    expect(screen.getByRole('button', { name: /Clear selection: homepage/ })).toBeTruthy();
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(stallsPanel()).queryByRole('article', { name: 'Selected event' })).toBeNull();
    expect(screen.getByRole('button', { name: /Clear selection: homepage/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /Clear selection: homepage/ })).toBeNull();
  });

  it('opening the detail focuses it; Back and Escape return focus to the event’s row', () => {
    setup(withStalls(Date.now()));
    openStalls();
    const row = () => within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ });
    fireEvent.click(row());
    expect(document.activeElement).toBe(
      within(stallsPanel()).getByRole('article', { name: 'Selected event' }),
    );
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /All events/ }));
    expect(document.activeElement).toBe(row());
    fireEvent.click(row());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(row());
  });

  it('a lane click opens the detail with focus in it; if the event disappears, focus goes to the list', () => {
    const now = Date.now();
    const { push } = setup(withStalls(now));
    const plot = stallPlot();
    clickAt(plot, now - 20_000);
    expect(document.activeElement).toBe(
      within(stallsPanel()).getByRole('article', { name: 'Selected event' }),
    );
    // A resync without that stall closes the detail.
    push({
      type: 'snapshot',
      snapshot: {
        cpu: [],
        memory: [],
        frames: [frame(now - 1000, { source: 'sdk' })],
        logs: [],
        events: [],
        stalls: [stall(now - 40_000, 300)],
        strictMode: [],
      },
    });
    expect(document.activeElement).toBe(
      within(stallsPanel()).getByRole('list', { name: 'Events, newest first' }),
    );
  });

  it('marks app frames for screen readers', () => {
    setup(withStalls(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ }));
    const stack = within(stallsPanel()).getByRole('region', { name: 'Main thread stack' });
    expect(within(stack).getAllByText('App frame:')).toHaveLength(2);
  });
});

describe('lane hover', () => {
  it('follows the hovered mark by key and drops the tooltip when the mark goes away', () => {
    const now = Date.now();
    const { push } = setup(withStalls(now));
    const plot = stallPlot();
    hoverAt(plot, now - 20_000);
    const lane = screen.getByRole('figure', { name: 'Main thread' });
    expect(lane.querySelector('.stall-tip')?.textContent).toContain('1.20 s');
    // The same stall re-reported with new values: the tooltip shows the new ones.
    push({
      type: 'stall',
      sample: stall(now - 20_000, 1300, { frames: CART_STACK, screen: 'CartFragment' }),
    });
    expect(lane.querySelector('.stall-tip')?.textContent).toContain('1.30 s');
    push({
      type: 'snapshot',
      snapshot: {
        cpu: [],
        memory: [],
        frames: [frame(now - 1000)],
        logs: [],
        events: [],
        stalls: [],
        strictMode: [],
      },
    });
    expect(lane.querySelector('.stall-tip')).toBeNull();
  });
});

describe('Escape with the device screen', () => {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    FakeScreenSocket.reset();
    vi.stubGlobal('WebSocket', FakeScreenSocket);
    installCanvasStubs();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  });

  const withEmulator = (now: number): ServerMessage[] => [
    ...withStalls(now),
    { type: 'emulators', emulators: [emulator()] },
  ];

  async function goLive() {
    const socket = FakeScreenSocket.latest();
    act(() => {
      socket.open();
      socket.receive(binaryMessage('frame'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return socket;
  }

  it('Esc on the focused screen is the device’s Back and leaves the stall detail open', async () => {
    setup(withEmulator(Date.now()));
    const socket = await goLive();
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ }));
    const canvas = screen.getByLabelText('Pixel 9a screen');
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(socket.messages()).toEqual([{ type: 'nav', button: 'back' }]);
    expect(within(stallsPanel()).getByRole('article', { name: 'Selected event' })).toBeTruthy();
  });

  it('one Esc closes the device drawer on top, the next the stall detail', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === DEVICE_OVERLAY_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setup(withEmulator(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Screen' }));
    const drawer = () => screen.queryByRole('complementary', { name: 'Device' });
    expect(drawer()).not.toBeNull();
    const detail = () => within(stallsPanel()).queryByRole('article', { name: 'Selected event' });
    expect(document.activeElement).toBe(drawer());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(drawer()).toBeNull();
    expect(detail()).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(detail()).toBeNull();
  });
});

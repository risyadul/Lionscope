import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  DeviceInfo,
  SdkStatus,
  ServerMessage,
  StackFrame,
  StallRx,
} from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { RX_UPDATE_HINT } from '../src/components/stalls/StallControls.tsx';
import { RX_SITE_MISSING } from '../src/components/stalls/StallDetail.tsx';
import { LAYOUT_KEYS } from '../src/lib/layoutPrefs.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { frame, SDK_V7, SDK_V9, session, span, stackFrame, stall, violation } from './fixtures.ts';
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
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const EMULATOR: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64' };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.9.0',
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
  const view = render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  return { sent, view, services };
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

const OBSERVE_ON = 'io.reactivex.internal.operators.observable.ObservableObserveOn$ObserveOnObserver';

/** The Looper running a posted Runnable, innermost first. */
const LOOPER_CALLBACK: StackFrame[] = [
  stackFrame('android.os.Handler', 'handleCallback', 'Handler.java', 995),
  stackFrame('android.os.Handler', 'dispatchMessage', 'Handler.java', 103),
  stackFrame('android.os.Looper', 'loop', 'Looper.java', 338),
];

/** An observeOn(mainThread()) task, the stack cut before the scheduler's Runnable. */
const RX_INNER: StackFrame[] = [
  stackFrame('java.lang.Thread', 'sleep', null, -2),
  stackFrame('com.example.shop.home.HomeViewModel', 'render', 'HomeViewModel.kt', 61, true),
  stackFrame('io.reactivex.internal.observers.LambdaObserver', 'onNext', 'LambdaObserver.java', 63),
  stackFrame(OBSERVE_ON, 'run', 'ObservableObserveOn.java', 255),
];
const RX_OUTER: StackFrame[] = [
  stackFrame(
    'io.reactivex.android.schedulers.HandlerScheduler$ScheduledRunnable',
    'run',
    'HandlerScheduler.java',
    124,
  ),
  ...LOOPER_CALLBACK,
];

const RX: StallRx = {
  task: OBSERVE_ON,
  consumer: 'com.example.shop.home.HomeViewModel$$ExternalSyntheticLambda1',
  subscribedAt: [
    stackFrame('com.example.shop.home.HomeViewModel', 'load', 'HomeViewModel.kt', 40, true),
    stackFrame('com.example.shop.home.HomeFragment', 'onViewCreated', 'HomeFragment.kt', 22, true),
  ],
};

const COROUTINE_FRAMES: StackFrame[] = [
  stackFrame('java.lang.Thread', 'sleep', null, -2),
  stackFrame('com.example.shop.cart.CartViewModel$refresh$1', 'invokeSuspend', 'CartViewModel.kt', 88, true),
  stackFrame('kotlin.coroutines.jvm.internal.BaseContinuationImpl', 'resumeWith', 'ContinuationImpl.kt', 33),
  stackFrame('kotlinx.coroutines.DispatchedTask', 'run', 'DispatchedTask.kt', 104),
  ...LOOPER_CALLBACK,
];

function withOrigins(now: number, sdk: SdkStatus = SDK_V9): ServerMessage[] {
  return running(sdk, now, [
    { type: 'screen', span: span(now - 50_000, null, 'homepage') },
    { type: 'stall', sample: stall(now - 40_000, 300, { frames: [...RX_INNER, ...RX_OUTER], rx: RX }) },
    {
      type: 'stall',
      sample: stall(now - 30_000, 450, { frames: RX_INNER, outerFrames: RX_OUTER, truncated: true, rx: RX }),
    },
    {
      type: 'stall',
      sample: stall(now - 20_000, 1200, { frames: COROUTINE_FRAMES, screen: 'CartFragment' }),
    },
    { type: 'strictmode', sample: violation(now - 10_000) },
  ]);
}

const stallsPanel = () => screen.getByRole('tabpanel', { name: /Stalls/ });
const openStalls = () => fireEvent.click(screen.getByRole('tab', { name: /Stalls/ }));
const events = () =>
  within(stallsPanel()).getByRole('list', { name: 'Events, newest first' }).children.length;
const byOrigin = () => fireEvent.click(within(stallsPanel()).getByRole('radio', { name: 'By origin' }));
const byLine = () => fireEvent.click(within(stallsPanel()).getByRole('radio', { name: 'By line' }));

describe('Origins breakdown', () => {
  it('ranks origins, filters the list to one and clears it', () => {
    setup(withOrigins(Date.now()));
    openStalls();
    const panel = stallsPanel();
    expect(within(panel).getByRole('radio', { name: 'By line' }).getAttribute('aria-checked')).toBe('true');
    byOrigin();
    const table = within(panel).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Origin' })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelector('.origin-tag')?.textContent)).toEqual(['Coroutine', 'RxJava']);
    expect(rows[0]?.textContent).toContain('Dispatchers.Main');
    expect(rows[0]?.textContent).toContain('CartViewModel$refresh$1');
    expect(rows[1]?.textContent).toContain('observeOn');
    expect(rows[1]?.textContent).toContain('HomeViewModel.load (HomeViewModel.kt:40)');
    expect(rows[1]?.textContent).toContain('750 ms');
    expect(events()).toBe(4);
    fireEvent.click(within(rows[1]!).getByRole('button', { pressed: false }));
    // Both Rx stalls; the violation has no origin.
    expect(events()).toBe(2);
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'Clear origin filter: RxJava observeOn · HomeViewModel.load (HomeViewModel.kt:40)',
      }),
    );
    expect(events()).toBe(4);
  });

  it('keeps one filter at a time and remembers the mode per viewer', () => {
    const { view } = setup(withOrigins(Date.now()));
    openStalls();
    byOrigin();
    const panel = stallsPanel();
    const rxRow = within(within(panel).getByRole('table')).getAllByRole('row')[2]!;
    fireEvent.click(within(rxRow).getByRole('button', { pressed: false }));
    expect(within(panel).getByRole('button', { name: /^Clear origin filter/ })).toBeTruthy();
    byLine();
    // The origin filter still narrows the list until a line is picked.
    expect(events()).toBe(2);
    const lineRow = within(within(panel).getByRole('table')).getAllByRole('row')[1]!;
    fireEvent.click(within(lineRow).getByRole('button', { pressed: false }));
    expect(within(panel).queryByRole('button', { name: /^Clear origin filter/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: /^Clear line filter/ })).toBeTruthy();
    byOrigin();
    expect(window.localStorage.getItem(LAYOUT_KEYS.stallsBreakdown)).toBe('origin');
    view.unmount();
    setup(withOrigins(Date.now()));
    openStalls();
    expect(within(stallsPanel()).getByRole('radio', { name: 'By origin' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('tags stall rows with their origin kind', () => {
    setup(withOrigins(Date.now()));
    openStalls();
    const list = within(stallsPanel()).getByRole('list', { name: 'Events, newest first' });
    const tags = [...list.querySelectorAll('.origin-tag')].map((el) => el.textContent);
    expect(tags).toEqual(['Coroutine', 'RxJava', 'RxJava']);
    expect(within(list).getByRole('button', { name: /blocked 450 ms.*RxJava origin/ })).toBeTruthy();
  });
});

describe('Origin in the stall detail', () => {
  it('shows the Rx chain: operator, consumer, subscribe site, and the outermost frames', () => {
    setup(withOrigins(Date.now()));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 450 ms/ }));
    const origin = within(stallsPanel()).getByRole('region', { name: 'Origin' });
    expect(origin.querySelector('.origin-tag')?.textContent).toBe('RxJava');
    expect(origin.querySelector('.origin-label')?.textContent).toBe('observeOn');
    expect(origin.querySelector('.origin-detail')?.textContent).toBe(
      'HomeViewModel.load (HomeViewModel.kt:40)',
    );
    expect(origin.textContent).toContain('Operator');
    expect(origin.textContent).toContain('lambda in HomeViewModel');
    expect(within(origin).getByRole('button', { name: 'Copy origin' })).toBeTruthy();
    const site = within(origin).getByRole('region', { name: 'Subscribed at' });
    expect(within(site).getByText('HomeFragment.onViewCreated')).toBeTruthy();
    const outer = within(stallsPanel()).getByRole('region', {
      name: 'Outermost frames · the Looper dispatch',
    });
    expect(within(outer).getByText('HandlerScheduler$ScheduledRunnable.run')).toBeTruthy();
    expect(within(outer).getByRole('button', { name: '+3 framework frames' })).toBeTruthy();
    expect(within(stallsPanel()).getByRole('region', { name: 'Main thread stack' }).textContent).toContain(
      'were not captured',
    );
  });

  it('says when the Rx subscribe site was not captured', () => {
    setup(
      running(SDK_V9, Date.now(), [
        {
          type: 'stall',
          sample: stall(Date.now() - 5000, 300, {
            frames: [...RX_INNER, ...RX_OUTER],
            rx: { ...RX, subscribedAt: [] },
          }),
        },
      ]),
    );
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 300 ms/ }));
    const origin = within(stallsPanel()).getByRole('region', { name: 'Origin' });
    expect(within(origin).getByText(RX_SITE_MISSING)).toBeTruthy();
    expect(within(origin).queryByRole('region', { name: 'Subscribed at' })).toBeNull();
    expect(within(stallsPanel()).queryByRole('region', { name: /Outermost frames/ })).toBeNull();
  });

  it('shows a coroutine: dispatcher, continuation, and its name or how to get one', () => {
    const now = Date.now();
    const { view } = setup(withOrigins(now));
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 1.20 s/ }));
    let origin = within(stallsPanel()).getByRole('region', { name: 'Origin' });
    expect(origin.querySelector('.origin-tag')?.textContent).toBe('Coroutine');
    expect(origin.querySelector('.origin-label')?.textContent).toBe('Dispatchers.Main');
    expect(origin.querySelector('.origin-detail')?.textContent).toBe('CartViewModel$refresh$1');
    expect(origin.querySelector('.origin-location')?.textContent).toBe('CartViewModel.kt:88');
    expect(origin.textContent).toContain('CartViewModel$refresh$1.invokeSuspend (CartViewModel.kt:88)');
    expect(origin.textContent).toContain('System.setProperty("kotlinx.coroutines.debug", "on")');
    view.unmount();

    setup(
      running(SDK_V9, now, [
        {
          type: 'stall',
          sample: stall(now - 5000, 600, { frames: COROUTINE_FRAMES, coroutine: 'refresh#12' }),
        },
      ]),
    );
    openStalls();
    fireEvent.click(within(stallsPanel()).getByRole('button', { name: /blocked 600 ms/ }));
    origin = within(stallsPanel()).getByRole('region', { name: 'Origin' });
    expect(within(origin).getByText('refresh#12')).toBeTruthy();
    expect(origin.textContent).not.toContain('kotlinx.coroutines.debug');
  });
});

describe('RxJava tracking switch', () => {
  const toggle = () => within(stallsPanel()).getByRole('switch', { name: 'RxJava tracking' });

  it('sends rxTracking on a v9 link', () => {
    const { sent } = setup(withOrigins(Date.now()));
    openStalls();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().hasAttribute('disabled')).toBe(false);
    fireEvent.click(toggle());
    expect(sent.filter((m) => m.type === 'setSdkOptions')).toEqual([
      { type: 'setSdkOptions', rxTracking: false },
    ]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('is inert with a hint below protocol v9, and reads an older server as on', () => {
    const legacy = {
      stallThresholdMs: 150,
      strictMode: false,
      inflateTracking: true,
    } as unknown as NonNullable<SdkStatus['options']>;
    const { sent } = setup(withOrigins(Date.now(), { ...SDK_V7, options: legacy }));
    openStalls();
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(within(stallsPanel()).getByText(RX_UPDATE_HINT)).toBeTruthy();
    expect(within(stallsPanel()).getByRole('switch', { name: 'StrictMode' }).hasAttribute('disabled')).toBe(
      false,
    );
    fireEvent.click(toggle());
    expect(sent.filter((m) => m.type === 'setSdkOptions')).toEqual([]);
  });
});

describe('Main thread lane', () => {
  it('names the origin in the stall tooltip', () => {
    const now = Date.now();
    setup(withOrigins(now));
    const plot = plots.find(
      (p) =>
        !p.destroyed && (p.opts as unknown as { series: { label?: string }[] }).series[1]?.label === 'Stall',
    );
    if (!plot) throw new Error('no Main thread chart');
    plot.over.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 60,
      right: 1000,
      bottom: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const [from, to] = plot.xRange();
    const ts = now - 40_000;
    act(() => {
      fireEvent.mouseMove(plot.over, { clientX: ((ts / 1000 - from) / (to - from)) * 1000 + 2, clientY: 10 });
    });
    const lane = screen.getByRole('figure', { name: 'Main thread' });
    expect(lane.querySelector('.stall-tip-origin')?.textContent).toBe(
      'RxJava observeOn · HomeViewModel.load (HomeViewModel.kt:40)',
    );
  });
});

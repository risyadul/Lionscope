import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, SdkStatus, ServerMessage } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { SDK_GRADLE_SNIPPET } from '../src/components/topbar/SdkStatus.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { breakdown, frame, session, span } from './fixtures.ts';
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
  protocolVersion: 1,
  serverVersion: '0.1.0',
  bufferWindowMs: 600_000,
};
const CONNECTED: SdkStatus = {
  connected: true,
  sdkVersion: '0.1.0',
  processName: 'com.example.shop',
  apiLevel: 34,
  framesActive: true,
};
const MISSING: SdkStatus = {
  connected: false,
  sdkVersion: null,
  processName: null,
  apiLevel: null,
  framesActive: false,
};

function setup(messages: ServerMessage[]) {
  const store = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const services: DashboardServices = {
    store,
    send: () => true,
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
  return { push };
}

function running(sdk: SdkStatus | undefined, now: number, extra: ServerMessage[] = []): ServerMessage[] {
  return [
    hello,
    { type: 'devices', devices: [EMULATOR] },
    { type: 'session', session: session({ startedAt: now - 60_000, ...(sdk ? { sdk } : {}) }) },
    ...extra,
  ];
}

/** Live chart whose first series has `label` (series[0] is x). */
function plotWith(label: string) {
  return plots.find((p) => {
    const series = (p.opts as unknown as { series: { label?: string }[] }).series;
    return !p.destroyed && series[1]?.label === label;
  });
}

function sdkSession(now: number): ServerMessage[] {
  return running(CONNECTED, now, [
    { type: 'screen', span: span(now - 30_000, null, 'MainActivity', 'activity') },
    { type: 'screen', span: span(now - 20_000, null, 'order_list') },
    { type: 'breakdown', sample: breakdown(now - 25_000, 'MainActivity', { frameCount: 20, jankCount: 0 }) },
    {
      type: 'breakdown',
      sample: breakdown(now - 10_000, 'order_list', { frameCount: 40, jankCount: 8, stages: { draw: 9 } }),
    },
    { type: 'frames', sample: frame(now - 1000, { source: 'sdk' }) },
  ]);
}

describe('SDK status', () => {
  it('shows the connected SDK with its version and that frames come from it', () => {
    setup(running(CONNECTED, Date.now()));
    const pill = screen
      .getByText('connected', { exact: false, selector: '.sdk-meta' })
      .closest('.sdk-pill') as HTMLElement;
    expect(pill.textContent).toBe('SDK v0.1.0 connected frames from SDK');
    expect(pill.title).toBe('com.example.shop · API 34');
  });

  it('explains how to add the SDK; Escape closes the hint', () => {
    setup(running(MISSING, Date.now()));
    const button = screen.getByRole('button', { name: /No SDK/ });
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Add the Lionscope SDK' });
    expect(dialog.textContent).toContain(
      'debugImplementation "com.github.risyadul.Lionscope:lionscope:0.1.1"',
    );
    // Public JitPack artifact, repository scoped to the Lionscope group; no mavenLocal, no credentials.
    expect(dialog.textContent).toContain(
      'maven { url "https://jitpack.io"; content { includeGroup "com.github.risyadul.Lionscope" } }',
    );
    expect(dialog.textContent).toContain(
      'releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.1.1"',
    );
    expect(dialog.textContent).not.toContain('mavenLocal');
    expect(dialog.textContent).toContain('dependencyResolutionManagement');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('after the link drops, says disconnected instead of how to install', () => {
    setup(running({ ...CONNECTED, connected: false, framesActive: false }, Date.now()));
    expect(screen.queryByRole('button', { name: /No SDK/ })).toBeNull();
    expect(document.querySelector('.sdk-pill')?.textContent).toBe('SDK v0.1.0 disconnected');
  });

  it('explains an empty SDK frame bucket with the SDK, not gfxinfo', () => {
    const now = Date.now();
    setup(
      running(CONNECTED, now, [
        {
          type: 'frames',
          sample: frame(now - 300, {
            source: 'sdk',
            frameCount: 0,
            jankCount: 0,
            slowCount: 0,
            fps: 0,
            durationsMs: [],
          }),
        },
      ]),
    );
    const fpsTile = screen.getByText('FPS', { selector: 'dt' }).closest('.readout') as HTMLElement;
    expect(fpsTile.title).toMatch(/in-app SDK saw no frames/);
    expect(screen.getByRole('note', { name: /Frames reported by the in-app Lionscope SDK/ })).toBeTruthy();
  });

  it('Copy puts the snippet on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup(running(MISSING, Date.now()));
    fireEvent.click(screen.getByRole('button', { name: /No SDK/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(SDK_GRADLE_SNIPPET);
    expect(SDK_GRADLE_SNIPPET).toContain('includeGroup "com.github.risyadul.Lionscope"');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('says nothing about the SDK outside a session or for servers without SDK state', () => {
    setup(running(undefined, Date.now()));
    expect(screen.queryByText(/No SDK/)).toBeNull();
    expect(document.querySelector('.sdk-pill')).toBeNull();
  });
});

describe('Screens', () => {
  it('draws a band per span, tags SDK frames and shows the breakdown lane', () => {
    const now = Date.now();
    setup(sdkSession(now));
    const lane = screen.getByRole('figure', { name: 'Screens' });
    const bands = within(lane).getAllByRole('button', { name: /, (Activity|Fragment), / });
    expect(bands.map((b) => b.textContent)).toEqual(['MainActivity', 'order_list']);
    expect(bands[1]?.getAttribute('aria-label')).toMatch(/^order_list, Fragment, .*, on top now$/);
    expect(screen.getAllByText('SDK FrameMetrics')).toHaveLength(2);
    expect(screen.getByRole('figure', { name: 'Frame breakdown' })).toBeTruthy();
    expect(plotWith('GPU')).toBeDefined();
  });

  it('clicking a band selects the screen without leaving logcat; View in Screens filters the table', () => {
    const now = Date.now();
    setup(sdkSession(now));
    const lane = screen.getByRole('figure', { name: 'Screens' });
    fireEvent.click(within(lane).getByRole('button', { name: /^MainActivity,/ }));

    expect(screen.getByRole('tab', { name: 'Logcat' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(lane).getByRole('button', { name: 'View in Screens' }));
    expect(screen.getByRole('tab', { name: /Screens/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(lane).queryByRole('button', { name: 'View in Screens' })).toBeNull();
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('MainActivity');
    expect(screen.getByText('Stage profile · mean ms / frame')).toBeTruthy();
    expect(
      within(lane)
        .getByRole('button', { name: /^MainActivity,/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(lane).getByRole('button', { name: 'Clear selection: MainActivity' })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(
      within(lane)
        .getByRole('button', { name: /^MainActivity,/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('sorts rows by jank % (worst first) and toggles the direction', () => {
    const now = Date.now();
    setup(sdkSession(now));
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    const names = () =>
      within(screen.getByRole('table'))
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('th')?.textContent);
    expect(names()).toEqual(['order_list', 'MainActivity']);
    expect(screen.getByRole('columnheader', { name: /Jank/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: 'Jank' }));
    expect(names()).toEqual(['MainActivity', 'order_list']);
  });

  it('explains how to integrate the SDK when there is no screen data', () => {
    setup(running(MISSING, Date.now()));
    expect(screen.queryByRole('figure', { name: 'Screens' })).toBeNull();
    expect(screen.queryByRole('figure', { name: 'Frame breakdown' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    expect(screen.getByText('No screen data yet')).toBeTruthy();
    const panel = screen.getByRole('tabpanel', { name: /Screens/ });
    expect(panel.textContent).toContain('includeGroup "com.github.risyadul.Lionscope"');
    expect(panel.textContent).toContain('settings.gradle');
  });

  it('pause freezes the screen bands and the breakdown lane; Live resumes', () => {
    const now = Date.now();
    const { push } = setup(sdkSession(now));
    const bandCount = () =>
      within(screen.getByRole('figure', { name: 'Screens' })).getAllByRole('button', {
        name: /, Fragment|Activity/,
      }).length;
    const breakdownRows = () => ((plotWith('GPU')?.data as number[][] | undefined)?.[0] ?? []).length;
    expect(bandCount()).toBe(2);
    const before = breakdownRows();

    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    push(
      { type: 'screen', span: span(now - 500, null, 'OrderDetailFragment') },
      { type: 'breakdown', sample: breakdown(now - 500, 'OrderDetailFragment') },
    );
    expect(bandCount()).toBe(2);
    expect(breakdownRows()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: /Live/ }));
    expect(bandCount()).toBe(3);
    expect(breakdownRows()).toBeGreaterThan(before);
  });
});

describe('SDK review round 1', () => {
  it('SDK connected + an empty gfxinfo sample reads as UI idle, never the gfxinfo caveat', () => {
    const now = Date.now();
    setup(
      running(CONNECTED, now, [
        {
          type: 'frames',
          sample: frame(now - 300, { frameCount: 0, jankCount: 0, slowCount: 0, fps: 0, durationsMs: [] }),
        },
      ]),
    );
    const fpsTile = screen.getByText('FPS', { selector: 'dt' }).closest('.readout') as HTMLElement;
    expect(within(fpsTile).getByText('UI idle')).toBeTruthy();
    expect(fpsTile.title).not.toMatch(/gfxinfo only sees/);
    expect(screen.queryByRole('note', { name: /gfxinfo only sees/ })).toBeNull();
    expect(screen.getAllByText('SDK · idle')).toHaveLength(2);
    expect(within(screen.getByRole('list', { name: 'Rendering values' })).getByText('UI idle')).toBeTruthy();
  });

  it('keeps the breakdown lane mounted while the SDK is linked, even with no bucket yet', () => {
    setup(running(CONNECTED, Date.now()));
    expect(screen.getByRole('figure', { name: 'Frame breakdown' })).toBeTruthy();
    expect(screen.getByText('SDK connected — waiting for frames')).toBeTruthy();
  });

  it('an adb reverse failure shows a link-failed pill and empty state, not the install hint', () => {
    const { push } = setup(running(MISSING, Date.now()));
    push({ type: 'error', code: 'sdk_link_unavailable', message: 'adb reverse tcp:8700 failed: offline' });
    expect(screen.queryByRole('button', { name: /No SDK/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /SDK link failed/ }));
    const dialog = screen.getByRole('dialog', { name: 'SDK link failed (adb reverse)' });
    expect(dialog.textContent).toContain('adb reverse tcp:8700 failed: offline');
    expect(dialog.textContent).not.toContain('debugImplementation');
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    const panel = screen.getByRole('tabpanel', { name: /Screens/ });
    expect(within(panel).getByText('SDK link failed')).toBeTruthy();
    expect(panel.textContent).not.toContain('debugImplementation');
  });

  it('a known SDK that dropped before any frame says disconnected in the Screens panel', () => {
    setup(running({ ...CONNECTED, connected: false, framesActive: false }, Date.now()));
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    expect(screen.getByText('SDK disconnected')).toBeTruthy();
    expect(screen.queryByText('No screen data yet')).toBeNull();
  });

  it('the hint popover takes focus, and Escape from anywhere closes it and refocuses the trigger', () => {
    setup(running(MISSING, Date.now()));
    const trigger = screen.getByRole('button', { name: /No SDK/ });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    // Focus moves elsewhere in the top bar; Escape on that element still closes the hint.
    const stop = screen.getByRole('button', { name: /Stop/ });
    stop.focus();
    fireEvent.keyDown(stop, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape that closes the popover does not also clear the screen selection', () => {
    const now = Date.now();
    setup(
      running(MISSING, now, [
        { type: 'screen', span: span(now - 20_000, null, 'order_list') },
        { type: 'breakdown', sample: breakdown(now - 10_000, 'order_list') },
      ]),
    );
    const lane = screen.getByRole('figure', { name: 'Screens' });
    fireEvent.click(within(lane).getByRole('button', { name: /^order_list,/ }));
    fireEvent.click(screen.getByRole('button', { name: /No SDK/ }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(lane).getByRole('button', { name: 'Clear selection: order_list' })).toBeTruthy();
  });

  it('keeps focus on the same span when older spans are pruned or a snapshot resyncs', () => {
    const now = Date.now();
    const { push } = setup(sdkSession(now));
    const lane = screen.getByRole('figure', { name: 'Screens' });
    within(lane)
      .getByRole('button', { name: /^order_list,/ })
      .focus();
    push({
      type: 'snapshot',
      snapshot: {
        cpu: [],
        memory: [],
        frames: [],
        logs: [],
        events: [],
        screens: [span(now - 20_000, null, 'order_list')],
        breakdown: [],
      },
    });
    const bands = within(lane).getAllByRole('button', { name: /, (Activity|Fragment), / });
    expect(bands).toHaveLength(1);
    expect(document.activeElement).toBe(bands[0]);
    expect(bands[0]?.getAttribute('tabindex')).toBe('0');
  });

  it('tabs move with Home / End and the panels are focusable', () => {
    setup(running(MISSING, Date.now()));
    const logcatTab = screen.getByRole('tab', { name: 'Logcat' });
    fireEvent.keyDown(logcatTab, { key: 'End' });
    expect(screen.getByRole('tab', { name: /Screens/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: /Screens/ }), { key: 'Home' });
    expect(logcatTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Logcat' }).getAttribute('tabindex')).toBe('0');
  });

  it('shows the typical p90 with the worst bucket under it', () => {
    const now = Date.now();
    setup(
      running(CONNECTED, now, [
        { type: 'screen', span: span(now - 20_000, null, 'list') },
        { type: 'breakdown', sample: breakdown(now - 9000, 'list', { frameCount: 30, p90TotalMs: 12 }) },
        { type: 'breakdown', sample: breakdown(now - 8000, 'list', { frameCount: 10, p90TotalMs: 44 }) },
      ]),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Screens/ }));
    const cell = screen.getByRole('table').querySelector('td[data-col="typicalP90Ms"]');
    expect(cell?.textContent).toBe('12.0worst 44.0');
    expect(screen.getByRole('button', { name: 'p90 typ' }).title).toMatch(/frame-weighted median/);
  });
});

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import {
  AUTO_REFRESH_MS,
  CAPTURE_TIMEOUT_MS,
  MIN_AUTO_INTERVAL_MS,
  useInspector,
} from '../src/hooks/useInspector.ts';
import { createSignal } from '../src/lib/signal.ts';
import {
  applyServerMessage,
  createInitialState,
  createStore,
  type ConnectionState,
} from '../src/lib/store.ts';
import { frame, span } from './fixtures.ts';
import type * as InspectorLib from '../src/lib/inspector.ts';
import { shortClass } from '../src/lib/inspector.ts';
import { inspectorSnapshot, node } from './inspectorFixtures.ts';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';
import { resetPlots } from './uplotMock.ts';

type InspectorModule = typeof InspectorLib;
vi.mock('uplot', () => import('./uplotMock.ts'));
// Every tree row renders its class through shortClass: counting its calls counts row renders.
vi.mock('../src/lib/inspector.ts', async (importOriginal) => {
  const actual = await importOriginal<InspectorModule>();
  return { ...actual, shortClass: vi.fn(actual.shortClass) };
});

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The overlay is 540 × 1200 px on screen for a 1080 × 2400 device: one screen px = half a CSS px. */
const OVERLAY_RECT = { left: 0, top: 0, width: 540, height: 1200, right: 540, bottom: 1200, x: 0, y: 0 };

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  resetPlots();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains('inspect-overlay') ? OVERLAY_RECT : new DOMRect(0, 0, 0, 0)) as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const hello: ServerMessage = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.5.0',
  bufferWindowMs: 600_000,
};
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };
const BASE: ServerMessage[] = [
  hello,
  { type: 'devices', devices: [EMU_DEVICE] },
  { type: 'emulators', emulators: [emulator()] },
];

function setup(messages: ServerMessage[] = BASE) {
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
  const inspects = () => sent.filter((m) => m.type === 'inspect');
  return { sent, push, inspects };
}

const inspectButton = () => screen.getByRole('button', { name: 'Inspect' });
const overlay = () => document.querySelector<HTMLElement>('.inspect-overlay')!;
const snapshotMsg = (overrides = {}): ServerMessage => ({
  type: 'inspection',
  snapshot: inspectorSnapshot(overrides),
});

/** Pointer position that lands on a device-px point of the 540 × 1200 overlay. */
const at = (x: number, y: number) => ({ clientX: x / 2, clientY: y / 2 });

describe('Inspect toggle', () => {
  it('asks the server for a snapshot of the device, shows the capturing state and opens the Inspector tab', () => {
    const { inspects } = setup();
    fireEvent.click(inspectButton());
    expect(inspects()).toEqual([{ type: 'inspect', serial: 'emulator-5554' }]);
    expect(inspectButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('Capturing the screen…').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: /Inspector/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('freezes the screen to the snapshot png once it arrives', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    const img = overlay().querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/inspector/snap-1.png');
    expect(screen.getByText('Frozen · hover to highlight · click to select', { exact: false })).toBeTruthy();
  });

  it('Esc and the toggle go back to the live screen', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.keyDown(overlay(), { key: 'Escape' });
    expect(document.querySelector('.inspect-overlay')).toBeNull();
    expect(inspectButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(inspectButton());
    await push(snapshotMsg({ id: 'snap-2' }));
    fireEvent.click(inspectButton());
    expect(document.querySelector('.inspect-overlay')).toBeNull();
  });

  it('shows why a capture failed and lets you try again', async () => {
    const { push, inspects } = setup();
    fireEvent.click(inspectButton());
    await push({ type: 'error', code: 'inspect_failed', message: 'The app is in the background.' });
    expect(screen.getAllByText('The app is in the background.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(inspects()).toHaveLength(2);
    expect(
      screen.queryByText('The app is in the background.', { selector: '.device-glass-status span' }),
    ).toBeNull();
  });

  it('is disabled without a device', () => {
    setup([hello, { type: 'devices', devices: [] }, { type: 'emulators', emulators: [] }]);
    expect(screen.queryByRole('button', { name: 'Inspect' })).toBeNull();
  });
});

describe('overlay', () => {
  it('highlights the deepest view under the pointer with its label, topmost window first', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.pointerMove(overlay(), at(400, 1250));
    expect(document.querySelector('.inspect-box[data-kind="hover"]')).not.toBeNull();
    expect(document.querySelector('.inspect-tag-name')?.textContent).toBe('Button#btn_ok');
    fireEvent.pointerLeave(overlay());
    expect(document.querySelector('.inspect-tag')).toBeNull();
  });

  it('click selects through the server and the selection is drawn with its box model', async () => {
    const { push, sent } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.click(overlay(), at(400, 1250));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 7 });
    // Nothing is selected until the server says so.
    expect(document.querySelector('.inspect-box[data-kind="selected"]')).toBeNull();
    await push({
      type: 'inspectorSelection',
      selection: { snapshotId: 'snap-1', nodeId: 7, ts: 1, origin: 'user' },
    });
    expect(document.querySelector('.inspect-box[data-kind="selected"]')).not.toBeNull();
  });

  it('clicking the same spot again steps to the view below, looking through an empty overlay first', async () => {
    const { push, sent } = setup();
    fireEvent.click(inspectButton());
    const at10 = { file: 'Home.kt', line: 10 };
    await push(
      snapshotMsg({
        nodes: [
          node(0, null, [0, 0, 1080, 2400], { className: 'androidx.compose.ui.platform.AndroidComposeView' }),
          node(1, 0, [0, 0, 1080, 2400], { className: 'Scaffold', composable: at10 }),
          node(2, 1, [100, 600, 500, 700], { className: 'Text', composable: at10, text: 'Track' }),
          node(3, 0, [0, 0, 1080, 2400], { className: 'ToastHost', composable: at10 }),
          node(4, 3, [53, 21, 1027, 2340], { className: 'Box', composable: at10 }),
        ],
        windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
      }),
    );
    const selected = (nodeId: number) =>
      push({
        type: 'inspectorSelection',
        selection: { snapshotId: 'snap-1', nodeId, ts: 1, origin: 'user' },
      });
    // The first click looks through the toast host's empty Box to the text under it.
    fireEvent.click(overlay(), at(300, 650));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 2 });
    await selected(2);
    expect(document.querySelector('.inspect-tag-layer')?.textContent).toBe('2/2');
    // Again on the same spot: the next one down wraps around to the top-most, the Box itself.
    fireEvent.click(overlay(), at(302, 652));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 4 });
    await selected(4);
    expect(document.querySelector('.inspect-tag-layer')?.textContent).toBe('1/2');
    // Elsewhere: a fresh pick, not a step.
    fireEvent.click(overlay(), at(300, 1500));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 1 });
  });

  it('syncs tree hover with the overlay highlight', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.pointerMove(overlay(), at(400, 1250));
    const row = document.querySelector('[data-node="7"]')!;
    expect(row.getAttribute('data-hover')).toBe('true');
    fireEvent.pointerLeave(overlay());
    fireEvent.pointerEnter(document.querySelector('[data-node="1"]')!);
    expect(document.querySelector('.inspect-tag-name')?.textContent).toBe('LinearLayout#content');
  });

  it('draws the screenshot at the snapshot size and rotation', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg({ display: { width: 2400, height: 1080, rotation: 90 } }));
    fireEvent.pointerMove(overlay(), { clientX: 100, clientY: 100 });
    // Landscape display: (100, 100) maps to (444, 90) of 2400 × 1080, not (200, 200) of the portrait size.
    expect(document.querySelector('.inspect-tag-name')?.textContent).toBe('LinearLayout#content');
  });
});

describe('Inspector tab', () => {
  const openTab = () => fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
  const selectedOn = (nodeId: number): ServerMessage => ({
    type: 'inspectorSelection',
    selection: { snapshotId: 'snap-1', nodeId, ts: 1, origin: 'user' },
  });

  it('explains how to start while nothing was inspected', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
    expect(screen.getByText('Nothing inspected yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect the screen' }));
    expect(inspectButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the source, node count, capture time and the SDK badge', async () => {
    const { push } = setup();
    await push(snapshotMsg());
    openTab();
    const panel = screen.getByRole('tabpanel', { name: /Inspector/ });
    expect(within(panel).getByText('SDK')).toBeTruthy();
    expect(within(panel).getByText('4.2 ms')).toBeTruthy();
    expect(within(panel).getByText('8 nodes')).toBeTruthy();
  });

  it('badges the uiautomator fallback with its reason and marks the SDK-only fields', async () => {
    const { push } = setup();
    await push(snapshotMsg({ source: 'uiautomator', fallbackReason: 'no_sdk', captureMs: null }));
    openTab();
    await push({
      type: 'inspectorSelection',
      selection: { snapshotId: 'snap-1', nodeId: 2, ts: 1, origin: 'user' },
    });
    const panel = screen.getByRole('tabpanel', { name: /Inspector/ });
    expect(within(panel).getByText('uiautomator — no SDK')).toBeTruthy();
  });

  it('reflects a selection made elsewhere: opens the path, shows source, owner and the line note', async () => {
    const { push } = setup();
    await push(snapshotMsg());
    openTab();
    await push(selectedOn(2));
    const tree = screen.getByRole('tree', { name: 'View hierarchy' });
    const row = within(tree)
      .getAllByRole('treeitem')
      .find((r) => r.getAttribute('data-node') === '2')!;
    expect(row.getAttribute('aria-selected')).toBe('true');
    const attrs = screen.getByRole('region', { name: 'Attributes' });
    expect(within(attrs).getByText('fragment_cart.xml:33')).toBeTruthy();
    expect(within(attrs).getByText('end of start tag')).toBeTruthy();
    expect(within(attrs).getByText('CartFragment')).toBeTruthy();
    expect(within(attrs).getByText('in MainActivity')).toBeTruthy();
    expect(within(attrs).getByText('Checkout')).toBeTruthy();
    expect(within(attrs).getByText('[100, 200][500, 300]')).toBeTruthy();
    expect(within(attrs).getByText('match_parent × wrap_content')).toBeTruthy();
    expect(within(attrs).getByText('clickable').getAttribute('data-on')).toBe('true');
  });

  it('shows a composable with its call site, destination and no view-only fields', async () => {
    const compose = inspectorSnapshot({
      nodes: [
        node(0, null, [0, 0, 1080, 2400], { className: 'com.android.internal.policy.DecorView' }),
        node(1, 0, [0, 0, 1080, 2400], {
          className: 'androidx.compose.ui.platform.AndroidComposeView',
          composition: 'read',
        }),
        node(2, 1, [100, 200, 500, 300], {
          className: 'Button',
          resourceId: 'checkout',
          clickable: true,
          alpha: null,
          padding: null,
          margin: null,
          layoutWidth: null,
          layoutHeight: null,
          composable: { file: 'CartScreen.kt', line: 87 },
          destination: 'cart',
          activity: 'com.example.shop.MainActivity',
        }),
      ],
    });
    const { push } = setup();
    await push({ type: 'inspection', snapshot: compose });
    openTab();
    await push(selectedOn(2));
    const row = document.querySelector('[data-node="2"]')!;
    expect(row.getAttribute('data-compose')).toBe('true');
    const attrs = screen.getByRole('region', { name: 'Attributes' });
    expect(within(attrs).getByText('CartScreen.kt:87')).toBeTruthy();
    expect(within(attrs).getByText('call site')).toBeTruthy();
    expect(within(attrs).queryByText('end of start tag')).toBeNull();
    expect(within(attrs).getByText('Compose')).toBeTruthy();
    expect(within(attrs).getByText('#checkout')).toBeTruthy();
    expect(within(attrs).getByText('cart')).toBeTruthy();
    expect(within(attrs).queryByText('Alpha')).toBeNull();
    expect(within(attrs).queryByText('Layout')).toBeNull();
    expect(within(attrs).queryByText('No padding or margin.')).toBeNull();
  });

  it('says why an AndroidComposeView shows no composables', async () => {
    const unread = inspectorSnapshot({
      nodes: [
        node(0, null, [0, 0, 1080, 2400], { className: 'com.android.internal.policy.DecorView' }),
        node(1, 0, [0, 0, 1080, 600], {
          className: 'androidx.compose.ui.platform.AndroidComposeView',
          composition: 'disabled',
        }),
      ],
    });
    const { push } = setup();
    await push({ type: 'inspection', snapshot: unread });
    openTab();
    await push(selectedOn(1));
    const attrs = screen.getByRole('region', { name: 'Attributes' });
    expect(within(attrs).getByText(/restart the app/)).toBeTruthy();
  });

  it('opens the path to a selection that was already there when the tree mounts (a reloaded page)', async () => {
    // Node 5 sits under the invisible View 4, which the default shape (depth < 2) leaves closed.
    setup([...BASE, snapshotMsg(), selectedOn(5)]);
    openTab();
    const tree = screen.getByRole('tree', { name: 'View hierarchy' });
    const row = within(tree)
      .getAllByRole('treeitem')
      .find((r) => r.getAttribute('data-node') === '5');
    expect(row?.getAttribute('aria-selected')).toBe('true');
  });

  it('selects a view from the tree and an ancestor from the path', async () => {
    const { push, sent } = setup();
    await push(snapshotMsg());
    openTab();
    await push(selectedOn(2));
    fireEvent.click(document.querySelector('[data-node="3"]')!);
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'LinearLayout#content' }));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 1 });
  });

  it('moves with the arrow keys: opens, steps in, steps out, selects with Enter', async () => {
    const { push, sent } = setup();
    await push(snapshotMsg());
    openTab();
    const tree = screen.getByRole('tree', { name: 'View hierarchy' });
    const item = (id: number) => tree.querySelector<HTMLElement>(`[data-node="${id}"]`)!;
    item(4).focus();
    fireEvent.click(item(4));
    expect(item(5)).toBeNull();
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(item(4).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item(5));
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item(4));
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item(3));
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-1', nodeId: 3 });
    fireEvent.keyDown(tree, { key: 'End' });
    expect(document.activeElement).toBe(item(5));
  });

  it('searches class, id and text, and says when nothing matches', async () => {
    const { push } = setup();
    await push(snapshotMsg());
    openTab();
    const search = screen.getByRole('searchbox', { name: 'Search the hierarchy' });
    fireEvent.change(search, { target: { value: 'btn_ok' } });
    const ids = () =>
      within(screen.getByRole('tree'))
        .getAllByRole('treeitem')
        .map((r) => r.getAttribute('data-node'));
    expect(ids()).toEqual(['6', '7']);
    fireEvent.change(search, { target: { value: '$12' } });
    expect(ids()).toEqual(['0', '1', '3']);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No view matches.')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('ignores a snapshot of another device', async () => {
    const { push } = setup();
    await push(snapshotMsg({ serial: 'R58M123ABC' }));
    openTab();
    fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
    expect(screen.getByText('Nothing inspected yet')).toBeTruthy();
  });
});

describe('auto-refresh', () => {
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it('re-captures when the top screen changes, once, and not before the 2 s throttle', async () => {
    fakeClock();
    const { push, inspects } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    expect(inspects()).toHaveLength(1);

    await push({ type: 'screen', span: span(Date.now(), null, 'CartFragment') });
    // The debounce alone is 700 ms, but this device was captured just now.
    advance(AUTO_REFRESH_MS + 1000);
    expect(inspects()).toHaveLength(1);
    advance(MIN_AUTO_INTERVAL_MS - AUTO_REFRESH_MS - 1000);
    expect(inspects()).toHaveLength(2);
    advance(10_000);
    expect(inspects()).toHaveLength(2);
  });

  it('waits only the 700 ms debounce when the last capture is old enough', async () => {
    fakeClock();
    const { push, inspects } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    advance(MIN_AUTO_INTERVAL_MS);
    await push({ type: 'screen', span: span(Date.now(), null, 'CartFragment') });
    advance(AUTO_REFRESH_MS - 1);
    expect(inspects()).toHaveLength(1);
    advance(1);
    expect(inspects()).toHaveLength(2);
  });

  it('never captures a device more than once per 2 s on its own, however fast the screens change', async () => {
    fakeClock();
    const { push, inspects } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    const t = Date.now();
    for (let i = 0; i < 10; i++) {
      await push({ type: 'screen', span: span(t + i * 100, null, `S${i}`) });
      advance(100);
    }
    expect(inspects()).toHaveLength(1);
    // The ten changes took 1 s: the held-back capture goes out 2 s after the first one.
    advance(MIN_AUTO_INTERVAL_MS - 1000);
    expect(inspects()).toHaveLength(2);
    // The next change right after is held back again.
    await push({ type: 'screen', span: span(Date.now(), null, 'Next') });
    advance(MIN_AUTO_INTERVAL_MS - 1);
    expect(inspects()).toHaveLength(2);
    advance(1);
    expect(inspects()).toHaveLength(3);
  });

  it('does nothing when inspect mode is off', async () => {
    fakeClock();
    const { push, inspects } = setup();
    await push({ type: 'screen', span: span(Date.now(), null, 'CartFragment') });
    advance(5000);
    expect(inspects()).toHaveLength(0);
  });

  it('refreshes on demand, without the throttle', async () => {
    const { push, inspects } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(inspects()).toHaveLength(2);
  });
});

describe('pending capture', () => {
  it("stays pending for another device's snapshot and settles on its own", async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg({ id: 'other', serial: 'R58M123ABC' }));
    expect(screen.getAllByText('Capturing the screen…').length).toBeGreaterThan(0);
    await push(snapshotMsg({ id: 'snap-9' }));
    expect(document.querySelector('.inspect-shot')).not.toBeNull();
    expect(screen.queryByText('Capturing the screen…')).toBeNull();
  });

  it("gives up only after the server's worst case", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.5.0',
      bufferWindowMs: 600_000,
    });
    act(() => vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS - 1));
    expect(screen.queryByText('The device did not answer in time.')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByText('The device did not answer in time.').length).toBeGreaterThan(0);
    expect(CAPTURE_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
  });

  it('clears a stale failure when a newer snapshot arrives', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await push({ type: 'error', code: 'inspect_failed', message: 'The app is in the background.' });
    const panel = screen.getByRole('tabpanel', { name: /Inspector/ });
    expect(within(panel).getByRole('alert').textContent).toBe('The app is in the background.');
    await push(snapshotMsg({ id: 'snap-2' }));
    expect(within(panel).queryByRole('alert')).toBeNull();
  });
});

describe('stale snapshot', () => {
  it('marks the old snapshot stale when Inspect is turned on again and blocks picking until a newer one arrives', async () => {
    const { push, sent } = setup();
    await push(snapshotMsg());
    fireEvent.click(inspectButton());
    expect(overlay().getAttribute('data-stale')).toBe('true');
    expect(screen.getByText('Refreshing…', { selector: '.inspect-stale span' })).toBeTruthy();
    fireEvent.pointerMove(overlay(), at(400, 1250));
    expect(document.querySelector('.inspect-tag')).toBeNull();
    const before = sent.length;
    fireEvent.click(overlay(), at(400, 1250));
    fireEvent.click(document.querySelector('[data-node="7"]')!);
    expect(sent).toHaveLength(before);
    await push(snapshotMsg({ id: 'snap-2' }));
    expect(overlay().getAttribute('data-stale')).toBeNull();
    fireEvent.click(overlay(), at(400, 1250));
    expect(sent.at(-1)).toEqual({ type: 'selectInspectorNode', snapshotId: 'snap-2', nodeId: 7 });
  });

  it('offers a retry when the refresh failed and the snapshot is still old', async () => {
    const { push, inspects } = setup();
    await push(snapshotMsg());
    fireEvent.click(inspectButton());
    await push({ type: 'error', code: 'inspect_failed', message: 'No window.' });
    expect(screen.getByText('Out of date')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Capture again' }));
    expect(inspects()).toHaveLength(2);
  });
});

describe('agent selection', () => {
  it('marks a selection made by an AI agent in the attributes and on the overlay', async () => {
    const { push } = setup();
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    await push({
      type: 'inspectorSelection',
      selection: { snapshotId: 'snap-1', nodeId: 7, ts: 1, origin: 'user' },
    });
    expect(screen.queryByText('AI selected')).toBeNull();
    expect(document.querySelector('.inspect-tag-ai')).toBeNull();
    await push({
      type: 'inspectorSelection',
      selection: { snapshotId: 'snap-1', nodeId: 7, ts: 2, origin: 'agent' },
    });
    expect(screen.getByText('AI selected')).toBeTruthy();
    expect(document.querySelector('.inspect-tag-ai')?.textContent).toBe('AI');
    expect(document.querySelector('.inspect-box[data-kind="selected"]')?.getAttribute('data-origin')).toBe(
      'agent',
    );
  });
});

describe('badges', () => {
  it('formats the capture time and words SDK and uiautomator truncation differently', async () => {
    const { push } = setup();
    await push(snapshotMsg({ captureMs: 12.3456, truncated: true }));
    fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
    expect(screen.getByText('12.3 ms')).toBeTruthy();
    expect(screen.getByText('capped at 5,000').getAttribute('title')).toContain('deepest first');
    await push(
      snapshotMsg({
        id: 'snap-2',
        source: 'uiautomator',
        fallbackReason: 'compose',
        captureMs: null,
        truncated: true,
      }),
    );
    expect(screen.getByText('truncated at 5,000 nodes').getAttribute('title')).toBeNull();
    expect(screen.getByText('uiautomator — Compose screen')).toBeTruthy();
  });
});

describe('rendering cost', () => {
  function bigSnapshot(count: number) {
    const nodes = [node(0, null, [0, 0, 1080, 2400])];
    for (let i = 1; i < count; i++) {
      nodes.push(
        node(i, i < 40 ? 0 : 1 + (i % 39), [0, i % 2400, 100, (i % 2400) + 10], { text: `row ${i}` }),
      );
    }
    return inspectorSnapshot({
      nodes,
      windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
    });
  }

  it('does not re-render a single row when live-session flushes arrive, and a hover re-renders two', async () => {
    const { push } = setup();
    await push({ type: 'inspection', snapshot: bigSnapshot(5000) });
    fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
    const rows = screen.getByRole('tree').querySelectorAll('[data-node]');
    expect(rows.length).toBeGreaterThan(30);
    const renders = vi.mocked(shortClass);
    renders.mockClear();
    for (let i = 0; i < 20; i++) await push({ type: 'frames', sample: frame(Date.now() + i) });
    expect(renders).not.toHaveBeenCalled();

    fireEvent.pointerEnter(rows[3]!);
    fireEvent.pointerEnter(rows[5]!);
    // Row 3 loses and row 5 gains the highlight on the second move; the first move rendered row 3 only.
    expect(renders.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('keeps the controller identity across store changes that do not touch the Inspector', () => {
    const base = applyServerMessage(createInitialState(), {
      type: 'inspection',
      snapshot: inspectorSnapshot(),
    });
    const send = () => true;
    const { result, rerender } = renderHook(
      ({ state }) => useInspector({ state, send, serial: 'emulator-5554', canInspect: true }),
      { initialProps: { state: base } },
    );
    const first = result.current;
    for (let i = 0; i < 5; i++) {
      rerender({
        state: applyServerMessage(base, {
          type: 'cpu',
          sample: { ts: Date.now() + i, percent: 5, percentSingleCore: 40, threads: 30 },
        }),
      });
    }
    expect(result.current).toBe(first);
    // Hovering moves a signal, not the controller.
    act(() => result.current.hover(3));
    expect(result.current).toBe(first);
    expect(result.current.hoverId.get()).toBe(3);
  });
});

describe('device toolbar', () => {
  it('keeps the fps readout under the screen and the toolbar to the tools, in live and inspect mode', async () => {
    const { push } = setup();
    const toolbar = () => document.querySelector<HTMLElement>('.device-toolbar')!;
    const fps = () => screen.getByTitle('Frames per second');
    expect(toolbar().contains(fps())).toBe(false);
    expect(document.querySelector('.device-nav')!.contains(fps())).toBe(true);
    fireEvent.click(inspectButton());
    await push(snapshotMsg());
    expect(toolbar().contains(fps())).toBe(false);
    expect(within(toolbar()).queryByRole('button', { name: /Refresh/ })).toBeNull();
    // Power, rotate x2, clipboard, screenshot, inspect, the size control and the emulator's shut down.
    expect(toolbar().children).toHaveLength(8);
  });
});

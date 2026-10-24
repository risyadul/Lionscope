import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, InspectorSnapshot, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { SLIDER_IDLE_MS } from '../src/components/inspector/ViewEditors.tsx';
import { argbToHsva, eyedropper, hsvaToArgb, recentColors } from '../src/lib/colorPicker.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { editableSnapshot } from './inspectorFixtures.ts';
import { emulator, FakeScreenSocket, installCanvasStubs } from './screenFakes.ts';
import { resetPlots } from './uplotMock.ts';

vi.mock('uplot', () => import('./uplotMock.ts'));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture = () => {};
});
beforeEach(() => {
  resetPlots();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
  eyedropper.set(null);
  recentColors.set([]);
  // The frozen screen is 270 × 600 css px over a 540 × 1200 screenshot; the picker's square is 100 × 100.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('inspect-overlay')) return new DOMRect(0, 0, 270, 600);
    if (this.classList.contains('cp-square')) return new DOMRect(0, 0, 100, 100);
    return new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: vi.fn(),
        getImageData: (x: number, y: number) => ({ data: [x % 256, y % 256, 0x56, 255] }),
      }) as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 540 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const OPEN: ConnectionState = { status: 'open', attempt: 0, retryAt: null, closeReason: null };
const EMU_DEVICE: DeviceInfo = { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' };
const BASE: ServerMessage[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, serverVersion: '0.8.0', bufferWindowMs: 600_000 },
  { type: 'devices', devices: [EMU_DEVICE] },
  { type: 'emulators', emulators: [emulator()] },
];

const inspection = (snapshot: InspectorSnapshot): ServerMessage => ({ type: 'inspection', snapshot });
const selected = (nodeId: number, snapshotId = 'snap-1'): ServerMessage => ({
  type: 'inspectorSelection',
  selection: { snapshotId, nodeId, ts: 1, origin: 'user' },
});

/** The app with `snapshot` inspected and node `nodeId` selected in the Inspector tab. */
function setup(snapshot: InspectorSnapshot = editableSnapshot(), nodeId = 2) {
  const store = createStore((flush) => {
    queueMicrotask(flush);
    return () => {};
  });
  const sent: ClientMessage[] = [];
  const link = { isOpen: true };
  const services: DashboardServices = {
    store,
    send: (msg) => {
      if (!link.isOpen) return false;
      sent.push(msg);
      return true;
    },
    probeTs: createSignal<number | null>(null),
    cursorX: createSignal<number | null>(null),
  };
  store.dispatch({ kind: 'connection', connection: OPEN });
  for (const msg of BASE) store.dispatch({ kind: 'server', msg });
  store.flush();
  render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
  act(() => {
    for (const msg of [inspection(snapshot), selected(nodeId, snapshot.id)])
      store.dispatch({ kind: 'server', msg });
    store.flush();
  });
  const push = (...msgs: ServerMessage[]) =>
    act(() => {
      for (const msg of msgs) store.dispatch({ kind: 'server', msg });
      store.flush();
    });
  const edits = () =>
    sent.filter(
      (m): m is Extract<ClientMessage, { type: 'setViewProperty' | 'revertViewProperties' }> =>
        m.type === 'setViewProperty' || m.type === 'revertViewProperties',
    );
  const answer = (ok: boolean, extra: Partial<Extract<ServerMessage, { type: 'viewEdit' }>> = {}) =>
    push({ type: 'viewEdit', requestId: edits().at(-1)!.requestId, ok, ...extra });
  return { sent, edits, push, answer, link };
}

const attrs = () => screen.getByRole('region', { name: 'Attributes' });
const setEdit = (property: string, value: unknown) => ({
  type: 'setViewProperty',
  requestId: expect.any(Number),
  snapshotId: 'snap-1',
  nodeId: 2,
  property,
  value,
});
const openPicker = (words = 'background color') =>
  fireEvent.click(within(attrs()).getByRole('button', { name: `Open the ${words} picker` }));
const picker = (words = 'background color') =>
  within(attrs()).getByRole('group', { name: `Pick the ${words}` });
const overlay = () => document.querySelector<HTMLElement>('.inspect-overlay')!;

describe('color picker', () => {
  it('opens from the swatch, starts at the app’s color and closes on Esc without sending', () => {
    const { edits } = setup();
    openPicker();
    const hue = within(picker()).getByRole('slider', { name: 'background color: hue' }) as HTMLInputElement;
    // #FF6200EE: hue 265.
    expect(hue.value).toBe('265');
    expect(within(picker()).getByText('#FF6200EE')).toBeTruthy();
    fireEvent.keyDown(hue, { key: 'Escape' });
    expect(within(attrs()).queryByRole('group', { name: 'Pick the background color' })).toBeNull();
    expect(edits()).toEqual([]);
    // Esc closed the picker only: inspect mode is still on.
    expect(overlay()).toBeTruthy();
  });

  it('sends a swatch of this screen at once and remembers it as recent', () => {
    const { edits } = setup();
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #FF202124' }));
    expect(edits()).toEqual([setEdit('backgroundColor', '#FF202124')]);
    expect(JSON.parse(window.localStorage.getItem('lionscope.inspector.recentColors')!)).toEqual([
      '#FF202124',
    ]);
    expect(within(picker()).getByRole('button', { name: 'Recent: #FF202124' })).toBeTruthy();
  });

  it('sends the square on release and a resting slider, never every step', () => {
    vi.useFakeTimers();
    const { edits } = setup();
    openPicker();
    const square = within(picker()).getByRole('slider', { name: /saturation and brightness/ });
    fireEvent.pointerDown(square, { button: 0, pointerId: 1, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(square, { pointerId: 1, buttons: 1, clientX: 50, clientY: 50 });
    expect(edits()).toEqual([]);
    fireEvent.pointerUp(square, { pointerId: 1 });
    expect(edits()).toEqual([
      setEdit('backgroundColor', hsvaToArgb({ ...argbToHsva('#FF6200EE')!, s: 0.5, v: 0.5 })),
    ]);

    const alpha = within(picker()).getByRole('slider', { name: 'background color: alpha' });
    fireEvent.change(alpha, { target: { value: '0.5' } });
    fireEvent.change(alpha, { target: { value: '0.25' } });
    act(() => vi.advanceTimersByTime(SLIDER_IDLE_MS - 1));
    expect(edits()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(edits()).toHaveLength(2);
    expect(edits()[1]).toEqual(setEdit('backgroundColor', expect.stringMatching(/^#40/)));
  });

  it('picks a pixel of the frozen screen with the eyedropper', () => {
    const { edits } = setup();
    fireEvent.load(overlay().querySelector('img')!);
    openPicker('text color');
    fireEvent.click(within(picker('text color')).getByRole('button', { name: 'Pick' }));
    expect(screen.getByText('Pick the text color · Esc cancels')).toBeTruthy();
    // (100, 30) css px is (200, 60) of the screenshot: the fake pixel is #FFC83C56.
    fireEvent.pointerMove(overlay(), { clientX: 100, clientY: 30 });
    expect(within(overlay()).getByText('#FFC83C56')).toBeTruthy();
    fireEvent.click(overlay(), { clientX: 100, clientY: 30 });
    expect(edits()).toEqual([setEdit('textColor', '#FFC83C56')]);
    expect(screen.queryByText('Pick the text color · Esc cancels')).toBeNull();
  });

  it('gives up the eyedropper on Esc and keeps inspect mode, then leaves it on the next Esc', () => {
    const { edits } = setup();
    fireEvent.load(overlay().querySelector('img')!);
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'Pick' }));
    fireEvent.keyDown(overlay(), { key: 'Escape' });
    expect(screen.queryByText(/Esc cancels/)).toBeNull();
    expect(overlay()).toBeTruthy();
    fireEvent.click(overlay(), { clientX: 100, clientY: 30 });
    // A plain click selects again: nothing was sent.
    expect(edits()).toEqual([]);
    fireEvent.keyDown(overlay(), { key: 'Escape' });
    expect(document.querySelector('.inspect-overlay')).toBeNull();
  });

  it('can’t pick before the screenshot has loaded', () => {
    setup();
    openPicker();
    expect((within(picker()).getByRole('button', { name: 'Pick' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('color picker sync (review fixes)', () => {
  const hex = () => within(picker()).getByText(/^#[0-9A-F]{8}$/).textContent;
  const rowSwatch = () =>
    within(attrs())
      .getByRole('button', { name: /the background color picker$/ })
      .querySelector('span');

  it('sends a color again after it was refused, and a refusal leaves the picker on the app’s color', () => {
    const { edits, link } = setup();
    openPicker();
    link.isOpen = false;
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #FF202124' }));
    expect(edits()).toEqual([]);
    expect(hex()).toBe('#FF6200EE');
    link.isOpen = true;
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #FF202124' }));
    expect(edits()).toEqual([setEdit('backgroundColor', '#FF202124')]);
  });

  it('keeps the color it sent last through a snapshot of an earlier one', async () => {
    const { edits, push } = setup();
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #FF202124' }));
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #DE000000' }));
    expect(edits()).toHaveLength(2);
    // The snapshot taken after the first edit comes while the second applies.
    await push(
      inspection(editableSnapshot({ id: 'snap-2' }, { 2: { backgroundColor: '#FF202124' } })),
      selected(2, 'snap-2'),
    );
    expect(hex()).toBe('#DE000000');
  });

  it('shows the app’s color on the row again once a pick failed', async () => {
    const { answer } = setup();
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'On this screen: #FF202124' }));
    expect(rowSwatch()?.getAttribute('style')).toContain('rgb(32, 33, 36)');
    await answer(false, { error: 'stale', message: 'The view is gone.' });
    expect(rowSwatch()?.getAttribute('style')).not.toContain('rgb(32, 33, 36)');
    expect(hex()).toBe('#FF6200EE');
  });

  it('gives the focus back to the swatch when Esc closes the picker', () => {
    setup();
    openPicker();
    fireEvent.keyDown(within(picker()).getByRole('slider', { name: /hue/ }), { key: 'Escape' });
    expect(document.activeElement).toBe(
      within(attrs()).getByRole('button', { name: 'Open the background color picker' }),
    );
  });

  it('gives up the eyedropper on an Esc pressed anywhere, without leaving inspect mode', () => {
    setup();
    fireEvent.load(overlay().querySelector('img')!);
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'Pick' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(eyedropper.get()).toBeNull();
    expect(overlay()).toBeTruthy();
  });
});

describe('color picker sync (second review)', () => {
  const hue = () =>
    within(picker()).getByRole('slider', { name: 'background color: hue' }) as HTMLInputElement;
  const square = () => within(picker()).getByRole('slider', { name: /saturation and brightness/ });

  it('keeps the hue a black was picked with once the app shows it', async () => {
    const { edits, push, answer } = setup();
    openPicker();
    fireEvent.change(hue(), { target: { value: '200' } });
    fireEvent.pointerDown(square(), { button: 0, pointerId: 1, clientX: 50, clientY: 100 });
    fireEvent.pointerUp(square(), { pointerId: 1 });
    expect(edits().at(-1)).toEqual(setEdit('backgroundColor', '#FF000000'));
    await answer(true, { liveEdits: 1 });
    await push(
      inspection(editableSnapshot({ id: 'snap-2', liveEdits: 1 }, { 2: { backgroundColor: '#FF000000' } })),
      selected(2, 'snap-2'),
    );
    expect(hue().value).toBe('200');
  });

  it('a right-click on a slider leaves no drag behind: hovering the square changes nothing', () => {
    const { edits } = setup();
    openPicker();
    fireEvent.pointerDown(hue(), { button: 2, pointerId: 1 });
    fireEvent.pointerMove(square(), { pointerId: 1, buttons: 0, clientX: 10, clientY: 10 });
    expect(within(picker()).getByText('#FF6200EE')).toBeTruthy();
    expect(edits()).toEqual([]);
  });

  it('an Esc that gives up the eyedropper keeps a hex being typed', () => {
    setup();
    fireEvent.load(overlay().querySelector('img')!);
    openPicker();
    fireEvent.click(within(picker()).getByRole('button', { name: 'Pick' }));
    const input = within(attrs()).getByRole('textbox', { name: 'background color' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#FF00FF' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(eyedropper.get()).toBeNull();
    expect(input.value).toBe('#FF00FF');
  });
});

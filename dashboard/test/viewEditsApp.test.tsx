import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, DeviceInfo, InspectorSnapshot, ServerMessage } from '@lionscope/protocol/wire';
import { PROTOCOL_VERSION } from '@lionscope/protocol/wire';
import { App } from '../src/App.tsx';
import { ServicesContext, type DashboardServices } from '../src/app/services.ts';
import { SLIDER_IDLE_MS } from '../src/components/inspector/ViewEditors.tsx';
import { ANSWER_TIMEOUT_MS, SETTLE_MS } from '../src/hooks/useViewEdits.ts';
import { createSignal } from '../src/lib/signal.ts';
import { createStore, type ConnectionState } from '../src/lib/store.ts';
import { editableSnapshot, inspectorSnapshot, node } from './inspectorFixtures.ts';
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
});
beforeEach(() => {
  resetPlots();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  FakeScreenSocket.reset();
  vi.stubGlobal('WebSocket', FakeScreenSocket);
  installCanvasStubs();
  window.localStorage.clear();
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
  for (const msg of [...BASE, inspection(snapshot), selected(nodeId, snapshot.id)]) {
    store.dispatch({ kind: 'server', msg });
  }
  store.flush();
  render(
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
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
const field = (name: string) => within(attrs()).getByRole('textbox', { name }) as HTMLInputElement;
const type = (input: HTMLElement, text: string) => fireEvent.change(input, { target: { value: text } });
const enter = (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Enter' });
const setEdit = (property: string, value: unknown) => ({
  type: 'setViewProperty',
  requestId: expect.any(Number),
  snapshotId: 'snap-1',
  nodeId: 2,
  property,
  value,
});

describe('which nodes get editors', () => {
  it('offers the editors of an SDK 0.8.0 TextView and sends nothing on render or focus', () => {
    const { edits } = setup();
    const pane = attrs();
    for (const name of [
      'text',
      'alpha value',
      'translation X',
      'translation Y',
      'elevation',
      'background color',
      'text size',
      'text color',
      'Padding left',
      'Margin top',
    ]) {
      expect(within(pane).getByRole('textbox', { name })).toBeTruthy();
    }
    expect(within(pane).getByRole('radiogroup', { name: 'Visibility' })).toBeTruthy();
    expect(within(pane).getByRole('radiogroup', { name: 'Layout width' })).toBeTruthy();
    expect(within(pane).getByRole('switch', { name: 'enabled' }).getAttribute('aria-checked')).toBe('true');
    expect(within(pane).getByText('sp')).toBeTruthy();
    const input = field('Padding left');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(edits()).toEqual([]);
  });

  it('offers only what applies: no text on a layout, no size on a window root, no margins without them', () => {
    setup(editableSnapshot({}, {}), 1);
    expect(within(attrs()).queryByRole('textbox', { name: 'text size' })).toBeNull();
    expect(within(attrs()).queryByRole('textbox', { name: 'text' })).toBeNull();
    cleanup();

    setup(editableSnapshot(), 0);
    expect(within(attrs()).queryByRole('radiogroup', { name: 'Layout width' })).toBeNull();
    expect(within(attrs()).getByText('match_parent × wrap_content')).toBeTruthy();
    cleanup();

    const snapshot = editableSnapshot();
    snapshot.nodes[2] = { ...snapshot.nodes[2]!, margin: null };
    setup(snapshot);
    expect(within(attrs()).getByRole('textbox', { name: 'Padding left' })).toBeTruthy();
    expect(within(attrs()).queryByRole('textbox', { name: 'Margin left' })).toBeNull();
  });

  it('never shows or edits the text of a password field', () => {
    setup(editableSnapshot({}, { 2: { password: true } }));
    expect(within(attrs()).queryByRole('textbox', { name: 'text' })).toBeNull();
    expect(within(attrs()).getByText('A password field: its text is never shown or edited.')).toBeTruthy();
    expect(within(attrs()).getByRole('textbox', { name: 'text size' })).toBeTruthy();
  });

  it('says why a composable, a uiautomator snapshot and an older SDK are read-only', () => {
    const compose = inspectorSnapshot({
      nodes: [
        node(0, null, [0, 0, 1080, 2400], { className: 'com.android.internal.policy.DecorView' }),
        node(1, 0, [100, 200, 500, 300], {
          className: 'Button',
          alpha: null,
          padding: null,
          margin: null,
          layoutWidth: null,
          layoutHeight: null,
          composable: { file: 'CartScreen.kt', line: 87 },
        }),
      ],
    });
    setup(compose, 1);
    expect(
      within(attrs()).getByText('A composable can’t be edited live: change it in code (CartScreen.kt:87).'),
    ).toBeTruthy();
    expect(within(attrs()).queryByRole('textbox')).toBeNull();
    cleanup();

    setup(inspectorSnapshot({ source: 'uiautomator', fallbackReason: 'no_sdk' }));
    expect(within(attrs()).getByText('Editing views live needs the Lionscope SDK in the app.')).toBeTruthy();
    expect(within(attrs()).queryByRole('textbox')).toBeNull();
    cleanup();

    setup(inspectorSnapshot());
    expect(
      within(attrs()).getByText('Update the app’s Lionscope SDK to 0.8.0 to edit views live.'),
    ).toBeTruthy();
    expect(within(attrs()).queryByRole('switch')).toBeNull();
  });
});

describe('committing', () => {
  it('sends a padding side on Enter, once, and not a value the view already has', () => {
    const { edits } = setup();
    const input = field('Padding left');
    type(input, '8');
    enter(input);
    expect(edits()).toEqual([]);
    type(input, '12');
    expect(edits()).toEqual([]);
    enter(input);
    fireEvent.blur(input);
    expect(edits()).toEqual([setEdit('paddingLeft', 12)]);
    expect(input.value).toBe('12');
  });

  it('commits on leaving the field, and Esc restores the value without leaving inspect mode', async () => {
    const { edits, push } = setup();
    const inspect = screen.getByRole('button', { name: 'Inspect' });
    fireEvent.click(inspect);
    // Until the new capture arrives the old snapshot may not match the screen: it can't be edited.
    expect(field('translation X').disabled).toBe(true);
    await push(inspection(editableSnapshot({ id: 'snap-2' })), selected(2, 'snap-2'));
    const input = field('translation X');
    type(input, '-24.5');
    fireEvent.blur(input);
    expect(edits()).toEqual([{ ...setEdit('translationX', -24.5), snapshotId: 'snap-2' }]);

    const elevation = field('elevation');
    type(elevation, '40');
    fireEvent.keyDown(elevation, { key: 'Escape' });
    expect(elevation.value).toBe('2');
    fireEvent.blur(elevation);
    expect(edits()).toHaveLength(1);
    expect(inspect.getAttribute('aria-pressed')).toBe('true');
    // With nothing to cancel, Esc in a control leaves inspect mode as anywhere else.
    fireEvent.keyDown(within(attrs()).getByRole('radio', { name: 'visible' }), { key: 'Escape' });
    expect(inspect.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not send an invalid value and says why next to the field', () => {
    const { edits } = setup();
    const input = field('Padding top');
    type(input, '-3');
    enter(input);
    expect(edits()).toEqual([]);
    expect(within(attrs()).getByRole('alert').textContent).toContain('Whole px from 0 to 2000.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('4');
    expect(within(attrs()).queryByRole('alert')).toBeNull();
  });

  it('normalizes a color and refuses one that is not', () => {
    const { edits } = setup();
    const input = field('background color');
    type(input, 'zz');
    enter(input);
    expect(edits()).toEqual([]);
    type(input, '#12abef');
    enter(input);
    expect(edits()).toEqual([setEdit('backgroundColor', '#FF12ABEF')]);
  });

  it('sends the visibility and the enabled state on a click', () => {
    const { edits } = setup();
    fireEvent.click(within(attrs()).getByRole('radio', { name: 'gone' }));
    fireEvent.click(within(attrs()).getByRole('switch', { name: 'enabled' }));
    expect(edits()).toEqual([setEdit('visibility', 'gone'), setEdit('enabled', false)]);
  });

  it('fixes the layout size at the measured px, then at a typed one', () => {
    const { edits } = setup();
    fireEvent.click(
      within(within(attrs()).getByRole('radiogroup', { name: 'Layout width' })).getByRole('radio', {
        name: 'px',
      }),
    );
    expect(edits()).toEqual([setEdit('layoutWidth', '400px')]);
    cleanup();

    const fixed = editableSnapshot();
    fixed.nodes[2] = { ...fixed.nodes[2]!, layoutWidth: '400px' };
    const next = setup(fixed);
    const input = field('width in px');
    expect(input.value).toBe('400');
    type(input, '320');
    enter(input);
    expect(next.edits()).toEqual([setEdit('layoutWidth', '320px')]);
  });

  it('sends text as typed', () => {
    const { edits } = setup();
    const input = field('text');
    expect(input.value).toBe('Checkout');
    type(input, 'Pay now');
    enter(input);
    expect(edits()).toEqual([setEdit('text', 'Pay now')]);
  });

  it('sends the alpha slider when it is released or rests, never every step', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { edits } = setup();
    const slider = within(attrs()).getByRole('slider', { name: 'alpha' });
    fireEvent.change(slider, { target: { value: '0.8' } });
    fireEvent.change(slider, { target: { value: '0.6' } });
    expect(edits()).toEqual([]);
    fireEvent.pointerUp(slider);
    expect(edits()).toEqual([setEdit('alpha', 0.6)]);
    act(() => vi.advanceTimersByTime(SLIDER_IDLE_MS));
    expect(edits()).toHaveLength(1);

    fireEvent.change(slider, { target: { value: '0.4' } });
    act(() => vi.advanceTimersByTime(SLIDER_IDLE_MS - 1));
    expect(edits()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(edits().at(-1)).toEqual(setEdit('alpha', 0.4));
    fireEvent.keyUp(slider, { key: 'ArrowLeft' });
    expect(edits()).toHaveLength(2);
  });

  it('says so when the socket is down', () => {
    const { edits, link } = setup();
    link.isOpen = false;
    const input = field('Padding left');
    type(input, '20');
    enter(input);
    expect(edits()).toEqual([]);
    expect(within(attrs()).getByRole('alert').textContent).toContain('Not connected to the server.');
  });
});

describe('applying', () => {
  const busy = (input: HTMLElement) => input.getAttribute('aria-busy') === 'true';

  it('stays applying after the answer until the next snapshot shows the change', async () => {
    const { push, answer } = setup();
    const input = field('elevation');
    type(input, '8');
    enter(input);
    expect(busy(input)).toBe(true);
    // A live region that is always there, so the change is announced.
    expect(
      within(attrs())
        .getAllByRole('status')
        .map((region) => region.textContent),
    ).toContain('Applying elevation');
    await answer(true, { liveEdits: 1 });
    expect(busy(field('elevation'))).toBe(true);
    expect(screen.getByText('1 live edit (temporary)')).toBeTruthy();

    // The server re-captured on its own and kept the selection on the same view.
    await push(
      inspection(
        editableSnapshot({ id: 'snap-2', liveEdits: 1 }, { 2: { elevation: 8, edited: ['elevation'] } }),
      ),
      selected(2, 'snap-2'),
    );
    expect(busy(field('elevation'))).toBe(false);
    expect(field('elevation').value).toBe('8');
    expect(within(attrs()).getByText('edited')).toBeTruthy();
  });

  it('settles on its own when no snapshot follows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { answer } = setup();
    const input = field('elevation');
    type(input, '8');
    enter(input);
    await answer(true);
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(busy(field('elevation'))).toBe(false);
  });

  it('gives up waiting for an answer that never comes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    setup();
    const input = field('elevation');
    type(input, '8');
    enter(input);
    act(() => vi.advanceTimersByTime(ANSWER_TIMEOUT_MS));
    expect(busy(field('elevation'))).toBe(false);
    expect(within(attrs()).getByRole('alert').textContent).toContain('The server did not answer in time.');
  });

  it('shows a refusal next to the field and keeps the draft', async () => {
    const { answer } = setup();
    const input = field('text size');
    type(input, '30');
    enter(input);
    await answer(false, { error: 'limit' });
    expect(within(attrs()).getByRole('alert').textContent).toBe(
      '256 live edits are in effect: revert some first.',
    );
    expect(field('text size').value).toBe('30');
    expect(busy(field('text size'))).toBe(false);
  });

  it("drops an error when a new snapshot comes: it named the old snapshot's node", async () => {
    const { answer, push } = setup();
    const input = field('text size');
    type(input, '30');
    enter(input);
    await answer(false, { error: 'invalid_value', message: 'That is not a valid textSize.' });
    expect(within(attrs()).getByRole('alert')).toBeTruthy();
    await push(inspection(editableSnapshot({ id: 'snap-2' })), selected(2, 'snap-2'));
    expect(within(attrs()).queryByRole('alert')).toBeNull();
  });

  it('keeps saying why an edit missed its view across the snapshot the server takes then, until the next edit', async () => {
    const { answer, push } = setup();
    const input = field('text size');
    type(input, '30');
    enter(input);
    await answer(false, { error: 'stale', message: 'The view was recreated: retry in the new snapshot.' });
    const head = () => document.querySelector('.inspect-failure');
    expect(head()?.textContent).toBe('The view was recreated: retry in the new snapshot.');
    expect(within(attrs()).queryByRole('alert')).toBeNull();
    await push(inspection(editableSnapshot({ id: 'snap-2' })), selected(2, 'snap-2'));
    expect(head()?.textContent).toBe('The view was recreated: retry in the new snapshot.');
    const retry = field('text size');
    type(retry, '28');
    enter(retry);
    expect(head()).toBeNull();
  });

  it('shows a text size to one decimal', async () => {
    const snapshot = editableSnapshot();
    const label = snapshot.nodes[2];
    if (!label?.view) throw new Error('fixture has no editable TextView at 2');
    setup({
      ...snapshot,
      nodes: snapshot.nodes.map((n) =>
        n === label ? { ...label, view: { ...label.view!, textSize: 17.905 } } : n,
      ),
    });
    expect(field('text size').value).toBe('17.9');
  });
});

describe('review fixes', () => {
  it('sends a toggle back while the first change is still applying', () => {
    const { edits } = setup();
    const toggle = within(attrs()).getByRole('switch', { name: 'enabled' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(edits().map((m) => m.type === 'setViewProperty' && m.value)).toEqual([false, true]);
    fireEvent.click(within(attrs()).getByRole('radio', { name: 'gone' }));
    fireEvent.click(within(attrs()).getByRole('radio', { name: 'visible' }));
    expect(
      edits()
        .slice(2)
        .map((m) => m.type === 'setViewProperty' && m.value),
    ).toEqual(['gone', 'visible']);
  });

  it('says in the head why an edit of an older snapshot failed', async () => {
    const { push, answer } = setup();
    const input = field('elevation');
    type(input, '9');
    enter(input);
    await push(inspection(editableSnapshot({ id: 'snap-2' })), selected(2, 'snap-2'));
    await answer(false, { error: 'limit', message: 'Revert some first.' });
    expect(document.querySelector('.inspect-failure')?.textContent).toBe('Revert some first.');
  });

  it('drops the head notice after the snapshot the server takes, and on another device', async () => {
    const { push, answer } = setup();
    const input = field('elevation');
    type(input, '9');
    enter(input);
    await answer(false, { error: 'stale', message: 'Gone.' });
    await push(inspection(editableSnapshot({ id: 'snap-2' })), selected(2, 'snap-2'));
    expect(document.querySelector('.inspect-failure')?.textContent).toBe('Gone.');
    await push(inspection(editableSnapshot({ id: 'snap-3' })), selected(2, 'snap-3'));
    expect(document.querySelector('.inspect-failure')).toBeNull();
  });

  it('sends a resting slider to the view in the snapshot that came meanwhile', async () => {
    vi.useFakeTimers();
    const { edits, push } = setup();
    fireEvent.change(within(attrs()).getByRole('slider', { name: 'alpha' }), { target: { value: '0.3' } });
    // A snapshot with another node order: the same view (same key) is now node 3.
    const moved = editableSnapshot({ id: 'snap-2' });
    const nodes = moved.nodes.map((n) => (n.id === 2 ? { ...n, id: 3 } : n.id === 3 ? { ...n, id: 2 } : n));
    await push(inspection({ ...moved, nodes }), selected(3, 'snap-2'));
    act(() => vi.advanceTimersByTime(SLIDER_IDLE_MS));
    expect(edits().at(-1)).toMatchObject({ snapshotId: 'snap-2', nodeId: 3, property: 'alpha', value: 0.3 });
  });
});

describe('reverting', () => {
  const edited = () =>
    editableSnapshot({ liveEdits: 3 }, { 2: { edited: ['alpha', 'paddingLeft', 'paddingTop'] } });

  it('marks edited properties and reverts one, or the padding group', () => {
    const { edits } = setup(edited());
    expect(within(attrs()).getAllByText('edited')).toHaveLength(2);
    fireEvent.click(within(attrs()).getByRole('button', { name: 'Revert this view' }));
    // While the view reverts, its other reverts wait.
    expect(
      (within(attrs()).getByRole('button', { name: 'Revert alpha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(edits()).toEqual([
      { type: 'revertViewProperties', requestId: expect.any(Number), snapshotId: 'snap-1', nodeId: 2 },
    ]);
  });

  it('reverts one property or the padding group, keeping the focus on the field', () => {
    const { edits } = setup(edited());
    fireEvent.click(within(attrs()).getByRole('button', { name: 'Revert alpha' }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('alpha');
    fireEvent.click(within(attrs()).getByRole('button', { name: 'Revert padding' }));
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Padding /);
    expect(edits()).toEqual([
      {
        type: 'revertViewProperties',
        requestId: expect.any(Number),
        snapshotId: 'snap-1',
        nodeId: 2,
        property: 'alpha',
      },
      {
        type: 'revertViewProperties',
        requestId: expect.any(Number),
        snapshotId: 'snap-1',
        nodeId: 2,
        property: 'padding',
      },
    ]);
    expect(new Set(edits().map((m) => m.requestId)).size).toBe(2);
    expect(field('Padding left').getAttribute('aria-busy')).toBe('true');
  });

  it('counts the live edits in the head and reverts them all', async () => {
    const { edits, answer } = setup(edited());
    const panel = screen.getByRole('tabpanel', { name: /Inspector/ });
    const badge = within(panel).getByText('3 live edits (temporary)');
    expect(badge.getAttribute('title')).toContain('until reverted');
    fireEvent.click(within(panel).getByRole('button', { name: 'Revert all' }));
    expect(edits()).toEqual([
      { type: 'revertViewProperties', requestId: expect.any(Number), snapshotId: 'snap-1' },
    ]);
    expect(within(panel).getByRole('button', { name: 'Reverting…' })).toBeTruthy();
    await answer(false, { error: 'no_link' });
    expect(within(panel).getByRole('alert').textContent).toBe(
      'The app’s SDK is no longer connected: inspect again.',
    );
    expect(within(panel).getByRole('button', { name: 'Revert all' })).toBeTruthy();
  });

  it('shows no count without live edits', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Revert all' })).toBeNull();
    expect(screen.queryByText(/live edit/)).toBeNull();
  });
});

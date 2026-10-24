import type { InspectorNode, InspectorSnapshot, ViewState } from '@lionscope/protocol';
import { VIEW_EDIT_BURST } from '@lionscope/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkEditError } from '../src/device/sdkLink.ts';
import type { SdkViewEditResult } from '../src/device/sdkLink.ts';
import {
  EDIT_BLOCKED_MESSAGES,
  RESNAPSHOT_DELAY_MS,
  VIEW_EDIT_MESSAGES,
  ViewEdits,
} from '../src/inspector/viewEdits.ts';
import type { ViewEditOutcome, ViewEditsOptions } from '../src/inspector/viewEdits.ts';
import type { InspectorSessionSource } from '../src/session/sessionManager.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const SERIAL = 'emulator-5554';
const PKG = 'com.example.shop';
const VIEW: ViewState = {
  key: 501,
  translationX: 0,
  translationY: 0,
  elevation: 0,
  backgroundColor: null,
  textSize: 16,
  textColor: '#FF000000',
  password: false,
};

function viewNode(id: number, overrides: Partial<InspectorNode> = {}): InspectorNode {
  return {
    id,
    parent: id === 0 ? null : 0,
    window: 0,
    className:
      id === 0
        ? 'com.android.internal.policy.DecorView'
        : 'com.google.android.material.button.MaterialButton',
    resourceId: id === 0 ? null : 'btn_pay',
    text: id === 0 ? null : 'Pay',
    contentDescription: null,
    bounds: [0, 0, 1080, 100],
    visibleBounds: [0, 0, 1080, 100],
    visibility: 'visible',
    alpha: 1,
    enabled: true,
    clickable: id !== 0,
    focused: false,
    selected: false,
    checked: null,
    padding: [0, 0, 0, 0],
    margin: id === 0 ? null : [0, 0, 0, 0],
    layoutWidth: 'match_parent',
    layoutHeight: 'wrap_content',
    source: null,
    fragment: null,
    activity: 'com.example.shop.ui.MainActivity',
    view: { ...VIEW, key: VIEW.key + id, ...(id === 0 ? { textSize: null, textColor: null } : {}) },
    ...overrides,
  };
}

function snapshot(nodes: InspectorNode[], overrides: Partial<InspectorSnapshot> = {}): InspectorSnapshot {
  return {
    id: 'a1b2c3d4e5f60718',
    ts: 1_800_000_000_000,
    serial: SERIAL,
    packageName: PKG,
    source: 'sdk',
    screen: 'checkout',
    display: { width: 1080, height: 2400, rotation: 0 },
    windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
    nodes,
    truncated: false,
    captureMs: 2,
    fallbackReason: null,
    liveEdits: 0,
    ...overrides,
  };
}

const ok = (liveEdits: number): Promise<SdkViewEditResult> =>
  Promise.resolve({ type: 'viewPropertyResult', requestId: 1, ok: true, liveEdits });

function setup(
  current: InspectorSnapshot | null = snapshot([viewNode(0), viewNode(1)]),
  protocolVersion = 8,
) {
  const link = new FakeLink(protocolVersion);
  link.answerEdit = () => ok(1);
  let source: InspectorSessionSource | null = { packageName: PKG, link, screen: 'checkout' };
  const fresh: string[] = [];
  const next = snapshot([viewNode(0), viewNode(1, { padding: [24, 0, 0, 0] })], { id: 'ffffffffffffffff' });
  const inspector: ViewEditsOptions['inspector'] = {
    get current() {
      return current;
    },
    editSource: (id) => (current?.id === id ? source : null),
    inspectFresh: async (serial) => {
      fresh.push(serial);
      return next;
    },
  };
  const edits = new ViewEdits({ inspector, now: () => Date.now() });
  return {
    edits,
    link,
    fresh,
    next,
    setSource: (value: InspectorSessionSource | null) => (source = value),
    setCurrent: (value: InspectorSnapshot | null) => (current = value),
  };
}

const failed = (outcome: ViewEditOutcome) => (outcome.ok ? null : outcome.error);

describe('live view edits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a valid edit by view key through the snapshot’s own link, then takes a new snapshot', async () => {
    const { edits, link, fresh, next } = setup();
    const outcome = await edits.set({
      snapshotId: 'a1b2c3d4e5f60718',
      nodeId: 1,
      property: 'paddingLeft',
      value: 24,
    });
    expect(outcome).toMatchObject({ ok: true, liveEdits: 1 });
    expect(link.edits).toEqual([{ kind: 'set', viewKey: 502, property: 'paddingLeft', value: 24 }]);
    expect(fresh).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL]);
    await expect(outcome.ok && outcome.next).resolves.toBe(next);
  });

  it('normalizes the value before sending it', async () => {
    const { edits, link } = setup();
    await edits.set({ nodeId: 1, property: 'backgroundColor', value: '#3366cc' });
    await edits.set({ nodeId: 1, property: 'layoutHeight', value: 96 });
    expect(link.edits.map((edit) => edit.kind === 'set' && edit.value)).toEqual(['#FF3366CC', '96px']);
  });

  it('takes one new snapshot for a burst of edits', async () => {
    const { edits, fresh } = setup();
    await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 });
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS / 2);
    await edits.set({ nodeId: 1, property: 'alpha', value: 0.4 });
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL]);
    await edits.set({ nodeId: 1, property: 'alpha', value: 0.3 });
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL, SERIAL]);
  });

  it('only edits the current snapshot, and says why not', async () => {
    const { edits, link, setCurrent } = setup();
    expect(
      failed(await edits.set({ snapshotId: '0000000000000000', nodeId: 1, property: 'alpha', value: 0.5 })),
    ).toBe('stale');
    expect(failed(await edits.set({ nodeId: 7, property: 'alpha', value: 0.5 }))).toBe('stale');
    setCurrent(null);
    expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('stale');
    expect(link.edits).toEqual([]);
  });

  it('refuses uiautomator snapshots, composables, views without state and properties that do not apply', async () => {
    const composable = viewNode(2, { className: 'Button', composable: { file: 'CartScreen.kt', line: 87 } });
    const old = viewNode(3, { view: undefined });
    const { edits, link, setCurrent } = setup(snapshot([viewNode(0), viewNode(1), composable, old]));
    const refused = await edits.set({ nodeId: 2, property: 'alpha', value: 0.5 });
    expect(refused).toMatchObject({ ok: false, error: 'not_editable' });
    // No app strings in messages (they reach agents unmarked): the dashboard shows the call site itself.
    expect(!refused.ok && refused.message).toContain('call site');
    expect(!refused.ok && refused.message).not.toContain('CartScreen');
    expect(failed(await edits.set({ nodeId: 3, property: 'alpha', value: 0.5 }))).toBe('old_sdk');
    expect(failed(await edits.set({ nodeId: 0, property: 'text', value: 'x' }))).toBe('not_editable');
    expect(failed(await edits.set({ nodeId: 0, property: 'layoutWidth', value: 'wrap_content' }))).toBe(
      'not_editable',
    );
    expect(failed(await edits.set({ nodeId: 0, property: 'marginTop', value: 4 }))).toBe('not_editable');
    expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 3 }))).toBe('invalid_value');
    setCurrent(snapshot([viewNode(0), viewNode(1)], { source: 'uiautomator', fallbackReason: 'no_sdk' }));
    expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('not_editable');
    expect(failed(await edits.revert({}))).toBe('not_editable');
    expect(link.edits).toEqual([]);
  });

  it('never sends the text of a password field', async () => {
    const field = viewNode(1, { text: null, view: { ...VIEW, key: 9, password: true } });
    const { edits, link } = setup(snapshot([viewNode(0), field]));
    const refused = await edits.set({ nodeId: 1, property: 'text', value: 'hunter2' });
    expect(refused).toEqual({ ok: false, error: 'password', message: VIEW_EDIT_MESSAGES.password });
    expect((await edits.set({ nodeId: 1, property: 'textSize', value: 18 })).ok).toBe(true);
    expect(link.edits).toEqual([{ kind: 'set', viewKey: 9, property: 'textSize', value: 18 }]);
  });

  it('refuses a snapshot whose link takes no edits, saying what to do, without asking the SDK', async () => {
    for (const editBlocked of ['needs_session', 'unverified'] as const) {
      const { edits, link } = setup(snapshot([viewNode(0), viewNode(1)], { editBlocked }));
      const refused = await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 });
      expect(refused).toEqual({
        ok: false,
        error: 'unauthenticated',
        message: EDIT_BLOCKED_MESSAGES[editBlocked],
      });
      expect(failed(await edits.revert({}))).toBe('unauthenticated');
      expect(link.edits).toEqual([]);
    }
    const { edits, link } = setup();
    link.answerEdit = () =>
      Promise.resolve({
        type: 'viewPropertyResult',
        requestId: 1,
        ok: false,
        error: 'unauthenticated',
        liveEdits: 0,
      });
    expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('unauthenticated');
  });

  it('needs the link that captured the snapshot, at v8', async () => {
    const old = setup(undefined, 6);
    expect(failed(await old.edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('old_sdk');
    const gone = setup();
    gone.setSource(null);
    expect(failed(await gone.edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('no_link');
    const closed = setup();
    closed.link.answerEdit = () => Promise.reject(new SdkEditError('closed'));
    expect(failed(await closed.edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('no_link');
    closed.link.answerEdit = () => Promise.reject(new SdkEditError('timeout'));
    expect(failed(await closed.edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('timeout');
  });

  it('passes the SDK’s refusals on with the live edits, and re-inspects after a stale one', async () => {
    const { edits, link, fresh } = setup();
    link.answerEdit = () =>
      Promise.resolve({ type: 'viewPropertyResult', requestId: 1, ok: false, error: 'stale', liveEdits: 2 });
    expect(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 })).toEqual({
      ok: false,
      error: 'stale',
      message: VIEW_EDIT_MESSAGES.stale,
      liveEdits: 2,
    });
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL]);
    for (const [sdk, error] of [
      ['unsupported', 'not_editable'],
      ['limit', 'limit'],
      ['invalid', 'invalid_value'],
      ['disabled', 'failed'],
    ] as const) {
      link.answerEdit = () =>
        Promise.resolve({ type: 'viewPropertyResult', requestId: 1, ok: false, error: sdk, liveEdits: 0 });
      expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe(error);
    }
  });

  it('rate-limits edits per device, dashboards and agents together', async () => {
    const { edits, link } = setup();
    const outcomes: ViewEditOutcome[] = [];
    for (let i = 0; i < VIEW_EDIT_BURST + 1; i += 1) {
      outcomes.push(await edits.set({ nodeId: 1, property: 'alpha', value: i / 20 }));
    }
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(VIEW_EDIT_BURST);
    expect(failed(outcomes.at(-1) as ViewEditOutcome)).toBe('rate_limited');
    expect(link.edits).toHaveLength(VIEW_EDIT_BURST);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await edits.set({ nodeId: 1, property: 'alpha', value: 0.9 })).ok).toBe(true);
  });

  it('reverts one property or group of a node, a node, or every edit in the app', async () => {
    const { edits, link } = setup();
    await edits.revert({ nodeId: 1, property: 'padding' });
    await edits.revert({ nodeId: 1 });
    await edits.revert({});
    expect(link.edits).toEqual([
      { kind: 'revert', viewKey: 502, property: 'padding' },
      { kind: 'revert', viewKey: 502, property: undefined },
      { kind: 'revert', viewKey: undefined, property: undefined },
    ]);
    expect(failed(await edits.revert({ property: 'padding' }))).toBe('not_editable');
  });

  it('checks every value of a multi-property request before sending any, and says which were set when one fails', async () => {
    const { edits, link } = setup();
    const invalid = await edits.setAll({
      nodeId: 1,
      values: [
        { property: 'paddingLeft', value: 8 },
        { property: 'paddingTop', value: -1 },
      ],
    });
    expect(failed(invalid)).toBe('invalid_value');
    expect(link.edits).toEqual([]);
    let answered = 0;
    link.answerEdit = () =>
      (answered += 1) === 2
        ? Promise.resolve({
            type: 'viewPropertyResult',
            requestId: 1,
            ok: false,
            error: 'failed',
            liveEdits: 1,
          })
        : ok(answered);
    const partly = await edits.setAll({
      nodeId: 1,
      values: ['paddingLeft', 'paddingTop', 'paddingRight'].map((property) => ({
        property: property as 'paddingLeft',
        value: 4,
      })),
    });
    expect(partly).toMatchObject({ ok: false, error: 'failed', applied: ['paddingLeft'] });
    expect(link.edits.map((edit) => edit.kind === 'set' && edit.viewKey)).toEqual([502, 502]);
  });

  it('takes a new snapshot after an edit that timed out or failed: the app may have changed', async () => {
    const { edits, link, fresh } = setup();
    link.answerEdit = () => Promise.reject(new SdkEditError('timeout'));
    expect(failed(await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 }))).toBe('timeout');
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL]);
    link.answerEdit = () =>
      Promise.resolve({
        type: 'viewPropertyResult',
        requestId: 1,
        ok: false,
        error: 'invalid',
        liveEdits: 0,
      });
    await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 });
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([SERIAL]); // Nothing changed: no new snapshot.
  });

  it('settles a pending follow-up snapshot when closed', async () => {
    const { edits, fresh } = setup();
    const outcome = await edits.set({ nodeId: 1, property: 'alpha', value: 0.5 });
    edits.close();
    await expect(outcome.ok && outcome.next).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(RESNAPSHOT_DELAY_MS);
    expect(fresh).toEqual([]);
  });
});

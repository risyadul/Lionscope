import type { InspectorNode, ViewState } from '@lionscope/protocol';
import { describe, expect, it } from 'vitest';
import { mcpInstructions } from '../src/agent/mcpServer.ts';
import { availableTools, callTool, findTool } from '../src/agent/registry.ts';
import type { SdkInspection } from '../src/device/sdkLink.ts';
import { InspectorService } from '../src/inspector/inspectorService.ts';
import { ViewEdits } from '../src/inspector/viewEdits.ts';
import { DEVICES, fakeAgent, PKG } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import { rgbPng } from './helpers/png.ts';
import { FakeLink } from './helpers/sdkSession.ts';
import type { EditRequest } from './helpers/sdkSession.ts';

const SERIAL = 'emulator-5554';
const PNG = rgbPng(108, 240, () => [255, 255, 255]);

function state(key: number, overrides: Partial<ViewState> = {}): ViewState {
  return {
    key,
    translationX: 0,
    translationY: 0,
    elevation: 0,
    backgroundColor: null,
    textSize: null,
    textColor: null,
    password: false,
    ...overrides,
  };
}

function node(id: number, overrides: Partial<InspectorNode>): InspectorNode {
  return {
    id,
    parent: id === 0 ? null : 0,
    window: 0,
    className: 'android.widget.FrameLayout',
    resourceId: null,
    text: null,
    contentDescription: null,
    bounds: [0, 0, 1080, 2400],
    visibleBounds: [0, 0, 1080, 2400],
    visibility: 'visible',
    alpha: 1,
    enabled: true,
    clickable: false,
    focused: false,
    selected: false,
    checked: null,
    padding: [0, 0, 0, 0],
    margin: id === 0 ? null : [0, 0, 0, 0],
    layoutWidth: 'match_parent',
    layoutHeight: id === 0 ? 'match_parent' : 'wrap_content',
    source: null,
    fragment: null,
    activity: 'com.example.shop.ui.MainActivity',
    ...overrides,
  };
}

/** The app's views now: padding and text as the edits so far set them. */
function screen(padding: [number, number, number, number], text: string): InspectorNode[] {
  return [
    node(0, { view: state(900) }),
    node(1, { className: 'Column', composable: { file: 'CartScreen.kt', line: 87 }, alpha: null }),
    node(2, {
      className: 'com.google.android.material.button.MaterialButton',
      resourceId: 'btn_pay',
      text,
      bounds: [48, 1600, 1032, 1744],
      visibleBounds: [48, 1600, 1032, 1744],
      padding,
      view: state(901, { textSize: 16, textColor: '#FFFFFFFF', edited: text === 'Pay' ? [] : ['text'] }),
    }),
  ];
}

function inspection(nodes: InspectorNode[], liveEdits: number): SdkInspection {
  return {
    begin: {
      type: 'inspectBegin',
      requestId: 1,
      ts: 1792516376500,
      screen: 'checkout',
      display: { width: 1080, height: 2400, rotation: 0 },
      windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
      nodeCount: nodes.length,
      truncated: false,
      captureMs: 2.1,
      compose: false,
      liveEdits,
    },
    nodes,
  };
}

/** An app on the device whose SDK applies the edits it is sent to what its next snapshot shows. */
function editableApp() {
  const link = new FakeLink(8);
  const padding: [number, number, number, number] = [0, 0, 0, 0];
  let text = 'Pay';
  let liveEdits = 0;
  link.answerInspect = async () => inspection(screen([...padding], text), liveEdits);
  link.answerEdit = async (request: EditRequest) => {
    if (request.kind === 'set') {
      const side = ['paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom'].indexOf(request.property);
      if (side !== -1) padding[side] = request.value as number;
      if (request.property === 'text') text = request.value as string;
      liveEdits += 1;
    } else {
      padding.fill(0);
      text = 'Pay';
      liveEdits = 0;
    }
    return { type: 'viewPropertyResult', requestId: 1, ok: true, liveEdits };
  };
  const inspector = new InspectorService({
    sessions: {
      getDevices: () => DEVICES,
      inspectorSource: () => ({ packageName: PKG, link, screen: 'checkout' }),
    },
    dumpUi: () => Promise.reject(new Error('no uiautomator here')),
    screencap: async () => PNG,
    broadcast: () => undefined,
  });
  const viewEdits = new ViewEdits({ inspector, resnapshotDelayMs: 0 });
  const agent = fakeAgent({}, { inspector });
  agent.ctx.viewEdits = viewEdits;
  return { agent, link, inspector };
}

describe('live view edit tools', () => {
  it('are device control tools, and the instructions mention them only then', () => {
    const names = (deviceControl: boolean) => availableTools(deviceControl).map((tool) => tool.name);
    expect(names(false)).not.toContain('set_view_property');
    expect(names(true)).toEqual(expect.arrayContaining(['set_view_property', 'revert_view_properties']));
    expect(findTool('set_view_property')?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(mcpInstructions(true)).toContain('set_view_property');
    expect(mcpInstructions(false)).not.toContain('set_view_property');
  });

  it('refuses without device control', async () => {
    const { agent, link } = editableApp();
    const result = await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 2, property: 'alpha', value: 0.5 },
      false,
    );
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(link.edits).toEqual([]);
  });

  it('sets a property and returns the element as the snapshot after it shows it', async () => {
    const { agent, link, inspector } = editableApp();
    const before = await inspector.inspect(SERIAL);
    const result = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 2, property: 'text', value: 'Pay now', snapshotId: before.id },
      true,
    )) as Json;
    expect(result.ok).toBe(true);
    expect(link.edits).toEqual([{ kind: 'set', viewKey: 901, property: 'text', value: 'Pay now' }]);
    expect(result.result).toMatchObject({
      set: { text: 'Pay now' },
      liveEdits: 1,
      snapshot: { liveEdits: 1 },
      element: { nodeId: 2, label: 'MaterialButton#btn_pay', values: { text: 'Pay now' }, edited: ['text'] },
    });
    expect(result.result.snapshot.id).not.toBe(before.id);
    expect(inspector.current?.id).toBe(result.result.snapshot.id);
  });

  it('sets the four sides of padding from one number or a list', async () => {
    const { agent, link, inspector } = editableApp();
    await inspector.inspect(SERIAL);
    const all = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 2, property: 'padding', value: 16 },
      true,
    )) as Json;
    expect(all.result.element.values).toEqual({
      paddingLeft: 16,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
    });
    const sides = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 2, property: 'padding', value: [8, 4, 8, 12] },
      true,
    )) as Json;
    expect(sides.result.set).toEqual({ paddingLeft: 8, paddingTop: 4, paddingRight: 8, paddingBottom: 12 });
    expect(link.edits).toHaveLength(8);
    expect(
      await callTool(agent.ctx, 'set_view_property', { nodeId: 2, property: 'padding', value: true }, true),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await callTool(
        agent.ctx,
        'set_view_property',
        { nodeId: 2, property: 'alpha', value: [1, 1, 1, 1] },
        true,
      ),
    ).toMatchObject({
      ok: false,
      error: 'alpha takes a single value',
    });
  });

  it('passes the reasons an edit is refused on as the error', async () => {
    const { agent, link, inspector } = editableApp();
    await inspector.inspect(SERIAL);
    const composable = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 1, property: 'alpha', value: 0.5 },
      true,
    )) as Json;
    expect(composable.ok).toBe(false);
    expect(composable.error).toContain('CartScreen.kt:87');
    const root = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 0, property: 'layoutWidth', value: 'wrap_content' },
      true,
    )) as Json;
    expect(root.error).toContain('layoutWidth does not apply to FrameLayout');
    const stale = (await callTool(
      agent.ctx,
      'set_view_property',
      { nodeId: 2, property: 'alpha', value: 0.5, snapshotId: '0000000000000000' },
      true,
    )) as Json;
    expect(stale.error).toContain('newer snapshot');
    expect(link.edits).toEqual([]);
  });

  it('reverts every live edit in the app, or one property of a node', async () => {
    const { agent, link, inspector } = editableApp();
    await inspector.inspect(SERIAL);
    await callTool(agent.ctx, 'set_view_property', { nodeId: 2, property: 'text', value: 'Buy' }, true);
    const one = (await callTool(
      agent.ctx,
      'revert_view_properties',
      { nodeId: 2, property: 'text' },
      true,
    )) as Json;
    expect(one.result).toMatchObject({
      reverted: 'text',
      liveEdits: 0,
      element: { values: { text: 'Pay' } },
    });
    const all = (await callTool(agent.ctx, 'revert_view_properties', {}, true)) as Json;
    expect(all.result).toMatchObject({
      reverted: 'every live edit in the app',
      liveEdits: 0,
      snapshot: { liveEdits: 0 },
    });
    expect(all.result.element).toBeUndefined();
    expect(link.edits.slice(1)).toEqual([
      { kind: 'revert', viewKey: 901, property: 'text' },
      { kind: 'revert', viewKey: undefined, property: undefined },
    ]);
    expect(await callTool(agent.ctx, 'revert_view_properties', { property: 'text' }, true)).toMatchObject({
      ok: false,
      error: 'property needs a nodeId',
    });
  });

  it('get_inspector_selection and inspect_screen say what can be edited', async () => {
    const { agent, inspector } = editableApp();
    const snapshot = await inspector.inspect(SERIAL);
    inspector.select(snapshot.id, 2, 'user');
    const selection = (await callTool(agent.ctx, 'get_inspector_selection', {}, false)) as Json;
    expect(selection.result.snapshot.liveEdits).toBe(0);
    expect(selection.result.element.editable).toEqual(
      expect.arrayContaining(['text', 'textSize', 'paddingLeft']),
    );
    expect(selection.result.element.viewState).toMatchObject({
      textSize: 16,
      textColor: '#FFFFFFFF',
      password: false,
    });
    expect(selection.result.element.edited).toEqual([]);
    const listed = (await callTool(agent.ctx, 'inspect_screen', {}, true)) as Json;
    const flags = listed.result.nodes.map((entry: Json) => entry.editable ?? false);
    expect(flags).toEqual([true, false, true]);
  });

  it('says editing is unavailable without the service', async () => {
    const agent = fakeAgent({});
    expect(await callTool(agent.ctx, 'revert_view_properties', {}, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available') as string,
    });
  });
});

// Test-only: the package itself stays free of Node types (it is shared with the browser dashboard).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PROTOCOL_V6,
  DEVICE_PROTOCOL_V8,
  editableProperties,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_EDIT_TEXT_CHARS,
  MAX_LIVE_EDITS,
  normalizeColor,
  normalizeViewValue,
  parseClientMessage,
  parseDeviceMessage,
  VIEW_PROPERTIES,
  VIEW_PROPERTY_GROUPS,
} from '../src/index.ts';
import type { InspectorNode, ViewProperty, ViewState } from '../src/index.ts';

const GOLDEN = readFileSync(new URL('../fixtures/device-messages.ndjson', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');
const SNAPSHOT_ID = '0123456789abcdef';

const VIEW: ViewState = {
  key: 42,
  translationX: 0,
  translationY: 0,
  elevation: 0,
  backgroundColor: null,
  textSize: null,
  textColor: null,
  password: false,
};

function node(overrides: Partial<InspectorNode> = {}): InspectorNode {
  return {
    id: 1,
    parent: 0,
    window: 0,
    className: 'android.widget.FrameLayout',
    resourceId: null,
    text: null,
    contentDescription: null,
    bounds: [0, 0, 100, 100],
    visibleBounds: [0, 0, 100, 100],
    visibility: 'visible',
    alpha: 1,
    enabled: true,
    clickable: false,
    focused: false,
    selected: false,
    checked: null,
    padding: [0, 0, 0, 0],
    margin: [0, 0, 0, 0],
    layoutWidth: 'match_parent',
    layoutHeight: 'wrap_content',
    source: null,
    fragment: null,
    activity: null,
    view: VIEW,
    ...overrides,
  };
}

describe('normalizeViewValue', () => {
  const valid = (property: ViewProperty, value: string | number | boolean) =>
    normalizeViewValue(property, value);

  it('bounds every property', () => {
    expect(valid('visibility', 'gone')).toBe('gone');
    expect(valid('visibility', 'hidden')).toBeNull();
    expect(valid('alpha', 0.4)).toBe(0.4);
    expect(valid('alpha', 1.01)).toBeNull();
    expect(valid('alpha', Number.NaN)).toBeNull();
    expect(valid('enabled', false)).toBe(false);
    expect(valid('enabled', 'false')).toBeNull();
    expect(valid('paddingLeft', 2000)).toBe(2000);
    expect(valid('paddingLeft', 2001)).toBeNull();
    expect(valid('paddingTop', -1)).toBeNull();
    expect(valid('paddingTop', 1.5)).toBeNull();
    expect(valid('marginRight', -2000)).toBe(-2000);
    expect(valid('marginRight', -2001)).toBeNull();
    expect(valid('translationX', -10_000)).toBe(-10_000);
    expect(valid('translationY', 10_000.5)).toBeNull();
    expect(valid('elevation', 1000)).toBe(1000);
    expect(valid('elevation', -0.5)).toBeNull();
    expect(valid('textSize', 1)).toBe(1);
    expect(valid('textSize', 200.5)).toBeNull();
    expect(valid('textSize', Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('gives layout sizes as match_parent, wrap_content or <n>px', () => {
    expect(valid('layoutWidth', 'match_parent')).toBe('match_parent');
    expect(valid('layoutHeight', 'wrap_content')).toBe('wrap_content');
    expect(valid('layoutWidth', 48)).toBe('48px');
    expect(valid('layoutWidth', '007px')).toBe('7px');
    expect(valid('layoutWidth', '10000px')).toBe('10000px');
    for (const bad of ['10001px', '-4px', '4', '4dp', '1.5px', 10_001, 1.5, true]) {
      expect(valid('layoutWidth', bad)).toBeNull();
    }
  });

  it('gives colors as #AARRGGBB in upper case', () => {
    expect(valid('backgroundColor', '#3366cc')).toBe('#FF3366CC');
    expect(valid('textColor', '#803366cc')).toBe('#803366CC');
    for (const bad of ['3366CC', '#36C', '#3366CCX', '#3366CC00FF', 'red', 0xff0000]) {
      expect(valid('backgroundColor', bad)).toBeNull();
    }
    expect(normalizeColor('#abcdef')).toBe('#FFABCDEF');
  });

  it('takes text with line breaks and tabs, nothing else of the control characters, and no lone surrogate', () => {
    expect(valid('text', 'Pay now\n\tlater 🛒')).toBe('Pay now\n\tlater 🛒');
    expect(valid('text', '')).toBe('');
    expect(valid('text', 'x'.repeat(MAX_EDIT_TEXT_CHARS))).not.toBeNull();
    expect(valid('text', 'x'.repeat(MAX_EDIT_TEXT_CHARS + 1))).toBeNull();
    expect(valid('text', 'a‍b ‮')).not.toBeNull();
    for (const bad of ['a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'lone \ud83d', 'low \ude00']) {
      expect(valid('text', bad)).toBeNull();
    }
    expect(valid('text', 5)).toBeNull();
  });
});

describe('editableProperties', () => {
  it('offers nothing without view state (uiautomator, composables, older SDKs)', () => {
    const { view: _view, ...withoutView } = node();
    expect(editableProperties(withoutView)).toEqual([]);
  });

  it('offers margins only with MarginLayoutParams and a layout size only below a window root', () => {
    const all = editableProperties(node());
    expect(all).toContain('marginTop');
    expect(all).toContain('layoutWidth');
    expect(all).not.toContain('text');
    expect(editableProperties(node({ margin: null }))).not.toContain('marginTop');
    expect(editableProperties(node({ parent: null }))).not.toContain('layoutWidth');
    expect(editableProperties(node({ layoutWidth: null, layoutHeight: null }))).not.toContain('layoutHeight');
  });

  it('offers text on TextViews but a password field only its size and color, in VIEW_PROPERTIES order', () => {
    const textView = node({ view: { ...VIEW, textSize: 16, textColor: '#FF000000' } });
    const offered = editableProperties(textView);
    expect(offered).toEqual(VIEW_PROPERTIES.filter((property) => offered.includes(property)));
    expect(offered.slice(-3)).toEqual(['text', 'textSize', 'textColor']);
    const password = editableProperties(
      node({ view: { ...VIEW, textSize: 16, textColor: '#FF000000', password: true } }),
    );
    expect(password).not.toContain('text');
    expect(password).toContain('textSize');
  });

  it('names the four sides of each group', () => {
    expect(VIEW_PROPERTY_GROUPS.padding.every((side) => VIEW_PROPERTIES.includes(side))).toBe(true);
    expect(VIEW_PROPERTY_GROUPS.margin).toEqual(['marginLeft', 'marginTop', 'marginRight', 'marginBottom']);
  });
});

describe('edit messages from the dashboard', () => {
  const set = (fields: Record<string, unknown>) =>
    parseClientMessage(
      JSON.stringify({
        type: 'setViewProperty',
        requestId: 1,
        snapshotId: SNAPSHOT_ID,
        nodeId: 3,
        ...fields,
      }),
    );

  it('normalizes a valid value and refuses an invalid one', () => {
    expect(set({ property: 'backgroundColor', value: '#ff0000' })).toMatchObject({
      ok: true,
      value: { value: '#FFFF0000' },
    });
    expect(set({ property: 'layoutWidth', value: 120 })).toMatchObject({
      ok: true,
      value: { value: '120px' },
    });
    expect(set({ property: 'alpha', value: 2 })).toEqual({ ok: false, error: 'invalid value for alpha' });
    expect(set({ property: 'padding', value: 4 }).ok).toBe(false); // Groups only revert.
    expect(set({ property: 'text', value: { a: 1 } }).ok).toBe(false);
    expect(set({ property: 'alpha', value: 0.5, extra: true }).ok).toBe(false);
    expect(set({ property: 'alpha', value: 0.5, requestId: -1 }).ok).toBe(false);
    expect(set({ property: 'alpha', value: 0.5, snapshotId: 'nope' }).ok).toBe(false);
  });

  it('carries the longest text within the frame limit', () => {
    const text = '界'.repeat(MAX_EDIT_TEXT_CHARS);
    const line = JSON.stringify({
      type: 'setViewProperty',
      requestId: 2_147_483_647,
      snapshotId: SNAPSHOT_ID,
      nodeId: 4999,
      property: 'text',
      value: text,
    });
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(line)).toMatchObject({ ok: true, value: { value: text } });
  });

  it('reverts a property or group of a node, a node, or everything', () => {
    const revert = (fields: Record<string, unknown>) =>
      parseClientMessage(
        JSON.stringify({ type: 'revertViewProperties', requestId: 1, snapshotId: SNAPSHOT_ID, ...fields }),
      );
    expect(revert({ nodeId: 3, property: 'padding' }).ok).toBe(true);
    expect(revert({ nodeId: 3, property: 'textColor' }).ok).toBe(true);
    expect(revert({ nodeId: 3 }).ok).toBe(true);
    expect(revert({}).ok).toBe(true);
    expect(revert({ property: 'padding' })).toEqual({ ok: false, error: 'property needs a nodeId' });
    expect(revert({ nodeId: 3, property: 'everything' }).ok).toBe(false);
  });
});

describe('v8 device messages', () => {
  it('has golden lines for editable views, live edits and both answers', () => {
    const parsed = GOLDEN.map((line) => JSON.parse(line) as Record<string, unknown>);
    const begin = parsed.find((message) => message.type === 'inspectBegin' && 'liveEdits' in message);
    expect(begin?.liveEdits).toBe(2);
    const nodes = parsed.find((message) => message.type === 'inspectNodes' && message.requestId === 10)
      ?.nodes as InspectorNode[];
    expect(nodes.every((view) => view.view !== undefined)).toBe(true);
    expect(nodes[1]?.view?.edited).toEqual(['paddingLeft', 'text']);
    expect(nodes[2]?.view?.password).toBe(true);
    expect(nodes[2]?.text).toBeNull();
    const results = parsed.filter((message) => message.type === 'viewPropertyResult');
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });

  it('skips a viewPropertyResult on a link below v8', () => {
    const line = '{"type":"viewPropertyResult","requestId":1,"ok":true,"liveEdits":0}';
    expect(parseDeviceMessage(line, DEVICE_PROTOCOL_V6)).toMatchObject({
      ok: false,
      unnegotiated: { type: 'viewPropertyResult', since: DEVICE_PROTOCOL_V8 },
    });
    expect(parseDeviceMessage(line, DEVICE_PROTOCOL_V8).ok).toBe(true);
  });

  it('drops an invalid result or view state as a skippable answer', () => {
    const result = (fields: Record<string, unknown>) =>
      parseDeviceMessage(
        JSON.stringify({ type: 'viewPropertyResult', requestId: 1, ok: false, liveEdits: 0, ...fields }),
      );
    expect(result({ error: 'stale' }).ok).toBe(true);
    expect(result({ error: 'nope' })).toMatchObject({ ok: false, invalidDiagnostic: 'viewPropertyResult' });
    expect(result({ liveEdits: MAX_LIVE_EDITS + 1 })).toMatchObject({
      invalidDiagnostic: 'viewPropertyResult',
    });
    const golden = GOLDEN.find((line) => line.includes('"requestId":10,"seq":0')) ?? '';
    const message = JSON.parse(golden) as { nodes: InspectorNode[] };
    const withView = (view: Record<string, unknown>) =>
      parseDeviceMessage(
        JSON.stringify({
          ...message,
          nodes: [{ ...message.nodes[0], view: { ...message.nodes[0]?.view, ...view } }],
        }),
      );
    expect(withView({}).ok).toBe(true);
    for (const bad of [
      { key: 0 },
      { backgroundColor: '#fafafa' },
      { textSize: -1 },
      { edited: ['paddingStart'] },
    ]) {
      expect(withView(bad)).toMatchObject({ ok: false, invalidDiagnostic: 'inspectNodes' });
    }
  });
});

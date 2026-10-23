import type { InspectorNode, InspectorSnapshot, PixelRect, ViewState } from '@lionscope/protocol/wire';

export function node(
  id: number,
  parent: number | null,
  bounds: PixelRect,
  overrides: Partial<InspectorNode> = {},
): InspectorNode {
  return {
    id,
    parent,
    window: 0,
    className: 'android.view.View',
    resourceId: null,
    text: null,
    contentDescription: null,
    bounds,
    visibleBounds: bounds,
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
    ...overrides,
  };
}

/**
 * Window 0 (activity): DecorView > LinearLayout#content > [Button#btn_checkout, TextView#price (paints over the
 * button), View (invisible) > ImageView]. Window 1 (dialog, above): DecorView > Button#btn_ok.
 */
export function inspectorSnapshot(overrides: Partial<InspectorSnapshot> = {}): InspectorSnapshot {
  const screen: PixelRect = [0, 0, 1080, 2400];
  const nodes: InspectorNode[] = [
    node(0, null, screen, { className: 'com.android.internal.policy.DecorView' }),
    node(1, 0, screen, { className: 'android.widget.LinearLayout', resourceId: 'content' }),
    node(2, 1, [100, 200, 500, 300], {
      className: 'com.google.android.material.button.MaterialButton',
      resourceId: 'btn_checkout',
      text: 'Checkout',
      clickable: true,
      padding: [8, 4, 8, 4],
      margin: [16, 0, 16, 0],
      source: { layout: 'fragment_cart', line: 33 },
      fragment: 'com.example.shop.CartFragment',
      activity: 'com.example.shop.MainActivity',
    }),
    node(3, 1, [100, 200, 500, 300], {
      className: 'android.widget.TextView',
      resourceId: 'com.example.shop:id/price',
      text: '$12.00',
    }),
    node(4, 1, [0, 1000, 1080, 1200], { visibility: 'invisible' }),
    node(5, 4, [0, 1000, 540, 1100], { className: 'android.widget.ImageView' }),
    node(6, null, [200, 800, 880, 1400], { window: 1, className: 'com.android.internal.policy.DecorView' }),
    node(7, 6, [300, 1200, 500, 1300], {
      window: 1,
      className: 'android.widget.Button',
      resourceId: 'btn_ok',
      text: 'OK',
    }),
  ];
  return {
    id: 'snap-1',
    ts: 1_700_000_000_000,
    serial: 'emulator-5554',
    packageName: 'com.example.shop',
    source: 'sdk',
    screen: 'CartFragment',
    display: { width: 1080, height: 2400, rotation: 0 },
    windows: [
      { id: 0, type: 1, bounds: screen },
      { id: 1, type: 2, bounds: [200, 800, 880, 1400] },
    ],
    nodes,
    truncated: false,
    captureMs: 4.2,
    fallbackReason: null,
    ...overrides,
  };
}

export function viewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    key: 100,
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

/**
 * `inspectorSnapshot()` from an SDK 0.8.0 app: every View carries its editable state (key 100 + id). The button and
 * the price are TextViews; the button has a solid background.
 */
export function editableSnapshot(
  overrides: Partial<InspectorSnapshot> = {},
  views: Partial<Record<number, Partial<ViewState>>> = {},
): InspectorSnapshot {
  const text: Partial<Record<number, Partial<ViewState>>> = {
    2: { textSize: 14, textColor: '#DE000000', backgroundColor: '#FF6200EE', elevation: 2 },
    3: { textSize: 16, textColor: '#FF202124' },
    7: { textSize: 14, textColor: '#FF202124' },
  };
  const base = inspectorSnapshot();
  return {
    ...base,
    nodes: base.nodes.map((n) => ({
      ...n,
      view: viewState({ key: 100 + n.id, ...text[n.id], ...views[n.id] }),
    })),
    liveEdits: 0,
    ...overrides,
  };
}

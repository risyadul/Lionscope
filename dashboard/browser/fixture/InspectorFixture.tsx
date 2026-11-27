import { useMemo, useState } from 'react';
import type { InspectorNode, InspectorSnapshot, RecompositionTrackingState } from '@lionscope/protocol/wire';
import { InspectorContext } from '../../src/components/inspector/InspectorContext.tsx';
import { InspectorPanel } from '../../src/components/inspector/InspectorPanel.tsx';
import type { InspectorController } from '../../src/hooks/useInspector.ts';
import type { ViewEdits } from '../../src/hooks/useViewEdits.ts';
import { buildIndex } from '../../src/lib/inspector.ts';
import { createSignal } from '../../src/lib/signal.ts';

function composeNode(
  id: number,
  parent: number | null,
  className: string,
  bounds: [number, number, number, number],
  overrides: Partial<InspectorNode> = {},
): InspectorNode {
  return {
    id,
    parent,
    window: 0,
    className,
    resourceId: null,
    text: null,
    contentDescription: null,
    bounds,
    visibleBounds: bounds,
    visibility: 'visible',
    alpha: null,
    enabled: true,
    clickable: false,
    focused: false,
    selected: false,
    checked: null,
    padding: null,
    margin: null,
    layoutWidth: null,
    layoutHeight: null,
    source: null,
    fragment: null,
    activity: 'com.synthetic.shop.ComposeShopActivity',
    ...overrides,
  };
}

function buildSnapshot(
  tracking: RecompositionTrackingState | undefined,
  counts: { card: [number, number]; badge: [number, number]; footer: [number, number] },
  recompositionTruncated = false,
  recompositionIncomplete = false,
): InspectorSnapshot {
  const withCounts = tracking === 'active';
  const nodes: InspectorNode[] = [
    composeNode(0, null, 'com.android.internal.policy.DecorView', [0, 0, 1080, 2400], {
      alpha: 1,
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
      layoutWidth: 'match_parent',
      layoutHeight: 'match_parent',
    }),
    composeNode(1, 0, 'androidx.compose.ui.platform.AndroidComposeView', [0, 0, 1080, 2400], {
      alpha: 1,
      composition: 'read',
    }),
    composeNode(2, 1, 'CatalogScreen', [0, 0, 1080, 2400], {
      destination: 'catalog',
      composable: {
        file: 'ComposeShopScreens.kt',
        line: 38,
        ...(withCounts ? { recompositions: 1, skips: 4 } : {}),
      },
    }),
    composeNode(3, 2, 'ProductCard', [32, 160, 1048, 420], {
      resourceId: 'product_1',
      text: 'Trail Running Pack',
      clickable: true,
      composable: {
        file: 'ComposeShopScreens.kt',
        line: 74,
        ...(withCounts ? { recompositions: counts.card[0], skips: counts.card[1] } : {}),
      },
    }),
    composeNode(4, 3, 'Row', [48, 180, 1020, 390], {
      composable: { file: 'ComposeShopScreens.kt', line: 82 },
    }),
    composeNode(5, 4, 'PriceBadge', [780, 210, 1000, 280], {
      text: '$129.00',
      composable: {
        file: 'ComposeShopScreens.kt',
        line: 96,
        ...(withCounts ? { recompositions: counts.badge[0], skips: counts.badge[1] } : {}),
      },
    }),
    composeNode(6, 2, 'CatalogFooter', [0, 2200, 1080, 2400], {
      text: 'Synthetic catalog',
      composable: {
        file: 'ComposeShopScreens.kt',
        line: 120,
        ...(withCounts && !recompositionTruncated && !recompositionIncomplete
          ? { recompositions: counts.footer[0], skips: counts.footer[1] }
          : {}),
      },
    }),
  ];
  return {
    id: `snap-${tracking ?? 'legacy'}-${recompositionTruncated ? 'cap-' : ''}${recompositionIncomplete ? 'inc-' : ''}${counts.card[0]}`,
    ts: 1_700_000_000_000,
    serial: 'emulator-5554',
    packageName: 'com.synthetic.shop',
    source: 'sdk',
    screen: 'CatalogScreen',
    display: { width: 1080, height: 2400, rotation: 0 },
    windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
    nodes,
    truncated: false,
    captureMs: 3.4,
    fallbackReason: null,
    ...(tracking === undefined ? {} : { recompositionTracking: tracking }),
    ...(recompositionTruncated ? { recompositionTruncated: true } : {}),
    ...(recompositionIncomplete ? { recompositionIncomplete: true } : {}),
  };
}

const NOOP_EDITS: ViewEdits = {
  canEdit: false,
  liveEdits: 0,
  notice: null,
  status: () => ({ kind: 'idle' }),
  edit: () => 'refused',
  revert: () => {},
  reject: () => {},
  dismiss: () => {},
  clearNotice: () => {},
};

export function InspectorFixture({ state }: { state: string | null }) {
  const initialTracking: RecompositionTrackingState | undefined =
    state === 'legacy'
      ? undefined
      : state === 'unsupported'
        ? 'unsupported'
        : state === 'conflict'
          ? 'conflict'
          : state === 'off'
            ? 'off'
            : 'active';
  const [tracking, setTracking] = useState<RecompositionTrackingState | undefined>(initialTracking);
  const [truncated, setTruncated] = useState(state === 'truncated');
  const [incomplete, setIncomplete] = useState(state === 'incomplete');
  const [counts, setCounts] = useState<{
    card: [number, number];
    badge: [number, number];
    footer: [number, number];
  }>({
    card: [14, 1],
    badge: [3, 2],
    footer: [0, 0],
  });
  const [selectedId, setSelectedId] = useState<number | null>(
    state === 'truncated' || state === 'incomplete' ? 6 : 3,
  );
  const [hoverId] = useState(() => createSignal<number | null>(null));

  const snapshot = useMemo(
    () => buildSnapshot(tracking, counts, truncated, incomplete),
    [tracking, counts, truncated, incomplete],
  );
  const index = useMemo(() => buildIndex(snapshot), [snapshot]);

  const controller = useMemo<InspectorController>(
    () => ({
      isActive: true,
      isCapturing: false,
      isStale: false,
      failure: null,
      canInspect: true,
      snapshot,
      index,
      selectedId,
      selectionOrigin: selectedId === null ? null : 'user',
      hoverId,
      edits: NOOP_EDITS,
      toggle: () => {},
      exit: () => {},
      refresh: () => {},
      setRecompositionTracking: (enabled) => {
        setTracking(enabled ? 'active' : 'off');
      },
      resetRecompositions: () => {
        setTruncated(false);
        setIncomplete(false);
        setCounts({ card: [0, 0], badge: [0, 0], footer: [0, 0] });
      },
      select: (id) => setSelectedId(id),
      hover: (id) => hoverId.set(id),
    }),
    [snapshot, index, selectedId, hoverId],
  );

  return (
    <main className="fixture-inspector">
      <h1>Synthetic Compose Layout Inspector</h1>
      <InspectorContext.Provider value={controller}>
        <InspectorPanel />
      </InspectorContext.Provider>
    </main>
  );
}

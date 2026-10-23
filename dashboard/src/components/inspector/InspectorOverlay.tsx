import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { InspectorNode, InspectorSnapshot } from '@lionscope/protocol/wire';
import type { InspectorController } from '../../hooks/useInspector.ts';
import {
  growRect,
  hasArea,
  hitTest,
  isZeroRect,
  nodeLabel,
  percentBox,
  rectSize,
  ringClip,
  shrinkRect,
} from '../../lib/inspector.ts';
import { useHoverId } from './InspectorContext.tsx';
import './inspector.css';

type Display = InspectorSnapshot['display'];

/** The label hugs the box's top-left; near the top it drops inside, near the right edge it aligns right. */
function labelPlacement(node: InspectorNode, display: Display) {
  const rect = node.visibleBounds ?? node.bounds;
  return {
    flip: rect[1] / display.height < 0.05,
    end: rect[0] / display.width > 0.55,
  };
}

function Box({
  node,
  display,
  kind,
  origin,
}: {
  node: InspectorNode;
  display: Display;
  kind: 'hover' | 'selected';
  origin?: 'user' | 'agent';
}) {
  const rect = node.visibleBounds ?? node.bounds;
  return (
    <div className="inspect-box" data-kind={kind} data-origin={origin} style={percentBox(rect, display)} />
  );
}

/** Padding and margin of the selection, as tinted rings around and inside its bounds. */
function BoxModel({ node, display }: { node: InspectorNode; display: Display }) {
  const rings: CSSProperties[] = [];
  const kinds: string[] = [];
  if (!isZeroRect(node.margin) && node.margin !== null) {
    const outer = growRect(node.bounds, node.margin);
    rings.push({ ...percentBox(outer, display), clipPath: ringClip(outer, node.bounds) });
    kinds.push('margin');
  }
  if (!isZeroRect(node.padding) && node.padding !== null) {
    const inner = shrinkRect(node.bounds, node.padding);
    rings.push({ ...percentBox(node.bounds, display), clipPath: ringClip(node.bounds, inner) });
    kinds.push('padding');
  }
  return (
    <>
      {rings.map((style, i) => (
        <div key={kinds[i]} className="inspect-ring" data-kind={kinds[i]} style={style} />
      ))}
    </>
  );
}

type Props = {
  controller: InspectorController;
  snapshot: InspectorSnapshot;
  label: string;
};

/** The frozen screenshot with the hover highlight, the selection and its box model. Hit-testing is in device px. */
export function InspectorOverlay({ controller, snapshot, label }: Props) {
  const { index, selectedId, selectionOrigin, isStale } = controller;
  const hoverId = useHoverId(controller);
  const { display } = snapshot;
  const ref = useRef<HTMLDivElement>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);

  // Focus lands on the frozen screen, so Esc exits without a click first.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  if (index === null) return null;

  const hitAt = (event: MouseEvent<HTMLDivElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * display.width;
    const y = ((event.clientY - rect.top) / rect.height) * display.height;
    return hitTest(snapshot, index, x, y);
  };

  const hovered = hoverId === null ? undefined : index.byId.get(hoverId);
  const selected = selectedId === null ? undefined : index.byId.get(selectedId);
  const labelled = hovered ?? selected;
  const placement = labelled === undefined ? null : labelPlacement(labelled, display);
  const labelRect = labelled === undefined ? null : (labelled.visibleBounds ?? labelled.bounds);

  return (
    <div
      ref={ref}
      className="inspect-overlay"
      data-stale={isStale || undefined}
      role="application"
      aria-roledescription="frozen device screen"
      aria-label={`${label} screen, frozen. Pick a view here, or from the hierarchy in the Inspector tab.`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        controller.exit();
      }}
      onPointerMove={(event) => controller.hover(isStale ? null : hitAt(event))}
      onPointerLeave={() => controller.hover(null)}
      onClick={(event) => {
        if (!isStale) controller.select(hitAt(event));
      }}
    >
      <img
        className="inspect-shot"
        src={`/inspector/${encodeURIComponent(snapshot.id)}.png`}
        alt=""
        draggable={false}
        onError={() => setFailedImage(snapshot.id)}
      />
      {failedImage === snapshot.id && (
        <div className="device-glass-status" data-tone="failed" role="status">
          <span>The screenshot is no longer available.</span>
          <button type="button" className="btn device-retry" onClick={controller.refresh}>
            Capture again
          </button>
        </div>
      )}
      {selected !== undefined && <BoxModel node={selected} display={display} />}
      {hovered !== undefined && hovered.id !== selectedId && hasArea(hovered.visibleBounds) && (
        <Box node={hovered} display={display} kind="hover" />
      )}
      {selected !== undefined && hasArea(selected.visibleBounds) && (
        <Box node={selected} display={display} kind="selected" origin={selectionOrigin ?? undefined} />
      )}
      {labelled !== undefined && labelRect !== null && placement !== null && (
        <div
          className="inspect-tag"
          data-flip={placement.flip || undefined}
          data-end={placement.end || undefined}
          style={{
            left: placement.end
              ? `${(labelRect[2] / display.width) * 100}%`
              : `${(labelRect[0] / display.width) * 100}%`,
            top: `${(labelRect[1] / display.height) * 100}%`,
          }}
        >
          {labelled === selected && hovered === undefined && selectionOrigin === 'agent' && (
            <span className="inspect-tag-ai" title="An AI agent pointed at this view">
              AI
            </span>
          )}
          <span className="inspect-tag-name">{nodeLabel(labelled)}</span>
          <span className="inspect-tag-size mono">
            {rectSize(labelled.bounds).width} × {rectSize(labelled.bounds).height}
          </span>
        </div>
      )}
      {controller.isCapturing && <div className="inspect-scan" aria-hidden="true" />}
      {isStale && (
        <div className="inspect-stale" role="status">
          <span>{controller.isCapturing ? 'Refreshing…' : 'Out of date'}</span>
          {!controller.isCapturing && (
            <button type="button" className="btn device-retry" onClick={controller.refresh}>
              Capture again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

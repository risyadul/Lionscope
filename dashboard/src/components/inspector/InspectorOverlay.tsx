import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { InspectorNode, InspectorSnapshot } from '@lionscope/protocol/wire';
import type { InspectorController } from '../../hooks/useInspector.ts';
import { useSignal } from '../../hooks/useSignal.ts';
import { canSampleScreen, eyedropper, pixelArgb } from '../../lib/colorPicker.ts';
import {
  growRect,
  hasArea,
  hitStack,
  hitTest,
  isZeroRect,
  nodeLabel,
  percentBox,
  pickFrom,
  rectSize,
  ringClip,
  shrinkRect,
} from '../../lib/inspector.ts';
import { useHoverId } from './InspectorContext.tsx';
import './inspector.css';

type Display = InspectorSnapshot['display'];

/** Clicks this close (device px) to the last one are "the same spot": they step to the view below. */
const SAME_SPOT_PX = 12;

/** The eyedropper's readout: where the pointer is (percent of the screen) and the pixel under it. */
interface Loupe {
  left: number;
  top: number;
  argb: string;
}

/** The screenshot drawn once into a canvas, so the eyedropper reads its pixels. */
interface Sampler {
  snapshotId: string;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
}

/** The last click on the frozen screen: where, on which snapshot, and every view that was under it. */
interface LastPick {
  snapshotId: string;
  x: number;
  y: number;
  stack: readonly number[];
}

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
  const shotPath = `/inspector/${encodeURIComponent(snapshot.id)}.png`;
  const ref = useRef<HTMLDivElement>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [lastPick, setLastPick] = useState<LastPick | null>(null);
  const shot = useRef<HTMLImageElement>(null);
  const sampler = useRef<Sampler | null>(null);
  const picking = useSignal(eyedropper);
  const [loupe, setLoupe] = useState<Loupe | null>(null);

  // Focus lands on the frozen screen, so Esc exits without a click first.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // While the eyedropper waits, Escape anywhere gives it up first (before the page's Escape leaves inspect mode).
  useEffect(() => {
    if (picking === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // This Escape only gives up the pick: no field below loses its draft, no search box is cleared.
      event.preventDefault();
      event.stopPropagation();
      picking.onCancel();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [picking]);

  // Without the frozen screen there is nothing to pick from: a waiting eyedropper gives up.
  useEffect(
    () => () => {
      canSampleScreen.set(false);
      eyedropper.get()?.onCancel();
    },
    [],
  );

  if (index === null) return null;

  const pointAt = (event: MouseEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * display.width,
      y: ((event.clientY - rect.top) / rect.height) * display.height,
    };
  };

  const hitAt = (event: MouseEvent<HTMLDivElement>): number | null => {
    const point = pointAt(event);
    return point === null ? null : hitTest(snapshot, index, point.x, point.y);
  };

  // A click picks the top-most view under it that shows something; clicking the same spot again steps down
  // through the views stacked there (overlays, the cards beneath, their containers), wrapping around.
  const pickAt = (event: MouseEvent<HTMLDivElement>): number | null => {
    const point = pointAt(event);
    if (point === null) return null;
    const stack = hitStack(snapshot, index, point.x, point.y);
    const isSameSpot =
      lastPick !== null &&
      lastPick.snapshotId === snapshot.id &&
      Math.abs(lastPick.x - point.x) <= SAME_SPOT_PX &&
      Math.abs(lastPick.y - point.y) <= SAME_SPOT_PX;
    const at = isSameSpot && selectedId !== null ? stack.indexOf(selectedId) : -1;
    setLastPick({ snapshotId: snapshot.id, x: point.x, y: point.y, stack });
    return at === -1 ? pickFrom(index, stack) : (stack[(at + 1) % stack.length] ?? null);
  };

  // The pixel of the screenshot under the pointer, as `#AARRGGBB` (the screenshot is opaque).
  const sampleAt = (event: MouseEvent<HTMLDivElement>): string | null => {
    const image = shot.current;
    // Until the new screenshot has loaded, the <img> still holds the previous one: never sample that.
    if (image === null || !image.complete || image.naturalWidth === 0) return null;
    if (sampler.current?.snapshotId !== snapshot.id) {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) return null;
      context.drawImage(image, 0, 0);
      sampler.current = { snapshotId: snapshot.id, context, width: canvas.width, height: canvas.height };
    }
    const { context, width, height } = sampler.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.min(
      width - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * width)),
    );
    const y = Math.min(
      height - 1,
      Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * height)),
    );
    try {
      const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data;
      return pixelArgb(r, g, b);
    } catch {
      return null;
    }
  };

  const loupeAt = (event: MouseEvent<HTMLDivElement>) => {
    const argb = sampleAt(event);
    const rect = event.currentTarget.getBoundingClientRect();
    // Kept off the very top and bottom, where the overlay would clip it.
    setLoupe(
      argb === null || rect.width === 0
        ? null
        : {
            left: ((event.clientX - rect.left) / rect.width) * 100,
            top: Math.min(96, Math.max(4, ((event.clientY - rect.top) / rect.height) * 100)),
            argb,
          },
    );
  };

  const hovered = hoverId === null ? undefined : index.byId.get(hoverId);
  const selected = selectedId === null ? undefined : index.byId.get(selectedId);
  const labelled = hovered ?? selected;
  const placement = labelled === undefined ? null : labelPlacement(labelled, display);
  const labelRect = labelled === undefined ? null : (labelled.visibleBounds ?? labelled.bounds);
  // "2/3": the selection's place among the views stacked under the last click, while there is more than one.
  const layer =
    labelled !== undefined &&
    labelled === selected &&
    lastPick !== null &&
    lastPick.snapshotId === snapshot.id &&
    lastPick.stack.length > 1
      ? lastPick.stack.indexOf(labelled.id)
      : -1;

  return (
    <div
      ref={ref}
      className="inspect-overlay"
      data-stale={isStale || undefined}
      data-eyedropper={picking !== null || undefined}
      role="application"
      aria-roledescription="frozen device screen"
      aria-label={`${label} screen, frozen. Pick a view here, or from the hierarchy in the Inspector tab.`}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        // The eyedropper first (the document listener above took it): the next Esc leaves inspect mode.
        if (picking === null) controller.exit();
      }}
      onPointerMove={(event) => {
        if (picking !== null) loupeAt(event);
        else controller.hover(isStale ? null : hitAt(event));
      }}
      onPointerLeave={() => {
        controller.hover(null);
        setLoupe(null);
      }}
      onClick={(event) => {
        if (picking !== null) {
          const argb = isStale ? null : sampleAt(event);
          setLoupe(null);
          // An out-of-date screen takes no edits: the pick gives up rather than seem to work.
          if (argb === null) picking.onCancel();
          else picking.onPick(argb);
          return;
        }
        if (!isStale) controller.select(pickAt(event));
      }}
    >
      <img
        ref={shot}
        className="inspect-shot"
        src={shotPath}
        alt=""
        draggable={false}
        onLoad={() => {
          // The sampler holds the previous screenshot's pixels.
          sampler.current = null;
          canSampleScreen.set(true);
        }}
        onError={() => {
          setFailedImage(snapshot.id);
          canSampleScreen.set(false);
        }}
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
          {layer !== -1 && lastPick !== null && (
            <span className="inspect-tag-layer mono" title="Click the same spot again for the view below">
              {layer + 1}/{lastPick.stack.length}
            </span>
          )}
        </div>
      )}
      {picking !== null && loupe !== null && (
        <div
          className="inspect-loupe"
          data-end={loupe.left > 60 || undefined}
          style={{ left: `${loupe.left}%`, top: `${loupe.top}%` }}
          aria-hidden="true"
        >
          <span className="inspect-loupe-swatch" style={{ backgroundColor: `#${loupe.argb.slice(3)}` }} />
          <span className="mono">{loupe.argb}</span>
        </div>
      )}
      {picking !== null && (
        <div className="inspect-eyedropper-hint" role="status">
          Pick the {picking.label} · Esc cancels
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

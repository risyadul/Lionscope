/**
 * Richer gesture tools (device control):
 * - `long_press_element`: long press an element by selector or index with configurable hold duration
 * - `drag`: drag between elements and/or screenshot coordinates (`input swipe` or API 26+ `input draganddrop`),
 *   checking soft-keyboard coverage on element endpoints like `tap_element`
 * - `pinch`: two-finger pinch in/out owned by the active mirror session (physical devices via scrcpy or emulators
 *   via gRPC multi-touch)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { MirrorTouchPoint } from '../emulator/screenGateway.ts';
import {
  coordinateSpace,
  INPUT,
  optionalSerial,
  SCROLL_SETTLE_MS,
  targetSerial,
  toDevicePoints,
  withReadBack,
} from './deviceTools.ts';
import { inside, joinNotes, KEYBOARD_UNCHECKED, screenInsets } from './insets.ts';
import { defineTool, ToolError, UNTRUSTED_DESCRIPTION, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext } from './tool.ts';
import { dumpUi, invalidateUi } from './uiDump.ts';
import {
  ELEMENT_CALL_MS,
  elementView,
  listedElement,
  pointAboveKeyboard,
  relistedElement,
  requireSelector,
  selectElement,
  selectorFields,
  tapElement,
} from './uiTools.ts';
import { clickTarget, tapPoint } from './uiTree.ts';
import type { Bounds, UiElement, UiTree } from './uiTree.ts';

const DRAG_AND_DROP_MIN_API = 26;
const API_LEVEL_TIMEOUT_MS = 5000;

const pointSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
});

const elementTargetSchema = z.object({
  ...selectorFields,
  index: z.number().int().min(0).optional().describe('Index from the last get_ui_tree.'),
  nth: z.number().int().min(1).max(100).optional().describe('Which match when several do (1 = first).'),
});

type ElementTarget = z.infer<typeof elementTargetSchema>;

function clampCoord(value: number, maxExclusive: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(0, maxExclusive - 1));
}

function resolveDragElement(
  ctx: AgentContext,
  serial: string,
  tree: UiTree,
  target: ElementTarget,
  label: string,
  ime: Bounds | null,
): { point: { x: number; y: number }; element: UiElement } {
  let element: UiElement;
  if (target.index !== undefined) {
    element = relistedElement(tree, listedElement(ctx, serial, target.index));
  } else {
    requireSelector(target);
    const selected = selectElement(tree, target);
    if (Array.isArray(selected)) {
      throw new ToolError(
        `${label} matched ${selected.length} elements: pass nth (1 = first) or a more specific selector (exact, id)`,
      );
    }
    element = selected;
  }
  let point = tapPoint(element.bounds, tree.screen);
  if (!point) throw new ToolError(`${label} element is off the screen: scroll_to it first`);
  if (ime && inside(ime, point)) {
    point = pointAboveKeyboard(tree, element, ime);
    if (!point) {
      throw new ToolError(
        `The keyboard covers ${label} (the keyboard starts at y ${ime[1]}, in device pixels): nothing was dragged. Hide the keyboard with press_key back, then drag again`,
      );
    }
  }
  return { point, element: clickTarget(tree, element) };
}

export const longPressElementTool = defineTool({
  name: 'long_press_element',
  title: 'Long-press an element',
  description: `Long-presses an element found by text, id, desc, hint, or index from the last get_ui_tree, holding for durationMs (default 800 ms, range 300–5000 ms). Uses the same center-targeting, soft-keyboard safety, candidate disambiguation, and optional readBack as tap_element. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z.object({
    ...selectorFields,
    index: z.number().int().min(0).optional().describe('Index from the last get_ui_tree.'),
    nth: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Which match to long-press when several do (1 = first).'),
    durationMs: z
      .number()
      .int()
      .min(300)
      .max(5000)
      .default(800)
      .describe('How long to hold the press in ms (300–5000).'),
    readBack: z
      .boolean()
      .default(true)
      .describe('Read the screen again after the long press (default true).'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run(args, ctx) {
    const serial = targetSerial(ctx, args.serial);
    const { outcome } = await tapElement(ctx, serial, {
      ...args,
      long: true,
      longDurationMs: args.durationMs,
    });
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        serial,
        durationMs: args.durationMs,
        ...outcome,
      },
    };
  },
});

export const dragTool = defineTool({
  name: 'drag',
  title: 'Drag between points or elements',
  description: `Drags from a start point or element (\`from\` or \`fromElement\`) to an end point or element (\`to\` or \`toElement\`) over durationMs (default 600 ms). Coordinates are in screenshot pixels (like tap/swipe); element targets are resolved from one fresh UI dump with the same soft-keyboard visibility check as \`tap_element\`. Uses \`adb shell input swipe\` by default (API 23+). Set \`dragAndDrop: true\` to use \`adb shell input draganddrop\` (holds before moving, e.g. for reorderable lists; requires Android 8.0 / API 26+). Supports \`readBack: true\` for before/after screenshot comparison. Device control. ${UNTRUSTED_DESCRIPTION}`,
  access: 'device',
  input: z
    .object({
      from: pointSchema.optional().describe('Start coordinates in screenshot pixels.'),
      to: pointSchema.optional().describe('End coordinates in screenshot pixels.'),
      fromElement: elementTargetSchema.optional().describe('Start element selector or index.'),
      toElement: elementTargetSchema.optional().describe('Destination element selector or index.'),
      durationMs: z
        .number()
        .int()
        .min(100)
        .max(5000)
        .default(600)
        .describe('Drag duration in ms (100–5000).'),
      dragAndDrop: z
        .boolean()
        .default(false)
        .describe('Use `input draganddrop` (long-press then drag, Android 8.0 / API 26+ only).'),
      ...coordinateSpace,
      readBack: z.boolean().default(false).describe('Compare screenshots from before and after the drag.'),
      serial: optionalSerial,
    })
    .refine((value) => (value.from !== undefined) !== (value.fromElement !== undefined), {
      message: 'pass either from or fromElement (not both)',
    })
    .refine((value) => (value.to !== undefined) !== (value.toElement !== undefined), {
      message: 'pass either to or toElement (not both)',
    }),
  annotations: INPUT,
  async run(
    { from, to, fromElement, toElement, durationMs, dragAndDrop, width, height, readBack, serial: requested },
    ctx,
  ) {
    const serial = targetSerial(ctx, requested);
    const deadline = performance.now() + ELEMENT_CALL_MS;

    if (dragAndDrop && ctx.uiHelper) {
      const api = await ctx.uiHelper.apiLevel(serial, API_LEVEL_TIMEOUT_MS);
      if (api !== null && api < DRAG_AND_DROP_MIN_API) {
        throw new ToolError(
          `dragAndDrop (\`input draganddrop\`) requires Android 8.0 (API ${DRAG_AND_DROP_MIN_API}) or later; ${serial} is API ${api}. Use dragAndDrop: false for a standard drag.`,
        );
      }
    }

    // Validate index references up front before dumping.
    if (fromElement?.index !== undefined) listedElement(ctx, serial, fromElement.index);
    else if (fromElement) requireSelector(fromElement);
    if (toElement?.index !== undefined) listedElement(ctx, serial, toElement.index);
    else if (toElement) requireSelector(toElement);

    const hasElementEndpoint = Boolean(fromElement || toElement);
    const coordPoints: { x: number; y: number }[] = [];
    if (from) coordPoints.push(from);
    if (to) coordPoints.push(to);

    const [mappedCoords, dump, insets] = await Promise.all([
      coordPoints.length > 0 ? toDevicePoints(ctx, serial, { width, height }, coordPoints) : [],
      hasElementEndpoint ? dumpUi(ctx, serial, { deadline }) : null,
      readBack || hasElementEndpoint ? screenInsets(ctx, serial) : null,
    ]);

    const ime = insets?.ime ?? null;
    let startPoint: { x: number; y: number };
    let endPoint: { x: number; y: number };
    let startEl: UiElement | null = null;
    let endEl: UiElement | null = null;

    let coordCursor = 0;
    if (from) {
      startPoint = mappedCoords[coordCursor++]!;
    } else {
      const resolved = resolveDragElement(ctx, serial, dump!.tree, fromElement!, 'fromElement', ime);
      startPoint = resolved.point;
      startEl = resolved.element;
    }

    if (to) {
      endPoint = mappedCoords[coordCursor]!;
    } else {
      const resolved = resolveDragElement(ctx, serial, dump!.tree, toElement!, 'toElement', ime);
      endPoint = resolved.point;
      endEl = resolved.element;
    }

    const subcommand = dragAndDrop ? 'draganddrop' : 'swipe';
    const command = `${subcommand} ${startPoint.x} ${startPoint.y} ${endPoint.x} ${endPoint.y} ${durationMs}`;
    const effect: { note?: string } = await withReadBack(
      ctx,
      serial,
      readBack,
      insets,
      SCROLL_SETTLE_MS,
      command,
    );
    const note = joinNotes(effect.note, hasElementEndpoint && insets === null ? KEYBOARD_UNCHECKED : null);

    return {
      data: {
        ...(dump ? { untrusted: UNTRUSTED_NOTE } : {}),
        serial,
        method: subcommand,
        from: startPoint,
        to: endPoint,
        ...(startEl && dump ? { fromElement: elementView(dump.tree, startEl, true) } : {}),
        ...(endEl && dump ? { toElement: elementView(dump.tree, endEl, true) } : {}),
        durationMs,
        ...effect,
        ...(note ? { note } : {}),
      },
    };
  },
});

export const pinchTool = defineTool({
  name: 'pinch',
  title: 'Pinch zoom',
  description:
    'Performs a two-finger pinch gesture (`out` = zoom in / fingers spread apart; `in` = zoom out / fingers move together) through the active mirroring session (physical devices over scrcpy `injectTouch` or emulators over gRPC multi-touch). `adb shell input` does not support multi-touch, so mirroring must be running in the dashboard Device panel before calling pinch; fails clearly when mirroring is off or another multi-touch gesture is already in progress. Coordinates centerX/centerY are optional (default: screen center) in screenshot pixels. Device control.',
  access: 'device',
  input: z
    .object({
      direction: z
        .enum(['in', 'out'])
        .describe('out: spread fingers apart (zoom in); in: bring fingers together (zoom out).'),
      centerX: z
        .number()
        .min(0)
        .optional()
        .describe('Pinch center X in screenshot pixels; default: horizontal center.'),
      centerY: z
        .number()
        .min(0)
        .optional()
        .describe('Pinch center Y in screenshot pixels; default: vertical center.'),
      distance: z
        .number()
        .min(0.05)
        .max(0.9)
        .default(0.4)
        .describe('Total finger travel as a fraction of the screen short edge (0.05–0.9, default 0.4).'),
      durationMs: z
        .number()
        .int()
        .min(100)
        .max(3000)
        .default(400)
        .describe('Gesture duration in ms (100–3000).'),
      steps: z
        .number()
        .int()
        .min(2)
        .max(60)
        .default(10)
        .describe('Interpolation steps between start and end positions (2–60).'),
      ...coordinateSpace,
      serial: optionalSerial,
    })
    .refine((value) => (value.centerX === undefined) === (value.centerY === undefined), {
      message: 'pass both centerX and centerY, or omit both to use the screen center',
    }),
  annotations: INPUT,
  async run(
    { direction, centerX, centerY, distance, durationMs, steps, width, height, serial: requested },
    ctx,
  ) {
    const serial = targetSerial(ctx, requested);
    const channel = ctx.mirrorTouch?.(serial) ?? null;
    if (!channel) {
      throw new ToolError(
        `Pinch requires active mirroring on ${serial}: open the Device panel in the dashboard to start mirroring first (works on mirrored physical devices and emulators; adb shell input has no multi-touch).`,
      );
    }

    const frame = channel.frameSize;
    let cx = Math.floor(frame.width / 2);
    let cy = Math.floor(frame.height / 2);
    if (centerX !== undefined && centerY !== undefined) {
      const rawCached = ctx.screenshots.get(serial);
      const cached =
        rawCached && (!rawCached.token || ctx.diffBaselines.isCurrent(rawCached.token))
          ? rawCached
          : undefined;
      const shot = width !== undefined && height !== undefined ? { width, height } : (cached?.shot ?? null);
      if (!shot) {
        throw new ToolError(
          'Take a screenshot first (centerX/centerY are in its pixels), or pass width and height',
        );
      }
      if (centerX > shot.width || centerY > shot.height) {
        throw new ToolError(
          `(${centerX}, ${centerY}) is outside the ${shot.width}×${shot.height} screenshot`,
        );
      }
      cx = clampCoord((centerX * frame.width) / shot.width, frame.width);
      cy = clampCoord((centerY * frame.height) / shot.height, frame.height);
    }

    const handle = channel.beginMultiTouch();
    if (!handle) {
      throw new ToolError(
        `Another multi-touch gesture is already running on ${serial}: wait for it to finish`,
      );
    }

    const shortEdge = Math.min(frame.width, frame.height);
    const nearRadius = Math.max(8, Math.round(shortEdge * 0.08));
    const farRadius = Math.min(
      Math.max(nearRadius + 4, Math.floor(shortEdge * 0.48)),
      nearRadius + Math.round((shortEdge * distance) / 2),
    );
    const startRadius = direction === 'out' ? nearRadius : farRadius;
    const endRadius = direction === 'out' ? farRadius : nearRadius;

    const pointsAt = (radius: number): [MirrorTouchPoint, MirrorTouchPoint] => {
      const offset = Math.round(radius * Math.SQRT1_2);
      return [
        {
          x: clampCoord(cx - offset, frame.width) / frame.width,
          y: clampCoord(cy - offset, frame.height) / frame.height,
        },
        {
          x: clampCoord(cx + offset, frame.width) / frame.width,
          y: clampCoord(cy + offset, frame.height) / frame.height,
        },
      ];
    };

    const stepDelayMs = Math.max(1, Math.round(durationMs / steps));
    let eventsSent = 0;
    let failedAt: 'down' | 'move' | 'up' | null = null;
    let lifted: boolean;

    try {
      const [startA, startB] = pointsAt(startRadius);
      if (!handle.down(0, startA)) {
        failedAt = 'down';
      } else {
        eventsSent += 1;
        if (!handle.down(1, startB)) {
          failedAt = 'down';
        } else {
          eventsSent += 1;
          for (let step = 1; step <= steps; step++) {
            await sleep(stepDelayMs);
            const radius = startRadius + ((endRadius - startRadius) * step) / steps;
            const [pA, pB] = pointsAt(radius);
            const moved = handle.move([
              { slot: 0, point: pA },
              { slot: 1, point: pB },
            ]);
            eventsSent += moved.sent;
            if (!moved.ok) {
              failedAt = 'move';
              break;
            }
          }
        }
      }

      const upResult = handle.up();
      eventsSent += upResult.sent;
      lifted = upResult.ok;
      if (failedAt === null && !lifted) {
        failedAt = 'up';
      }
    } finally {
      handle.release();
      invalidateUi(ctx, serial);
    }

    const base = {
      serial,
      backend: handle.backend,
      direction,
      center: { x: cx, y: cy },
      frameSize: handle.frameSize,
      startRadius,
      endRadius,
      steps,
      durationMs,
      eventsSent,
      completed: failedAt === null,
      interrupted: failedAt !== null,
      lifted,
    };

    if (failedAt !== null) {
      return {
        data: {
          ...base,
          failedAt,
          error: `Pinch gesture on ${serial} was interrupted during ${failedAt}${lifted ? '' : ' (finger lift was not delivered)'}`,
        },
      };
    }

    return { data: base };
  },
});

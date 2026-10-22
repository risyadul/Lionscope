/**
 * Device control (only with --allow-device-control): one-shot screenshots and input over adb (`screencap`,
 * `input`), which works the same on emulators and physical devices, mirrored or not; emulators boot and shut
 * down through the dashboard's emulator manager. Power, sleep and lock keys are deliberately not offered.
 */
import { z } from 'zod';
import { isValidAvdName } from '@lionscope/protocol';
import { adbShell, execBinary } from '../adb/adb.ts';
import type { Size } from '../emulator/screenInput.ts';
import { displaySize, sameSize, SCREENSHOT_SHORT_EDGE } from './display.ts';
import { pngSize, scalePng } from './png.ts';
import { packageInput } from './sessionTools.ts';
import { serialInput } from './statusTools.ts';
import { defineTool, ToolError } from './tool.ts';
import type { AgentContext, ToolAnnotations } from './tool.ts';
import { invalidateUi } from './uiDump.ts';

export { SCREENSHOT_SHORT_EDGE };

const SCREENCAP_TIMEOUT_MS = 15_000;
const MAX_SCREENCAP_BYTES = 64 * 1024 * 1024;
const INPUT_TIMEOUT_MS = 10_000;
/** `am start -W` waits for the launch to finish drawing. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Sizes whose width / height ratios differ by more than this are different orientations or screens. */
const ASPECT_TOLERANCE = 0.03;

/** Keys an agent may press: navigation and editing only. */
export const AGENT_KEYCODES = {
  back: 4,
  home: 3,
  recents: 187,
  enter: 66,
  delete: 67,
  tab: 61,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  dpad_center: 23,
} as const;
type AgentKey = keyof typeof AGENT_KEYCODES;

export const INPUT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const optionalSerial = serialInput
  .optional()
  .describe('adb serial; default: the session device, or the only ready one.');

/** The device to operate: the given serial, else the session's device, else the only ready device. */
export function targetSerial(ctx: AgentContext, serial: string | undefined): string {
  const devices = ctx.sessions.getDevices();
  const ready = devices.filter((device) => device.state === 'device');
  const chosen =
    serial ?? ctx.sessions.getSessionState().serial ?? (ready.length === 1 ? ready[0]?.serial : null);
  if (!chosen) {
    throw new ToolError(
      ready.length === 0
        ? 'No device is ready'
        : `Several devices are ready (${ready.map((d) => d.serial).join(', ')}): pass serial`,
    );
  }
  const device = devices.find((candidate) => candidate.serial === chosen);
  if (!device) throw new ToolError(`Device ${chosen} is not connected`);
  if (device.state !== 'device') throw new ToolError(`Device ${chosen} is ${device.state}`);
  return chosen;
}

function screencap(ctx: AgentContext, serial: string): Promise<Buffer> {
  return execBinary(ctx.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeoutMs: SCREENCAP_TIMEOUT_MS,
    maxBytes: MAX_SCREENCAP_BYTES,
  });
}

const coordinateSpace = {
  width: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Width of the image the coordinates refer to; default: the last screenshot.'),
  height: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Height of that image; default: the last screenshot.'),
};

function aspect(size: Size): number {
  return size.width / size.height;
}

/** The display now: `wm size` and the rotation, else the last known size, else a fresh screencap. */
async function currentDisplay(ctx: AgentContext, serial: string, known: Size | undefined): Promise<Size> {
  const now = await displaySize(ctx, serial).catch(() => null);
  return now ?? known ?? pngSize(await screencap(ctx, serial));
}

/**
 * Maps points from screenshot pixels to device pixels (as `input` takes them, in the current rotation). A
 * screenshot taken before the screen rotated is refused rather than mapped onto the wrong spot.
 */
async function toDevicePoints(
  ctx: AgentContext,
  serial: string,
  space: Partial<Size>,
  points: readonly { x: number; y: number }[],
): Promise<{ x: number; y: number }[]> {
  const cached = ctx.screenshots.get(serial);
  const explicit =
    space.width !== undefined && space.height !== undefined
      ? { width: space.width, height: space.height }
      : null;
  const shot = explicit ?? cached?.shot;
  if (!shot)
    throw new ToolError('Take a screenshot first (coordinates are in its pixels), or pass width and height');
  const device = await currentDisplay(ctx, serial, cached?.device);
  if (explicit === null && cached && !sameSize(cached.device, device)) {
    ctx.screenshots.delete(serial);
    throw new ToolError(
      'The screen rotated (or changed size) since the last screenshot or get_ui_tree: take a new one',
    );
  }
  if (Math.abs(aspect(shot) / aspect(device) - 1) > ASPECT_TOLERANCE) {
    throw new ToolError(
      `A ${shot.width}×${shot.height} image does not match the screen as it is now (${device.width}×${device.height}): take a new screenshot`,
    );
  }
  return points.map(({ x, y }) => {
    if (x < 0 || y < 0 || x > shot.width || y > shot.height) {
      throw new ToolError(`(${x}, ${y}) is outside the ${shot.width}×${shot.height} screenshot`);
    }
    return {
      x: Math.min(device.width - 1, Math.round((x * device.width) / shot.width)),
      y: Math.min(device.height - 1, Math.round((y * device.height) / shot.height)),
    };
  });
}

/** `adb shell input …`; the screen may change, so the cached UI dump goes stale. */
export async function input(ctx: AgentContext, serial: string, command: string): Promise<string> {
  try {
    return await adbShell(ctx.adb, serial, `input ${command}`, { timeoutMs: INPUT_TIMEOUT_MS });
  } finally {
    invalidateUi(ctx, serial);
  }
}

export const screenshotTool = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  description: `A PNG of the device screen as shown now, scaled to at most ${SCREENSHOT_SHORT_EDGE} px on its short edge, plus its size. tap and swipe take coordinates in this image's pixels (they are mapped to the device). Device control: only available when enabled.`,
  access: 'device',
  input: z.object({ serial: optionalSerial }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const full = await screencap(ctx, serial);
    const device = pngSize(full);
    const { png, size } = scalePng(full, SCREENSHOT_SHORT_EDGE);
    ctx.screenshots.set(serial, { shot: size, device });
    return {
      data: {
        serial,
        width: size.width,
        height: size.height,
        deviceWidth: device.width,
        deviceHeight: device.height,
      },
      image: { mimeType: 'image/png', data: png },
    };
  },
});

export const tapTool = defineTool({
  name: 'tap',
  title: 'Tap',
  description:
    'Taps the screen at (x, y) in the pixels of the last screenshot (or of width × height when given). Device control.',
  access: 'device',
  input: z.object({ x: z.number().min(0), y: z.number().min(0), ...coordinateSpace, serial: optionalSerial }),
  annotations: INPUT,
  async run({ x, y, width, height, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const [point] = await toDevicePoints(ctx, serial, { width, height }, [{ x, y }]);
    if (!point) throw new ToolError('no point');
    await input(ctx, serial, `tap ${point.x} ${point.y}`);
    return { data: { serial, tapped: point } };
  },
});

export const swipeTool = defineTool({
  name: 'swipe',
  title: 'Swipe',
  description:
    'Drags from (x1, y1) to (x2, y2) over durationMs (default 300; a long duration at one point is a long press), in screenshot pixels like tap. To scroll a list down, swipe upwards. Device control.',
  access: 'device',
  input: z.object({
    x1: z.number().min(0),
    y1: z.number().min(0),
    x2: z.number().min(0),
    y2: z.number().min(0),
    durationMs: z.number().int().min(50).max(5000).default(300).describe('Gesture length in ms (50-5000).'),
    ...coordinateSpace,
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ x1, y1, x2, y2, durationMs, width, height, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const points = await toDevicePoints(ctx, serial, { width, height }, [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]);
    const [from, to] = points;
    if (!from || !to) throw new ToolError('no points');
    await input(ctx, serial, `swipe ${from.x} ${from.y} ${to.x} ${to.y} ${durationMs}`);
    return { data: { serial, from, to, durationMs } };
  },
});

export const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * `input text` argument for the device shell: single-quoted, spaces as `%s` (input's own escape). There is no
 * escape for a literal `%s`, so type_text refuses text containing it.
 */
export function inputTextArgument(text: string): string {
  return `'${text.replaceAll(' ', '%s').replaceAll("'", "'\\''")}'`;
}

export const pressKeyTool = defineTool({
  name: 'press_key',
  title: 'Press a key',
  description: `Presses a navigation or editing key: ${Object.keys(AGENT_KEYCODES).join(', ')}. (Power, sleep and lock keys are not available.) Device control.`,
  access: 'device',
  input: z.object({
    key: z.enum(Object.keys(AGENT_KEYCODES) as [AgentKey, ...AgentKey[]]),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ key, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    await input(ctx, serial, `keyevent ${AGENT_KEYCODES[key]}`);
    return { data: { serial, pressed: key } };
  },
});

const COMPONENT = /^([A-Za-z][\w.]*)\/([\w.$]+)$/;

/** The launcher activity from `cmd package resolve-activity --brief` (its last line), if it is the package's. */
export function parseResolvedActivity(output: string, packageName: string): string | null {
  const line = output.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  const match = COMPONENT.exec(line);
  return match?.[1] === packageName ? line : null;
}

export const launchAppTool = defineTool({
  name: 'launch_app',
  title: 'Launch an app',
  description:
    "Opens an app's launcher activity, like tapping its icon, and waits until it has drawn. cold: true force-stops it first (a cold start; its unsaved state is lost). Returns the activity and the launch time Android reports (TotalTime, ms). Device control.",
  access: 'device',
  input: z.object({
    packageName: packageInput,
    cold: z.boolean().default(false).describe('Force-stop the app first.'),
    serial: optionalSerial,
  }),
  annotations: INPUT,
  async run({ packageName, cold, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const options = { timeoutMs: INPUT_TIMEOUT_MS };
    const resolved = await adbShell(
      ctx.adb,
      serial,
      `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`,
      options,
    );
    const activity = parseResolvedActivity(resolved, packageName);
    if (!activity) {
      throw new ToolError(`${packageName} has no launcher activity on ${serial} (is it installed?)`);
    }
    try {
      if (cold) await adbShell(ctx.adb, serial, `am force-stop ${packageName}`, options);
      // Quoted: an activity name may contain `$`.
      const started = await adbShell(ctx.adb, serial, `am start -W -n '${activity}'`, {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      const failure = /^(?:Error|Exception)[^\n]*/m.exec(started)?.[0];
      if (failure) throw new ToolError(`Could not start ${activity}: ${failure.slice(0, 200)}`);
      const totalTime = /TotalTime:\s*(\d+)/.exec(started)?.[1];
      return {
        data: {
          serial,
          packageName,
          activity,
          cold,
          launchMs: totalTime === undefined ? null : Number(totalTime),
        },
      };
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

const avdInput = z
  .string()
  .refine(isValidAvdName, 'not an AVD name')
  .describe('AVD name from status, e.g. Pixel_9');

function emulatorView(ctx: AgentContext, avdName: string) {
  return ctx.emulators.getEmulators().find((emulator) => emulator.avdName === avdName) ?? null;
}

export const bootEmulatorTool = defineTool({
  name: 'boot_emulator',
  title: 'Boot an emulator',
  description:
    'Boots an AVD headless (host GPU), as the dashboard does; this server shuts it down again when it stops. quick loads the Quick Boot snapshot, cold boots from scratch. Returns at once: poll status until its state is running and its serial is listed as a ready device (a cold boot takes a minute or more). Device control.',
  access: 'device',
  input: z.object({ avdName: avdInput, mode: z.enum(['quick', 'cold']).default('quick') }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run({ avdName, mode }, ctx) {
    await ctx.emulators.boot(avdName, mode);
    invalidateUi(ctx);
    return { data: { emulator: emulatorView(ctx, avdName) } };
  },
});

export const shutdownEmulatorTool = defineTool({
  name: 'shutdown_emulator',
  title: 'Shut down an emulator',
  description:
    'Shuts down a running emulator (ending a profiling session on it first), saving its Quick Boot snapshot. Calling it again while it is shutting down (or once it is off) changes nothing; force: true kills one that is stuck shutting down. One this server did not boot (started from Android Studio or a terminal) needs confirm: true; ask the user before doing that. Device control.',
  access: 'device',
  input: z.object({
    avdName: avdInput,
    confirm: z.boolean().default(false).describe('Required for an emulator this server did not boot.'),
    force: z.boolean().default(false).describe('Kill an emulator that is stuck shutting down.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run({ avdName, confirm, force }, ctx) {
    const state = emulatorView(ctx, avdName)?.state;
    // A repeated request would force-kill it in the emulator manager: only `force` does that here.
    if (state === 'off' || (state === 'shutting_down' && !force)) {
      return { data: { emulator: emulatorView(ctx, avdName), changed: false } };
    }
    await ctx.emulators.shutdown(avdName, confirm);
    invalidateUi(ctx);
    return { data: { emulator: emulatorView(ctx, avdName), changed: true } };
  },
});

/**
 * Device environment tools (device control):
 * - `set_orientation`: portrait / landscape / reverse_portrait / reverse_landscape / auto
 * - `set_display_options`: dark mode (`cmd uimode night`) and font scale (`settings put system font_scale`)
 * - `restore_device_settings`: idempotent explicit restore of original orientation and display options
 * Original values are recorded before the first change and restored automatically on `stop_session` and server close.
 */
import { z } from 'zod';
import { optionalSerial, targetSerial } from './deviceTools.ts';
import { defineTool, ToolError } from './tool.ts';
import { invalidateUi } from './uiDump.ts';

const ENV_MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const setOrientationTool = defineTool({
  name: 'set_orientation',
  title: 'Set screen orientation',
  description:
    'Changes the device screen orientation (`portrait`, `landscape`, `reverse_portrait`, `reverse_landscape`, or `auto`) via `settings put system accelerometer_rotation` and `user_rotation` (works on Android 6.0 / API 23+). Records the original values before the first change on the device and restores them automatically on `stop_session` or server close, or anytime via `restore_device_settings`. Pair with `get_activity_instance` and `get_saved_state` to verify configuration changes. Invalidates cached screenshots because screen dimensions change. Device control.',
  access: 'device',
  input: z.object({
    orientation: z
      .enum(['portrait', 'landscape', 'reverse_portrait', 'reverse_landscape', 'auto'])
      .describe('Target orientation; auto re-enables accelerometer rotation.'),
    serial: optionalSerial,
  }),
  annotations: ENV_MUTATION,
  async run({ orientation, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    try {
      const outcome = await ctx.deviceSettings.setOrientation(serial, orientation);
      return {
        data: {
          serial,
          ...outcome,
          trackedSettings: ctx.deviceSettings.tracked(serial),
          note: 'Original settings are recorded and restored automatically on stop_session or via restore_device_settings.',
        },
      };
    } finally {
      invalidateUi(ctx, serial);
      ctx.screenshots.delete(serial);
    }
  },
});

export const setDisplayOptionsTool = defineTool({
  name: 'set_display_options',
  title: 'Set display options',
  description:
    'Changes device display and accessibility options: `darkMode` (`dark` / `light` / `auto` via `cmd uimode night`, where supported by the device) and/or `fontScale` (0.5 to 3.0 via `settings put system font_scale`, API 23+). Records original values before the first change and restores them automatically on `stop_session` or server close, or anytime via `restore_device_settings`. Returns a clear error if `cmd uimode night` is unsupported or rejected on the device. Device control.',
  access: 'device',
  input: z
    .object({
      darkMode: z
        .enum(['dark', 'light', 'auto'])
        .optional()
        .describe(
          'System night mode: dark (yes), light (no), or auto (requires `cmd uimode night` support).',
        ),
      fontScale: z
        .number()
        .finite()
        .min(0.5)
        .max(3.0)
        .optional()
        .describe('System font scale multiplier, e.g. 1.0 (default), 1.3 (large), 2.0 (largest).'),
      serial: optionalSerial,
    })
    .refine((value) => value.darkMode !== undefined || value.fontScale !== undefined, {
      message: 'pass darkMode and/or fontScale',
    }),
  annotations: ENV_MUTATION,
  async run({ darkMode, fontScale, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    try {
      const outcome = await ctx.deviceSettings.setDisplayOptions(serial, { darkMode, fontScale });
      return {
        data: {
          serial,
          ...outcome,
          trackedSettings: ctx.deviceSettings.tracked(serial),
          note: 'Original settings are recorded and restored automatically on stop_session or via restore_device_settings.',
        },
      };
    } finally {
      invalidateUi(ctx, serial);
    }
  },
});

export const restoreDeviceSettingsTool = defineTool({
  name: 'restore_device_settings',
  title: 'Restore device settings',
  description:
    'Restores original orientation, dark mode, and font scale values that Lionscope recorded before `set_orientation` or `set_display_options` changed them. Idempotent: returns `restored: false` with an empty `settings` list if Lionscope made no changes or already restored them. Device control.',
  access: 'device',
  input: z.object({ serial: optionalSerial }),
  annotations: ENV_MUTATION,
  async run({ serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const hadOrientation = ctx.deviceSettings.tracked(serial).includes('orientation');
    const result = await ctx.deviceSettings.restore(serial);
    if (result.restored) {
      invalidateUi(ctx, serial);
      if (hadOrientation) ctx.screenshots.delete(serial);
    }
    if (result.errors.length > 0) {
      const details: string[] = [];
      if (result.settings.length > 0) details.push(`restored: ${result.settings.join(', ')}`);
      if (result.outstanding.length > 0) details.push(`outstanding: ${result.outstanding.join(', ')}`);
      throw new ToolError(
        `Could not restore some device settings on ${serial}: ${result.errors.join('; ')}` +
          (details.length > 0 ? ` (${details.join('; ')})` : ''),
      );
    }
    return {
      data: {
        serial,
        restored: result.restored,
        settings: result.settings,
        outstanding: result.outstanding,
        ...(result.note ? { note: result.note } : {}),
      },
    };
  },
});

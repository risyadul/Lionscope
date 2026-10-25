/**
 * `get_location`, `set_location`, `clear_location`: the dashboard's Location panel. Emulators get the point as their
 * GPS fix; physical devices (Android 12+) get it from mock location providers, so setting one needs device control.
 * A physical device's real location is never read.
 */
import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@lionscope/protocol';
import type { DeviceLocation } from '@lionscope/protocol';
import { isEmulatorSerial } from '../emulator/screenGateway.ts';
import { optionalSerial, targetSerial } from './deviceTools.ts';
import { defineTool, READ_ONLY, ToolError } from './tool.ts';
import type { AgentContext, AgentLocations } from './tool.ts';
import { iso } from './views.ts';

function locationsOf(ctx: AgentContext): AgentLocations {
  if (!ctx.locations) throw new ToolError('This server cannot change device locations');
  return ctx.locations;
}

function locationView(location: DeviceLocation | null) {
  if (!location) return null;
  const { latitude, longitude, method, since, warning } = location;
  return { latitude, longitude, method, since: iso(since), warning };
}

export const getLocationTool = defineTool({
  name: 'get_location',
  title: 'Device location',
  description:
    "The location Lionscope put on a device (set_location or the dashboard's Location panel), or null, and for an emulator also its current GPS fix. method 'emulator' is the emulator's own GPS (apps see a real fix); 'mock_provider' is a physical device's mock location (apps see Location.isMock() true). A physical device's real location is never read.",
  access: 'read',
  input: z.object({ serial: optionalSerial }),
  annotations: READ_ONLY,
  async run({ serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const locations = locationsOf(ctx);
    const emulatorGps = isEmulatorSerial(serial)
      ? await locations.readEmulatorGps(serial).catch(() => null)
      : null;
    return { data: { serial, set: locationView(locations.getLocation(serial)), emulatorGps } };
  },
});

export const setLocationTool = defineTool({
  name: 'set_location',
  title: 'Set the device location',
  description:
    "Puts the device at latitude, longitude (WGS 84 degrees) until clear_location, like the Android Studio emulator's Location controls; shown in the dashboard. Emulators: their GPS fix moves. Physical devices (Android 12+): mock location providers replace gps, network and fused (refreshed every second), so apps that refuse mock locations ignore it; the real location comes back with clear_location or when Lionscope stops. warning says when apps will not see it (e.g. the device's location switch is off). Tell the user, and clear it when you are done. Device control.",
  access: 'device',
  input: z.object({
    latitude: latitudeSchema.describe('Degrees north, -90..90 (e.g. -6.2088).'),
    longitude: longitudeSchema.describe('Degrees east, -180..180 (e.g. 106.8456).'),
    serial: optionalSerial,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ latitude, longitude, serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    const location = await locationsOf(ctx).setLocation(serial, { latitude, longitude });
    return { data: { serial, location: locationView(location) } };
  },
});

export const clearLocationTool = defineTool({
  name: 'clear_location',
  title: 'Reset the device location',
  description:
    'Undoes set_location: a physical device gets its real location back (the mock providers are removed), an emulator the GPS fix it had before. cleared is false when Lionscope had not set a location there. Device control.',
  access: 'device',
  input: z.object({ serial: optionalSerial }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run({ serial: requested }, ctx) {
    const serial = targetSerial(ctx, requested);
    return { data: { serial, cleared: await locationsOf(ctx).clearLocation(serial) } };
  },
});

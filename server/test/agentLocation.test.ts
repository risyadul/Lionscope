import { describe, expect, it } from 'vitest';
import { mcpInstructions } from '../src/agent/mcpServer.ts';
import { availableTools, callTool, DEVICE_CONTROL_DISABLED } from '../src/agent/registry.ts';
import { LocationService } from '../src/location/locationService.ts';
import { FakeEmulatorClient } from './helpers/fakeEmulatorClient.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';

function setup() {
  const agent = fakeAgent();
  const emulator = new FakeEmulatorClient();
  const locations = new LocationService({
    adb: agent.adb,
    emulatorClient: () => emulator,
    broadcast: () => undefined,
    now: () => Date.UTC(2026, 9, 26, 8, 0, 0),
  });
  agent.ctx = { ...agent.ctx, locations };
  return { agent, emulator, locations };
}

async function run(ctx: ReturnType<typeof setup>['agent']['ctx'], name: string, args: object, device = true) {
  const outcome = await callTool(ctx, name, args, device);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.result as Json;
}

describe('location tools', () => {
  it('reads with get_location always, sets and clears with device control only', async () => {
    const names = (on: boolean) => availableTools(on).map((tool) => tool.name);
    expect(names(false)).toContain('get_location');
    expect(names(false)).not.toContain('set_location');
    expect(names(true)).toEqual(expect.arrayContaining(['set_location', 'clear_location']));
    expect(mcpInstructions(true)).toContain('clear_location');

    const { agent } = setup();
    expect(await callTool(agent.ctx, 'set_location', { latitude: 1, longitude: 2 }, false)).toEqual({
      ok: false,
      code: 'forbidden',
      error: DEVICE_CONTROL_DISABLED,
    });
  });

  it('moves the session emulator and puts it back', async () => {
    const { agent, emulator } = setup();
    expect(await run(agent.ctx, 'get_location', {}, false)).toEqual({
      serial: 'emulator-5554',
      set: null,
      emulatorGps: { latitude: 37.422, longitude: -122.084 },
    });
    expect(await run(agent.ctx, 'set_location', { latitude: -6.2088, longitude: 106.8456 })).toEqual({
      serial: 'emulator-5554',
      location: {
        latitude: -6.2088,
        longitude: 106.8456,
        method: 'emulator',
        since: '2026-10-26T08:00:00.000Z',
        warning: null,
      },
    });
    expect(emulator.gps).toEqual({ latitude: -6.2088, longitude: 106.8456 });
    expect((await run(agent.ctx, 'get_location', {}, false)).set.latitude).toBe(-6.2088);
    expect(await run(agent.ctx, 'clear_location', {})).toEqual({ serial: 'emulator-5554', cleared: true });
    expect(emulator.gps).toEqual({ latitude: 37.422, longitude: -122.084 });
  });

  it('refuses coordinates out of range and devices that are not ready', async () => {
    const { agent } = setup();
    expect(await callTool(agent.ctx, 'set_location', { latitude: 95, longitude: 0 }, true)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    expect(
      await callTool(agent.ctx, 'set_location', { latitude: 0, longitude: 0, serial: 'R58M123ABC' }, true),
    ).toMatchObject({ ok: false, error: 'Device R58M123ABC is unauthorized' });
  });
});

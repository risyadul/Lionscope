import { readFileSync } from 'node:fs';
import type { DeviceMessage, ServerMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceGateway } from '../src/device/deviceGateway.ts';
import { droppedFramesMessage } from '../src/device/sdkBridge.ts';
import type { DeviceGateway } from '../src/device/deviceGateway.ts';
import { SessionManager } from '../src/session/sessionManager.ts';
import { DeviceClient } from './helpers/deviceClient.ts';
import { FakeAdb, FakeDevice, fixture } from './helpers/fakes.ts';

const GOLDEN = readFileSync(
  new URL('../../protocol/fixtures/device-messages.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '');
const HELLO = JSON.parse(GOLDEN[0] ?? '{}') as Extract<DeviceMessage, { type: 'hello' }>;
/** The device clock runs 5 s behind the laptop. */
const OFFSET_MS = 5000;
/** Device wall clock when the test starts: just after the fixture's last screen change. */
const DEVICE_START_MS = HELLO.deviceWallMs + 3000;
const laptop = (deviceMs: number) => deviceMs + OFFSET_MS;

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('golden device messages through the gateway', () => {
  let manager: SessionManager | null = null;
  let gateway: DeviceGateway | null = null;

  afterEach(async () => {
    await manager?.close();
    await gateway?.close();
  });

  it('produces screen spans, SDK frame samples and a breakdown', async () => {
    // A step clock: frozen while the session starts (so the measured offset is exactly OFFSET_MS), then
    // moved to just after the fixture's last screen change.
    let clock = laptop(HELLO.deviceWallMs - 1000);
    const now = () => clock;
    const device = new FakeDevice();
    device.pid = HELLO.pid; // the hello's PID is the app's process on the session device
    const adb = new FakeAdb(
      (args) => (args[0] === 'devices' ? fixture('adb-devices.txt') : ''),
      (command) => {
        if (command === 'date +%s%3N') return `${clock - OFFSET_MS}\n`;
        // No gfxinfo frames: only the SDK feeds the frames stream here.
        if (command.includes('gfxinfo')) return `${device.uptimeLine}No process found for: ${HELLO.pid}\n`;
        return device.handle(command);
      },
    );
    const messages: ServerMessage[] = [];
    const ofType = <T extends ServerMessage['type']>(type: T) =>
      messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
    manager = new SessionManager({
      adb,
      broadcast: (message) => messages.push(message),
      now,
      deviceGatewayPort: () => gateway?.address?.port ?? null,
    });
    gateway = createDeviceGateway({ port: 0, target: manager });
    const { port } = await gateway.listen();

    await manager.startSession('emulator-5554', HELLO.packageName);
    await waitUntil(() => manager?.getSessionState().status === 'running');
    expect(adb.reverseCalls[0]).toEqual(['-s', 'emulator-5554', 'reverse', 'tcp:8700', `tcp:${port}`]);
    clock = laptop(DEVICE_START_MS);

    const client = await DeviceClient.open(port);
    for (const line of GOLDEN) client.send(line);
    await client.waitFor((message) => message.type === 'welcome');
    await waitUntil(() => ofType('breakdown').length > 0);
    expect(manager.getSessionState().sdk).toEqual({
      connected: true,
      sdkVersion: '0.1.0',
      processName: HELLO.processName,
      apiLevel: 35,
      framesActive: true,
    });
    // The hello's PID was checked with pidof right away.
    expect(device.commands.filter((command) => command.startsWith('pidof')).length).toBeGreaterThanOrEqual(2);

    const bucketEnd = laptop(1792516375500);
    const sdkFrames = ofType('frames').filter((message) => message.sample.source === 'sdk');
    // The 24.5 ms frame is a first draw: counted, but left out of jank, slow, percentiles and stage means.
    expect(sdkFrames[0]?.sample).toEqual({
      ts: bucketEnd,
      frameCount: 2,
      jankCount: 0, // 7.9 ms is within its deadline
      slowCount: 0,
      fps: 4,
      p50Ms: 7.9,
      p90Ms: 7.9,
      p99Ms: 7.9,
      maxMs: 7.9,
      frameIntervalMs: 8.33,
      frameIntervalSource: 'reported',
      durationsMs: [7.9],
      source: 'sdk',
    });
    // Later golden lines may add more batches: assert on the first bucket only.
    expect(ofType('breakdown')[0]?.sample).toEqual({
      ts: bucketEnd,
      screen: 'homepage',
      frameCount: 2,
      jankCount: 0,
      slowCount: 0,
      meanStageMs: {
        input: 0.2,
        animation: 0.4,
        layout: 1.1,
        draw: 1.6,
        sync: 0.3,
        command: 1.2,
        swap: 0.5,
        delay: 2.6,
        gpu: 2.1,
      },
      p90TotalMs: 7.9,
      maxTotalMs: 7.9,
      frameIntervalMs: 8.33,
    });
    // Dropped frames are summed per session; the (throttled) notice carries the total as of the first
    // golden batch that reports drops.
    const firstDrop = GOLDEN.map((line) => JSON.parse(line) as DeviceMessage)
      .map((message) => (message.type === 'frames' ? (message.droppedFrames ?? 0) : 0))
      .find((count) => count > 0);
    expect(firstDrop).toBeGreaterThan(0);
    await waitUntil(() =>
      ofType('error').some((message) => message.message === droppedFramesMessage(firstDrop ?? 0)),
    );

    client.close();
    await waitUntil(() => manager?.getSessionState().sdk?.connected === false);
    const main = {
      name: 'MainActivity',
      className: 'com.example.shop.ui.MainActivity',
      kind: 'activity',
    };
    const home = {
      name: 'homepage',
      className: 'com.example.shop.ui.home.HomeFragment',
      kind: 'fragment',
    };
    const promo = {
      name: 'BottomSheetPromo',
      className: 'com.example.shop.ui.promo.PromoBottomSheet',
      kind: 'dialog',
    };
    const spans = ofType('screen').map((message) => message.span);
    expect(spans.slice(0, 4)).toEqual([
      { start: laptop(1792516375100), end: null, screen: main },
      { start: laptop(1792516375250), end: null, screen: home },
      { start: laptop(1792516376000), end: null, screen: promo },
      { start: laptop(1792516377000), end: null, screen: null },
    ]);
    // Link closed: the open (background) span is re-sent closed.
    expect(spans[4]).toEqual({ start: laptop(1792516377000), end: laptop(DEVICE_START_MS), screen: null });
    expect(manager.getSessionState().sdk?.framesActive).toBe(false);

    const snapshot = manager.getSnapshot();
    expect(snapshot.screens?.map((span) => span.end)).toEqual([
      laptop(1792516375250),
      laptop(1792516376000),
      laptop(1792516377000),
      laptop(DEVICE_START_MS),
    ]);
    expect(snapshot.breakdown?.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.frames.filter((sample) => sample.source === 'sdk').length).toBe(sdkFrames.length);
  });
});

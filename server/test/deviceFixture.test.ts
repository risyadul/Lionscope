import { readFileSync } from 'node:fs';
import { DEFAULT_SDK_OPTIONS } from '@lionscope/protocol';
import type { DeviceMessage, ServerMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceGateway } from '../src/device/deviceGateway.ts';
import { SdkInspectError } from '../src/device/sdkLink.ts';
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

  /**
   * A running session on a step clock: frozen while the session starts (so the measured offset is exactly
   * OFFSET_MS), then moved to just after the fixture's last screen change. Resolves with the gateway port.
   */
  async function startSession() {
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
    const sessions = new SessionManager({
      adb,
      broadcast: (message) => messages.push(message),
      now,
      deviceGatewayPort: () => gateway?.address?.port ?? null,
    });
    manager = sessions;
    gateway = createDeviceGateway({ port: 0, target: sessions });
    const { port } = await gateway.listen();

    await sessions.startSession('emulator-5554', HELLO.packageName);
    await waitUntil(() => sessions.getSessionState().status === 'running');
    clock = laptop(DEVICE_START_MS);
    return { adb, device, manager: sessions, port, ofType };
  }

  it('produces screen spans, SDK frame samples and a breakdown', async () => {
    const { adb, device, manager, port, ofType } = await startSession();
    expect(adb.reverseCalls[0]).toEqual(['-s', 'emulator-5554', 'reverse', 'tcp:8700', `tcp:${port}`]);

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
      protocolVersion: 1,
      options: DEFAULT_SDK_OPTIONS,
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
  it('on a v2 link: config after the welcome, and stalls / StrictMode violations on the laptop clock', async () => {
    const { manager, port, ofType } = await startSession();
    const v2Lines = GOLDEN.slice(1).filter((line) => /"type":"(stall|strictmode)"/.test(line));
    expect(v2Lines).toHaveLength(2);

    const client = await DeviceClient.open(port);
    client.send({ ...HELLO, protocolVersion: 2 });
    for (const line of GOLDEN.slice(1)) client.send(line);
    await client.waitFor((message) => message.type === 'config');
    expect(client.rawLines.slice(0, 2)).toEqual([
      '{"type":"welcome","protocolVersion":2}',
      '{"type":"config","stallThresholdMs":150,"strictMode":false,"inflateTracking":true}',
    ]);
    await waitUntil(() => ofType('strictmode').length > 0);
    expect(manager.getSessionState().sdk).toMatchObject({ connected: true, protocolVersion: 2 });

    const [stallLine, strictLine] = v2Lines.map((line) => JSON.parse(line) as DeviceMessage);
    const { type: _stall, ...stall } = stallLine as Extract<DeviceMessage, { type: 'stall' }>;
    const { type: _strict, ...violation } = strictLine as Extract<DeviceMessage, { type: 'strictmode' }>;
    expect(ofType('stall').map((message) => message.sample)).toEqual([{ ...stall, ts: laptop(stall.ts) }]);
    // Sent 1 s ahead of the device's "now" (within the accepted lead): placed at now.
    expect(ofType('strictmode').map((message) => message.sample)).toEqual([
      { ...violation, ts: laptop(DEVICE_START_MS) },
    ]);
    expect(manager.getSnapshot()).toMatchObject({
      stalls: [ofType('stall')[0]?.sample],
      strictMode: [ofType('strictmode')[0]?.sample],
    });

    // Options changed from the dashboard reach the live link.
    manager.setSdkOptions({ strictMode: true });
    await client.waitFor((message) => message.type === 'config' && message.strictMode);
    expect(client.rawLines.at(-1)).toBe(
      '{"type":"config","stallThresholdMs":150,"strictMode":true,"inflateTracking":true}',
    );
    client.close();
  });

  it('on a v3 link: inflations and view trees on the laptop clock, ignored on a v2 link', async () => {
    const { manager, port, ofType } = await startSession();
    const [inflateLine, labelLine, treeLine] = GOLDEN.filter((line) =>
      /^\{"type":"(inflate|viewtree)"/.test(line),
    ).map((line) => JSON.parse(line) as DeviceMessage);
    const v3 = await DeviceClient.open(port);
    v3.send({ ...HELLO, protocolVersion: 3 });
    for (const line of GOLDEN.slice(1)) v3.send(line);
    await waitUntil(() => ofType('viewtree').length > 0);
    const { type: _i, ...inflate } = inflateLine as Extract<DeviceMessage, { type: 'inflate' }>;
    const { type: _l, ...label } = labelLine as Extract<DeviceMessage, { type: 'inflate' }>;
    const { type: _t, ...tree } = treeLine as Extract<DeviceMessage, { type: 'viewtree' }>;
    expect(ofType('inflate').map((message) => message.sample)).toEqual([
      { ...inflate, ts: laptop(inflate.ts) },
      { ...label, ts: laptop(label.ts) },
    ]);
    expect(ofType('viewtree').map((message) => message.sample)).toEqual([{ ...tree, ts: laptop(tree.ts) }]);
    expect(manager.getSnapshot()).toMatchObject({
      inflates: ofType('inflate').map((message) => message.sample),
      viewTrees: [ofType('viewtree')[0]?.sample],
    });
    expect(v3.rawLines[0]).toBe('{"type":"welcome","protocolVersion":3}');
    expect(v3.rawLines[1]).toBe(
      '{"type":"config","stallThresholdMs":150,"strictMode":false,"inflateTracking":true}',
    );

    // Options round trip: the dashboard's toggle reaches the link and the session state.
    manager.setSdkOptions({ inflateTracking: false });
    await v3.waitFor((message) => message.type === 'config' && !message.inflateTracking);
    expect(v3.rawLines.at(-1)).toBe(
      '{"type":"config","stallThresholdMs":150,"strictMode":false,"inflateTracking":false}',
    );
    expect(manager.getSessionState().sdk?.options).toEqual({
      stallThresholdMs: 150,
      strictMode: false,
      inflateTracking: false,
    });
    v3.close();
  });

  it('on a v4 link: answers an inspect request with the golden snapshot, and an error with its reason', async () => {
    const { manager, port } = await startSession();
    const golden = (type: string) => {
      const line = GOLDEN.find((candidate) => candidate.startsWith(`{"type":"${type}"`));
      return JSON.parse(line ?? '{}') as Record<string, unknown>;
    };
    const client = await DeviceClient.open(port);
    client.send({ ...HELLO, protocolVersion: 4 });
    await client.waitFor((message) => message.type === 'welcome');
    await waitUntil(() => manager.getSessionState().sdk?.connected === true);
    const link = manager.inspectorSource('emulator-5554')?.link;
    expect(link?.protocolVersion).toBe(4);
    expect(manager.inspectorSource('R58M123ABC')).toBeNull();

    const requests = () =>
      client.received.flatMap((message) => (message.type === 'inspect' ? [message.requestId] : []));
    const answer = link?.inspect();
    await client.waitFor((message) => message.type === 'inspect');
    const [requestId = -1] = requests();
    expect(client.rawLines.at(-1)).toBe(`{"type":"inspect","requestId":${requestId}}`);
    client.send({ ...golden('inspectBegin'), requestId });
    client.send({ ...golden('inspectNodes'), requestId });
    const inspection = await answer;
    expect(inspection?.begin).toEqual({ ...golden('inspectBegin'), requestId });
    expect(inspection?.nodes).toEqual(golden('inspectNodes').nodes);

    const failing = link?.inspect();
    await waitUntil(() => requests().length === 2);
    client.send({ ...golden('inspectError'), requestId: requests()[1] });
    await expect(failing).rejects.toEqual(new SdkInspectError('background'));
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    client.close();
  });

  it('ignores the v3 golden lines on a v2 link', async () => {
    const { manager, port, ofType } = await startSession();
    const client = await DeviceClient.open(port);
    client.send({ ...HELLO, protocolVersion: 2 });
    for (const line of GOLDEN.slice(1)) client.send(line);
    const done = { name: 'done', className: 'com.example.shop.ui.DoneActivity', kind: 'activity' } as const;
    client.send({ type: 'screen', ts: DEVICE_START_MS, screen: done });
    await waitUntil(() => ofType('screen').some((message) => message.span.screen?.name === 'done'));
    expect(ofType('inflate')).toEqual([]);
    expect(ofType('viewtree')).toEqual([]);
    expect(manager.getSnapshot()).toMatchObject({ inflates: [], viewTrees: [] });
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    client.close();
  });

  it('ignores the v2 and v3 golden lines on a v1 link', async () => {
    const { manager, port, ofType } = await startSession();
    const client = await DeviceClient.open(port);
    for (const line of GOLDEN) client.send(line);
    // Lines are handled in order: once this one is through, the v2 lines before it were skipped.
    const done = { name: 'done', className: 'com.example.shop.ui.DoneActivity', kind: 'activity' } as const;
    client.send({ type: 'screen', ts: DEVICE_START_MS, screen: done });
    await waitUntil(() => ofType('screen').some((message) => message.span.screen?.name === 'done'));
    expect(client.rawLines).toEqual(['{"type":"welcome","protocolVersion":1}']);
    expect(ofType('stall')).toEqual([]);
    expect(ofType('strictmode')).toEqual([]);
    expect(ofType('inflate')).toEqual([]);
    expect(ofType('viewtree')).toEqual([]);
    expect(manager.getSessionState().sdk?.connected).toBe(true);
    client.close();
  });
});

import { readFileSync } from 'node:fs';
import type { GatewayMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceGateway, gatewayLine } from '../src/device/deviceGateway.ts';
import type { DeviceGateway, DeviceGatewayLimits } from '../src/device/deviceGateway.ts';
import { SdkEditError } from '../src/device/sdkLink.ts';
import type {
  SdkAttachResult,
  SdkHello,
  SdkLink,
  SdkLinkMessage,
  SdkLinkTarget,
} from '../src/device/sdkLink.ts';
import { DeviceClient } from './helpers/deviceClient.ts';

const GATEWAY_GOLDEN = readFileSync(
  new URL('../../protocol/fixtures/gateway-messages.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '');

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 8,
  sdkVersion: '0.8.0',
  packageName: 'com.example.shop',
  processName: 'com.example.shop',
  pid: 4242,
  apiLevel: 36,
  deviceWallMs: 1792516375000,
  refreshRateHz: 60,
};

class Target implements SdkLinkTarget {
  readonly links: SdkLink[] = [];
  readonly messages: SdkLinkMessage[] = [];

  attachSdk(_hello: SdkHello, link: SdkLink): SdkAttachResult {
    this.links.push(link);
    return {
      ok: true,
      mode: 'inspect',
      handler: {
        onMessage: (message) => this.messages.push(message),
        onInvalidDiagnostic: () => undefined,
        onClose: () => undefined,
      },
    };
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('server → SDK golden lines', () => {
  it('reproduces every golden gateway line byte for byte, flat with type first', () => {
    expect(GATEWAY_GOLDEN.length).toBeGreaterThanOrEqual(10);
    for (const line of GATEWAY_GOLDEN) {
      const message = JSON.parse(line) as GatewayMessage;
      expect(gatewayLine(message)).toBe(`${line}\n`);
      expect(line.startsWith('{"type":')).toBe(true);
      expect(Object.values(message).every((value) => typeof value !== 'object')).toBe(true);
    }
    const types = new Set(GATEWAY_GOLDEN.map((line) => (JSON.parse(line) as GatewayMessage).type));
    expect(types).toEqual(
      new Set([
        'welcome',
        'mocks',
        'mock',
        'config',
        'bye',
        'inspect',
        'setViewProperty',
        'revertViewProperties',
      ]),
    );
  });

  it('leaves the optional revert fields out instead of writing null', () => {
    expect(
      gatewayLine({ type: 'revertViewProperties', requestId: 3, viewKey: undefined, property: undefined }),
    ).toBe('{"type":"revertViewProperties","requestId":3}\n');
  });
});

describe('device gateway edit requests', () => {
  let gateway: DeviceGateway | null = null;
  let target: Target;
  const clients: DeviceClient[] = [];

  async function linked(limits: Partial<DeviceGatewayLimits> = {}, version = 8) {
    target = new Target();
    gateway = createDeviceGateway({ port: 0, target, limits });
    const { port } = await gateway.listen();
    const client = await DeviceClient.open(port);
    clients.push(client);
    client.send({ ...HELLO, protocolVersion: version });
    await client.waitFor((message) => message.type === 'welcome');
    const link = target.links[0];
    if (!link) throw new Error('no link');
    return { client, link };
  }

  const edits = (client: DeviceClient) =>
    client.received.filter(
      (message) => message.type === 'setViewProperty' || message.type === 'revertViewProperties',
    );

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await gateway?.close();
    gateway = null;
  });

  it('sends a set request and resolves with its answer, which never reaches the handler', async () => {
    const { client, link } = await linked();
    const answer = link.setViewProperty(42, 'text', 'Pay "now"');
    await waitUntil(() => edits(client).length === 1);
    const request = edits(client)[0] as Extract<GatewayMessage, { type: 'setViewProperty' }>;
    expect(request).toEqual({
      type: 'setViewProperty',
      requestId: request.requestId,
      viewKey: 42,
      property: 'text',
      value: 'Pay "now"',
    });
    client.send({ type: 'viewPropertyResult', requestId: request.requestId, ok: true, liveEdits: 1 });
    await expect(answer).resolves.toEqual({
      type: 'viewPropertyResult',
      requestId: request.requestId,
      ok: true,
      liveEdits: 1,
    });
    expect(target.messages).toEqual([]);
  });

  it('matches answers by request id, shared with inspect, and drops one for no request', async () => {
    const { client, link } = await linked();
    const inspect = link.inspect();
    inspect.catch(() => undefined);
    const revert = link.revertViewProperties(7, 'padding');
    const all = link.revertViewProperties();
    await waitUntil(() => edits(client).length === 2);
    const [first, second] = edits(client) as Extract<GatewayMessage, { type: 'revertViewProperties' }>[];
    const inspectId = client.received.find((message) => message.type === 'inspect');
    expect(
      new Set([
        first?.requestId,
        second?.requestId,
        inspectId && 'requestId' in inspectId ? inspectId.requestId : -1,
      ]).size,
    ).toBe(3);
    expect(client.rawLines.at(-2)).toBe(
      `{"type":"revertViewProperties","requestId":${first?.requestId},"viewKey":7,"property":"padding"}`,
    );
    expect(client.rawLines.at(-1)).toBe(`{"type":"revertViewProperties","requestId":${second?.requestId}}`);
    client.send({ type: 'viewPropertyResult', requestId: 999, ok: true, liveEdits: 5 });
    client.send({ type: 'viewPropertyResult', requestId: second?.requestId, ok: true, liveEdits: 0 });
    client.send({
      type: 'viewPropertyResult',
      requestId: first?.requestId,
      ok: false,
      error: 'stale',
      liveEdits: 3,
    });
    await expect(all).resolves.toMatchObject({ ok: true, liveEdits: 0 });
    await expect(revert).resolves.toMatchObject({ ok: false, error: 'stale', liveEdits: 3 });
    expect(client.isClosed).toBe(false);
  });

  it('times out an unanswered edit and ignores its late answer', async () => {
    const { client, link } = await linked({ viewEditTimeoutMs: 50 });
    const answer = link.setViewProperty(1, 'alpha', 0.5);
    await expect(answer).rejects.toEqual(new SdkEditError('timeout'));
    const requestId = (edits(client)[0] as { requestId: number }).requestId;
    client.send({ type: 'viewPropertyResult', requestId, ok: true, liveEdits: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.isClosed).toBe(false);
  });

  it('refuses more edits in flight than the cap, and every edit on a link below v8', async () => {
    const { link } = await linked({ maxPendingEdits: 2 });
    const pending = [link.setViewProperty(1, 'alpha', 0.5), link.setViewProperty(1, 'alpha', 0.6)];
    for (const edit of pending) edit.catch(() => undefined);
    await expect(link.setViewProperty(1, 'alpha', 0.7)).rejects.toEqual(new SdkEditError('busy'));
    await gateway?.close();
    await expect(Promise.all(pending)).rejects.toEqual(new SdkEditError('closed'));

    const old = await linked({}, 6);
    await expect(old.link.setViewProperty(1, 'alpha', 0.5)).rejects.toEqual(new SdkEditError('unsupported'));
    await expect(old.link.revertViewProperties()).rejects.toEqual(new SdkEditError('unsupported'));
    expect(edits(old.client)).toEqual([]);
  });

  it('fails edits in flight when the SDK goes away, and new ones on a closed link', async () => {
    const { client, link } = await linked();
    const answer = link.setViewProperty(1, 'visibility', 'gone');
    await waitUntil(() => edits(client).length === 1);
    client.socket.destroy();
    await expect(answer).rejects.toEqual(new SdkEditError('closed'));
    await expect(link.revertViewProperties()).rejects.toEqual(new SdkEditError('closed'));
  });

  it('never gives two links the same request id', async () => {
    const first = await linked();
    const firstGateway = gateway;
    const second = await linked();
    first.link.setViewProperty(1, 'alpha', 0.5).catch(() => undefined);
    second.link.setViewProperty(1, 'alpha', 0.5).catch(() => undefined);
    await waitUntil(() => edits(first.client).length === 1 && edits(second.client).length === 1);
    const id = (client: DeviceClient) => (edits(client)[0] as { requestId: number }).requestId;
    expect(id(first.client)).not.toBe(id(second.client));
    await firstGateway?.close();
  });

  it('lets the answers of pending edits through a spent line budget, and only them', async () => {
    const { client, link } = await linked({ lineBurst: 2, linesPerSecond: 0.001 });
    client.send({ type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 }); // With the hello: the budget is spent.
    const answer = link.setViewProperty(1, 'alpha', 0.5);
    await waitUntil(() => edits(client).length === 1);
    const requestId = (edits(client)[0] as { requestId: number }).requestId;
    client.send({ type: 'viewPropertyResult', requestId, ok: true, liveEdits: 1 });
    await expect(answer).resolves.toMatchObject({ ok: true });
    // A second answer with no edit pending is a line like any other: over the budget it is shed.
    client.send({ type: 'viewPropertyResult', requestId, ok: true, liveEdits: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.isClosed).toBe(false);
  });

  it('closes a link whose exempt answer is another type in disguise', async () => {
    const { client, link } = await linked({ lineBurst: 2, linesPerSecond: 0.001 });
    client.send({ type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 });
    link.setViewProperty(1, 'alpha', 0.5).catch(() => undefined);
    await waitUntil(() => edits(client).length === 1);
    client.send('{"type":"viewPropertyResult","type":"screen","ts":1792516380000,"screen":null}');
    await client.closed;
  });

  it('skips a viewPropertyResult with invalid fields without closing the link', async () => {
    const { client, link } = await linked({ viewEditTimeoutMs: 100 });
    const answer = link.setViewProperty(1, 'alpha', 0.5);
    await waitUntil(() => edits(client).length === 1);
    const requestId = (edits(client)[0] as { requestId: number }).requestId;
    client.send({ type: 'viewPropertyResult', requestId, ok: true, liveEdits: -1 });
    await expect(answer).rejects.toEqual(new SdkEditError('timeout'));
    expect(client.isClosed).toBe(false);
  });
});

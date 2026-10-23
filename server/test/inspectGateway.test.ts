import type { InspectorNode } from '@lionscope/protocol';
import { MAX_DEVICE_LINE_BYTES } from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceGateway } from '../src/device/deviceGateway.ts';
import type { DeviceGateway, DeviceGatewayLimits } from '../src/device/deviceGateway.ts';
import { SdkInspectError } from '../src/device/sdkLink.ts';
import type {
  SdkAttachResult,
  SdkHello,
  SdkLink,
  SdkLinkMessage,
  SdkLinkTarget,
} from '../src/device/sdkLink.ts';
import { DeviceClient } from './helpers/deviceClient.ts';

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 4,
  sdkVersion: '0.5.0',
  packageName: 'com.example.shop',
  processName: 'com.example.shop',
  pid: 4242,
  apiLevel: 36,
  deviceWallMs: 1792516375000,
  refreshRateHz: 60,
};
const HEARTBEAT = { type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 };

function node(id: number, parent: number | null = id === 0 ? null : 0): InspectorNode {
  return {
    id,
    parent,
    window: 0,
    className: 'android.widget.TextView',
    resourceId: `label_${id}`,
    text: `Item ${id}`,
    contentDescription: null,
    bounds: [0, id * 10, 1080, id * 10 + 10],
    visibleBounds: [0, id * 10, 1080, id * 10 + 10],
    visibility: 'visible',
    alpha: 1,
    enabled: true,
    clickable: false,
    focused: false,
    selected: false,
    checked: null,
    padding: [0, 0, 0, 0],
    margin: null,
    layoutWidth: 'match_parent',
    layoutHeight: 'wrap_content',
    source: { layout: 'row_item', line: 12 },
    fragment: null,
    activity: 'com.example.shop.MainActivity',
  };
}

function begin(requestId: number, nodeCount: number, windows = 1) {
  return {
    type: 'inspectBegin',
    requestId,
    ts: 1792516376500,
    screen: 'home',
    display: { width: 1080, height: 2424, rotation: 0 },
    windows: Array.from({ length: windows }, (_, id) => ({ id, type: 1, bounds: [0, 0, 1080, 2424] })),
    nodeCount,
    truncated: false,
    captureMs: 2.4,
    compose: false,
  };
}

function chunk(requestId: number, seq: number, nodes: InspectorNode[], last = false) {
  return { type: 'inspectNodes', requestId, seq, last, nodes };
}

const nodes = (count: number) => Array.from({ length: count }, (_, id) => node(id));

class Target implements SdkLinkTarget {
  readonly links: SdkLink[] = [];
  readonly messages: SdkLinkMessage[] = [];
  invalidDiagnostics = 0;

  attachSdk(_hello: SdkHello, link: SdkLink): SdkAttachResult {
    this.links.push(link);
    return {
      ok: true,
      handler: {
        onMessage: (message) => this.messages.push(message),
        onInvalidDiagnostic: () => {
          this.invalidDiagnostics += 1;
        },
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

describe('device gateway inspect requests', () => {
  let gateway: DeviceGateway | null = null;
  let target: Target;
  const clock = 1_000_000;
  const clients: DeviceClient[] = [];

  /** A linked SDK at `version` and the gateway's link to it. */
  async function linked(limits: Partial<DeviceGatewayLimits> = {}, version = 4) {
    target = new Target();
    gateway = createDeviceGateway({ port: 0, target, limits, now: () => clock });
    const { port } = await gateway.listen();
    const client = await DeviceClient.open(port);
    clients.push(client);
    client.send({ ...HELLO, protocolVersion: version });
    await client.waitFor((message) => message.type === 'welcome');
    const link = target.links[0];
    if (!link) throw new Error('no link');
    return { client, link };
  }

  /** Request ids the client was asked for, in order. */
  const requests = (client: DeviceClient) =>
    client.received.flatMap((message) => (message.type === 'inspect' ? [message.requestId] : []));

  async function request(client: DeviceClient, link: SdkLink) {
    const before = requests(client).length;
    const answer = link.inspect();
    // Not awaited by every test: a rejection must not count as unhandled meanwhile.
    answer.catch(() => undefined);
    await waitUntil(() => requests(client).length > before);
    return { answer, requestId: requests(client).at(-1) ?? -1 };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await gateway?.close();
    gateway = null;
  });

  it('sends inspect with a fresh request id and reassembles the chunks in order', async () => {
    const { client, link } = await linked();
    const { answer, requestId } = await request(client, link);
    expect(client.rawLines.at(-1)).toBe(`{"type":"inspect","requestId":${requestId}}`);
    const all = nodes(5);
    client.send(begin(requestId, 5));
    client.send(chunk(requestId, 0, all.slice(0, 2)));
    client.send(chunk(requestId, 1, all.slice(2, 4)));
    client.send(chunk(requestId, 2, all.slice(4), true));
    const inspection = await answer;
    expect(inspection.nodes).toEqual(all);
    expect(inspection.begin).toMatchObject({ requestId, nodeCount: 5, screen: 'home' });
    // The answers never reach the link handler.
    expect(target.messages).toEqual([]);

    const next = await request(client, link);
    expect(next.requestId).toBe(requestId + 1);
  });

  it('accepts chunks out of order and an empty snapshot', async () => {
    const { client, link } = await linked();
    const first = await request(client, link);
    const all = nodes(4);
    client.send(begin(first.requestId, 4));
    client.send(chunk(first.requestId, 1, all.slice(2), true));
    client.send(chunk(first.requestId, 0, all.slice(0, 2)));
    expect((await first.answer).nodes).toEqual(all);

    const empty = await request(client, link);
    client.send(begin(empty.requestId, 0));
    client.send(chunk(empty.requestId, 0, [], true));
    expect((await empty.answer).nodes).toEqual([]);
  });

  it.each([
    ['a chunk before the begin', (id: number) => [chunk(id, 0, nodes(1), true)]],
    ['a second begin', (id: number) => [begin(id, 1), begin(id, 1)]],
    [
      'windows out of order',
      (id: number) => [{ ...begin(id, 1), windows: [{ id: 1, type: 1, bounds: [0, 0, 1, 1] }] }],
    ],
    ['a duplicate seq', (id: number) => [begin(id, 2), chunk(id, 0, nodes(1)), chunk(id, 0, nodes(1))]],
    ['more nodes than announced', (id: number) => [begin(id, 1), chunk(id, 0, nodes(2), true)]],
    ['fewer nodes than announced', (id: number) => [begin(id, 3), chunk(id, 0, nodes(2), true)]],
    ['an empty chunk of a non-empty snapshot', (id: number) => [begin(id, 2), chunk(id, 0, [])]],
    [
      'a chunk after the last',
      (id: number) => [begin(id, 3), chunk(id, 1, nodes(1), true), chunk(id, 2, nodes(1))],
    ],
    ['ids out of order', (id: number) => [begin(id, 2), chunk(id, 0, [node(1), node(0)], true)]],
    [
      'a parent after its child',
      (id: number) => [begin(id, 2), chunk(id, 0, [node(0, 1), node(1, null)], true)],
    ],
    [
      'a node in an unknown window',
      (id: number) => [begin(id, 1), chunk(id, 0, [{ ...node(0), window: 3 }], true)],
    ],
    [
      'an invalid node',
      (id: number) => [begin(id, 1), chunk(id, 0, [{ ...node(0), text: 'bad\nline' }], true)],
    ],
  ])('fails the request as invalid on %s, and keeps the link up', async (_name, lines) => {
    const { client, link } = await linked();
    const { answer, requestId } = await request(client, link);
    for (const line of lines(requestId)) client.send(line);
    await expect(answer).rejects.toEqual(new SdkInspectError('invalid'));
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    expect(client.isClosed).toBe(false);
    expect(target.invalidDiagnostics).toBe(0);
  });

  it("passes the SDK's error reason on and ignores answers to unknown or finished requests", async () => {
    const { client, link } = await linked();
    const { answer, requestId } = await request(client, link);
    client.send(begin(requestId + 5, 1));
    client.send({ type: 'inspectError', requestId, reason: 'background' });
    await expect(answer).rejects.toEqual(new SdkInspectError('background'));
    client.send(chunk(requestId, 0, nodes(1), true));
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    expect(client.isClosed).toBe(false);
  });

  it('times out a request whose chunks do not all arrive, and drops the late ones', async () => {
    const { client, link } = await linked({ inspectTimeoutMs: 100 });
    const { answer, requestId } = await request(client, link);
    client.send(begin(requestId, 2));
    client.send(chunk(requestId, 1, nodes(2).slice(1), true));
    await expect(answer).rejects.toEqual(new SdkInspectError('timeout'));
    client.send(chunk(requestId, 0, nodes(1)));
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 1);
    expect(client.isClosed).toBe(false);
  });

  it('refuses on a link below v4 and fails pending requests when the link closes', async () => {
    const old = await linked({}, 3);
    await expect(old.link.inspect()).rejects.toEqual(new SdkInspectError('unsupported'));
    expect(requests(old.client)).toEqual([]);
    await gateway?.close();

    const { client, link } = await linked();
    const { answer } = await request(client, link);
    client.socket.destroy();
    await expect(answer).rejects.toEqual(new SdkInspectError('closed'));
    await expect(link.inspect()).rejects.toEqual(new SdkInspectError('closed'));
  });

  it("exempts a request's lines from the line budget, up to the announced node count", async () => {
    // A budget of 5 lines and no refill: the hello took one.
    const { client, link } = await linked({ lineBurst: 5, linesPerSecond: 1 });
    const { answer, requestId } = await request(client, link);
    const all = nodes(50);
    client.send(begin(requestId, 50));
    for (let seq = 0; seq < 50; seq++)
      client.send(chunk(requestId, seq, [all[seq] ?? node(seq)], seq === 49));
    expect((await answer).nodes).toHaveLength(50);
    // The budget is untouched: four heartbeats still fit.
    for (let i = 0; i < 4; i++) client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 4);
    expect(client.isClosed).toBe(false);
  });

  it('bounds the exemption: answer lines past it spend the budget and are shed once it is gone', async () => {
    const { client, link } = await linked({ lineBurst: 3, linesPerSecond: 1 });
    const { answer, requestId } = await request(client, link);
    // Announces 2 nodes (exempt: the begin + 2 chunks) but floods 10 chunks of 1: the 3rd and 4th spend the
    // two tokens left (the 3rd fails the request: too many nodes), the rest are shed.
    client.send(begin(requestId, 2));
    for (let seq = 0; seq < 10; seq++) client.send(chunk(requestId, seq, [node(0)]));
    await expect(answer).rejects.toEqual(new SdkInspectError('invalid'));
    client.send(HEARTBEAT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Out of budget: a non-diagnostic line now closes the link, as before 0.5.0.
    await client.closed;
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
  });

  it('does not exempt inspect lines while no request is pending', async () => {
    const { client } = await linked({ lineBurst: 3, linesPerSecond: 1 });
    for (let i = 0; i < 5; i++) client.send({ type: 'inspectError', requestId: 1, reason: 'failed' });
    client.send(HEARTBEAT);
    await client.closed;
    expect(target.messages).toEqual([]);
  });

  it('still closes on an answer line over MAX_DEVICE_LINE_BYTES', async () => {
    const { client, link } = await linked();
    const { answer, requestId } = await request(client, link);
    client.send(begin(requestId, 1));
    client.send(chunk(requestId, 0, [{ ...node(0), text: 'x'.repeat(MAX_DEVICE_LINE_BYTES) }], true));
    await expect(answer).rejects.toEqual(new SdkInspectError('closed'));
    await client.closed;
  });

  it('closes the link on an exempt line whose duplicate type key makes it another message', async () => {
    const { client, link } = await linked({ lineBurst: 3, linesPerSecond: 1 });
    const { answer, requestId } = await request(client, link);
    client.send(
      `{"type":"inspectNodes","type":"heartbeat","ts":1792516380000,"droppedMessages":0,"requestId":${requestId}}`,
    );
    await client.closed;
    await expect(answer).rejects.toEqual(new SdkInspectError('closed'));
    expect(target.messages).toEqual([]);
    expect(client.received.at(-1)).toEqual({ type: 'bye', reason: 'protocol_error' });
  });

  it('charges answers to another request id against the line budget', async () => {
    // Two tokens left after the hello; the pending request's allowance is not spent on stale lines.
    const { client, link } = await linked({ lineBurst: 3, linesPerSecond: 1 });
    const { answer, requestId } = await request(client, link);
    for (let i = 0; i < 4; i++)
      client.send({ type: 'inspectError', requestId: requestId + 10, reason: 'failed' });
    // Still exempt: the real answer goes through although the budget is gone.
    client.send({ type: 'inspectError', requestId, reason: 'no_window' });
    await expect(answer).rejects.toEqual(new SdkInspectError('no_window'));
    client.send(HEARTBEAT);
    await client.closed;
  });

  it('caps the bytes of an answer: past the cap the request fails as too_large', async () => {
    const { client, link } = await linked({ maxInspectAnswerBytes: 4000 });
    const { answer, requestId } = await request(client, link);
    client.send(begin(requestId, 10));
    for (let seq = 0; seq < 10; seq++) client.send(chunk(requestId, seq, [node(seq)], seq === 9));
    await expect(answer).rejects.toEqual(new SdkInspectError('too_large'));
    expect(client.isClosed).toBe(false);
  });

  it('bounds the exempt bytes too: lines past them spend the line budget', async () => {
    const { client, link } = await linked({ lineBurst: 3, linesPerSecond: 1, maxInspectAnswerBytes: 1500 });
    const { answer, requestId } = await request(client, link);
    client.send(begin(requestId, 4));
    // The begin and the first chunk fit the exempt bytes; the next two spend the 2 tokens left (and the request
    // fails as too large), the last is shed.
    for (let seq = 0; seq < 4; seq++) client.send(chunk(requestId, seq, [node(seq)], seq === 3));
    await expect(answer).rejects.toEqual(new SdkInspectError('too_large'));
    client.send(HEARTBEAT);
    await client.closed;
  });

  it('re-arms the timeout on every answer line, within a total limit', async () => {
    const { client, link } = await linked({ inspectTimeoutMs: 150, inspectTotalTimeoutMs: 1000 });
    const { answer, requestId } = await request(client, link);
    const all = nodes(4);
    client.send(begin(requestId, 4));
    for (let seq = 0; seq < 4; seq++) {
      // Each gap is under the per-line timeout, the whole answer well over it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      client.send(chunk(requestId, seq, [all[seq] ?? node(seq)], seq === 3));
    }
    expect((await answer).nodes).toEqual(all);

    const slow = await request(client, link);
    const started = performance.now();
    client.send(begin(slow.requestId, 100));
    for (let seq = 0; seq < 20; seq++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      client.send(chunk(slow.requestId, seq, [node(seq)]));
    }
    await expect(slow.answer).rejects.toEqual(new SdkInspectError('timeout'));
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
  });
});

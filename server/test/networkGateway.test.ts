import { readFileSync } from 'node:fs';
import {
  DEVICE_PROTOCOL_V5,
  DEVICE_PROTOCOL_V7,
  MAX_DEVICE_LINE_BYTES,
  MAX_HTTP_LINE_BYTES,
} from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDeviceGateway,
  encodeMocks,
  encodeWelcome,
  MAX_PENDING_MOCK_BYTES,
} from '../src/device/deviceGateway.ts';
import { linkProof } from '../src/device/linkKey.ts';
import type { DeviceGateway, DeviceGatewayLimits } from '../src/device/deviceGateway.ts';
import type {
  SdkAttachResult,
  SdkHello,
  SdkLink,
  SdkLinkMessage,
  SdkLinkMode,
  SdkLinkTarget,
} from '../src/device/sdkLink.ts';
import { DeviceClient } from './helpers/deviceClient.ts';
import { mockRule } from './helpers/networkFixtures.ts';

/** The welcome and mock lines of the golden file (it also holds the v8 edit lines), each with its newline. */
const GATEWAY_GOLDEN = readFileSync(
  new URL('../../protocol/fixtures/gateway-messages.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => /^\{"type":"(welcome|mocks|mock)"/.test(line))
  .map((line) => `${line}\n`)
  .join('');
/** The fixtures' link key: bytes 0x00..0x1f. */
const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const GOLDEN_NONCE = (
  JSON.parse(
    readFileSync(new URL('../../protocol/fixtures/device-messages.ndjson', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{"type":"hello"') && line.includes('"nonce"')) ?? '{}',
  ) as { nonce?: string }
).nonce;

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: DEVICE_PROTOCOL_V7,
  sdkVersion: '0.7.0',
  packageName: 'com.example.shop',
  processName: 'com.example.shop',
  pid: 4242,
  apiLevel: 35,
  deviceWallMs: 1792516375000,
  refreshRateHz: 120,
};
const HEARTBEAT = { type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 };
const REQUEST = {
  type: 'httpRequest',
  id: 1,
  ts: 1792516381000,
  method: 'GET',
  url: 'https://api.example.com/v1/items?page=2',
  headers: [['Accept', 'application/json']],
  body: null,
  mockId: null,
  dropped: 0,
};
const RESPONSE = {
  type: 'httpResponse',
  id: 1,
  ts: 1792516381183,
  status: 200,
  protocol: 'h2',
  headers: [['Content-Type', 'text/plain']],
  body: { size: 2, contentType: 'text/plain', text: 'ok', truncated: false, omitted: null },
  headersMs: 120.4,
  durationMs: 182.7,
  error: null,
};

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('welcome and mock rule lines for the SDK', () => {
  it('reproduces the golden gateway lines byte for byte', () => {
    expect(GOLDEN_NONCE).toMatch(/^[0-9a-f]{32}$/);
    const welcome = encodeWelcome(
      DEVICE_PROTOCOL_V7,
      'session',
      linkProof(TEST_KEY, GOLDEN_NONCE ?? '', 7, 'session'),
    );
    const rules = [
      mockRule({
        id: 'm2',
        match: 'exact',
        url: 'https://api.example.com/v1/items/42',
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Note', '"quoted" ✓'],
        ],
        body: '{"id":42,"name":"Mocked ✓"}',
        delayMs: 1500,
      }),
      // A failure sends no response: status 0, no headers, no body, whatever the rule holds.
      mockRule({
        method: null,
        match: 'glob',
        url: 'https://*.example.com/v1/*',
        action: 'timeout',
        status: 503,
        headers: [['X-Ignored', 'yes']],
        body: 'ignored',
      }),
    ];
    expect(welcome + encodeMocks(3, rules) + encodeMocks(4, [])).toBe(GATEWAY_GOLDEN);
  });

  it('puts a proof only into the welcome of a v7 session link', () => {
    const proof = 'ab'.repeat(32);
    expect(encodeWelcome(7, 'session')).toBe('{"type":"welcome","protocolVersion":7,"mode":"session"}\n');
    expect(encodeWelcome(7, 'inspect', proof)).toBe(
      '{"type":"welcome","protocolVersion":7,"mode":"inspect"}\n',
    );
    expect(encodeWelcome(6, 'session', proof)).toBe(
      '{"type":"welcome","protocolVersion":6,"mode":"session"}\n',
    );
    expect(encodeWelcome(4, 'session', proof)).toBe('{"type":"welcome","protocolVersion":4}\n');
  });
});

/** Accepts every hello with `mode`; `onAttach` runs inside attachSdk (before the welcome went out). */
class Target implements SdkLinkTarget {
  readonly links: SdkLink[] = [];
  readonly messages: SdkLinkMessage[] = [];
  invalid = 0;
  constructor(
    private readonly mode: SdkLinkMode = 'session',
    private readonly onAttach?: (link: SdkLink) => void,
    private readonly proof?: string,
  ) {}
  attachSdk(_hello: SdkHello, link: SdkLink): SdkAttachResult {
    this.links.push(link);
    this.onAttach?.(link);
    return {
      ok: true,
      mode: this.mode,
      ...(this.proof === undefined ? {} : { proof: this.proof }),
      handler: {
        onMessage: (message) => this.messages.push(message),
        onInvalidDiagnostic: () => {
          this.invalid += 1;
        },
        onClose: () => undefined,
      },
    };
  }
}

describe('device gateway: network messages (v7)', () => {
  let gateway: DeviceGateway | null = null;
  const clients: DeviceClient[] = [];
  let clock = 1_000_000;

  async function start(target: Target, limits: Partial<DeviceGatewayLimits> = {}): Promise<number> {
    gateway = createDeviceGateway({ port: 0, target, limits, now: () => clock });
    return (await gateway.listen()).port;
  }

  async function linked(port: number, protocolVersion = DEVICE_PROTOCOL_V7): Promise<DeviceClient> {
    const client = await DeviceClient.open(port);
    clients.push(client);
    client.send({ ...HELLO, protocolVersion });
    await client.waitFor((message) => message.type === 'welcome');
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await gateway?.close();
    gateway = null;
    clock = 1_000_000;
  });

  it(`accepts httpRequest / httpResponse lines up to ${MAX_HTTP_LINE_BYTES / 1024} KB on a v7 link, its type split across chunks`, async () => {
    const target = new Target();
    const client = await linked(await start(target));
    // Control characters are JSON-escaped to six bytes each: 40 000 of them make a ~240 KB line.
    const text = '\u0001'.repeat(40_000);
    const response = { ...RESPONSE, body: { ...RESPONSE.body, size: text.length, text } };
    const line = `${JSON.stringify(response)}\n`;
    expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_DEVICE_LINE_BYTES * 3);
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_HTTP_LINE_BYTES);
    client.send(REQUEST);
    client.write(line.slice(0, 5)); // `{"typ`
    await settle();
    client.write(line.slice(5));
    await waitUntil(() => target.messages.length === 2);
    expect(target.messages[1]).toEqual(response);
    expect(client.isClosed).toBe(false);
  });

  it(`closes on an httpResponse line over ${MAX_HTTP_LINE_BYTES / 1024} KB on a v7 link`, async () => {
    const client = await linked(await start(new Target()));
    client.write(`{"type":"httpResponse","pad":"${'x'.repeat(MAX_HTTP_LINE_BYTES)}`);
    await client.closed;
  });

  it(`keeps ${MAX_DEVICE_LINE_BYTES / 1024} KB for every other line on a v7 link, and for http lines below v7`, async () => {
    const big = (type: string) => `{"type":"${type}","pad":"${'x'.repeat(MAX_DEVICE_LINE_BYTES)}`;
    const port = await start(new Target());
    const v7 = await linked(port);
    v7.write(big('heartbeat'));
    await v7.closed;
    const v5 = await linked(port, DEVICE_PROTOCOL_V5);
    v5.write(big('httpResponse'));
    await v5.closed;
  });

  it('drops an invalid network line but keeps the link up', async () => {
    const target = new Target();
    const client = await linked(await start(target));
    client.send({ ...REQUEST, method: 'GET /' });
    client.send({ ...RESPONSE, status: 42 });
    client.send({ type: 'mocksApplied', rev: -1, count: 0 });
    client.send({ type: 'mocksApplied', rev: 3, count: 2 });
    await waitUntil(() => target.messages.length === 1);
    expect(target.messages).toEqual([{ type: 'mocksApplied', rev: 3, count: 2 }]);
    expect(target.invalid).toBe(3);
    expect(client.isClosed).toBe(false);
  });

  it('sheds network lines over the line budget instead of closing the link', async () => {
    const target = new Target();
    const client = await linked(await start(target, { lineBurst: 5, linesPerSecond: 1 }));
    for (let id = 1; id <= 12; id += 1) client.send({ ...REQUEST, id });
    // The hello took one token: four requests fit, the rest are shed.
    await waitUntil(() => target.messages.length === 4);
    await settle();
    expect(target.messages).toHaveLength(4);
    expect(client.isClosed).toBe(false);
    clock += 1000;
    client.send(HEARTBEAT);
    await waitUntil(() => target.messages.length === 5);
  });

  it('sends a mock rule set to a v7 session link, after the welcome when asked while attaching', async () => {
    const rules = [mockRule()];
    const target = new Target('session', (link) => link.sendMocks(1, rules));
    const client = await linked(await start(target));
    await waitUntil(() => client.rawLines.length === 3);
    expect(client.rawLines.map((line) => JSON.parse(line).type)).toEqual(['welcome', 'mocks', 'mock']);
    target.links[0]?.sendMocks(2, []);
    await waitUntil(() => client.rawLines.length === 4);
    expect(client.rawLines.slice(1).join('\n') + '\n').toBe(encodeMocks(1, rules) + encodeMocks(2, []));
  });

  it("writes the target's proof into a v7 session link's welcome, never an inspect-only link's", async () => {
    const proof = 'cd'.repeat(32);
    const session = await linked(await start(new Target('session', undefined, proof)));
    expect(session.rawLines[0]).toBe(
      `{"type":"welcome","protocolVersion":7,"mode":"session","proof":"${proof}"}`,
    );
    await gateway?.close();
    const inspect = await linked(await start(new Target('inspect', undefined, proof)));
    expect(inspect.rawLines[0]).toBe('{"type":"welcome","protocolVersion":7,"mode":"inspect"}');
  });

  it('keeps only the latest mock set while the socket buffers over 1 MB, and writes it on drain', async () => {
    const target = new Target();
    const client = await linked(await start(target));
    client.socket.pause(); // a slow phone: nothing is read for now
    // 4 rules with 256 KB bodies: ~1.4 MB of lines per set.
    const body = 'x'.repeat(256 * 1024);
    const rules = [1, 2, 3, 4].map((index) =>
      mockRule({ id: `m${index}`, url: `https://api.example.com/${index}`, body }),
    );
    expect(encodeMocks(1, rules).length).toBeGreaterThan(MAX_PENDING_MOCK_BYTES);
    const sets = 30;
    for (let rev = 1; rev <= sets; rev += 1) target.links[0]?.sendMocks(rev, rules);
    client.socket.resume();
    const revs = () => client.received.flatMap((message) => (message.type === 'mocks' ? [message.rev] : []));
    await waitUntil(() => revs().at(-1) === sets, 10_000);
    await settle();
    // Some sets were never written, the latest was, and every written set is whole and in order.
    expect(revs().length).toBeLessThan(sets);
    expect(revs()).toEqual([...revs()].sort((a, b) => a - b));
    expect(client.received.filter((message) => message.type === 'mock')).toHaveLength(revs().length * 4);
    expect(client.isClosed).toBe(false);
  });

  it('never sends mocks to a link below v7 or to an inspect-only link', async () => {
    const session = new Target('session', (link) => link.sendMocks(1, [mockRule()]));
    const v5 = await linked(await start(session), DEVICE_PROTOCOL_V5);
    session.links[0]?.sendMocks(2, [mockRule()]);
    await settle();
    expect(v5.received.map((message) => message.type)).toEqual(['welcome']);
    await gateway?.close();

    const inspect = new Target('inspect', (link) => link.sendMocks(1, [mockRule()]));
    const v7 = await linked(await start(inspect));
    inspect.links[0]?.sendMocks(2, [mockRule()]);
    await settle();
    expect(v7.received).toEqual([{ type: 'welcome', protocolVersion: DEVICE_PROTOCOL_V7, mode: 'inspect' }]);
  });
});

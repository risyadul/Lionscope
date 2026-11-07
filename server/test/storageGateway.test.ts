import { readFileSync } from 'node:fs';
import type { GatewayMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { configMessage, createDeviceGateway, gatewayLine } from '../src/device/deviceGateway.ts';
import type { DeviceGateway, DeviceGatewayLimits } from '../src/device/deviceGateway.ts';
import { SdkStorageError } from '../src/device/sdkLink.ts';
import type {
  SdkAttachResult,
  SdkHello,
  SdkLink,
  SdkLinkMessage,
  SdkLinkTarget,
} from '../src/device/sdkLink.ts';
import { DeviceClient } from './helpers/deviceClient.ts';
import { StorageService } from '../src/storage/storageService.ts';
import type { StorageSessionTarget } from '../src/session/sessionManager.ts';

const RESULTS = readFileSync(
  new URL('../../protocol/fixtures/storage-results.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '');

const HELLO: SdkHello = {
  type: 'hello',
  protocolVersion: 11,
  sdkVersion: '0.13.0',
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
      mode: 'session',
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

const STORAGE_TYPES = new Set(['storageList', 'storageRead', 'storageWrite']);
const OP_ID = '6f1c2b8e-0d5a-4f43-9b0e-3a7c2d1e4f50';

describe('storage config', () => {
  const options = {
    stallThresholdMs: 250,
    strictMode: true,
    inflateTracking: true,
    rxTracking: false,
    savedStateTracking: false,
  };

  it('appends storageConsent last on v11 links only, off unless given', () => {
    expect(gatewayLine(configMessage(options, 11, 'read_write'))).toBe(
      '{"type":"config","stallThresholdMs":250,"strictMode":true,"inflateTracking":true,"rxTracking":false,"savedStateTracking":false,"storageConsent":"read_write"}\n',
    );
    expect(configMessage(options, 11)).toMatchObject({ storageConsent: 'off' });
    expect(configMessage(options, 10, 'read_write')).not.toHaveProperty('storageConsent');
  });
});

describe('device gateway storage requests', () => {
  let gateway: DeviceGateway | null = null;
  let target: Target;
  const clients: DeviceClient[] = [];

  async function linked(limits: Partial<DeviceGatewayLimits> = {}, version = 11) {
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

  const requests = (client: DeviceClient) =>
    client.received.filter((message) => STORAGE_TYPES.has(message.type)) as Extract<
      GatewayMessage,
      { requestId: number }
    >[];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await gateway?.close();
    gateway = null;
  });

  it('sends a flat request with its own request id and resolves with the answer of the matching type', async () => {
    const { client, link } = await linked();
    const answer = link.storage({ type: 'storageRead', store: 'prefs', name: 'app_settings', limit: 100 });
    await waitUntil(() => requests(client).length === 1);
    const request = requests(client)[0]!;
    expect(client.rawLines.at(-1)).toBe(
      `{"type":"storageRead","requestId":${request.requestId},"store":"prefs","name":"app_settings","limit":100}`,
    );
    const golden = JSON.parse(RESULTS.find((line) => line.includes('"requestId":31'))!) as Record<
      string,
      unknown
    >;
    client.send({ ...golden, requestId: request.requestId });
    await expect(answer).resolves.toMatchObject({ type: 'storageReadResult', code: 'ok' });
    expect(target.messages).toEqual([]);
  });

  it('never sends a request line over 60 KiB (too_large) and refuses storage below v11', async () => {
    const { client, link } = await linked();
    const big = JSON.stringify({ t: 'string', v: 'x'.repeat(61 * 1024) });
    await expect(
      link.storage({
        type: 'storageWrite',
        opId: OP_ID,
        store: 'prefs',
        name: 'p',
        op: 'update',
        key: 'k',
        expected: big,
        value: big,
      }),
    ).rejects.toEqual(new SdkStorageError('too_large'));
    expect(requests(client)).toEqual([]);

    const old = await linked({}, 10);
    await expect(old.link.storage({ type: 'storageList' })).rejects.toEqual(
      new SdkStorageError('unsupported'),
    );
    expect(requests(old.client)).toEqual([]);
  });

  it('times a request out, and hands a write answer that comes after to the link handler (late outcome)', async () => {
    const { client, link } = await linked({ storageTimeoutMs: 50 });
    const answer = link.storage({
      type: 'storageWrite',
      opId: OP_ID,
      store: 'prefs',
      name: 'app_settings',
      op: 'remove',
      key: 'k',
      expected: '{"t":"bool","v":true}',
    });
    await expect(answer).rejects.toEqual(new SdkStorageError('timeout'));
    const requestId = requests(client)[0]!.requestId;
    client.send({
      type: 'storageWriteResult',
      requestId,
      opId: OP_ID,
      phase: 'final',
      code: 'ok',
      memory: 'applied',
      persisted: true,
      observers: 'posted_unverified',
    });
    await waitUntil(() => target.messages.length === 1);
    expect(target.messages[0]).toMatchObject({ type: 'storageWriteResult', opId: OP_ID, phase: 'final' });
    // A stale list / read answer is not a late outcome: dropped quietly, the link stays.
    client.send({
      type: 'storageListResult',
      requestId: 999,
      code: 'ok',
      prefs: [],
      prefsTruncated: false,
      databases: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(target.messages).toHaveLength(1);
    expect(client.isClosed).toBe(false);
  });

  it('resolves a prefs write with its provisional answer and passes the final one on', async () => {
    const { client, link } = await linked();
    const answer = link.storage({
      type: 'storageWrite',
      opId: OP_ID,
      store: 'prefs',
      name: 'app_settings',
      op: 'update',
      key: 'count',
      expected: '{"t":"int","v":"3"}',
      value: '{"t":"int","v":"4"}',
    });
    await waitUntil(() => requests(client).length === 1);
    const requestId = requests(client)[0]!.requestId;
    const base = {
      type: 'storageWriteResult',
      requestId,
      opId: OP_ID,
      code: 'ok',
      memory: 'applied',
      observers: 'posted_unverified',
    };
    client.send({ ...base, phase: 'provisional', persisted: 'timeout' });
    await expect(answer).resolves.toMatchObject({ phase: 'provisional', persisted: 'timeout' });
    client.send({ ...base, phase: 'final', persisted: true });
    await waitUntil(() => target.messages.length === 1);
    expect(target.messages[0]).toMatchObject({ phase: 'final', persisted: true });
  });

  it('refuses more requests in flight than the cap, and fails them when the SDK goes away', async () => {
    const { client, link } = await linked({ maxPendingStorage: 1 });
    const first = link.storage({ type: 'storageList' });
    await expect(link.storage({ type: 'storageList' })).rejects.toEqual(new SdkStorageError('busy'));
    await waitUntil(() => requests(client).length === 1);
    client.socket.destroy();
    await expect(first).rejects.toEqual(new SdkStorageError('closed'));
    await expect(link.storage({ type: 'storageList' })).rejects.toEqual(new SdkStorageError('closed'));
  });

  it('rejects an answer of another storage type for the request id', async () => {
    const { client, link } = await linked();
    const answer = link.storage({ type: 'storageList' });
    await waitUntil(() => requests(client).length === 1);
    const requestId = requests(client)[0]!.requestId;
    client.send({ type: 'storageReadResult', requestId, code: 'ok' });
    await expect(answer).rejects.toEqual(new SdkStorageError('invalid'));
  });

  it('lets the answers of pending requests through a spent line budget, the 256 KB cap included', async () => {
    const { client, link } = await linked({ lineBurst: 2, linesPerSecond: 0.001 });
    client.send({ type: 'heartbeat', ts: 1792516380000, droppedMessages: 0 });
    const answer = link.storage({ type: 'storageRead', store: 'prefs', name: 'p' });
    await waitUntil(() => requests(client).length === 1);
    const requestId = requests(client)[0]!.requestId;
    const entries = Array.from({ length: 12 }, (_, index) => ({
      key: `k${index}`,
      value: { t: 'string', v: 'v'.repeat(16 * 1024) },
    }));
    const line = JSON.stringify({
      type: 'storageReadResult',
      requestId,
      code: 'ok',
      entries,
      nextCursor: null,
      truncated: false,
    });
    expect(Buffer.byteLength(line)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThan(256 * 1024);
    client.send(line);
    await expect(answer).resolves.toMatchObject({ code: 'ok' });
    expect(client.isClosed).toBe(false);
  });

  it('takes a large listing of escaped names (cut by size) and answers the next request on the same socket', async () => {
    const { client, link } = await linked();
    const first = link.storage({ type: 'storageList' });
    await waitUntil(() => requests(client).length === 1);
    const firstId = requests(client)[0]!.requestId;
    // Every char of these names is sent as \u0001 (6 bytes), as the SDK's serializer writes them.
    const escaped = '\u0001';
    const prefs = Array.from({ length: 120 }, (_, index) => ({
      name: String(index).padStart(3, '0') + escaped.repeat(252),
      backupOnly: false,
    }));
    const databases = Array.from({ length: 16 }, (_, index) => ({
      name: String(index).padStart(2, '0') + escaped.repeat(298),
      status: 'ok',
    }));
    const line = JSON.stringify({
      type: 'storageListResult',
      requestId: firstId,
      code: 'ok',
      prefs,
      prefsTruncated: true,
      databases,
    });
    expect(line).toContain('\\u0001');
    expect(Buffer.byteLength(line)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(240 * 1024);
    client.send(line);
    const listed = (await first) as Extract<SdkLinkMessage, { type: 'storageListResult' }>;
    expect(listed).toMatchObject({ type: 'storageListResult', code: 'ok', prefsTruncated: true });
    expect(listed.prefs).toHaveLength(120);
    expect(listed.prefs[0]!.name).toBe(prefs[0]!.name);
    expect(listed.databases).toHaveLength(16);

    // The link took it whole: the next request goes out and is answered on the same socket.
    const sockets = clients.length;
    const second = link.storage({ type: 'storageList' });
    await waitUntil(() => requests(client).length === 2);
    const secondId = requests(client)[1]!.requestId;
    expect(secondId).not.toBe(firstId);
    client.send({
      type: 'storageListResult',
      requestId: secondId,
      code: 'ok',
      prefs: [],
      prefsTruncated: false,
      databases: [],
    });
    await expect(second).resolves.toMatchObject({ type: 'storageListResult', code: 'ok' });
    expect(client.isClosed).toBe(false);
    expect(clients).toHaveLength(sockets);
    expect(target.links).toHaveLength(1);
  });
});

describe('late outcomes over a real socket', () => {
  /** The gateway wired to a StorageService the way server.ts does: a link with the proof, late answers to it. */
  async function wired() {
    let link: SdkLink | null = null;
    const broadcasts: unknown[] = [];
    const session = () => ({
      serial: 'emulator-fixture',
      packageName: 'com.example.shop',
      link,
      ready: true,
    });
    const service = new StorageService({
      consent: 'read_write',
      target: () => session() as StorageSessionTarget,
      broadcast: (message) => broadcasts.push(message),
    });
    const target: SdkLinkTarget = {
      attachSdk: (_hello, attached) => {
        link = attached;
        return {
          ok: true,
          mode: 'session',
          proof: 'a'.repeat(64),
          handler: {
            onMessage: (message) => {
              if (message.type === 'storageWriteResult') {
                service.onLateResult(session() as StorageSessionTarget, message);
              }
            },
            onInvalidDiagnostic: () => undefined,
            onClose: () => undefined,
          },
        };
      },
    };
    const gateway = createDeviceGateway({ port: 0, target });
    const { port } = await gateway.listen();
    const client = await DeviceClient.open(port);
    client.send({ ...HELLO, nonce: 'b'.repeat(32) });
    await client.waitFor((message) => message.type === 'welcome');
    await waitUntil(() => link !== null);
    return { gateway, client, service, broadcasts };
  }

  it('records the final answer that arrives in the same chunk as its provisional one', async () => {
    const { gateway, client, service, broadcasts } = await wired();
    try {
      const pending = service.write({
        store: 'prefs',
        name: 'app',
        op: 'update',
        key: 'count',
        expected: { t: 'int', v: '3' },
        value: { t: 'int', v: '4' },
      });
      await waitUntil(() => client.received.some((message) => message.type === 'storageWrite'));
      const request = client.received.find((message) => message.type === 'storageWrite') as unknown as {
        requestId: number;
        opId: string;
      };
      const base = {
        type: 'storageWriteResult',
        requestId: request.requestId,
        opId: request.opId,
        code: 'ok',
        memory: 'applied',
        observers: 'posted_unverified',
        stored: { t: 'int', v: '4' },
      };
      // provisional, final and a duplicate final in ONE write: one TCP chunk.
      client.write(
        [
          JSON.stringify({ ...base, phase: 'provisional', persisted: 'timeout' }),
          JSON.stringify({ ...base, phase: 'final', persisted: true }),
          JSON.stringify({ ...base, phase: 'final', persisted: false }),
        ].join('\n') + '\n',
      );
      const response = await pending;
      if (!response.ok || response.kind !== 'write') throw new Error('not a write');
      expect(response.outcome).toMatchObject({ phase: 'provisional', persisted: 'timeout' });
      expect(response.outcome.undo).toBeUndefined();
      await waitUntil(() => broadcasts.length === 1);
      expect(broadcasts[0]).toMatchObject({
        type: 'storageOutcome',
        outcome: { opId: request.opId, phase: 'final', persisted: true, late: false },
      });
      expect(service.auditEntries(request.opId).map((entry) => entry.phase)).toEqual([
        'provisional',
        'final',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(broadcasts).toHaveLength(1);
      expect(client.isClosed).toBe(false);
    } finally {
      client.socket.destroy();
      await gateway.close();
    }
  });
});

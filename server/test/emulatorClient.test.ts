import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '../src/emulator/discovery.ts';
import {
  createEmulatorClientFactory,
  EmulatorRpcError,
  limitReadAhead,
  loadEmulatorController,
} from '../src/emulator/emulatorClient.ts';
import type { EmulatorClient, ScreenFrame } from '../src/emulator/emulatorClient.ts';
import { FAKE_TOKEN, FakeEmulator, FIXTURE_PROTO } from './helpers/fakeEmulator.ts';

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('EmulatorController client', () => {
  const emulator = new FakeEmulator();
  const factory = createEmulatorClientFactory(loadEmulatorController(FIXTURE_PROTO));
  let port: number;
  let client: EmulatorClient;

  beforeAll(async () => {
    port = await emulator.start();
  });

  afterAll(() => emulator.stop());

  const connect = (token = FAKE_TOKEN): EmulatorClient => {
    client = factory({ port, token: new Secret(token) });
    return client;
  };

  afterEach(() => {
    client.close();
    emulator.rotation = 'PORTRAIT';
    emulator.displayConfigurations = true;
  });

  it('sends the token as a bearer header', async () => {
    expect(await connect().getStatus()).toEqual({ booted: true });
  });

  it('fails with UNAUTHENTICATED (16) for a wrong token, without the token in the message', async () => {
    const failure = connect('wrong-token').getStatus();
    await expect(failure).rejects.toBeInstanceOf(EmulatorRpcError);
    await expect(failure).rejects.toMatchObject({
      code: 16,
      message: expect.stringContaining('authorization'),
    });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining('wrong-token') });
    await expect(client.getDisplaySize()).rejects.toMatchObject({ code: 16 });
  });

  it('blanks control characters in error details and caps their length', async () => {
    emulator.statusFailure = { code: 13, details: `bad\u001b[31mred\u202e\n${'x'.repeat(500)}` };
    try {
      const error = await connect()
        .getStatus()
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(EmulatorRpcError);
      const message = (error as Error).message;
      expect(message).toMatch(/^getStatus failed: bad \[31mred {2}x+$/);
      expect(message.length).toBe('getStatus failed: '.length + 200);
    } finally {
      emulator.statusFailure = null;
    }
  });

  it('reads the natural display size, from a screenshot on emulators without display configurations', async () => {
    expect(await connect().getDisplaySize()).toEqual({ width: 1080, height: 2424, dpi: 420 });
    emulator.displayConfigurations = false;
    emulator.rotation = 'REVERSE_LANDSCAPE';
    expect(await client.getDisplaySize()).toEqual({ width: 1080, height: 2424, dpi: null });
  });

  it('takes full-size PNG screenshots, rotated like the screen', async () => {
    emulator.rotation = 'LANDSCAPE';
    const frame = await connect().getScreenshot();
    expect(frame).toMatchObject({ width: 2424, height: 1080, rotation: 270 });
    expect(frame.png.toString()).toBe('png 2424x1080');
    expect(emulator.screenshotRequests.at(-1)).toMatchObject({ format: 'PNG', width: 0, height: 0 });
  });

  it('streams scaled frames into the bounding box, skipping empty images, until cancelled', async () => {
    const frames: ScreenFrame[] = [];
    const ended: unknown[] = [];
    const stream = connect().streamScreenshot(
      { width: 540, height: 1212 },
      { onFrame: (frame) => frames.push(frame), onEnd: (error) => ended.push(error) },
    );
    await waitUntil(() => frames.length === 1);
    expect(emulator.streams.at(-1)?.request).toMatchObject({ format: 'PNG', width: 540, height: 1212 });
    emulator.pushFrame({ rotation: 'REVERSE_LANDSCAPE', width: 1212, height: 540 });
    await waitUntil(() => frames.length === 2);
    expect(frames.map(({ width, height, rotation }) => [width, height, rotation])).toEqual([
      [540, 1212, 0],
      [1212, 540, 90],
    ]);
    stream.cancel();
    await waitUntil(() => emulator.openStreams.length === 0);
    emulator.pushFrame();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toHaveLength(2);
    expect(ended).toEqual([]);
  });

  it('hands over nothing while paused, and the newest frame last once resumed', async () => {
    const frames: ScreenFrame[] = [];
    const stream = connect().streamScreenshot(
      { width: 540, height: 1212 },
      { onFrame: (frame) => frames.push(frame), onEnd: () => undefined },
    );
    await waitUntil(() => frames.length === 1);
    stream.pause();
    for (const width of [101, 102, 103]) emulator.pushFrame({ width, height: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toHaveLength(1);
    stream.resume();
    await waitUntil(() => frames.at(-1)?.width === 103);
    expect(frames[0]?.width).toBe(540);
    expect(frames.at(-1)?.width).toBe(103);
    // Paused and resumed after cancel: no effect, no frames.
    stream.cancel();
    stream.pause();
    stream.resume();
    const delivered = frames.length;
    await waitUntil(() => emulator.openStreams.length === 0);
    expect(frames).toHaveLength(delivered);
  });

  it('limits a paused stream to reading one message ahead (16 by default)', async () => {
    const readAhead = async (limit: boolean): Promise<number> => {
      let reads = 0;
      const stream = new Readable({
        objectMode: true,
        read() {
          reads += 1;
          setImmediate(() => this.push({ n: reads }));
        },
      });
      if (limit) limitReadAhead(stream);
      stream.on('data', () => undefined);
      stream.pause();
      await new Promise((resolve) => setTimeout(resolve, 30));
      stream.destroy();
      return reads;
    };
    expect(await readAhead(false)).toBe(16);
    expect(await readAhead(true)).toBe(1);
  });

  it('reports the end of a stream: null when the emulator closes it, the error otherwise', async () => {
    const ends: (EmulatorRpcError | null)[] = [];
    connect().streamScreenshot(
      { width: 1, height: 1 },
      { onFrame: () => undefined, onEnd: (error) => ends.push(error) },
    );
    await waitUntil(() => emulator.openStreams.length === 1);
    emulator.openStreams[0]?.call.end();
    await waitUntil(() => ends.length === 1);
    expect(ends).toEqual([null]);

    const denied: (EmulatorRpcError | null)[] = [];
    const other = factory({ port, token: new Secret('nope') });
    other.streamScreenshot(
      { width: 1, height: 1 },
      { onFrame: () => undefined, onEnd: (error) => denied.push(error) },
    );
    await waitUntil(() => denied.length === 1);
    expect(denied[0]).toMatchObject({ code: 16 });
    other.close();
  });

  it('writes input events on one stream', async () => {
    const ends: unknown[] = [];
    const input = connect().openInput((error) => ends.push(error));
    input.send({ touch_event: { touches: [{ x: 10, y: 20, identifier: 1, pressure: 1024 }], display: 0 } });
    input.send({ key_event: { eventType: 'keypress', key: 'GoBack' } });
    input.send({ key_event: { text: 'hi' } });
    await waitUntil(() => emulator.inputEvents.length === 3);
    expect(emulator.inputEvents.slice(-3)).toEqual([
      {
        touch_event: {
          touches: [expect.objectContaining({ x: 10, y: 20, identifier: 1, pressure: 1024 })],
          display: 0,
        },
      },
      { key_event: expect.objectContaining({ eventType: 'keypress', key: 'GoBack' }) },
      { key_event: expect.objectContaining({ text: 'hi' }) },
    ]);
    input.end();
    input.send({ key_event: { text: 'ignored' } });
    expect(ends).toEqual([]);

    const denied: unknown[] = [];
    factory({ port, token: new Secret('nope') }).openInput((error) => denied.push(error));
    await waitUntil(() => denied.length === 1);
    expect(denied[0]).toMatchObject({ code: 16 });
  });

  it('drops droppable events while the input stream is backed up, never the others', async () => {
    const input = connect().openInput(() => undefined);
    const before = emulator.inputEvents.length;
    const move = (y: number) => ({
      touch_event: { touches: [{ x: 1, y, identifier: 0, pressure: 1 }], display: 0 as const },
    });
    // Written in one go: the stream's buffer fills, so most moves are dropped; the key always goes out.
    for (let y = 0; y < 200; y += 1) input.send(move(y), true);
    input.send({ key_event: { text: 'last' } });
    await waitUntil(
      () => (emulator.inputEvents.at(-1)?.key_event as { text?: string } | undefined)?.text === 'last',
    );
    const received = emulator.inputEvents.length - before;
    expect(received).toBeLessThan(201);
    expect(received).toBeGreaterThan(1);
    // Once drained, moves go through again.
    input.send(move(500), true);
    await waitUntil(() => emulator.inputEvents.length === before + received + 1);
    input.end();
  });

  it('reads and sets the rotation, and shuts the emulator down gracefully', async () => {
    emulator.rotationZ = -90;
    expect(await connect().getRotationZ()).toBe(-90);
    await client.setRotationZ(180);
    expect(emulator.physicalModelWrites.at(-1)).toMatchObject({
      target: 'ROTATION',
      value: { data: [-4.75, 0, 180] },
      interpolation: 'STEP',
    });
    await client.shutdown();
    expect(emulator.vmStates).toEqual(['SHUTDOWN']);
  });

  it('reads the GPS fix and moves it, without the Location window overriding it', async () => {
    expect(await connect().getGps()).toEqual({ latitude: 37.422, longitude: -122.084 });
    await client.setGps({ latitude: -6.2088, longitude: 106.8456 });
    expect(emulator.gpsWrites.at(-1)).toMatchObject({
      passiveUpdate: false,
      latitude: -6.2088,
      longitude: 106.8456,
    });
    expect(await client.getGps()).toEqual({ latitude: -6.2088, longitude: 106.8456 });
  });

  it('refuses a proto without the EmulatorController service', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lionscope-proto-'));
    try {
      const other = path.join(dir, 'other.proto');
      writeFileSync(
        other,
        'syntax = "proto3";\npackage android.emulation.control;\nmessage X { int32 a = 1; }\n',
      );
      expect(() => loadEmulatorController(other)).toThrow('no EmulatorController service in the proto');
      expect(() => loadEmulatorController(path.join(dir, 'missing.proto'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

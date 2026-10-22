import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVideoPipeline,
  DECODER_FAILED_MESSAGE,
  DECODER_RETRY,
  decoderConfig,
  KEY_FRAME_REQUEST_MS,
  MAX_HELD_DELTAS,
  MAX_IN_FLIGHT,
  UNSUPPORTED_VIDEO_MESSAGE,
  webCodecsApi,
  type VideoPacket,
} from '../src/lib/videoDecoder.ts';
import type { FakeVideoFrame } from './screenFakes.ts';
import { CONFIG_PAYLOAD, DELTA_PAYLOAD, FakeChunk, FakeVideoDecoder, IDR_PAYLOAD } from './screenFakes.ts';

const packet = (kind: 'config' | 'key' | 'delta', pts = 0, payload?: number[]): VideoPacket => ({
  isConfig: kind === 'config',
  isKey: kind === 'key',
  pts,
  data: new Uint8Array(
    payload ?? (kind === 'config' ? CONFIG_PAYLOAD : kind === 'key' ? IDR_PAYLOAD : DELTA_PAYLOAD),
  ),
});

/** Lets `isConfigSupported` settle. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

let drawn: FakeVideoFrame[];
let unsupported: string[];
let failed: string[];
let keyRequests: number;

function pipeline(maxQueue?: number) {
  const api = webCodecsApi({ VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: FakeChunk } as never);
  if (api === null) throw new Error('fake WebCodecs not detected');
  return createVideoPipeline({
    api,
    draw: (frame) => drawn.push(frame as unknown as FakeVideoFrame),
    onUnsupported: (message) => unsupported.push(message),
    onFailed: (message) => failed.push(message),
    onKeyFrameNeeded: () => keyRequests++,
    ...(maxQueue !== undefined && { maxQueue }),
  });
}

/** A pipeline that has taken a config packet and is ready to decode. */
async function configured(maxQueue?: number) {
  const video = pipeline(maxQueue);
  video.push(packet('config'));
  await settle();
  return { video, decoder: FakeVideoDecoder.latest() };
}

const chunkTypes = (decoder: FakeVideoDecoder) => decoder.chunks.map((c) => `${c.type}@${c.timestamp}`);

beforeEach(() => {
  FakeVideoDecoder.reset();
  drawn = [];
  unsupported = [];
  failed = [];
  keyRequests = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('webCodecsApi', () => {
  it('needs VideoDecoder with isConfigSupported and EncodedVideoChunk', () => {
    expect(webCodecsApi({} as never)).toBeNull();
    expect(webCodecsApi({ VideoDecoder: FakeVideoDecoder } as never)).toBeNull();
    expect(webCodecsApi({ VideoDecoder: class {}, EncodedVideoChunk: FakeChunk } as never)).toBeNull();
    expect(
      webCodecsApi({ VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: FakeChunk } as never),
    ).not.toBeNull();
  });
});

describe('createVideoPipeline', () => {
  it('configures from the SPS for Annex B with low latency and no description', async () => {
    const { decoder } = await configured();
    expect(decoder.configs).toEqual([decoderConfig('avc1.640028')]);
    expect(decoder.configs[0]).toEqual({
      codec: 'avc1.640028',
      optimizeForLatency: true,
      hardwareAcceleration: 'no-preference',
    });
    expect(decoder.configs[0]).not.toHaveProperty('description');
  });

  it('decodes key and delta chunks with their PTS, SPS / PPS prepended to the key frame', async () => {
    const { video, decoder } = await configured();
    video.push(packet('key', 1000));
    video.push(packet('delta', 17_000));
    expect(chunkTypes(decoder)).toEqual(['key@1000', 'delta@17000']);
    expect([...(decoder.chunks[0]?.data ?? [])]).toEqual([...CONFIG_PAYLOAD, ...IDR_PAYLOAD]);
    expect([...(decoder.chunks[1]?.data ?? [])]).toEqual(DELTA_PAYLOAD);
  });

  it('does not prepend SPS / PPS to a key frame that carries its own', async () => {
    const { video, decoder } = await configured();
    const selfContained = [...CONFIG_PAYLOAD, ...IDR_PAYLOAD];
    video.push(packet('key', 1000, selfContained));
    expect([...(decoder.chunks[0]?.data ?? [])]).toEqual(selfContained);
  });

  it('decodes the key frame that arrives while the codec is still being checked (the usual order)', async () => {
    const video = pipeline();
    video.push(packet('config'));
    video.push(packet('key', 1));
    video.push(packet('delta', 2));
    expect(FakeVideoDecoder.instances).toHaveLength(0);
    await settle();
    const decoder = FakeVideoDecoder.latest();
    expect(chunkTypes(decoder)).toEqual(['key@1', 'delta@2']);
    expect([...(decoder.chunks[0]?.data ?? [])].slice(0, CONFIG_PAYLOAD.length)).toEqual(CONFIG_PAYLOAD);
    video.push(packet('delta', 3));
    expect(chunkTypes(decoder)).toEqual(['key@1', 'delta@2', 'delta@3']);
    expect(video.dropped).toBe(0);
  });

  it('while waiting, holds only the newest key frame and the deltas after it, bounded', async () => {
    const video = pipeline();
    video.push(packet('key', 0));
    video.push(packet('config'));
    video.push(packet('delta', 1));
    video.push(packet('key', 2));
    video.push(packet('delta', 3));
    video.push(packet('key', 4));
    video.push(packet('delta', 5));
    await settle();
    expect(chunkTypes(FakeVideoDecoder.latest())).toEqual(['key@4', 'delta@5']);
    // Media before any config, a delta without a key, and the superseded key + delta.
    expect(video.dropped).toBe(4);

    FakeVideoDecoder.reset();
    const overfull = pipeline();
    overfull.push(packet('config'));
    overfull.push(packet('key', 0));
    for (let i = 1; i <= MAX_HELD_DELTAS + 1; i++) overfull.push(packet('delta', i));
    overfull.push(packet('delta', 999));
    await settle();
    // The chain broke past the bound: nothing decodes until the next key frame.
    expect(FakeVideoDecoder.latest().chunks).toEqual([]);
    overfull.push(packet('key', 1000));
    expect(chunkTypes(FakeVideoDecoder.latest())).toEqual(['key@1000']);
  });

  it('a delta after the key frame is decoded only after that key', async () => {
    const { video, decoder } = await configured();
    video.push(packet('delta', 1));
    video.push(packet('key', 2));
    video.push(packet('delta', 3));
    expect(chunkTypes(decoder)).toEqual(['key@2', 'delta@3']);
    expect(video.dropped).toBe(1);
  });

  it('draws each decoded frame and always closes it', async () => {
    const { video, decoder } = await configured();
    video.push(packet('key', 1));
    const frame = decoder.emit();
    expect(drawn).toEqual([frame]);
    expect(frame.closed).toBe(true);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = createVideoPipeline({
      api: webCodecsApi({ VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: FakeChunk } as never)!,
      draw: () => {
        throw new Error('canvas gone');
      },
      onUnsupported: () => {},
      onFailed: () => {},
    });
    failing.push(packet('config'));
    await settle();
    expect(FakeVideoDecoder.latest().emit().closed).toBe(true);
  });

  it('closes frames that land after dispose without drawing them, and closes the decoder', async () => {
    const { video, decoder } = await configured();
    video.dispose();
    expect(decoder.state).toBe('closed');
    const late = decoder.emit();
    expect(late.closed).toBe(true);
    expect(drawn).toEqual([]);
  });

  it('under backpressure drops delta frames until the next key frame', async () => {
    const { video, decoder } = await configured(2);
    video.push(packet('key', 1));
    video.push(packet('delta', 2));
    decoder.decodeQueueSize = 3;
    video.push(packet('delta', 3));
    decoder.decodeQueueSize = 0;
    // The queue drained, but the chain is broken until a key frame.
    video.push(packet('delta', 4));
    video.push(packet('key', 5));
    video.push(packet('delta', 6));
    expect(chunkTypes(decoder)).toEqual(['key@1', 'delta@2', 'key@5', 'delta@6']);
    expect(video.dropped).toBe(2);
  });

  it('a new config resets and reconfigures, and waits for its key frame', async () => {
    const { video, decoder } = await configured();
    video.push(packet('key', 1));
    const landscape = [0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0xab, 0, 0, 0, 1, 0x68, 0xee];
    video.push(packet('config', 0, landscape));
    await settle();
    video.push(packet('delta', 2));
    video.push(packet('key', 3));
    expect(decoder.resets).toBe(1);
    expect(decoder.configs.map((c) => c.codec)).toEqual(['avc1.640028', 'avc1.4D401F']);
    expect(chunkTypes(decoder)).toEqual(['key@1', 'key@3']);
    expect([...(decoder.chunks[1]?.data ?? [])].slice(0, landscape.length)).toEqual(landscape);
  });

  it('reset (a new screenInfo) flushes the decoder and waits for the next key frame', async () => {
    const { video, decoder } = await configured();
    video.push(packet('key', 1));
    video.push(packet('delta', 2));
    video.reset();
    expect(decoder.resets).toBe(1);
    expect(decoder.configs).toHaveLength(2);
    video.push(packet('delta', 3));
    video.push(packet('key', 4));
    expect(chunkTypes(decoder)).toEqual(['key@1', 'delta@2', 'key@4']);
    expect([...(decoder.chunks[2]?.data ?? [])].slice(0, CONFIG_PAYLOAD.length)).toEqual(CONFIG_PAYLOAD);
    // The session's own config (known codec: no second isConfigSupported round trip) resets once more.
    video.push(packet('config'));
    video.push(packet('delta', 5));
    video.push(packet('key', 6));
    expect(decoder.resets).toBe(2);
    expect(chunkTypes(decoder)).toEqual(['key@1', 'delta@2', 'key@4', 'key@6']);
  });

  it('reset before any config is harmless', () => {
    const video = pipeline();
    video.reset();
    video.push(packet('key', 1));
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('recovers from a decoder error with a fresh decoder after a backoff, keeping the key frame', async () => {
    vi.useFakeTimers();
    const { video, decoder } = await configured();
    video.push(packet('key', 1));
    decoder.fail();
    expect(FakeVideoDecoder.instances).toHaveLength(1);
    video.push(packet('key', 2));
    video.push(packet('delta', 3));
    vi.advanceTimersByTime(DECODER_RETRY.baseDelayMs);
    const fresh = FakeVideoDecoder.latest();
    expect(fresh).not.toBe(decoder);
    expect(fresh.configs.map((c) => c.codec)).toEqual(['avc1.640028']);
    // The frames that came during the backoff decode at once, SPS / PPS first.
    expect(chunkTypes(fresh)).toEqual(['key@2', 'delta@3']);
    expect([...(fresh.chunks[0]?.data ?? [])].slice(0, CONFIG_PAYLOAD.length)).toEqual(CONFIG_PAYLOAD);
  });

  it('a decode that throws gets the same fresh-decoder recovery', async () => {
    vi.useFakeTimers();
    const { video, decoder } = await configured();
    vi.spyOn(decoder, 'decode').mockImplementationOnce(() => {
      throw new DOMException('bad', 'DataError');
    });
    video.push(packet('key', 1));
    expect(decoder.state).toBe('closed');
    video.push(packet('delta', 2));
    video.push(packet('key', 3));
    vi.advanceTimersByTime(DECODER_RETRY.baseDelayMs);
    expect(chunkTypes(FakeVideoDecoder.latest())).toEqual(['key@3']);
  });

  it('gives up at the third failure in a row, and a decoded frame resets the count', async () => {
    vi.useFakeTimers();
    const { video } = await configured();
    const failAndRetry = (delayMs: number) => {
      FakeVideoDecoder.latest().fail();
      vi.advanceTimersByTime(delayMs - 1);
      const before = FakeVideoDecoder.instances.length;
      vi.advanceTimersByTime(1);
      expect(FakeVideoDecoder.instances).toHaveLength(before + 1);
    };
    failAndRetry(250);
    failAndRetry(500);
    // A frame came through: the decoder works, so the next failure starts over.
    video.push(packet('key', 1));
    FakeVideoDecoder.latest().emit();
    failAndRetry(250);
    failAndRetry(500);
    expect(failed).toEqual([]);
    FakeVideoDecoder.latest().fail();
    expect(failed).toEqual([DECODER_FAILED_MESSAGE]);
    const count = FakeVideoDecoder.instances.length;
    vi.advanceTimersByTime(60_000);
    video.push(packet('config'));
    expect(FakeVideoDecoder.instances).toHaveLength(count);
  });

  it('stops instead of looping when every configure fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(FakeVideoDecoder.prototype, 'configure').mockImplementation(function (this: FakeVideoDecoder) {
      this.state = 'configured';
      // A real decoder reports a bad configuration asynchronously, through the error callback.
      queueMicrotask(() => this.fail());
    });
    const video = pipeline();
    video.push(packet('config'));
    video.push(packet('key', 1));
    await vi.runAllTimersAsync();
    expect(failed).toEqual([DECODER_FAILED_MESSAGE]);
    expect(FakeVideoDecoder.instances).toHaveLength(DECODER_RETRY.maxFailures);
    expect(FakeVideoDecoder.instances.every((d) => d.state === 'closed')).toBe(true);
  });

  it('ignores errors from a decoder it already replaced', async () => {
    vi.useFakeTimers();
    const { decoder } = await configured();
    decoder.fail();
    vi.advanceTimersByTime(DECODER_RETRY.baseDelayMs);
    const fresh = FakeVideoDecoder.latest();
    decoder.error(new DOMException('late', 'EncodingError'));
    decoder.error(new DOMException('late', 'EncodingError'));
    expect(fresh.state).toBe('configured');
    expect(failed).toEqual([]);
  });

  it('a NotSupportedError from the decoder means the codec is unsupported', async () => {
    const { decoder } = await configured();
    decoder.error(new DOMException('no H.264 decoder', 'NotSupportedError'));
    expect(unsupported).toEqual([UNSUPPORTED_VIDEO_MESSAGE]);
    expect(failed).toEqual([]);
  });

  it('reports an unsupported codec once and stops', async () => {
    FakeVideoDecoder.support = false;
    const video = pipeline();
    video.push(packet('config'));
    await settle();
    video.push(packet('config'));
    await settle();
    expect(unsupported).toEqual([UNSUPPORTED_VIDEO_MESSAGE]);
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('treats a rejected isConfigSupported (invalid codec string) as unsupported', async () => {
    vi.spyOn(FakeVideoDecoder, 'isConfigSupported').mockRejectedValueOnce(new TypeError('bad codec'));
    const video = pipeline();
    video.push(packet('config'));
    await settle();
    expect(unsupported).toEqual([UNSUPPORTED_VIDEO_MESSAGE]);
  });

  it('ignores a config without an SPS', async () => {
    const video = pipeline();
    video.push(packet('config', 0, IDR_PAYLOAD));
    await settle();
    expect(FakeVideoDecoder.instances).toHaveLength(0);
    expect(unsupported).toEqual([]);
  });

  it('asks for a key frame when the chain breaks, not on a normal start', async () => {
    vi.useFakeTimers();
    const { video, decoder } = await configured(2);
    video.push(packet('key', 1));
    video.push(packet('delta', 2));
    expect(keyRequests).toBe(0);
    // Backpressure drop.
    decoder.decodeQueueSize = 3;
    video.push(packet('delta', 3));
    expect(keyRequests).toBe(1);
    // Within the throttle window: one trailing request when it ends, if still waiting.
    decoder.decodeQueueSize = 0;
    video.push(packet('delta', 4));
    video.push(packet('delta', 5));
    expect(keyRequests).toBe(1);
    vi.advanceTimersByTime(KEY_FRAME_REQUEST_MS);
    expect(keyRequests).toBe(2);
    // The key frame came: no trailing request.
    vi.advanceTimersByTime(KEY_FRAME_REQUEST_MS);
    video.push(packet('delta', 6));
    expect(keyRequests).toBe(3);
    video.push(packet('key', 7));
    vi.advanceTimersByTime(KEY_FRAME_REQUEST_MS * 4);
    expect(keyRequests).toBe(3);
  });

  it('asks for a key frame after a decoder error and a lost first key frame, never on a reset', async () => {
    vi.useFakeTimers();
    const { video } = await configured();
    video.push(packet('key', 1));
    // A screenInfo (the server's answer to a request, too) brings its own config and key frame.
    video.reset();
    video.push(packet('config'));
    video.push(packet('key', 2));
    vi.advanceTimersByTime(KEY_FRAME_REQUEST_MS * 4);
    expect(keyRequests).toBe(0);
    FakeVideoDecoder.latest().fail();
    expect(keyRequests).toBe(1);

    FakeVideoDecoder.reset();
    keyRequests = 0;
    const lost = pipeline();
    lost.push(packet('config'));
    // The key frame went missing: the first delta while configuring asks for another.
    lost.push(packet('delta', 1));
    expect(keyRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeVideoDecoder.latest().chunks).toEqual([]);
  });

  it('counts chunks in flight and drops deltas when too many never come out', async () => {
    const { video, decoder } = await configured();
    video.push(packet('key', 0));
    for (let i = 1; i <= MAX_IN_FLIGHT; i++) video.push(packet('delta', i));
    expect(video.inFlight).toBe(MAX_IN_FLIGHT + 1);
    // decodeQueueSize stays 0 (the decoder holds frames for reordering), but output lags too far.
    video.push(packet('delta', 999));
    expect(decoder.chunks).toHaveLength(MAX_IN_FLIGHT + 1);
    decoder.emit();
    expect(video.inFlight).toBe(MAX_IN_FLIGHT);
  });
});

/**
 * The physical-device mirror's H.264 pipeline on WebCodecs: config packets (re)configure a `VideoDecoder`,
 * access units decode as chunks, decoded frames go to `draw` and are always closed. Lag never builds up:
 * when the decoder's queue grows past a few chunks, delta frames are dropped until the next key frame.
 * Works on Chrome, Safari 16.4+ and Firefox 130+ (no Chrome-only APIs, no `requestVideoFrameCallback`).
 */
import { codecFromConfig, concatBytes, hasNalType, NAL_TYPE } from './h264.ts';

export const UNSUPPORTED_VIDEO_MESSAGE =
  'This browser can’t decode H.264 video: use Chrome, Firefox 130+ or Safari 16.4+';

/** WebCodecs only exists on secure pages: a LAN address over plain http gets none. */
export const INSECURE_VIDEO_MESSAGE = 'Open the dashboard on localhost (WebCodecs needs a secure page)';

export const DECODER_FAILED_MESSAGE = 'The video decoder keeps failing on this stream';

/** Chunks waiting in the decoder before delta frames are dropped (about 50 ms at 60 fps). */
export const MAX_DECODE_QUEUE = 3;

/**
 * Chunks sent but not yet output before delta frames are dropped. Generous: a decoder may hold up to a
 * DPB's worth (16) for reordering when the SPS has no bitstream_restriction (seen as a Firefox risk).
 */
export const MAX_IN_FLIGHT = 30;

/** At most one key frame request (`keyFrame`) per this long; a later need is sent when it ends. */
export const KEY_FRAME_REQUEST_MS = 500;

/**
 * Held while the decoder is being configured (support check, retry backoff): the newest key frame and up to
 * this many deltas after it, about a second at 60 fps. More breaks the chain, so the whole hold is dropped.
 */
export const MAX_HELD_DELTAS = 60;

/** Why the video can't be shown; `canRetry` when a fresh stream may work (not for a missing codec). */
export interface VideoError {
  message: string;
  canRetry: boolean;
}

/**
 * Consecutive decoder failures without a decoded frame in between: retried with backoff (250, 500 ms), and
 * the pipeline gives up at the third.
 */
export const DECODER_RETRY = { maxFailures: 3, baseDelayMs: 250 } as const;

export interface VideoPacket {
  isConfig: boolean;
  isKey: boolean;
  /** Microseconds; 0 for config packets. */
  pts: number;
  /** Annex B, start codes included. */
  data: Uint8Array;
}

/** The subset of `VideoDecoder` used here. */
export interface VideoDecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  reset(): void;
  close(): void;
}

/** The subset of `VideoFrame` used here. */
export interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

export interface WebCodecsApi {
  createDecoder(output: (frame: VideoFrame) => void, error: (error: DOMException) => void): VideoDecoderLike;
  createChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
  isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
}

/** Why `webCodecsApi` found nothing: an insecure page hides WebCodecs even in browsers that have it. */
export function videoUnavailableMessage(scope: typeof globalThis = globalThis): string {
  return scope.isSecureContext === false ? INSECURE_VIDEO_MESSAGE : UNSUPPORTED_VIDEO_MESSAGE;
}

/** The browser's WebCodecs, or null when it has none (or lacks `isConfigSupported`, so support is unknowable). */
export function webCodecsApi(scope: typeof globalThis = globalThis): WebCodecsApi | null {
  const Decoder = (scope as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
  const Chunk = (scope as { EncodedVideoChunk?: typeof EncodedVideoChunk }).EncodedVideoChunk;
  if (typeof Decoder !== 'function' || typeof Chunk !== 'function') return null;
  if (typeof Decoder.isConfigSupported !== 'function') return null;
  return {
    createDecoder: (output, error) => new Decoder({ output, error }),
    createChunk: (init) => new Chunk(init),
    isConfigSupported: (config) => Decoder.isConfigSupported(config),
  };
}

/** Annex B input: no `description`, so SPS / PPS travel in-band (prepended to key frames below). */
export function decoderConfig(codec: string): VideoDecoderConfig {
  return { codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' };
}

export interface VideoPipelineOptions {
  api: WebCodecsApi;
  draw: (frame: VideoFrame) => void;
  /** The browser can't decode this stream; the pipeline stops. */
  onUnsupported: (message: string) => void;
  /** The decoder failed again and again; the pipeline stops (a fresh pipeline may do better). */
  onFailed: (message: string) => void;
  /** The decoder lost the chain and waits for a key frame: ask the device for one. Throttled here. */
  onKeyFrameNeeded?: () => void;
  maxQueue?: number;
  now?: () => number;
}

export interface VideoPipeline {
  push(packet: VideoPacket): void;
  /** A new capture session (rotation, size): flush the decoder and wait for the next key frame. */
  reset(): void;
  /** Access units dropped so far (waiting for a key frame, backpressure, or an overfull hold). */
  readonly dropped: number;
  /** Chunks sent to the decoder and not output yet. */
  readonly inFlight: number;
  dispose(): void;
}

export function createVideoPipeline(options: VideoPipelineOptions): VideoPipeline {
  const { api, draw, onUnsupported, onFailed, onKeyFrameNeeded } = options;
  const maxQueue = options.maxQueue ?? MAX_DECODE_QUEUE;
  const now = options.now ?? Date.now;
  const supported = new Set<string>();
  let decoder: VideoDecoderLike | null = null;
  /** The SPS / PPS the decoder runs with; null until a config packet is accepted. */
  let config: Uint8Array | null = null;
  let codec: string | null = null;
  let isConfigured = false;
  let needsKey = true;
  let isStopped = false;
  let dropped = 0;
  let inFlight = 0;
  /** Bumped by every new config, so a late `isConfigSupported` answer can’t apply a stale one. */
  let generation = 0;
  /** A key frame and the deltas after it, waiting for the decoder to be configured. */
  let held: VideoPacket[] = [];
  /** Decoder failures since the last decoded frame. */
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastKeyRequest = -Infinity;
  let keyRequestTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** Throttled: a need inside the window is sent when it ends, if a key frame is still missing. */
  const requestKeyFrame = () => {
    if (onKeyFrameNeeded === undefined || isStopped || keyRequestTimer !== null) return;
    const wait = lastKeyRequest + KEY_FRAME_REQUEST_MS - now();
    if (wait <= 0) {
      lastKeyRequest = now();
      onKeyFrameNeeded();
      return;
    }
    keyRequestTimer = setTimeout(() => {
      keyRequestTimer = null;
      if (needsKey) requestKeyFrame();
    }, wait);
  };

  /** The chain is broken: nothing but a key frame decodes now. */
  const waitForKey = () => {
    needsKey = true;
    requestKeyFrame();
  };

  const dropHeld = () => {
    dropped += held.length;
    held = [];
  };

  const stop = () => {
    isStopped = true;
    clearRetry();
    if (keyRequestTimer !== null) clearTimeout(keyRequestTimer);
    keyRequestTimer = null;
    held = [];
    const current = decoder;
    decoder = null;
    if (current !== null && current.state !== 'closed') current.close();
  };

  const giveUp = (message: string, report: (message: string) => void) => {
    stop();
    report(message);
  };

  const onOutput = (frame: VideoFrame) => {
    try {
      if (isStopped) return;
      failures = 0;
      inFlight = Math.max(0, inFlight - 1);
      draw(frame);
    } catch (error) {
      console.error('Lionscope: could not draw a video frame', error);
    } finally {
      frame.close();
    }
  };

  /** The decoder is unusable: retry with a fresh one after a backoff, holding frames meanwhile. */
  const fail = (error: unknown) => {
    if (isStopped) return;
    console.warn('Lionscope: the video decoder failed', error);
    const current = decoder;
    decoder = null;
    isConfigured = false;
    inFlight = 0;
    if (current !== null && current.state !== 'closed') current.close();
    if (error instanceof DOMException && error.name === 'NotSupportedError') {
      giveUp(UNSUPPORTED_VIDEO_MESSAGE, onUnsupported);
      return;
    }
    failures++;
    if (failures >= DECODER_RETRY.maxFailures) {
      giveUp(DECODER_FAILED_MESSAGE, onFailed);
      return;
    }
    waitForKey();
    clearRetry();
    retryTimer = setTimeout(configure, DECODER_RETRY.baseDelayMs * 2 ** (failures - 1));
  };

  const ensureDecoder = (): VideoDecoderLike => {
    if (decoder !== null && decoder.state !== 'closed') return decoder;
    // Errors from a decoder already replaced (closed by a reset) are not this one's.
    const created = api.createDecoder(onOutput, (error) => {
      if (decoder === created) fail(error);
    });
    decoder = created;
    return created;
  };

  function configure() {
    clearRetry();
    needsKey = true;
    if (isStopped || codec === null || !supported.has(codec)) return;
    const target = ensureDecoder();
    try {
      if (target.state === 'configured') target.reset();
      target.configure(decoderConfig(codec));
      isConfigured = true;
      inFlight = 0;
    } catch (error) {
      fail(error);
      return;
    }
    const queued = held;
    held = [];
    for (const packet of queued) decode(packet);
  }

  /** Not configured yet but about to be: keep the newest key frame and its deltas, bounded. */
  const hold = (packet: VideoPacket) => {
    if (packet.isKey) {
      dropHeld();
      held = [packet];
      return;
    }
    if (held.length > 0 && held.length <= MAX_HELD_DELTAS) {
      held = [...held, packet];
      return;
    }
    // No key frame to build on (lost, or the hold overflowed): wait for, and ask for, the next one.
    dropHeld();
    dropped++;
    requestKeyFrame();
  };

  const acceptConfig = (data: Uint8Array) => {
    const next = codecFromConfig(data);
    if (next === null) return;
    generation++;
    config = data.slice();
    codec = next;
    isConfigured = false;
    dropHeld();
    if (supported.has(next)) {
      configure();
      return;
    }
    needsKey = true;
    const asked = generation;
    api.isConfigSupported(decoderConfig(next)).then(
      (support) => {
        if (isStopped || asked !== generation) return;
        if (support.supported !== true) {
          giveUp(UNSUPPORTED_VIDEO_MESSAGE, onUnsupported);
          return;
        }
        supported.add(next);
        configure();
      },
      () => {
        if (isStopped || asked !== generation) return;
        giveUp(UNSUPPORTED_VIDEO_MESSAGE, onUnsupported);
      },
    );
  };

  function decode(packet: VideoPacket) {
    const target = decoder;
    if (!isConfigured || target === null || target.state !== 'configured') {
      if (codec === null) dropped++;
      else hold(packet);
      return;
    }
    if (!packet.isKey) {
      const isBehind = target.decodeQueueSize > maxQueue || inFlight > MAX_IN_FLIGHT;
      if (needsKey || isBehind) {
        dropped++;
        waitForKey();
        return;
      }
    }
    // Decoders on every engine need SPS / PPS before an IDR in Annex B mode; scrcpy sends them apart.
    const data =
      packet.isKey && config !== null && !hasNalType(packet.data, NAL_TYPE.sps)
        ? concatBytes(config, packet.data)
        : packet.data;
    try {
      target.decode(api.createChunk({ type: packet.isKey ? 'key' : 'delta', timestamp: packet.pts, data }));
      inFlight++;
      if (packet.isKey) needsKey = false;
    } catch (error) {
      // E.g. a key frame the decoder rejects: a fresh decoder waits for the next one.
      fail(error);
    }
  }

  return {
    push(packet) {
      if (isStopped) return;
      if (packet.isConfig) acceptConfig(packet.data);
      else decode(packet);
    },
    // The last SPS / PPS stay: if the session's config came before its screenInfo it is already the new
    // one; if it comes after, it replaces them. Either way nothing decodes until a key frame. No key frame
    // request here: the server sends a config and a key frame after every screenInfo, and answers a
    // request with a new screenInfo, so asking would loop.
    reset() {
      if (isStopped) return;
      isConfigured = false;
      dropHeld();
      configure();
    },
    get dropped() {
      return dropped;
    },
    get inFlight() {
      return inFlight;
    },
    dispose: stop,
  };
}

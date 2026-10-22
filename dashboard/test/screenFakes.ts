/**
 * Fakes for the screen mirror: a WebSocket, binary frames and video packets, and the canvas / ImageBitmap /
 * WebCodecs APIs jsdom lacks.
 */
import { vi } from 'vitest';
import type { EmulatorInfo, ScreenServerMessage } from '@lionscope/protocol/wire';
import { SCREEN_BINARY_KIND, SCREEN_VIDEO_FLAG, SCREEN_VIDEO_HEADER_BYTES } from '@lionscope/protocol/wire';
import type { ScreenSocketLike } from '../src/lib/screenSocket.ts';

export class FakeScreenSocket implements ScreenSocketLike {
  static instances: FakeScreenSocket[] = [];
  readyState = 0;
  binaryType: BinaryType = 'blob';
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeScreenSocket.instances.push(this);
  }

  static latest(): FakeScreenSocket {
    const socket = FakeScreenSocket.instances[FakeScreenSocket.instances.length - 1];
    if (!socket) throw new Error('no screen socket was opened');
    return socket;
  }

  static reset() {
    FakeScreenSocket.instances = [];
  }

  /** Parsed JSON messages sent so far. */
  allMessages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown);
  }

  /** Sent messages without the `clipboardSync` setting every open socket starts with. */
  messages(): unknown[] {
    return this.allMessages().filter((msg) => (msg as { type: string }).type !== 'clipboardSync');
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  receiveJson(msg: ScreenServerMessage) {
    this.receive(JSON.stringify(msg));
  }

  drop() {
    this.readyState = 3;
    this.onerror?.(new Event('error'));
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

/** One binary screen message: the kind byte, then (fake) PNG bytes. */
export function binaryMessage(kind: keyof typeof SCREEN_BINARY_KIND, payload = [0x89, 0x50, 0x4e, 0x47]) {
  return new Uint8Array([SCREEN_BINARY_KIND[kind], ...payload]).buffer;
}

export const SCREEN_INFO: ScreenServerMessage = {
  type: 'screenInfo',
  serial: 'emulator-5554',
  codec: 'png',
  displayWidth: 1080,
  displayHeight: 2424,
  rotation: 0,
  frameWidth: 540,
  frameHeight: 1212,
};

export function emulator(overrides: Partial<EmulatorInfo> = {}): EmulatorInfo {
  return {
    avdName: 'Pixel_9a',
    displayName: 'Pixel 9a',
    state: 'running',
    serial: 'emulator-5554',
    managed: false,
    canMirror: true,
    renderer: 'host',
    ...overrides,
  };
}

export interface CanvasStubs {
  drawImage: ReturnType<typeof vi.fn>;
  closed: ReturnType<typeof vi.fn>;
}

/**
 * jsdom has no 2D context, no ImageBitmap and lays nothing out: the canvas gets a 2D context spy, a
 * 270 × 606 box at (10, 20), and decoded frames are 540 × 1212 (the box shows them at half size).
 */
export function installCanvasStubs(): CanvasStubs {
  const drawImage = vi.fn();
  const closed = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 10, top: 20, width: 270, height: 606, right: 280, bottom: 626, x: 10, y: 20 }) as DOMRect,
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 540, height: 1212, close: closed })),
  );
  return { drawImage, closed };
}

/** SPS (High 4.0) and PPS NAL units, Annex B, as a config packet carries them. */
export const CONFIG_PAYLOAD = [
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80,
];
export const IDR_PAYLOAD = [0, 0, 0, 1, 0x65, 0x88, 0x84];
export const DELTA_PAYLOAD = [0, 0, 0, 1, 0x41, 0x9a, 0x02];

/** One binary `video` message: kind byte, flags byte, PTS (µs, big-endian float64), Annex B payload. */
export function videoMessage(flags: { config?: boolean; key?: boolean }, pts: number, payload: number[]) {
  const bytes = new Uint8Array(SCREEN_VIDEO_HEADER_BYTES + payload.length);
  bytes[0] = SCREEN_BINARY_KIND.video;
  bytes[1] = (flags.config ? SCREEN_VIDEO_FLAG.config : 0) | (flags.key ? SCREEN_VIDEO_FLAG.key : 0);
  new DataView(bytes.buffer).setFloat64(2, pts, false);
  bytes.set(payload, SCREEN_VIDEO_HEADER_BYTES);
  return bytes.buffer;
}

export const DEVICE_SCREEN_INFO: Extract<ScreenServerMessage, { type: 'screenInfo' }> = {
  type: 'screenInfo',
  serial: 'R58M123ABC',
  codec: 'h264',
  displayWidth: 1080,
  displayHeight: 2400,
  rotation: 0,
  frameWidth: 540,
  frameHeight: 1200,
};

export class FakeVideoFrame {
  closed = false;
  constructor(
    readonly displayWidth = 540,
    readonly displayHeight = 1200,
  ) {}
  close() {
    this.closed = true;
  }
}

export class FakeChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly data: Uint8Array;
  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = new Uint8Array(init.data as ArrayBuffer);
  }
}

/** A `VideoDecoder` that records calls; tests emit frames and errors through its callbacks. */
export class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  static support = true;
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  configs: VideoDecoderConfig[] = [];
  chunks: FakeChunk[] = [];
  resets = 0;
  readonly output: (frame: VideoFrame) => void;
  readonly error: (error: DOMException) => void;

  constructor(init: VideoDecoderInit) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }

  static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
    return Promise.resolve({ supported: FakeVideoDecoder.support, config });
  }

  static latest(): FakeVideoDecoder {
    const decoder = FakeVideoDecoder.instances[FakeVideoDecoder.instances.length - 1];
    if (!decoder) throw new Error('no video decoder was created');
    return decoder;
  }

  static reset() {
    FakeVideoDecoder.instances = [];
    FakeVideoDecoder.support = true;
  }

  configure(config: VideoDecoderConfig) {
    this.configs.push(config);
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk) {
    this.chunks.push(chunk as unknown as FakeChunk);
  }

  reset() {
    this.resets++;
    this.state = 'unconfigured';
  }

  close() {
    this.state = 'closed';
  }

  /** Emits a decoded frame, as the browser does after `decode`. */
  emit(frame = new FakeVideoFrame()): FakeVideoFrame {
    this.output(frame as unknown as VideoFrame);
    return frame;
  }

  /** Fails like a real decoder: closed, then the error callback. */
  fail() {
    this.state = 'closed';
    this.error(new DOMException('decode failed', 'EncodingError'));
  }
}

/** Installs the fake WebCodecs globals the physical-device mirror needs. */
export function installWebCodecs() {
  FakeVideoDecoder.reset();
  vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
}

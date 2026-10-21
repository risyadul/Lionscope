/** Fakes for the screen mirror: a WebSocket, binary frames and the canvas / ImageBitmap APIs jsdom lacks. */
import { vi } from 'vitest';
import type { EmulatorInfo, ScreenServerMessage } from '@lionscope/protocol/wire';
import { SCREEN_BINARY_KIND } from '@lionscope/protocol/wire';
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

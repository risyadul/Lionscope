import type {
  ClipboardStreamHandlers,
  EmulatorClient,
  EmulatorRpcError,
  FrameStream,
  FrameStreamHandlers,
  GpsPoint,
  InputStream,
  ScreenFrame,
} from '../../src/emulator/emulatorClient.ts';
import type { ScreenSocket } from '../../src/emulator/screenSession.ts';
import type { DisplaySize, EmulatorInputEvent, Size } from '../../src/emulator/screenInput.ts';

/** An in-memory EmulatorClient: tests drive the streams by hand. */
export class FakeEmulatorClient implements EmulatorClient {
  display: DisplaySize | Error = { width: 1080, height: 2424, dpi: 420 };
  booted: boolean | Error = true;
  rotationZ = 0;
  screenshot: ScreenFrame | Error = { width: 1080, height: 2424, rotation: 0, png: Buffer.from('full') };
  shutdownResult: Error | 'hang' | null = null;
  /** Screenshot streams as opened; `paused` follows pause()/resume(), `resumes` counts the resumes. */
  readonly streams: {
    box: Size;
    handlers: FrameStreamHandlers;
    cancelled: boolean;
    paused: boolean;
    resumes: number;
  }[] = [];
  /**
   * Input streams as opened. Like grpc-js, a stream starts on a later tick: closing the client before then
   * cancels it (its events are lost, `cancelled`). After end() the emulator answers (`onEnd(null)`) on a later
   * tick unless `answersEnd` is false.
   */
  readonly inputs: {
    events: EmulatorInputEvent[];
    droppable: boolean[];
    started: boolean;
    ended: boolean;
    cancelled: boolean;
    onEnd: (error: EmulatorRpcError | null) => void;
  }[] = [];
  answersEnd = true;
  readonly rotations: number[] = [];
  shutdowns = 0;
  closed = false;

  get stream(): (typeof this.streams)[number] | undefined {
    return this.streams.at(-1);
  }

  /** Every input event sent, over all input streams. */
  get events(): EmulatorInputEvent[] {
    return this.inputs.flatMap((input) => input.events);
  }

  async getStatus(): Promise<{ booted: boolean }> {
    if (this.booted instanceof Error) throw this.booted;
    return { booted: this.booted };
  }

  async getDisplaySize(): Promise<DisplaySize> {
    if (this.display instanceof Error) throw this.display;
    return this.display;
  }

  /**
   * Scaled screenshots (the session fetches one after every stream start and rotation): unanswered by default so
   * stream tests see stream frames only; `answer` returns a frame of the requested box at `skinRotation`.
   */
  scaledScreenshots: 'hang' | 'answer' | Error = 'hang';
  skinRotation: ScreenFrame['rotation'] = 0;
  readonly screenshotBoxes: Size[] = [];

  async getScreenshot(box?: Size): Promise<ScreenFrame> {
    if (box) {
      this.screenshotBoxes.push(box);
      if (this.scaledScreenshots === 'hang') return new Promise(() => undefined);
      if (this.scaledScreenshots instanceof Error) throw this.scaledScreenshots;
      return { ...box, rotation: this.skinRotation, png: Buffer.from(`prime ${box.width}x${box.height}`) };
    }
    if (this.screenshot instanceof Error) throw this.screenshot;
    return this.screenshot;
  }

  streamScreenshot(box: Size, handlers: FrameStreamHandlers): FrameStream {
    const stream = { box, handlers, cancelled: false, paused: false, resumes: 0 };
    this.streams.push(stream);
    return {
      pause: () => {
        stream.paused = true;
      },
      resume: () => {
        if (stream.paused) stream.resumes += 1;
        stream.paused = false;
      },
      cancel: () => {
        stream.cancelled = true;
      },
    };
  }

  openInput(onEnd: (error: EmulatorRpcError | null) => void): InputStream {
    const input = {
      events: [] as EmulatorInputEvent[],
      droppable: [] as boolean[],
      started: false,
      ended: false,
      cancelled: false,
      onEnd,
    };
    this.inputs.push(input);
    // A promise job, not queueMicrotask: tests with fake timers fake that one too.
    void Promise.resolve().then(() => {
      if (!input.cancelled) input.started = true;
    });
    return {
      send: (event, droppable = false) => {
        if (input.ended || input.cancelled) return;
        input.events.push(event);
        input.droppable.push(droppable);
      },
      end: () => {
        input.ended = true;
        if (this.answersEnd) setTimeout(() => !input.cancelled && onEnd(null), 0);
      },
    };
  }

  /** setClipboard calls, in order; `clipboardFailure` makes them fail. */
  readonly clipboardSets: string[] = [];
  clipboardFailure: Error | null = null;
  readonly clipboardStreams: { handlers: ClipboardStreamHandlers; cancelled: boolean }[] = [];

  get clipboardStream(): (typeof this.clipboardStreams)[number] | undefined {
    return this.clipboardStreams.at(-1);
  }

  async setClipboard(text: string): Promise<void> {
    if (this.clipboardFailure) throw this.clipboardFailure;
    this.clipboardSets.push(text);
  }

  streamClipboard(handlers: ClipboardStreamHandlers): { cancel(): void } {
    const stream = { handlers, cancelled: false };
    this.clipboardStreams.push(stream);
    return {
      cancel: () => {
        stream.cancelled = true;
      },
    };
  }

  async getRotationZ(): Promise<number> {
    return this.rotationZ;
  }

  async setRotationZ(z: number): Promise<void> {
    this.rotations.push(z);
    this.rotationZ = z;
  }

  gps: GpsPoint = { latitude: 37.422, longitude: -122.084 };
  /** setGps calls, in order; `gpsFailure` makes getGps and setGps fail. */
  readonly gpsSets: GpsPoint[] = [];
  gpsFailure: Error | null = null;

  async getGps(): Promise<GpsPoint> {
    if (this.gpsFailure) throw this.gpsFailure;
    return this.gps;
  }

  async setGps(point: GpsPoint): Promise<void> {
    if (this.gpsFailure) throw this.gpsFailure;
    this.gpsSets.push(point);
    this.gps = point;
  }

  shutdown(): Promise<void> {
    this.shutdowns += 1;
    if (this.shutdownResult === 'hang') return new Promise(() => undefined);
    return this.shutdownResult ? Promise.reject(this.shutdownResult) : Promise.resolve();
  }

  close(): void {
    this.closed = true;
    for (const input of this.inputs) {
      if (input.started) continue;
      input.cancelled = true;
      input.events = [];
    }
  }
}

/** A ScreenSocket that records what was sent; `bufferedAmount` is set by the test. */
export class FakeScreenSocket implements ScreenSocket {
  bufferedAmount = 0;
  readonly sent: (string | Buffer)[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  terminated = false;

  terminate(): void {
    this.terminated = true;
  }

  /** Text messages, parsed. */
  get texts(): Record<string, unknown>[] {
    return this.sent
      .filter((data) => typeof data === 'string')
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  /** Binary messages as [kind, payload]. */
  get binaries(): [number, string][] {
    return this.sent
      .filter((data): data is Buffer => typeof data !== 'string')
      .map((data) => [data[0] ?? -1, data.subarray(1).toString()]);
  }

  /** The sequence of message kinds: `screenInfo`, `frame:<payload>`, … */
  get kinds(): string[] {
    return this.sent.map((data) =>
      typeof data === 'string'
        ? String((JSON.parse(data) as { type: string }).type)
        : `${data[0]}:${data.subarray(1)}`,
    );
  }
}

export function frame(
  width: number,
  height: number,
  rotation: ScreenFrame['rotation'] = 0,
  label = 'f',
): ScreenFrame {
  return { width, height, rotation, png: Buffer.from(label) };
}

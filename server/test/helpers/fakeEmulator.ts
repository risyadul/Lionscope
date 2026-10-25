import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const FIXTURE_PROTO = fileURLToPath(new URL('../fixtures/emulator_controller.proto', import.meta.url));
export const FAKE_TOKEN = 'fake-grpc-token';

type SkinRotation = 'PORTRAIT' | 'LANDSCAPE' | 'REVERSE_PORTRAIT' | 'REVERSE_LANDSCAPE';

export interface ImageRequest {
  format: string;
  width: number;
  height: number;
}

export interface FakeImage {
  width: number;
  height: number;
  rotation?: SkinRotation;
  bytes?: Buffer;
}

function image(frame: FakeImage): object {
  return {
    format: {
      format: 'PNG',
      width: frame.width,
      height: frame.height,
      rotation: { rotation: frame.rotation ?? 'PORTRAIT' },
    },
    image: frame.bytes ?? Buffer.from(`png ${frame.width}x${frame.height}`),
  };
}

/**
 * An EmulatorController gRPC server on 127.0.0.1 (the trimmed fixture proto), with the emulator's token check:
 * without `authorization: Bearer <token>` every call fails with UNAUTHENTICATED, like emulator 36.6.
 */
export class FakeEmulator {
  token = FAKE_TOKEN;
  booted = true;
  /** getStatus fails with this status instead of answering. */
  statusFailure: Partial<grpc.StatusObject> | null = null;
  display = { width: 1080, height: 2424 };
  /** false: getDisplayConfigurations is UNIMPLEMENTED (older emulators). */
  displayConfigurations = true;
  rotation: SkinRotation = 'PORTRAIT';
  rotationZ = 0;
  /** Resting x tilt of the device pose (emulator 36.6 reports -4.75). */
  rotationX = -4.75;
  readonly physicalModelWrites: unknown[] = [];
  readonly vmStates: string[] = [];
  readonly inputEvents: Record<string, unknown>[] = [];
  readonly screenshotRequests: ImageRequest[] = [];
  readonly streams: { request: ImageRequest; call: grpc.ServerWritableStream<ImageRequest, object> }[] = [];
  readonly inputCalls: grpc.ServerReadableStream<object, object>[] = [];
  /** Android's clipboard, and the open streamClipboard calls (with the peer that opened them). */
  clipboard = 'initial clip';
  readonly clipboardSets: string[] = [];
  readonly clipboardCalls: grpc.ServerWritableStream<object, object>[] = [];
  /** The GPS fix (the emulator's default is the Googleplex), and every setGps request. */
  gps = { latitude: 37.422, longitude: -122.084 };
  readonly gpsWrites: Record<string, unknown>[] = [];
  private server: grpc.Server | null = null;

  async start(): Promise<number> {
    const definition = protoLoader.loadSync(FIXTURE_PROTO, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
    });
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      android: { emulation: { control: { EmulatorController: { service: grpc.ServiceDefinition } } } };
    };
    const server = new grpc.Server();
    server.addService(loaded.android.emulation.control.EmulatorController.service, this.handlers());
    this.server = server;
    return new Promise((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
        error ? reject(error) : resolve(port),
      );
    });
  }

  stop(): void {
    this.server?.forceShutdown();
    this.server = null;
  }

  /** Streams that are still open. */
  get openStreams(): typeof this.streams {
    return this.streams.filter((stream) => !stream.call.cancelled && stream.call.writable);
  }

  /** Send a frame on every open screenshot stream. */
  pushFrame(frame: Partial<FakeImage> = {}): void {
    for (const { request, call } of this.openStreams) {
      call.write(image({ width: request.width, height: request.height, rotation: this.rotation, ...frame }));
    }
  }

  /** A copy inside Android: every clipboard stream gets it. */
  guestCopy(text: string): void {
    this.clipboard = text;
    for (const call of this.clipboardCalls) if (!call.cancelled && call.writable) call.write({ text });
  }

  private authorized(call: { metadata: grpc.Metadata }): boolean {
    return call.metadata.get('authorization')[0] === `Bearer ${this.token}`;
  }

  private unauthenticated(): Partial<grpc.StatusObject> {
    return {
      code: grpc.status.UNAUTHENTICATED,
      details: "Missing the 'authorization' header with security credentials.",
    };
  }

  private handlers(): grpc.UntypedServiceImplementation {
    const unary =
      (respond: (request: Record<string, unknown>) => object | Partial<grpc.StatusObject>) =>
      (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, callback: grpc.sendUnaryData<object>) => {
        if (!this.authorized(call)) return callback(this.unauthenticated());
        const result = respond(call.request);
        if ('code' in result) return callback(result);
        callback(null, result);
      };
    return {
      getStatus: unary(
        () => this.statusFailure ?? { version: '36.6.11.0', uptime: 1000, booted: this.booted },
      ),
      getDisplayConfigurations: unary(() =>
        this.displayConfigurations
          ? { displays: [{ display: 0, width: this.display.width, height: this.display.height, dpi: 420 }] }
          : { code: grpc.status.UNIMPLEMENTED, details: 'not here' },
      ),
      getScreenshot: unary((request) => {
        const box = request as unknown as ImageRequest;
        this.screenshotRequests.push(box);
        const quarter = this.rotation === 'LANDSCAPE' || this.rotation === 'REVERSE_LANDSCAPE';
        const width = quarter ? this.display.height : this.display.width;
        const height = quarter ? this.display.width : this.display.height;
        // Like the emulator: scaled into the box (aspect kept) only when both sides are set.
        const scale =
          box.width > 0 && box.height > 0 ? Math.min(1, box.width / width, box.height / height) : 1;
        return image({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          rotation: this.rotation,
        });
      }),
      setClipboard: (
        call: grpc.ServerUnaryCall<{ text: string }, object>,
        callback: grpc.sendUnaryData<object>,
      ) => {
        if (!this.authorized(call)) return callback(this.unauthenticated());
        this.clipboard = call.request.text;
        this.clipboardSets.push(call.request.text);
        // Like the emulator: every other client's stream hears of it, the setter's own channel does not.
        for (const stream of this.clipboardCalls) {
          if (!stream.cancelled && stream.writable && stream.getPeer() !== call.getPeer()) {
            stream.write({ text: call.request.text });
          }
        }
        callback(null, {});
      },
      getClipboard: unary(() => ({ text: this.clipboard })),
      streamClipboard: (call: grpc.ServerWritableStream<object, object>) => {
        if (!this.authorized(call)) return call.emit('error', this.unauthenticated());
        this.clipboardCalls.push(call);
        // The current content first.
        call.write({ text: this.clipboard });
      },
      getPhysicalModel: unary(() => ({
        target: 'ROTATION',
        value: { data: [this.rotationX, 0, this.rotationZ] },
      })),
      setPhysicalModel: unary((request) => {
        this.physicalModelWrites.push(request);
        // The skin follows the device rotation; the screen content (and so the stream) does not change.
        const z = Number((request as { value?: { data?: number[] } }).value?.data?.[2] ?? 0);
        this.rotationZ = z;
        const skins = ['PORTRAIT', 'LANDSCAPE', 'REVERSE_PORTRAIT', 'REVERSE_LANDSCAPE'] as const;
        this.rotation = skins[(((Math.round(z / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3];
        return {};
      }),
      getGps: unary(() => ({ passiveUpdate: true, ...this.gps, satellites: 4 })),
      setGps: unary((request) => {
        this.gpsWrites.push(request);
        this.gps = { latitude: Number(request.latitude), longitude: Number(request.longitude) };
        return {};
      }),
      setVmState: unary((request) => {
        this.vmStates.push(String(request.state));
        return {};
      }),
      streamScreenshot: (call: grpc.ServerWritableStream<ImageRequest, object>) => {
        if (!this.authorized(call)) return call.emit('error', this.unauthenticated());
        this.streams.push({ request: call.request, call });
        // Like the emulator: an empty image first, then the current screen.
        call.write(image({ width: 0, height: 0, bytes: Buffer.alloc(0) }));
        call.write(
          image({ width: call.request.width, height: call.request.height, rotation: this.rotation }),
        );
      },
      streamInputEvent: (
        call: grpc.ServerReadableStream<object, object>,
        callback: grpc.sendUnaryData<object>,
      ) => {
        if (!this.authorized(call)) return callback(this.unauthenticated());
        this.inputCalls.push(call);
        // Unset oneof members decode as null (`defaults: true`): keep the one that was sent.
        call.on('data', (event: Record<string, unknown>) =>
          this.inputEvents.push(
            Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null)),
          ),
        );
        call.on('end', () => callback(null, {}));
        call.on('error', () => undefined);
      },
    };
  }
}

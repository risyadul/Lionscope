import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { ScreenRotation } from '@lionscope/protocol';
import { HOST } from '../config.ts';
import type { GrpcEndpoint } from './discovery.ts';
import { rotatedSize, rotationOf } from './screenInput.ts';
import type { DisplaySize, EmulatorInputEvent, Size } from './screenInput.ts';

/** A PNG frame as the emulator delivers it: already rotated, `width` × `height` as shown. */
export interface ScreenFrame {
  width: number;
  height: number;
  rotation: ScreenRotation;
  png: Buffer;
}

/** A gRPC failure; `code` is the gRPC status (16 = UNAUTHENTICATED: the token was refused). */
export class EmulatorRpcError extends Error {
  override name = 'EmulatorRpcError';

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The emulator refused the token (gRPC UNAUTHENTICATED). */
export function isAuthError(error: unknown): boolean {
  return error instanceof EmulatorRpcError && error.code === grpc.status.UNAUTHENTICATED;
}

export interface FrameStreamHandlers {
  onFrame(frame: ScreenFrame): void;
  /** The stream ended without cancel(): null when the emulator closed it, else the error. */
  onEnd(error: EmulatorRpcError | null): void;
}

export interface ClipboardStreamHandlers {
  onText(text: string): void;
  /** The stream ended without cancel(): null when the emulator closed it, else the error. */
  onEnd(error: EmulatorRpcError | null): void;
}

export interface InputStream {
  /**
   * `droppable` (touch moves): dropped while the stream is backed up (a write returned false) until it drains;
   * everything else (downs, ups, keys) is always written.
   */
  send(event: EmulatorInputEvent, droppable?: boolean): void;
  /** Half-close: `onEnd` fires once the emulator has taken everything written. */
  end(): void;
}

/** What the server uses of one emulator's EmulatorController service. */
export interface EmulatorClient {
  getStatus(): Promise<{ booted: boolean }>;
  /** The main display's natural (unrotated) size and density. */
  getDisplaySize(): Promise<DisplaySize>;
  /** One PNG, rotated like the screen: full resolution, or scaled into `box` (both sides set). */
  getScreenshot(box?: Size): Promise<ScreenFrame>;
  /** PNG frames scaled into `box` (set both sides or the emulator does not scale). Frames come on change only. */
  streamScreenshot(box: Size, handlers: FrameStreamHandlers): { cancel(): void };
  /** One long-lived input stream; `onEnd` fires when it fails or ends (also after end()). */
  openInput(onEnd: (error: EmulatorRpcError | null) => void): InputStream;
  /** Physical model ROTATION z, in degrees. */
  getRotationZ(): Promise<number>;
  /** Set z at once (no smooth transition), keeping x and y. */
  setRotationZ(z: number): Promise<void>;
  /** Put text on Android's clipboard. */
  setClipboard(text: string): Promise<void>;
  /**
   * Android's clipboard as it changes. The emulator sends the current content first, then every change made
   * in the guest or by another client (never this client's own setClipboard).
   */
  streamClipboard(handlers: ClipboardStreamHandlers): { cancel(): void };
  /** The GPS fix the emulator reports, in WGS 84 degrees. */
  getGps(): Promise<GpsPoint>;
  /**
   * Move the GPS fix (also stops the emulator's Location window, when it has one, from overriding it every second
   * with its own point).
   */
  setGps(point: GpsPoint): Promise<void>;
  /** Graceful shutdown (saves the Quick Boot snapshot unless the emulator runs with -no-snapshot-save). */
  shutdown(): Promise<void>;
  close(): void;
}

export interface GpsPoint {
  latitude: number;
  longitude: number;
}

export type EmulatorClientFactory = (endpoint: GrpcEndpoint) => EmulatorClient;

export const RPC_TIMEOUT_MS = 5000;
const UNAUTHENTICATED = grpc.status.UNAUTHENTICATED;

interface RawImage {
  format?: { width?: number; height?: number; rotation?: { rotation?: string } };
  image?: Buffer;
}

type UnaryMethod<Res> = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response?: Res) => void,
) => grpc.ClientUnaryCall;

/** The generated EmulatorController client, as far as we use it. */
interface RawController extends grpc.Client {
  getStatus: UnaryMethod<{ booted?: boolean }>;
  getDisplayConfigurations: UnaryMethod<{
    displays?: { display?: number; width?: number; height?: number; dpi?: number }[];
  }>;
  getScreenshot: UnaryMethod<RawImage>;
  getPhysicalModel: UnaryMethod<{ value?: { data?: number[] } }>;
  setPhysicalModel: UnaryMethod<object>;
  setClipboard: UnaryMethod<object>;
  streamClipboard(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<{ text?: string }>;
  setVmState: UnaryMethod<object>;
  getGps: UnaryMethod<{ latitude?: number; longitude?: number }>;
  setGps: UnaryMethod<object>;
  streamScreenshot(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<RawImage>;
  streamInputEvent(
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null) => void,
  ): grpc.ClientWritableStream<EmulatorInputEvent>;
}

type ControllerConstructor = new (address: string, credentials: grpc.ChannelCredentials) => RawController;

const LOADER_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true };

/**
 * Load `emulator_controller.proto` (from the user's SDK, so it matches their emulator). Throws when the file
 * cannot be parsed or has no `android.emulation.control.EmulatorController`.
 */
export function loadEmulatorController(protoPath: string): ControllerConstructor {
  const loaded: unknown = grpc.loadPackageDefinition(protoLoader.loadSync(protoPath, LOADER_OPTIONS));
  let node: unknown = loaded;
  for (const key of ['android', 'emulation', 'control', 'EmulatorController']) {
    node = typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
  }
  if (typeof node !== 'function') throw new Error('no EmulatorController service in the proto');
  return node as ControllerConstructor;
}

const MAX_DETAILS_CHARS = 200;

function rpcError(method: string, error: grpc.ServiceError): EmulatorRpcError {
  // `details` comes from the other end (e.g. "Missing the 'authorization' header…"; it never echoes the token):
  // shown in logs only after control and format characters are blanked and its length capped.
  const details = (error.details || grpc.status[error.code] || '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .slice(0, MAX_DETAILS_CHARS);
  return new EmulatorRpcError(error.code, `${method} failed: ${details}`);
}

function toFrame(raw: RawImage): ScreenFrame | null {
  const width = raw.format?.width ?? 0;
  const height = raw.format?.height ?? 0;
  if (width <= 0 || height <= 0 || !raw.image?.length) return null;
  return { width, height, rotation: rotationOf(raw.format?.rotation?.rotation), png: raw.image };
}

/** Clients for every emulator from one loaded proto; each client has its own channel to 127.0.0.1. */
export function createEmulatorClientFactory(Controller: ControllerConstructor): EmulatorClientFactory {
  return (endpoint) => {
    const raw = new Controller(`${HOST}:${endpoint.port}`, grpc.credentials.createInsecure());
    const metadata = (): grpc.Metadata => {
      const value = new grpc.Metadata();
      value.set('authorization', `Bearer ${endpoint.token.reveal()}`);
      return value;
    };
    const unary = <Res>(method: string, call: UnaryMethod<Res>, request: object): Promise<Res> =>
      new Promise((resolve, reject) => {
        call.call(raw, request, metadata(), { deadline: Date.now() + RPC_TIMEOUT_MS }, (error, response) => {
          if (error) reject(rpcError(method, error));
          else resolve(response as Res);
        });
      });
    const screenshot = async (box?: Size): Promise<ScreenFrame> => {
      const request = box ? { format: 'PNG', width: box.width, height: box.height } : { format: 'PNG' };
      const frame = toFrame(await unary('getScreenshot', raw.getScreenshot, request));
      if (!frame) throw new EmulatorRpcError(grpc.status.UNAVAILABLE, 'getScreenshot returned no image');
      return frame;
    };

    return {
      async getStatus() {
        return { booted: (await unary('getStatus', raw.getStatus, {})).booted === true };
      },
      async getDisplaySize() {
        try {
          const { displays = [] } = await unary('getDisplayConfigurations', raw.getDisplayConfigurations, {});
          const main = displays.find((display) => (display.display ?? 0) === 0);
          if (main?.width && main.height) {
            return { width: main.width, height: main.height, dpi: main.dpi || null };
          }
        } catch (error) {
          if (error instanceof EmulatorRpcError && error.code === UNAUTHENTICATED) throw error;
        }
        // Older emulators: the natural size of a full-size screenshot.
        const frame = await screenshot();
        return { ...rotatedSize(frame, frame.rotation), dpi: null };
      },
      getScreenshot: (box) => screenshot(box),
      streamScreenshot(box, handlers) {
        const stream = raw.streamScreenshot(
          { format: 'PNG', width: box.width, height: box.height },
          metadata(),
        );
        let cancelled = false;
        let ended = false;
        const end = (error: EmulatorRpcError | null): void => {
          if (ended || cancelled) return;
          ended = true;
          handlers.onEnd(error);
        };
        stream.on('data', (image: RawImage) => {
          // The first image of a stream can be empty (0×0).
          const frame = toFrame(image);
          if (frame && !cancelled) handlers.onFrame(frame);
        });
        stream.on('error', (error: grpc.ServiceError) => end(rpcError('streamScreenshot', error)));
        stream.on('end', () => end(null));
        return {
          cancel() {
            cancelled = true;
            stream.cancel();
          },
        };
      },
      openInput(onEnd) {
        let ended = false;
        let closing = false;
        let backedUp = false;
        const end = (error: EmulatorRpcError | null): void => {
          if (ended) return;
          ended = true;
          onEnd(error);
        };
        const stream = raw.streamInputEvent(metadata(), (error) =>
          end(error ? rpcError('streamInputEvent', error) : null),
        );
        // Errors also reach the callback above; this only keeps them from being unhandled.
        stream.on('error', () => undefined);
        stream.on('drain', () => {
          backedUp = false;
        });
        return {
          send(event, droppable = false) {
            if (ended || closing || !stream.writable || (droppable && backedUp)) return;
            if (!stream.write(event)) backedUp = true;
          },
          end() {
            if (closing) return;
            closing = true;
            stream.end();
          },
        };
      },
      async getRotationZ() {
        const model = await unary('getPhysicalModel', raw.getPhysicalModel, { target: 'ROTATION' });
        return model.value?.data?.[2] ?? 0;
      },
      async setRotationZ(z) {
        // Only z changes: the emulator's resting pose has a small x tilt (-4.75° on emulator 36.6).
        const current = await unary('getPhysicalModel', raw.getPhysicalModel, { target: 'ROTATION' });
        const [x = 0, y = 0] = current.value?.data ?? [];
        // STEP: jump to the angle instead of the default smooth transition, so the skin rotation follows at once.
        await unary('setPhysicalModel', raw.setPhysicalModel, {
          target: 'ROTATION',
          value: { data: [x, y, z] },
          interpolation: 'STEP',
        });
      },
      async setClipboard(text) {
        await unary('setClipboard', raw.setClipboard, { text });
      },
      streamClipboard(handlers) {
        const stream = raw.streamClipboard({}, metadata());
        let done = false;
        const end = (error: EmulatorRpcError | null): void => {
          if (done) return;
          done = true;
          handlers.onEnd(error);
        };
        stream.on('data', (clip: { text?: string }) => {
          if (!done) handlers.onText(clip.text ?? '');
        });
        stream.on('error', (error: grpc.ServiceError) => end(rpcError('streamClipboard', error)));
        stream.on('end', () => end(null));
        return {
          cancel() {
            done = true;
            stream.cancel();
          },
        };
      },
      async getGps() {
        const gps = await unary('getGps', raw.getGps, {});
        return { latitude: gps.latitude ?? 0, longitude: gps.longitude ?? 0 };
      },
      async setGps({ latitude, longitude }) {
        // passiveUpdate false: the Location window (an emulator with a window) no longer resends its own point.
        await unary('setGps', raw.setGps, { passiveUpdate: false, latitude, longitude, satellites: 12 });
      },
      async shutdown() {
        await unary('setVmState', raw.setVmState, { state: 'SHUTDOWN' });
      },
      close() {
        raw.close();
      },
    };
  };
}

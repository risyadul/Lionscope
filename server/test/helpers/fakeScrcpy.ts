import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { CODEC_ID_H264, DEVICE_NAME_FIELD_BYTES } from '../../src/scrcpy/protocol.ts';
import { FakeAdb, FakeChild } from './fakes.ts';

/** A made-up serial for the physical device (never one of a real device). */
export const PHYSICAL_SERIAL = 'FAKEPHYS0001';
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('fake png')]);

export function videoMeta(name = 'Fake Phone'): Buffer {
  const field = Buffer.alloc(DEVICE_NAME_FIELD_BYTES);
  field.write(name, 'utf8');
  return field;
}

export function codecId(id: number = CODEC_ID_H264): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(id, 0);
  return buffer;
}

export function sessionPacket(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE(0x8000_0000, 0);
  buffer.writeUInt32BE(width, 4);
  buffer.writeUInt32BE(height, 8);
  return buffer;
}

export function mediaPacket(packet: { config?: boolean; key?: boolean; pts?: number; data: Buffer }): Buffer {
  const header = Buffer.alloc(12);
  let ptsAndFlags = packet.config ? 1n << 62n : BigInt(packet.pts ?? 0);
  if (!packet.config && packet.key) ptsAndFlags |= 1n << 61n;
  header.writeBigUInt64BE(ptsAndFlags, 0);
  header.writeUInt32BE(packet.data.length, 8);
  return Buffer.concat([header, packet.data]);
}

/** The usual start of a stream: meta, codec, a session packet, then config and key frame. */
export function streamStart(width = 540, height = 1200): Buffer {
  return Buffer.concat([
    videoMeta(),
    codecId(),
    sessionPacket(width, height),
    mediaPacket({ config: true, data: Buffer.from('config') }),
    mediaPacket({ key: true, pts: 1000, data: Buffer.from('key') }),
  ]);
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The device side of `adb forward` to a scrcpy server, on a local TCP port: the first accepted connection is the
 * video socket (dummy byte, then `greeting`), the second the control socket (its bytes are recorded).
 */
export class FakeScrcpyDevice {
  private server: Server | null = null;
  port = 0;
  /** Connections closed at once, like adb does while the server does not listen yet. */
  refuse = 0;
  /** Accept no connection at all (every one is closed), e.g. a server that never starts. */
  refuseAll = false;
  /** Sent on the video socket after the dummy byte. */
  greeting: Buffer = streamStart();
  video: Socket | null = null;
  control: Socket | null = null;
  private controlChunks: Buffer[] = [];
  connections = 0;
  /** Both sockets of the current server closed: a real server exits then. */
  onClosed: (() => void) | null = null;

  async start(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    return this.port;
  }

  get controlBytes(): Buffer {
    return Buffer.concat(this.controlChunks);
  }

  waitFor(condition: () => boolean, timeoutMs?: number): Promise<void> {
    return until(condition, timeoutMs);
  }

  async stop(): Promise<void> {
    this.video?.destroy();
    this.control?.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    this.connections += 1;
    socket.on('error', () => undefined);
    if (this.refuseAll || this.refuse > 0) {
      this.refuse = Math.max(0, this.refuse - 1);
      socket.destroy();
      return;
    }
    // After a restart (the previous video socket is gone) the next connection is a new server's video socket.
    if (!this.video || this.video.destroyed) {
      this.video = socket;
      this.control = null;
      socket.write(Buffer.concat([Buffer.from([0]), this.greeting]));
    } else {
      this.control = socket;
      socket.on('data', (chunk: Buffer) => this.controlChunks.push(chunk));
    }
    const video = this.video;
    socket.on('close', () => {
      if (video.destroyed && (this.control?.destroyed ?? true)) this.onClosed?.();
    });
  }
}

/**
 * FakeAdb for a physical device mirrored through scrcpy: `devices` lists PHYSICAL_SERIAL, `forward tcp:0` answers
 * the fake device's port, `app_process` spawns a fake server process (exits when its sockets close, like the real
 * one) and `exec-out screencap -p` writes `screencap`.
 */
export class FakeScrcpyAdb extends FakeAdb {
  readonly servers: { args: readonly string[]; child: FakeChild }[] = [];
  readonly pkills: string[] = [];
  /** `adb push` runs (spawned) and the bytes of each pushed file, read when adb is asked to push it. */
  readonly pushes: { args: readonly string[]; child: FakeChild }[] = [];
  readonly pushed: Buffer[] = [];
  /** exec calls and pushes, in order. */
  readonly calls: (readonly string[])[] = [];
  /** A push that never finishes (a slow device). */
  pushHangs = false;
  wmSize = 'Physical size: 1080x2400\n';
  screencap: Buffer = PNG_BYTES;
  deviceState = 'device';
  /** Replace to make one adb command fail: return an Error to throw. */
  fail: (args: readonly string[]) => Error | null = () => null;
  /** The server process exits by itself when its sockets close. */
  exitsWithSockets = true;

  constructor(readonly device: FakeScrcpyDevice) {
    super(() => '');
    this.execHandler = (args) => this.handle(args);
    device.onClosed = () => {
      if (this.exitsWithSockets) this.servers.at(-1)?.child.exit(0);
    };
  }

  get liveServers(): FakeChild[] {
    return this.servers.map((server) => server.child).filter((child) => !child.exited);
  }

  private handle(args: readonly string[]): string {
    this.calls.push(args);
    const failure = this.fail(args);
    if (failure) throw failure;
    if (args[0] === 'devices') {
      return `List of devices attached\n${PHYSICAL_SERIAL}\t${this.deviceState} usb:1-1 product:fake model:Fake_Phone device:fake transport_id:7\n`;
    }
    const command = args.slice(2);
    if (command[0] === 'forward' && command[1] === 'tcp:0') return `${this.device.port}\n`;
    if (command[0] === 'forward') return '';
    if (command[0] === 'shell' && command[1] === 'wm size') return this.wmSize;
    if (command[0] === 'shell' && command[1]?.startsWith('pkill')) {
      this.pkills.push(command[1]);
      for (const child of this.liveServers) child.exit(null, 'SIGTERM');
      return '';
    }
    return '';
  }

  override spawn(args: readonly string[]): FakeChild {
    if (args[2] === 'push') {
      const child = new FakeChild();
      this.pushes.push({ args, child });
      this.calls.push(args);
      this.pushed.push(readFileSync(String(args[3])));
      const failure = this.fail(args);
      if (!this.pushHangs) {
        setImmediate(() => {
          if (failure) child.stderr.write(failure.message);
          else child.stdout.write('1 file pushed, 0 skipped.\n');
          child.exit(failure ? 1 : 0);
        });
      }
      return child;
    }
    if (args.includes('app_process')) {
      const child = new FakeChild();
      this.servers.push({ args, child });
      return child;
    }
    if (args.includes('exec-out')) {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write(this.screencap);
        child.exit(0);
      });
      return child;
    }
    return super.spawn(args);
  }
}

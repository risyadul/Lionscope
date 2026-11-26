import type { ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFfmpegArgs,
  clearHostH264EncoderProbeCache,
  createHostVideoEncoderFactory,
  HostVideoEncoder,
  parseFfmpegEncoders,
  probeHostH264Encoder,
  resolveFfmpegPath,
} from '../src/emulator/hostVideoEncoder.ts';
import type {
  ExecFileLike,
  HostH264EncoderInfo,
  HostVideoPacket,
  SpawnedFfmpegProcess,
} from '../src/emulator/hostVideoEncoder.ts';

const SC4 = [0x00, 0x00, 0x00, 0x01];
const SPS = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
const PPS = [0x68, 0xee, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84];
const DELTA = [0x41, 0x9a, 0x02];

function bytes(...parts: number[][]): Buffer {
  return Buffer.from(parts.flat());
}

function execError(message: string, code: number): ExecFileException {
  return Object.assign(new Error(message), { code, cmd: 'ffmpeg' });
}

class FakeFfmpegProcess extends EventEmitter implements SpawnedFfmpegProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  autoCloseOnSignal: NodeJS.Signals | null = 'SIGTERM';

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (this.autoCloseOnSignal !== null && signal === this.autoCloseOnSignal) {
      queueMicrotask(() => {
        this.stdout.end();
        this.stderr.end();
        this.emit('close', null, signal);
      });
    }
    return true;
  }
}

describe('probeHostH264Encoder', () => {
  beforeEach(() => {
    clearHostH264EncoderProbeCache();
  });

  it('resolves LIONSCOPE_FFMPEG or falls back to ffmpeg on PATH', () => {
    expect(resolveFfmpegPath({ env: { LIONSCOPE_FFMPEG: ' /custom/ffmpeg ' } })).toBe('/custom/ffmpeg');
    expect(resolveFfmpegPath({ env: { LIONSCOPE_FFMPEG: '   ' } })).toBe('ffmpeg');
    expect(resolveFfmpegPath({ env: {} })).toBe('ffmpeg');
  });

  it('parses video encoders from ffmpeg -encoders output', () => {
    const out = [
      'Encoders:',
      ' V..... h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC',
      ' A....D aac                  AAC (Advanced Audio Coding)',
    ].join('\n');
    expect(parseFfmpegEncoders(out)).toEqual(new Set(['h264_videotoolbox', 'libx264']));
  });

  it('picks hardware encoder in platform priority order and skips broken candidates', async () => {
    const calls: string[][] = [];
    const execFile: ExecFileLike = (_file, args, _opts, cb) => {
      calls.push([...args]);
      if (args.includes('-encoders')) {
        cb(
          null,
          [' V..... h264_videotoolbox VideoToolbox', ' V..... h264_nvenc NVENC', ' V..... libx264 x264'].join(
            '\n',
          ),
          '',
        );
        return;
      }
      // Simulate h264_videotoolbox failing startup null-encode, h264_nvenc succeeding
      if (args.includes('h264_videotoolbox')) {
        cb(execError('vt init failed', 1), '', 'Cannot create session');
        return;
      }
      cb(null, '', '');
    };

    const info = await probeHostH264Encoder({
      platform: 'darwin',
      env: {},
      execFile,
    });
    expect(info).toEqual({
      ffmpegPath: 'ffmpeg',
      encoder: 'h264_nvenc',
      hardware: true,
    });
    expect(calls[0]).toEqual(['-hide_banner', '-encoders']);
    expect(calls[1]).toContain('h264_videotoolbox');
    expect(calls[2]).toContain('h264_nvenc');
  });

  it('falls back to libx264 only when hardware encoders fail and allowSoftware is enabled', async () => {
    const execFile: ExecFileLike = (_file, args, _opts, cb) => {
      if (args.includes('-encoders')) {
        cb(null, ' V..... h264_vaapi VAAPI\n V..... libx264 x264\n', '');
        return;
      }
      if (args.includes('h264_vaapi')) {
        cb(execError('no dri', 1), '', 'No VA display');
        return;
      }
      cb(null, '', '');
    };

    const sw = await probeHostH264Encoder({ platform: 'linux', env: {}, execFile });
    expect(sw).toEqual({ ffmpegPath: 'ffmpeg', encoder: 'libx264', hardware: false });

    const hwOnly = await probeHostH264Encoder({
      platform: 'linux',
      env: {},
      allowSoftware: false,
      execFile,
    });
    expect(hwOnly).toBeNull();
  });

  it('returns null cleanly when ffmpeg binary fails to launch (e.g. missing dylib) and caches per path', async () => {
    const execFile = vi.fn<ExecFileLike>((_file, _args, _opts, cb) => {
      cb(execError('dyld: Library not loaded: libx265.215.dylib', 134), '', 'dyld: Library not loaded');
    });

    const first = await probeHostH264Encoder({
      env: { LIONSCOPE_FFMPEG: '/opt/homebrew/bin/ffmpeg' },
      execFile,
    });
    const second = await probeHostH264Encoder({
      env: { LIONSCOPE_FFMPEG: '/opt/homebrew/bin/ffmpeg' },
      execFile,
    });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(execFile).toHaveBeenCalledTimes(1);

    // Different executable path is probed independently.
    await probeHostH264Encoder({
      env: { LIONSCOPE_FFMPEG: '/usr/local/bin/ffmpeg' },
      execFile,
    });
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

describe('buildFfmpegArgs', () => {
  it('validates dimensions and fpsCap and pads odd dimensions to even', () => {
    const even = buildFfmpegArgs('h264_videotoolbox', { width: 540, height: 1200, fpsCap: 30 });
    expect(even.encodedWidth).toBe(540);
    expect(even.encodedHeight).toBe(1200);
    expect(even.args).toContain('540x1200');
    expect(even.args).toContain('-bf');
    expect(even.args).toContain('0');
    expect(even.args).toContain('-g');
    expect(even.args).toContain('60');
    expect(even.args).toContain('-realtime');
    expect(even.args).not.toContain('-vf');

    const odd = buildFfmpegArgs('libx264', { width: 541, height: 1201, fpsCap: 24 });
    expect(odd.encodedWidth).toBe(542);
    expect(odd.encodedHeight).toBe(1202);
    expect(odd.args).toContain('pad=542:1202:0:0:black');
    expect(odd.args).toContain('48');

    expect(() => buildFfmpegArgs('libx264', { width: 1, height: 100, fpsCap: 30 })).toThrow(RangeError);
    expect(() => buildFfmpegArgs('libx264', { width: 540.5, height: 100, fpsCap: 30 })).toThrow(RangeError);
    expect(() => buildFfmpegArgs('libx264', { width: 540, height: 100, fpsCap: 0 })).toThrow(RangeError);
  });
});

describe('HostVideoEncoder', () => {
  const probe: HostH264EncoderInfo = {
    ffmpegPath: '/usr/bin/ffmpeg',
    encoder: 'h264_videotoolbox',
    hardware: true,
  };

  it('writes RGBA frames, pairs coded H.264 packets with queued PTS, and respects stdin backpressure', async () => {
    const fake = new FakeFfmpegProcess();
    const packets: HostVideoPacket[] = [];
    const exits: (Error | undefined)[] = [];
    const spawnCalls: { cmd: string; args: readonly string[] }[] = [];

    const factory = createHostVideoEncoderFactory(probe, {
      spawn: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return fake;
      },
      eofGraceMs: 10,
      termGraceMs: 10,
    });

    const encoder = factory({
      width: 4,
      height: 4,
      fpsCap: 30,
      onPacket: (packet) => packets.push(packet),
      onExit: (err) => exits.push(err),
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe('/usr/bin/ffmpeg');

    const frame = Buffer.alloc(4 * 4 * 4, 0x7f);
    const writeSpy = vi.spyOn(fake.stdin, 'write');
    writeSpy.mockReturnValueOnce(false); // simulate stdin full on frame 1

    expect(encoder.writeFrame(frame, 1000)).toBe(true);
    expect(encoder.isBackpressured).toBe(true);
    // Frame 2 dropped while backpressured (stdin.write not called again)
    expect(encoder.writeFrame(frame, 2000)).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Drain restores writeability
    fake.stdin.emit('drain');
    expect(encoder.isBackpressured).toBe(false);
    writeSpy.mockReturnValueOnce(true);
    expect(encoder.writeFrame(frame, 3000)).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(2);

    // Emit Annex B stream for frame 1 (IDR) and frame 2 (delta, pts 3000)
    fake.stdout.write(bytes(SC4, SPS, SC4, PPS, SC4, IDR, SC4, DELTA));
    await new Promise((r) => setTimeout(r, 10));

    // Close encoder cleanly (EOF triggers parser.flush() for the final delta frame)
    fake.stdout.end();
    fake.emit('close', 0, null);
    await encoder.close();

    expect(packets).toEqual([
      { isConfig: true, isKey: false, pts: 0, data: bytes(SC4, SPS, SC4, PPS) },
      { isConfig: false, isKey: true, pts: 1000, data: bytes(SC4, IDR) },
      // Second frame was dropped while backpressured, so the 2nd coded frame takes PTS 3000.
      { isConfig: false, isKey: false, pts: 3000, data: bytes(SC4, DELTA) },
    ]);
    expect(exits).toEqual([undefined]);
  });

  it('probes the real host ffmpeg without throwing and runs a live smoke encode only if available', async () => {
    clearHostH264EncoderProbeCache();
    const info = await probeHostH264Encoder();
    if (!info) {
      expect(info).toBeNull();
      return;
    }

    const packets: HostVideoPacket[] = [];
    const exits: (Error | undefined)[] = [];
    const encoder = new HostVideoEncoder(info, {
      width: 64,
      height: 64,
      fpsCap: 30,
      onPacket: (packet) => packets.push(packet),
      onExit: (error) => exits.push(error),
    });
    const frame = Buffer.alloc(64 * 64 * 4, 0x40);
    expect(encoder.writeFrame(frame, 1000)).toBe(true);
    await encoder.close();
    expect(exits).toEqual([undefined]);
    expect(packets.some((packet) => packet.isConfig)).toBe(true);
    expect(packets.some((packet) => !packet.isConfig && packet.isKey)).toBe(true);
  });

  it('rejects undersized RGBA buffers', () => {
    const fake = new FakeFfmpegProcess();
    const encoder = new HostVideoEncoder(
      probe,
      { width: 4, height: 4, fpsCap: 30, onPacket: () => undefined, onExit: () => undefined },
      { spawn: () => fake },
    );
    expect(() => encoder.writeFrame(Buffer.alloc(10), 1000)).toThrow(RangeError);
  });

  it('bounds stderr and passes error to onExit on unexpected ffmpeg crash', async () => {
    const fake = new FakeFfmpegProcess();
    const exits: (Error | undefined)[] = [];

    new HostVideoEncoder(
      probe,
      { width: 4, height: 4, fpsCap: 30, onPacket: () => undefined, onExit: (e) => exits.push(e) },
      { spawn: () => fake },
    );

    fake.stderr.write(Buffer.alloc(32 * 1024, 'x'));
    fake.stderr.end();
    fake.stdout.end();
    await new Promise((r) => setTimeout(r, 10));
    fake.emit('close', 1, null);

    expect(exits).toHaveLength(1);
    expect(exits[0]).toBeInstanceOf(Error);
    expect(exits[0]!.message).toContain('ffmpeg exited (code 1)');
    expect(exits[0]!.message.length).toBeLessThan(400);
  });

  it('escalates close() from stdin EOF to SIGTERM then SIGKILL if ffmpeg refuses to exit', async () => {
    const fake = new FakeFfmpegProcess();
    fake.autoCloseOnSignal = 'SIGKILL';
    const encoder = new HostVideoEncoder(
      probe,
      { width: 4, height: 4, fpsCap: 30, onPacket: () => undefined, onExit: () => undefined },
      { spawn: () => fake, eofGraceMs: 10, termGraceMs: 10 },
    );

    await encoder.close();
    expect(fake.stdin.writableEnded).toBe(true);
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

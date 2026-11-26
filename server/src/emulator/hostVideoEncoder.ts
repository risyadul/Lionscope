import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ExecFileException, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { errorMessage, log } from '../log.ts';
import { FlvH264Parser } from './flvH264.ts';

const MAX_VIDEO_DIMENSION = 16_384;
const MAX_FPS_CAP = 240;
const KEY_FRAME_INTERVAL_S = 2;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_MAX_BUFFER_BYTES = 256 * 1024;
const PROBE_FRAME_SIZE = 64;
const PROBE_RAW_FRAME = Buffer.alloc(PROBE_FRAME_SIZE * PROBE_FRAME_SIZE * 4);
const STDERR_CAP_BYTES = 8 * 1024;
const MAX_ERROR_SUMMARY_CHARS = 300;
const DEFAULT_EOF_GRACE_MS = 200;
const DEFAULT_TERM_GRACE_MS = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 8;
const MAX_FLUSH_DELAY_MS = 50;
const MIN_FLUSH_DELAY_MS = 18;
const MAX_FLUSH_IN_FLIGHT = 6;
const MAX_FLUSH_ATTEMPTS = 8;
const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

export type HostH264EncoderName = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_vaapi' | 'h264_qsv' | 'libx264';

const HARDWARE_ENCODERS_DARWIN: readonly HostH264EncoderName[] = [
  'h264_videotoolbox',
  'h264_nvenc',
  'h264_vaapi',
  'h264_qsv',
];

const HARDWARE_ENCODERS_OTHER: readonly HostH264EncoderName[] = ['h264_nvenc', 'h264_vaapi', 'h264_qsv'];

const LOW_LATENCY_ENCODERS_DARWIN: readonly HostH264EncoderName[] = [
  'h264_nvenc',
  'libx264',
  'h264_qsv',
  'h264_vaapi',
  'h264_videotoolbox',
];

const LOW_LATENCY_ENCODERS_OTHER: readonly HostH264EncoderName[] = [
  'h264_nvenc',
  'libx264',
  'h264_qsv',
  'h264_vaapi',
];

export interface HostH264EncoderInfo {
  ffmpegPath: string;
  encoder: HostH264EncoderName;
  hardware: boolean;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    encoding?: BufferEncoding;
    windowsHide?: boolean;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => { stdin?: Writable | null } | void;

export interface ProbeHostH264EncoderOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  ffmpegPath?: string;
  allowSoftware?: boolean;
  timeoutMs?: number;
  execFile?: ExecFileLike;
  forceRefresh?: boolean;
}

export interface HostVideoPacket {
  isConfig: boolean;
  isKey: boolean;
  pts: number;
  data: Buffer;
}

export interface HostVideoEncoderOptions {
  width: number;
  height: number;
  fpsCap: number;
  onPacket: (packet: HostVideoPacket) => void;
  onExit: (error?: Error) => void;
}

export interface HostVideoEncoderHandle {
  readonly width: number;
  readonly height: number;
  readonly encodedWidth: number;
  readonly encodedHeight: number;
  readonly isBackpressured: boolean;
  writeFrame(rgba: Buffer, ptsUs: number): boolean;
  close(): Promise<void>;
}

export type HostVideoEncoderFactory = (options: HostVideoEncoderOptions) => HostVideoEncoderHandle;

export interface SpawnedFfmpegProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnFfmpegLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedFfmpegProcess;

export interface HostVideoEncoderDeps {
  spawn?: SpawnFfmpegLike;
  eofGraceMs?: number;
  termGraceMs?: number;
  flushDelayMs?: number;
  flushIntervalMs?: number;
}

const probeCache = new Map<string, Promise<HostH264EncoderInfo | null>>();

/** Clear cached ffmpeg encoder probe results (primarily for tests). */
export function clearHostH264EncoderProbeCache(): void {
  probeCache.clear();
}

export function resolveFfmpegPath(
  options: Pick<ProbeHostH264EncoderOptions, 'env' | 'ffmpegPath'> = {},
): string {
  if (options.ffmpegPath !== undefined) {
    const trimmed = options.ffmpegPath.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const env = options.env ?? process.env;
  const fromEnv = env.LIONSCOPE_FFMPEG?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'ffmpeg';
}

export function parseFfmpegEncoders(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*V\S*\s+([a-zA-Z0-9_]+)/.exec(line);
    if (match?.[1]) encoders.add(match[1]);
  }
  return encoders;
}

function candidateEncoders(platform: NodeJS.Platform, allowSoftware: boolean): HostH264EncoderName[] {
  if (!allowSoftware) {
    return [...(platform === 'darwin' ? HARDWARE_ENCODERS_DARWIN : HARDWARE_ENCODERS_OTHER)];
  }
  return [...(platform === 'darwin' ? LOW_LATENCY_ENCODERS_DARWIN : LOW_LATENCY_ENCODERS_OTHER)];
}

function execFfmpegProbe(
  execFileFn: ExecFileLike,
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
  stdinFrame?: Buffer,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, stdout: string, stderr: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout, stderr });
    };
    try {
      const child = execFileFn(
        ffmpegPath,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: PROBE_MAX_BUFFER_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          finish(
            error === null,
            typeof stdout === 'string' ? stdout : '',
            typeof stderr === 'string' ? stderr : '',
          );
        },
      );
      if (stdinFrame && child && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdinFrame);
      }
    } catch {
      finish(false, '', '');
    }
  });
}

function probeEncodeArgs(encoder: HostH264EncoderName): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];
  if (encoder === 'h264_vaapi') {
    args.push('-vaapi_device', DEFAULT_VAAPI_DEVICE);
  }
  args.push(
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-video_size',
    `${PROBE_FRAME_SIZE}x${PROBE_FRAME_SIZE}`,
    '-framerate',
    '1',
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
  );
  if (encoder === 'h264_vaapi') {
    args.push('-vf', 'format=nv12,hwupload');
  } else {
    args.push('-pix_fmt', 'yuv420p');
  }
  args.push('-c:v', encoder, '-bf', '0', '-f', 'null', '-');
  return args;
}

async function runHostH264Probe(
  ffmpegPath: string,
  platform: NodeJS.Platform,
  allowSoftware: boolean,
  timeoutMs: number,
  execFileFn: ExecFileLike,
): Promise<HostH264EncoderInfo | null> {
  const listResult = await execFfmpegProbe(execFileFn, ffmpegPath, ['-hide_banner', '-encoders'], timeoutMs);
  if (!listResult.ok) return null;

  const available = parseFfmpegEncoders(listResult.stdout);
  const candidates = candidateEncoders(platform, allowSoftware).filter((name) => available.has(name));

  for (const encoder of candidates) {
    const testResult = await execFfmpegProbe(
      execFileFn,
      ffmpegPath,
      probeEncodeArgs(encoder),
      timeoutMs,
      PROBE_RAW_FRAME,
    );
    if (testResult.ok) {
      return {
        ffmpegPath,
        encoder,
        hardware: encoder !== 'libx264',
      };
    }
  }
  return null;
}

/**
 * Probe `LIONSCOPE_FFMPEG` (or `ffmpeg` on `PATH`) for a working H.264 encoder without throwing.
 * Caches the probe result per executable path (and software-fallback setting).
 */
export function probeHostH264Encoder(
  options: ProbeHostH264EncoderOptions = {},
): Promise<HostH264EncoderInfo | null> {
  try {
    const ffmpegPath = resolveFfmpegPath(options);
    const platform = options.platform ?? process.platform;
    const allowSoftware = options.allowSoftware ?? true;
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.trunc(options.timeoutMs)
        : PROBE_TIMEOUT_MS;
    const execFileFn: ExecFileLike =
      options.execFile ??
      ((file, args, opts, cb) => execFile(file, args, opts, cb) as unknown as { stdin?: Writable | null });

    const cacheKey = `${platform}:${allowSoftware ? 'sw' : 'hw'}:${ffmpegPath}`;
    if (options.forceRefresh) {
      probeCache.delete(cacheKey);
    }
    const existing = probeCache.get(cacheKey);
    if (existing) return existing;

    const pending = runHostH264Probe(ffmpegPath, platform, allowSoftware, timeoutMs, execFileFn).catch(
      () => null,
    );
    probeCache.set(cacheKey, pending);
    return pending;
  } catch {
    return Promise.resolve(null);
  }
}

function assertDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_VIDEO_DIMENSION) {
    throw new RangeError(`${name} must be a safe integer between 2 and ${MAX_VIDEO_DIMENSION}, got ${value}`);
  }
  return value;
}

function assertFpsCap(fpsCap: number): number {
  if (!Number.isFinite(fpsCap) || fpsCap <= 0 || fpsCap > MAX_FPS_CAP) {
    throw new RangeError(`fpsCap must be finite within (0, ${MAX_FPS_CAP}], got ${fpsCap}`);
  }
  return Math.max(1, Math.round(fpsCap));
}

function encoderTuningArgs(encoder: HostH264EncoderName): string[] {
  switch (encoder) {
    case 'h264_videotoolbox':
      // VideoToolbox rejects `-flags low_delay` without an explicit `-b:v`; baseline disables B/reordering.
      return ['-realtime', 'true', '-prio_speed', 'true', '-max_ref_frames', '1', '-profile:v', 'baseline'];
    case 'h264_nvenc':
      return [
        '-preset',
        'p1',
        '-tune',
        'ull',
        '-zerolatency',
        '1',
        '-profile:v',
        'baseline',
        '-flags',
        'low_delay',
      ];
    case 'h264_vaapi':
      return ['-flags', 'low_delay'];
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-look_ahead', '0', '-profile:v', 'baseline', '-flags', 'low_delay'];
    case 'libx264':
      return [
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'baseline',
        '-crf',
        '26',
        '-flags',
        'low_delay',
      ];
  }
}

/**
 * Build strictly validated `ffmpeg` argument array for low-latency RGBA -> FLV H.264 encoding.
 * Odd dimensions are padded by 1px to an even integer so YUV420p H.264 encoding always succeeds.
 */
export function buildFfmpegArgs(
  encoder: HostH264EncoderName,
  options: { width: number; height: number; fpsCap: number },
): { args: string[]; encodedWidth: number; encodedHeight: number } {
  const width = assertDimension(options.width, 'width');
  const height = assertDimension(options.height, 'height');
  const fps = assertFpsCap(options.fpsCap);
  const encodedWidth = width + (width & 1);
  const encodedHeight = height + (height & 1);
  const gopSize = Math.max(1, fps * KEY_FRAME_INTERVAL_S);

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    'nobuffer',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
  ];
  if (encoder === 'h264_vaapi') {
    args.push('-vaapi_device', DEFAULT_VAAPI_DEVICE);
  }

  args.push(
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
    '-an',
  );

  const filters: string[] = [];
  if (encodedWidth !== width || encodedHeight !== height) {
    filters.push(`pad=${encodedWidth}:${encodedHeight}:0:0:black`);
  }
  if (encoder === 'h264_vaapi') {
    filters.push('format=nv12', 'hwupload');
  } else {
    args.push('-pix_fmt', 'yuv420p');
  }
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  args.push(
    '-fps_mode',
    'passthrough',
    '-c:v',
    encoder,
    '-bf',
    '0',
    '-g',
    String(gopSize),
    ...encoderTuningArgs(encoder),
    '-flush_packets',
    '1',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-max_interleave_delta',
    '0',
    '-f',
    'flv',
    'pipe:1',
  );

  return { args, encodedWidth, encodedHeight };
}

function appendBoundedStderr(chunks: Buffer[], totalBytes: number, chunk: Buffer): number {
  if (totalBytes >= STDERR_CAP_BYTES) return totalBytes;
  const remaining = STDERR_CAP_BYTES - totalBytes;
  const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(slice);
  return totalBytes + slice.length;
}

function formatStderrSummary(chunks: readonly Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return '';
  return text.length <= MAX_ERROR_SUMMARY_CHARS ? text : text.slice(0, MAX_ERROR_SUMMARY_CHARS);
}

/**
 * Spawns and manages one `ffmpeg` encoder process converting RGBA frames on stdin to FLV-delimited
 * H.264 packets on stdout, emitted as Annex B packets with zero frame holdback.
 */
export class HostVideoEncoder implements HostVideoEncoderHandle {
  readonly width: number;
  readonly height: number;
  readonly encodedWidth: number;
  readonly encodedHeight: number;

  private readonly child: SpawnedFfmpegProcess;
  private readonly parser = new FlvH264Parser();
  private readonly ptsQueue: number[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly expectedFrameBytes: number;
  private readonly eofGraceMs: number;
  private readonly termGraceMs: number;
  private readonly flushDelayMs: number;
  private readonly flushIntervalMs: number;

  private stderrBytes = 0;
  private lastPts = 0;
  private lastRealFrame: Buffer | null = null;
  private lastRealPts = 0;
  private writtenTotalFrames = 0;
  private targetCodedIndex = 0;
  private emittedCodedFrames = 0;
  private flushAttempts = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private backpressured = false;
  private closing = false;
  private exited = false;
  private exitNotified = false;
  private closePromise: Promise<void> | null = null;
  private readonly exitWaiters = new Set<() => void>();

  constructor(
    probe: HostH264EncoderInfo,
    private readonly options: HostVideoEncoderOptions,
    deps: HostVideoEncoderDeps = {},
  ) {
    this.width = assertDimension(options.width, 'width');
    this.height = assertDimension(options.height, 'height');
    this.expectedFrameBytes = this.width * this.height * 4;
    this.eofGraceMs = deps.eofGraceMs ?? DEFAULT_EOF_GRACE_MS;
    this.termGraceMs = deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    const defaultFlushDelayMs = Math.min(
      MAX_FLUSH_DELAY_MS,
      Math.max(MIN_FLUSH_DELAY_MS, Math.round(1000 / assertFpsCap(options.fpsCap)) + 10),
    );
    this.flushDelayMs = deps.flushDelayMs ?? defaultFlushDelayMs;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    const { args, encodedWidth, encodedHeight } = buildFfmpegArgs(probe.encoder, {
      width: this.width,
      height: this.height,
      fpsCap: options.fpsCap,
    });
    this.encodedWidth = encodedWidth;
    this.encodedHeight = encodedHeight;

    const spawnFn: SpawnFfmpegLike =
      deps.spawn ??
      ((command, spawnArgs, spawnOpts) => spawn(command, [...spawnArgs], spawnOpts) as ChildProcess);

    this.child = spawnFn(probe.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdin?.on('error', () => undefined);
    this.child.stdin?.on('drain', () => {
      this.backpressured = false;
      if (this.emittedCodedFrames < this.targetCodedIndex) {
        this.scheduleFlush(this.flushDelayMs);
      }
    });
    this.child.stdout?.on('error', () => undefined);
    this.child.stdout?.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.emitParsedPackets(this.parser.push(buf));
    });
    this.child.stderr?.on('error', () => undefined);
    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.stderrBytes = appendBoundedStderr(this.stderrChunks, this.stderrBytes, buf);
    });

    this.child.on('error', (error) => {
      this.onProcessFinish(error);
    });
    this.child.on('close', (code, signal) => {
      const detail = formatStderrSummary(this.stderrChunks);
      const failure =
        !this.closing && (code !== 0 || signal !== null)
          ? new Error(`ffmpeg exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`)
          : undefined;
      this.onProcessFinish(failure);
    });
  }

  get isBackpressured(): boolean {
    return this.backpressured;
  }

  /**
   * Write one RGBA frame to `ffmpeg` stdin.
   * Returns `true` if the frame was accepted into stdin, or `false` if closed or currently backpressured.
   */
  writeFrame(rgba: Buffer, ptsUs: number): boolean {
    if (!Number.isFinite(ptsUs)) {
      throw new RangeError(`ptsUs must be finite, got ${ptsUs}`);
    }
    if (rgba.length < this.expectedFrameBytes) {
      throw new RangeError(
        `RGBA buffer too small: expected at least ${this.expectedFrameBytes} bytes, got ${rgba.length}`,
      );
    }
    const stdin = this.child.stdin;
    if (this.closing || this.exited || this.backpressured || !stdin || stdin.destroyed || !stdin.writable) {
      return false;
    }

    const slice = rgba.length === this.expectedFrameBytes ? rgba : rgba.subarray(0, this.expectedFrameBytes);
    this.lastRealFrame = slice;
    this.lastRealPts = ptsUs;
    this.ptsQueue.push(ptsUs);
    try {
      const ready = stdin.write(slice);
      this.writtenTotalFrames += 1;
      this.targetCodedIndex = this.writtenTotalFrames;
      this.flushAttempts = 0;
      if (!ready) this.backpressured = true;
      else this.scheduleFlush(this.flushDelayMs);
      return true;
    } catch (error) {
      this.ptsQueue.pop();
      log.warn(`Writing frame to ffmpeg failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Close stdin and terminate `ffmpeg` with `SIGTERM` then `SIGKILL` grace so no process leaks. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.clearFlushTimer();
    this.lastRealFrame = null;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private scheduleFlush(delayMs: number): void {
    this.clearFlushTimer();
    if (
      delayMs < 0 ||
      this.closing ||
      this.exited ||
      this.backpressured ||
      this.emittedCodedFrames >= this.targetCodedIndex ||
      !this.lastRealFrame
    ) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPipeline();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * `ffmpeg` CLI (`dmx0`) and hardware encoders (`h264_videotoolbox`) buffer 1–5 frames in flight before
   * emitting packet #1. When a static or settled frame has not emerged after `flushDelayMs`, repeat the
   * identical frame until that target frame exits `stdout`, then stop so idle bandwidth stays zero.
   */
  private flushPipeline(): void {
    if (
      this.closing ||
      this.exited ||
      this.backpressured ||
      this.emittedCodedFrames >= this.targetCodedIndex ||
      this.flushAttempts >= MAX_FLUSH_ATTEMPTS
    ) {
      return;
    }
    const frame = this.lastRealFrame;
    const stdin = this.child.stdin;
    if (!frame || !stdin || stdin.destroyed || !stdin.writable) return;

    if (this.writtenTotalFrames - this.emittedCodedFrames >= MAX_FLUSH_IN_FLIGHT) {
      this.flushAttempts += 1;
      this.scheduleFlush(this.flushIntervalMs);
      return;
    }

    this.ptsQueue.push(this.lastRealPts);
    try {
      const ready = stdin.write(frame);
      this.writtenTotalFrames += 1;
      this.flushAttempts += 1;
      if (!ready) this.backpressured = true;
      else if (this.emittedCodedFrames < this.targetCodedIndex) {
        this.scheduleFlush(this.flushIntervalMs);
      }
    } catch {
      this.ptsQueue.pop();
    }
  }

  private async performClose(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin?.end();
    } catch {
      // Stdin may already be destroyed if ffmpeg crashed.
    }

    if (await this.waitForExit(this.eofGraceMs)) return;

    try {
      this.child.kill('SIGTERM');
    } catch {
      // Process may have exited right as SIGTERM was sent.
    }

    if (await this.waitForExit(this.termGraceMs)) return;

    try {
      this.child.kill('SIGKILL');
    } catch {
      // Process already gone.
    }
    await this.waitForExit(this.termGraceMs);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (didExit: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.exitWaiters.delete(onExit);
        resolve(didExit);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.exitWaiters.add(onExit);
    });
  }

  private emitParsedPackets(packets: ReturnType<FlvH264Parser['push']>): void {
    for (const packet of packets) {
      if (this.closing) return;
      if (packet.isConfig) {
        this.options.onPacket({ isConfig: true, isKey: false, pts: 0, data: packet.data });
        continue;
      }
      this.emittedCodedFrames += 1;
      const pts = this.ptsQueue.shift() ?? this.lastPts;
      this.lastPts = pts;
      this.options.onPacket({ isConfig: false, isKey: packet.isKey, pts, data: packet.data });
    }
    if (this.emittedCodedFrames >= this.targetCodedIndex) {
      this.clearFlushTimer();
      this.flushAttempts = 0;
    }
  }

  private onProcessFinish(error?: Error): void {
    this.clearFlushTimer();
    this.lastRealFrame = null;
    if (!this.closing) {
      try {
        this.emitParsedPackets(this.parser.flush());
      } catch (parseError) {
        error ??= parseError instanceof Error ? parseError : new Error(errorMessage(parseError));
      }
    }
    this.exited = true;
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters.clear();

    if (this.exitNotified) return;
    this.exitNotified = true;
    this.options.onExit(this.closing ? undefined : error);
  }
}

export function createHostVideoEncoderFactory(
  probe: HostH264EncoderInfo,
  deps: HostVideoEncoderDeps = {},
): HostVideoEncoderFactory {
  return (options) => new HostVideoEncoder(probe, options, deps);
}

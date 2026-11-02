import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Adb } from '../../src/adb/adb.ts';
import { PS_COMMAND } from '../../src/session/appPids.ts';

export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

/** A ChildProcess stand-in built from PassThrough streams. */
export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exited = false;
  /** Everything written to stdin so far. */
  input = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk;
    });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.exit(null, 'SIGTERM'));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.emit('exit', code, signal);
  }
}

/** What a fake device shell does with a command: reply (optionally later) or never answer. */
export type ShellReply = string | { output: string; delayMs: number } | 'hang';
export type ShellHandler = (command: string) => ShellReply;

const FRAMED_LINE =
  /^printf '\\n__LSB_([0-9a-f]{16})_%s__\\n' (\d+); (.*); printf '\\n__LS_[0-9a-f]{16}_%s__\\n' \d+$/;

/**
 * A fake `adb shell` that understands ShellSession's framing: every framed command line is answered
 * via `handler` between the begin and the end marker. With `ptyNoise` it behaves like an API 23 PTY
 * shell: the line is echoed back and a prompt is printed before the begin marker.
 */
export class FakeShellChild extends FakeChild {
  readonly commands: string[] = [];
  private pending = '';
  private chain: Promise<void> = Promise.resolve();
  /** Emulate a PTY shell (API < 24), which turns every `\n` into `\r\n`. */
  crlf = false;
  /** Emulate the echo and prompt of a PTY shell (API 23) around every command. */
  ptyNoise = false;

  constructor(private readonly handler: ShellHandler) {
    super();
    this.stdin.on('data', (chunk: string) => this.onInput(chunk));
  }

  private write(text: string): void {
    this.stdout.write(this.crlf ? text.replaceAll('\n', '\r\n') : text);
  }

  private onInput(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.onLine(line);
      newline = this.pending.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    if (line === 'exec 2>&1') {
      if (this.ptyNoise) this.write(`${line}\nroot@generic_arm64:/ # `);
      return;
    }
    const framed = FRAMED_LINE.exec(line);
    if (!framed?.[1] || !framed[2] || framed[3] === undefined) return;
    const [, nonce, id, command] = framed;
    this.commands.push(command);
    const reply = this.handler(command);
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          if (reply === 'hang') return; // never resolves: the session must time out
          const output = typeof reply === 'string' ? reply : reply.output;
          const delayMs = typeof reply === 'string' ? 0 : reply.delayMs;
          const write = () => {
            if (!this.exited) {
              if (this.ptyNoise) this.write(`${line}\n`);
              this.write(`\n__LSB_${nonce}_${id}__\n${output}\n__LS_${nonce}_${id}__\n`);
              if (this.ptyNoise) this.write('root@generic_arm64:/ # ');
            }
            resolve();
          };
          if (delayMs > 0) setTimeout(write, delayMs);
          else write();
        }),
    );
  }
}

export type ExecHandler = (args: readonly string[]) => string | Promise<string>;

/** The command of an `adb -s <serial> shell <command>` exec, null for any other adb call. */
export function execShellCommand(args: readonly string[]): string | null {
  return args[0] === '-s' && args[2] === 'shell' && args.length === 4 ? (args[3] ?? null) : null;
}

/** Fake Adb: `exec` goes to a handler, `spawn` creates fake shells / logcat children. */
export class FakeAdb implements Adb {
  readonly path = 'fake-adb';
  readonly shells: FakeShellChild[] = [];
  /** `logcat` children of an app's process (`--pid`). */
  readonly logcats: { args: readonly string[]; child: FakeChild }[] = [];
  /** `logcat -b crash` children (a session's crash stream), kept apart from `logcats`. */
  readonly crashLogcats: { args: readonly string[]; child: FakeChild }[] = [];
  readonly execCalls: (readonly string[])[] = [];
  /** Spawn PTY shells like API 23 does (echo, prompt, CRLF). */
  pty = false;
  /** `reverse` / `removeReverse` calls as adb argument lists (kept apart from execCalls). */
  readonly reverseCalls: string[][] = [];
  /** Throw (or reject) here to make a reverse call fail. */
  reverseHandler: (args: readonly string[]) => void | Promise<void> = () => undefined;

  constructor(
    public execHandler: ExecHandler,
    public shellHandler: ShellHandler = () => '',
  ) {}

  reverse(serial: string, devicePort: number, hostPort: number): Promise<void> {
    return this.runReverse(['-s', serial, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`]);
  }

  removeReverse(serial: string, devicePort: number): Promise<void> {
    return this.runReverse(['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`]);
  }

  private runReverse(args: string[]): Promise<void> {
    this.reverseCalls.push(args);
    return Promise.resolve().then(() => this.reverseHandler(args));
  }

  exec(args: readonly string[]): Promise<string> {
    this.execCalls.push(args);
    return Promise.resolve().then(() => this.execHandler(args));
  }

  spawn(args: readonly string[]): FakeChild {
    if (args.includes('logcat')) {
      const child = new FakeChild();
      (args.includes('crash') ? this.crashLogcats : this.logcats).push({ args, child });
      return child;
    }
    const shell = new FakeShellChild((command) => this.shellHandler(command));
    shell.crlf = this.pty;
    shell.ptyNoise = this.pty;
    this.shells.push(shell);
    return shell;
  }

  get liveLogcats(): { args: readonly string[]; child: FakeChild }[] {
    return this.logcats.filter((entry) => !entry.child.killed && !entry.child.exited);
  }
}

/** Build a /proc/<pid>/stat line with a tricky comm and the given counters. */
export function statLine(
  pid: number,
  utime: number,
  stime: number,
  threads: number,
  startTime = 1152,
): string {
  const middle = Array.from({ length: 10 }, (_, i) => i + 1).join(' ');
  return `${pid} (my (weird) app) S ${middle} ${utime} ${stime} 0 0 20 0 ${threads} 0 ${startTime} 17730977792\n`;
}

/** Minimal framestats dump with one PROFILEDATA block holding frames at the given vsyncs. */
export function framestats(frames: { vsync: number; durationMs: number; flags?: number }[]): string {
  const header = 'Flags,IntendedVsync,Vsync,FrameDeadline,FrameInterval,FrameCompleted,';
  const rows = frames.map(
    (frame) =>
      `${frame.flags ?? 0},${frame.vsync},${frame.vsync},${frame.vsync + 16_666_666},16666666,${
        frame.vsync + Math.round(frame.durationMs * 1_000_000)
      },`,
  );
  return ['Window: test', '---PROFILEDATA---', header, ...rows, '---PROFILEDATA---', ''].join('\n');
}

const API30_HEADER =
  'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,' +
  'PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,' +
  'DequeueBufferDuration,QueueBufferDuration,';
export const VSYNC_120HZ_NS = 8_333_333;

/**
 * Synthetic API 30 `framestats` dump (no FrameInterval / FrameDeadline columns) for a 120 Hz device.
 * Each inner array is one window; values are vsync indices; every frame takes `durationMs`.
 */
export function api30Framestats(windows: number[][], durationMs = 5, baseNs = 50_000_000_000): string {
  const blocks = windows.map((vsyncs, w) => {
    const rows = vsyncs.map((index) => {
      const vsync = baseNs + index * VSYNC_120HZ_NS;
      const done = vsync + Math.round(durationMs * 1e6);
      return `0,${vsync},${vsync},0,0,${vsync},${vsync},${vsync},${vsync},${vsync},${vsync},${vsync},${done},${done},100,200,`;
    });
    return [`Window: w${w}`, '---PROFILEDATA---', API30_HEADER, ...rows, '---PROFILEDATA---', ''].join('\n');
  });
  return ['Profile data in ms:', ...blocks].join('\n');
}

/** Scriptable device behind FakeAdb: PID, CPU counters, memory and frames. */
export class FakeDevice {
  pid: number | null = 1105;
  /** /proc/<pid>/stat starttime; change it to simulate PID reuse. */
  startTime = 1152;
  ticks = 0;
  ticksPerPoll = 50;
  clockSkewMs = -5000;
  meminfo = fixture('meminfo.txt');
  meminfoReply: (() => ShellReply) | null = null;
  nextVsync = 1_000_000_000;
  framesPerPoll = 3;
  /**
   * Behave like API 23: toybox `pidof` ignores its name and prints every PID, `date +%s%3N` prints
   * `<seconds>3N`, the SDK level is 23 (and its logcat predates `-v epoch`).
   */
  legacy = false;
  /** The package `ps` lists under `pid` when `legacy`. */
  legacyPackage = 'com.google.android.apps.nexuslauncher';
  /** Zone of the device clock when `legacy`: local time = UTC + this. */
  utcOffsetMs = 7 * 3_600_000;
  readonly commands: string[] = [];
  private readonly bootedAt = Date.now() - 100_000;

  /** Device uptime follows the (fake) wall clock, like a real device. */
  get uptimeLine(): string {
    return `${((Date.now() - this.bootedAt) / 1000).toFixed(2)} 1.00\n`;
  }

  handle(command: string): ShellReply {
    this.commands.push(command);
    if (command === 'getconf CLK_TCK') return '100\n';
    if (command === 'cat /sys/devices/system/cpu/possible') return '0-3\n';
    if (command === 'getprop ro.build.version.sdk') return this.legacy ? '23\n' : '34\n';
    if (command === 'date +%s%3N') {
      const deviceMs = Date.now() + this.clockSkewMs;
      return this.legacy ? `${Math.floor(deviceMs / 1000)}3N\n` : `${deviceMs}\n`;
    }
    if (command === 'date "+%s %Y-%m-%d %H:%M:%S"') {
      const seconds = Math.floor((Date.now() + this.clockSkewMs) / 1000);
      const local = new Date(seconds * 1000 + this.utcOffsetMs).toISOString();
      return `${seconds} ${local.slice(0, 10)} ${local.slice(11, 19)}\n`;
    }
    if (command.startsWith('pidof ')) {
      if (this.legacy) return fixture('pidof-api23.txt');
      return this.pid === null ? '' : `${this.pid}\n`;
    }
    if (command === PS_COMMAND) {
      const app =
        this.pid === null
          ? ''
          : `u0_a55    ${this.pid}  897   1245156 114040 SyS_epoll_ 7b974f3a34 S ${this.legacyPackage}\n`;
      return `${fixture('ps-api23.txt')}${app}USER      PID   PPID  VSIZE  RSS   WCHAN              PC  NAME\n`;
    }
    const stat = /^cat \/proc\/uptime \/proc\/(\d+)\/stat$/.exec(command);
    if (stat) {
      if (Number(stat[1]) !== this.pid) return `${this.uptimeLine}cat: /proc/${stat[1]}/stat: No such file\n`;
      this.ticks += this.ticksPerPoll;
      return `${this.uptimeLine}${statLine(this.pid, this.ticks, 0, 42, this.startTime)}`;
    }
    const gfx = /^cat \/proc\/uptime; dumpsys gfxinfo (\d+) framestats reset$/.exec(command);
    if (gfx) {
      if (Number(gfx[1]) !== this.pid) return `${this.uptimeLine}No process found for: ${gfx[1]}\n`;
      const frames = Array.from({ length: this.framesPerPoll }, (_, i) => ({
        vsync: this.nextVsync + i * 16_666_666,
        durationMs: i === 0 ? 40 : 8,
      }));
      this.nextVsync += 1_000_000_000;
      return `${this.uptimeLine}${framestats(frames)}`;
    }
    if (/^dumpsys meminfo --local \d+$/.test(command)) return this.meminfoReply?.() ?? this.meminfo;
    return '';
  }
}

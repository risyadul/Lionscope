import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callTool } from '../src/agent/registry.ts';
import { dumpUi, UI_DUMP_FAILED, UI_HELPER_FAILED_TOO } from '../src/agent/uiDump.ts';
import {
  HELPER_BAD_JAR,
  HELPER_BUSY,
  HELPER_CLOSED,
  HELPER_CRASHED,
  HELPER_FAILED,
  HELPER_OLD_API,
  HELPER_TIMEOUT,
  HELPER_TOO_LARGE,
  resolveUiHelperJar,
  UI_HELPER_IDLE_MS,
  UI_HELPER_MAIN,
  UiHelperError,
  UiHelpers,
} from '../src/agent/uiHelper.ts';
import type { UiHelperOptions } from '../src/agent/uiHelper.ts';
import { UI_HELPER_JAR_NAME, UI_HELPER_JAR_SHA256 } from '../src/agent/uiHelperJar.ts';
import { MAX_UI_XML_BYTES } from '../src/agent/uiXml.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import { FakeAdb, FakeChild, fixture } from './helpers/fakes.ts';

const SERIAL = 'emulator-5554';
const DUMP = fixture('ui-dump.xml').trim();

/** What the fake helper does with a dump request. */
type DumpReply = string | 'no-root' | 'failed' | 'hang' | 'crash' | 'huge';

/** A fake `adb shell … app_process … UiHelper`: READY (or ERR) first, then answers per `reply`. */
class FakeHelperChild extends FakeChild {
  readonly requests: string[] = [];
  private pending = '';

  constructor(
    readonly args: readonly string[],
    start: 'ready' | 'busy' | 'silent' | 'crash',
    private readonly reply: () => DumpReply,
    /** false: ignores `exit` and the end of stdin, so it has to be killed. */
    private readonly obeysExit = true,
  ) {
    super();
    queueMicrotask(() => {
      if (start === 'ready') this.stdout.write('some framework noise\nREADY 1\n');
      else if (start === 'busy') {
        this.stdout.write('ERR - busy\n');
        this.exit(2);
      } else if (start === 'crash') this.exit(1);
    });
    this.stdin.on('data', (chunk: string) => this.onInput(chunk));
    this.stdin.on('end', () => {
      if (this.obeysExit) this.exit(0);
    });
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
    this.requests.push(line);
    if (line === 'exit') {
      if (this.obeysExit) this.exit(0);
      return;
    }
    const nonce = /^dump ([0-9a-f]+)$/.exec(line)?.[1];
    if (!nonce) return;
    const reply = this.reply();
    if (reply === 'hang') return;
    if (reply === 'crash') {
      this.exit(null, 'SIGKILL');
      return;
    }
    // A PTY shell's echo and \r\n, and a stale answer, are all skipped by the reader.
    this.stdout.write(`${line}\r\nOK 0000 <hierarchy/>\r\n`);
    if (reply === 'huge') {
      this.stdout.write(`OK ${nonce} <hierarchy>${'x'.repeat(MAX_UI_XML_BYTES + 2048)}`);
      return;
    }
    const answer =
      reply === 'no-root'
        ? `ERR ${nonce} no-root`
        : reply === 'failed'
          ? `ERR ${nonce} failed`
          : `OK ${nonce} ${reply}`;
    // Split across chunks, as a pipe may deliver it.
    this.stdout.write(answer.slice(0, 10));
    setTimeout(() => this.stdout.write(`${answer.slice(10)}\r\n`), 1);
  }
}

interface Scenario {
  starts?: ('ready' | 'busy' | 'silent' | 'crash')[];
  replies?: DumpReply[];
  obeysExit?: boolean;
  wmSize?: string;
  /** ro.build.version.sdk (default 35). */
  api?: number;
  /** How long `adb push` takes. */
  pushMs?: number;
}

/** adb whose pushes succeed, whose shells answer `wm size`, and whose app_process runs a FakeHelperChild. */
class FakeHelperAdb extends FakeAdb {
  readonly helpers: FakeHelperChild[] = [];
  readonly pushes: (readonly string[])[] = [];
  readonly commands: string[] = [];
  private startIndex = 0;
  private replyIndex = 0;

  constructor(private readonly scenario: Scenario) {
    super(() => '');
    this.execHandler = (args) => {
      const command = String(args.at(-1));
      this.commands.push(command);
      if (command === 'getprop ro.build.version.sdk') return `${scenario.api ?? 35}\n`;
      // Each marker the command echoes, followed by what comes after it.
      const answers: Record<string, string> = {
        XML: DUMP,
        WM: scenario.wmSize ?? 'Physical size: 1080x2400',
        TOP: 'topResumedActivity=ActivityRecord{1 u0 com.example.shop/.MainActivity t1}',
      };
      const markers = [...command.matchAll(/echo (__LS_[0-9a-f]+_([A-Z]+)__)/g)];
      if (markers.length === 0) return '';
      const status = command.startsWith('uiautomator dump') ? 'UI hierchary dumped to: x\n' : '';
      return status + markers.map((match) => `${match[1]}\n${answers[match[2] ?? ''] ?? ''}\n`).join('');
    };
  }

  override spawn(args: readonly string[]): FakeChild {
    if (args.includes('push')) {
      this.pushes.push(args);
      const child = new FakeChild();
      setTimeout(() => child.exit(0), this.scenario.pushMs ?? 0);
      return child;
    }
    if (args.includes('app_process')) {
      const starts = this.scenario.starts ?? ['ready'];
      const start = starts[Math.min(this.startIndex++, starts.length - 1)] ?? 'ready';
      const replies = this.scenario.replies ?? [DUMP];
      const helper = new FakeHelperChild(
        args,
        start,
        () => replies[Math.min(this.replyIndex++, replies.length - 1)] ?? DUMP,
        this.scenario.obeysExit ?? true,
      );
      this.helpers.push(helper);
      return helper;
    }
    return super.spawn(args);
  }

  get removals(): string[] {
    return this.commands.filter((command) =>
      command.startsWith('rm -f /data/local/tmp/lionscope-ui-helper-'),
    );
  }
}

let dir: string;
let jarPath: string;
let jarSha256: string;
const managers: UiHelpers[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lionscope-ui-helper-test-'));
  jarPath = path.join(dir, UI_HELPER_JAR_NAME);
  writeFileSync(jarPath, 'fake dex jar');
  jarSha256 = createHash('sha256').update('fake dex jar').digest('hex');
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  rmSync(dir, { recursive: true, force: true });
});

function helpers(adb: FakeHelperAdb, options: Partial<UiHelperOptions> = {}): UiHelpers {
  const manager = new UiHelpers({ adb, jarPath, jarSha256, ...options });
  managers.push(manager);
  return manager;
}

describe('the UI helper jar', () => {
  it('is vendored with its checksum, which the server has built in', () => {
    const jar = resolveUiHelperJar();
    expect(jar.endsWith(path.join('server', 'vendor', UI_HELPER_JAR_NAME))).toBe(true);
    const digest = createHash('sha256').update(readFileSync(jar)).digest('hex');
    expect(digest).toBe(UI_HELPER_JAR_SHA256);
    expect(readFileSync(`${jar}.sha256`, 'utf8')).toBe(`${UI_HELPER_JAR_SHA256}  ${UI_HELPER_JAR_NAME}\n`);
    const bundle = pathToFileURL(path.join(dir, 'dist', 'lionscope.mjs')).href;
    expect(resolveUiHelperJar(bundle, true)).toBe(path.join(dir, 'dist', UI_HELPER_JAR_NAME));
  });
});

describe('UiHelpers', () => {
  it('pushes the jar under a fresh versioned name, starts it once and serves dumps from it', async () => {
    const adb = new FakeHelperAdb({});
    const manager = helpers(adb);
    const dumps = await Promise.all([manager.dump(SERIAL, 5000), manager.dump(SERIAL, 5000)]);
    expect(dumps).toEqual([{ xml: DUMP }, { xml: DUMP }]);
    expect(adb.helpers).toHaveLength(1);
    const [helper] = adb.helpers;
    const devicePath = /^CLASSPATH=(\S+)$/.exec(helper?.args[3] ?? '')?.[1] ?? '';
    expect(devicePath).toMatch(/^\/data\/local\/tmp\/lionscope-ui-helper-v1-[0-9a-f]{12}\.jar$/);
    expect(adb.pushes[0]?.at(-1)).toBe(devicePath);
    expect(helper?.args.slice(0, 7)).toEqual([
      '-s',
      SERIAL,
      'shell',
      `CLASSPATH=${devicePath}`,
      'app_process',
      '/',
      UI_HELPER_MAIN,
    ]);
    // Requests go one at a time, each with its own nonce.
    const nonces = helper?.requests.map((line) => /^dump ([0-9a-f]{16})$/.exec(line)?.[1]);
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(2);
    expect(manager.unavailable(SERIAL)).toBeNull();
  });

  it('reports a screen without an active window as null', async () => {
    const manager = helpers(new FakeHelperAdb({ replies: ['no-root'] }));
    expect(await manager.dump(SERIAL, 5000)).toBeNull();
  });

  it('refuses a jar that does not match its checksum, without pushing it', async () => {
    const adb = new FakeHelperAdb({});
    const manager = helpers(adb, { jarSha256: '0'.repeat(64) });
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_BAD_JAR);
    expect(adb.pushes).toEqual([]);
  });

  it('backs off when another UiAutomation is connected, and tries again later', async () => {
    const adb = new FakeHelperAdb({ starts: ['busy', 'ready'] });
    const manager = helpers(adb, { backoffMs: 50 });
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_BUSY);
    expect(manager.unavailable(SERIAL)).toBe(HELPER_BUSY);
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_BUSY);
    expect(adb.helpers).toHaveLength(1);
    expect(adb.removals).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.unavailable(SERIAL)).toBeNull();
    expect(await manager.dump(SERIAL, 5000)).toEqual({ xml: DUMP });
  });

  it('restarts a helper that crashed once, and gives up on a second crash', async () => {
    const adb = new FakeHelperAdb({ replies: ['crash', DUMP, 'crash', 'crash'] });
    const manager = helpers(adb);
    expect(await manager.dump(SERIAL, 5000)).toEqual({ xml: DUMP });
    expect(adb.helpers).toHaveLength(2);
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_CRASHED);
    expect(adb.helpers).toHaveLength(3);
    expect(manager.unavailable(SERIAL)).toBe(HELPER_CRASHED);
    // Each helper's jar is removed again.
    expect(new Set(adb.removals).size).toBe(3);
  });

  it('stops a helper that does not answer in time, killing it on the device', async () => {
    const adb = new FakeHelperAdb({ replies: ['hang'], obeysExit: false });
    const manager = helpers(adb);
    await expect(manager.dump(SERIAL, 300)).rejects.toThrow(HELPER_TIMEOUT);
    const [helper] = adb.helpers;
    expect(helper?.requests.at(-1)).toBe('exit');
    expect(helper?.killed).toBe(true);
    const token = helper?.args.at(-1) ?? '';
    expect(adb.commands).toContain(`pkill -f '${UI_HELPER_MAIN} [${token[0]}]${token.slice(1)}'`);
    expect(adb.removals).toHaveLength(1);
  });

  it('gives up on a helper that does not start in time', async () => {
    const adb = new FakeHelperAdb({ starts: ['silent'] });
    const manager = helpers(adb, { startMs: 100 });
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_TIMEOUT);
    expect(adb.helpers[0]?.exited).toBe(true);
  });

  it('turns a failed read and an oversized answer into errors', async () => {
    await expect(helpers(new FakeHelperAdb({ replies: ['failed'] })).dump(SERIAL, 5000)).rejects.toThrow(
      HELPER_FAILED,
    );
    await expect(helpers(new FakeHelperAdb({ replies: ['huge'] })).dump(SERIAL, 5000)).rejects.toThrow(
      HELPER_TOO_LARGE,
    );
  });

  it('stops an idle helper and removes its jar', async () => {
    const adb = new FakeHelperAdb({});
    const manager = helpers(adb, { idleMs: 30 });
    await manager.dump(SERIAL, 5000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(adb.helpers[0]?.requests.at(-1)).toBe('exit');
    expect(adb.helpers[0]?.exited).toBe(true);
    expect(adb.removals).toHaveLength(1);
    // The next dump starts a new one.
    await manager.dump(SERIAL, 5000);
    expect(adb.helpers).toHaveLength(2);
  });

  it('stops every helper on close and refuses dumps after it', async () => {
    const adb = new FakeHelperAdb({});
    const manager = helpers(adb);
    await manager.dump(SERIAL, 5000);
    await manager.dump('emulator-5556', 5000);
    await manager.close();
    expect(adb.helpers.every((helper) => helper.exited && helper.requests.at(-1) === 'exit')).toBe(true);
    expect(adb.removals).toHaveLength(2);
    await expect(manager.dump(SERIAL, 5000)).rejects.toBeInstanceOf(UiHelperError);
  });
});

describe('UiHelpers on a device that goes away or a server that closes', () => {
  const until = async (condition: () => boolean) => {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it('treats a failing stream (EPIPE once the device is gone) as the helper exiting, and restarts it', async () => {
    const adb = new FakeHelperAdb({ replies: ['hang', DUMP] });
    const manager = helpers(adb);
    const dump = manager.dump(SERIAL, 5000);
    await until(() => adb.helpers[0]?.requests.length === 1);
    adb.helpers[0]?.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(await dump).toEqual({ xml: DUMP });
    expect(adb.helpers[0]?.killed).toBe(true);
    expect(adb.helpers).toHaveLength(2);
    // An idle helper's stream failing is noticed too: the next dump starts another one.
    adb.helpers[1]?.stderr.emit('error', new Error('read ECONNRESET'));
    expect(manager.isRunning(SERIAL)).toBe(false);
    expect(await manager.dump(SERIAL, 5000)).toEqual({ xml: DUMP });
    expect(adb.helpers).toHaveLength(3);
  });

  it('never restarts a helper once the server is closing', async () => {
    const adb = new FakeHelperAdb({ replies: ['hang'] });
    const manager = helpers(adb);
    const dump = manager.dump(SERIAL, 5000);
    await until(() => adb.helpers[0]?.requests.length === 1);
    await manager.close();
    await expect(dump).rejects.toThrow(UiHelperError);
    expect(adb.helpers).toHaveLength(1);
    expect(adb.pushes).toHaveLength(1);
  });

  it('starts nothing when the server closes while the jar is being pushed', async () => {
    const adb = new FakeHelperAdb({ pushMs: 50 });
    const manager = helpers(adb);
    const dump = manager.dump(SERIAL, 5000);
    await until(() => adb.pushes.length === 1);
    await manager.close();
    await expect(dump).rejects.toThrow(HELPER_CLOSED);
    expect(adb.helpers).toHaveLength(0);
    expect(adb.removals).toHaveLength(1);
  });

  it('is not used below API 24, where connecting would suppress TalkBack', async () => {
    const adb = new FakeHelperAdb({ api: 23 });
    const manager = helpers(adb);
    await expect(manager.dump(SERIAL, 5000)).rejects.toThrow(HELPER_OLD_API);
    expect(manager.unavailable(SERIAL)).toBe(HELPER_OLD_API);
    expect(adb.pushes).toEqual([]);
    expect(adb.commands.filter((command) => command.startsWith('getprop'))).toHaveLength(1);
  });

  it('stops an idle helper after 20 s by default', () => {
    expect(UI_HELPER_IDLE_MS).toBe(20_000);
  });
});

describe('UI dumps with the helper', () => {
  function agent(scenario: Scenario) {
    const adb = new FakeHelperAdb(scenario);
    const fake = fakeAgent({}, { adb });
    fake.ctx.uiHelper = helpers(adb);
    const call = async (name: string, args: unknown): Promise<Json> => {
      const outcome = await callTool(fake.ctx, name, args, true);
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    };
    return { adb, call };
  }

  it('uses the helper, reading the display size beside it', async () => {
    const { adb, call } = agent({ wmSize: 'Physical size: 1080x2400' });
    const result = await call('get_ui_tree', {});
    expect(result.screen).toEqual({ width: 1080, height: 2400, rotation: 0 });
    expect(result.elements.length).toBeGreaterThan(0);
    expect(adb.commands.some((command) => command.startsWith('uiautomator'))).toBe(false);
    expect(adb.commands.some((command) => command.includes('topResumedActivity'))).toBe(true);
  });

  it('falls back to uiautomator when the helper fails, after stopping it', async () => {
    const { adb, call } = agent({ replies: ['failed'] });
    const result = await call('get_ui_tree', {});
    expect(result.elements.length).toBeGreaterThan(0);
    expect(adb.helpers[0]?.exited).toBe(true);
    expect(adb.commands.some((command) => command.startsWith('uiautomator dump'))).toBe(true);
  });

  it('uses uiautomator on API 23', async () => {
    const { adb, call } = agent({ api: 23 });
    expect((await call('get_ui_tree', {})).elements.length).toBeGreaterThan(0);
    expect(adb.helpers).toHaveLength(0);
    expect(adb.commands.some((command) => command.startsWith('uiautomator dump'))).toBe(true);
  });

  it('does not start a helper with little time left, and counts no failure for it', async () => {
    const adb = new FakeHelperAdb({});
    const fake = fakeAgent({}, { adb });
    const manager = helpers(adb);
    fake.ctx.uiHelper = manager;
    const ctx = { ...fake.ctx, deviceControl: true, networkBodies: false };
    await dumpUi(ctx, SERIAL, { deadline: performance.now() + 2000 });
    expect(adb.helpers).toHaveLength(0);
    expect(manager.unavailable(SERIAL)).toBeNull();
    // With time enough it is started, and then used even for a short budget.
    await dumpUi(ctx, SERIAL, { deadline: performance.now() + 5000 });
    await dumpUi(ctx, SERIAL, { deadline: performance.now() + 1000 });
    expect(adb.helpers).toHaveLength(1);
    expect(adb.helpers[0]?.requests).toHaveLength(2);
  });

  it('retries a screen without a root through the helper', async () => {
    const { adb, call } = agent({ replies: ['no-root', DUMP] });
    expect((await call('get_ui_tree', {})).elements.length).toBeGreaterThan(0);
    expect(adb.commands.some((command) => command.startsWith('uiautomator'))).toBe(false);
  });

  it('names both failures when uiautomator fails too', async () => {
    const { adb, call } = agent({ starts: ['busy'] });
    adb.execHandler = (args) => {
      const command = String(args.at(-1));
      adb.commands.push(command);
      return command.startsWith('uiautomator dump') ? 'Killed' : '';
    };
    const failure = call('get_ui_tree', {});
    await expect(failure).rejects.toThrow(UI_DUMP_FAILED);
    await expect(failure).rejects.toThrow(`${UI_HELPER_FAILED_TOO} (${HELPER_BUSY}).`);
  }, 10_000);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildInputScript,
  INPUT_ESTIMATE_MS,
  MAX_STEPS,
  parseScriptOutput,
} from '../src/agent/inputTools.ts';
import { callTool } from '../src/agent/registry.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import { FakeAdb, FakeChild, fixture } from './helpers/fakes.ts';

const DUMP = fixture('ui-dump.xml');
const MARKER = '__LS_0123456789ab__';
/** What `t` echoes: the start mark, then one line per finished step. */
const START = 1_793_366_413;

/** The commands of a run_inputs script, each with the index of the step it belongs to. */
function scriptSteps(script: string): { command: string; index: number }[] {
  return [
    ...script.matchAll(/(input tap \d+ \d+|input keyevent \d+|sleep [\d.]+) \|\| f (\d+) \$\?; t (\d+)/g),
  ].map((match) => ({ command: match[1] ?? '', index: Number(match[3]) }));
}

/**
 * Runs a run_inputs script the way the device shell would, on a fake clock: an input takes `inputMs`, a sleep its
 * duration plus 4 ms; the command matching `fail` exits with status 1.
 */
function runScript(script: string, { inputMs = 25, fail = null as RegExp | null } = {}): string {
  const marker = /^m=(\S+);/.exec(script)?.[1] ?? '';
  let micros = 0;
  const now = () => `${START + Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, '0')}`;
  const lines = [`${marker} S ${now()}`];
  for (const { command, index } of scriptSteps(script)) {
    if (fail?.test(command)) {
      lines.push(`${marker} F ${index} 1`);
      break;
    }
    const sleep = /^sleep ([\d.]+)$/.exec(command)?.[1];
    micros += sleep === undefined ? inputMs * 1000 : Math.round(Number(sleep) * 1e6) + 4000;
    lines.push(`${marker} ${index} ${now()}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The markers a dump command asked for (they are random per call). */
function dumpMarkers(command: string): string[] {
  return [...command.matchAll(/echo (__LS_[0-9a-f]+_[A-Z]+__)/g)].map((match) => match[1] ?? '');
}

/** What `adb shell <script>` does: its output, then its exit code (or stderr and a code, or no end at all). */
type ScriptRun = string | { output: string; stderr?: string; exit?: number; hang?: true };

/**
 * adb answering `uiautomator dump` with the given dumps in turn (the last one repeats) and running run_inputs
 * scripts with `run`.
 */
function inputAgent(
  dumpsInTurn: readonly string[] = [DUMP],
  run: (script: string) => ScriptRun = (script) => runScript(script),
) {
  const commands: string[] = [];
  let dumpIndex = 0;
  const adb = new FakeAdb((args) => {
    const command = String(args.at(-1));
    commands.push(command);
    if (command.startsWith('wm size;')) {
      return 'Physical size: 1080x2400\n__LIONSCOPE_ROTATION__\n  Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1080, 2400]\n';
    }
    if (!command.startsWith('uiautomator dump')) return '';
    const file = /uiautomator dump (\S+)/.exec(command)?.[1] ?? '';
    const [xmlMarker = '', wmMarker = '', topMarker] = dumpMarkers(command);
    const dump = dumpsInTurn[Math.min(dumpIndex++, dumpsInTurn.length - 1)] ?? '';
    const top =
      topMarker === undefined
        ? ''
        : `\n${topMarker}\n  topResumedActivity=ActivityRecord{1 u0 com.example.shop/.MainActivity t1}`;
    return `UI hierchary dumped to: ${file}\n${xmlMarker}\n${dump}\n${wmMarker}\nPhysical size: 1080x2400${top}`;
  });
  adb.spawn = (args) => {
    const script = String(args.at(-1));
    commands.push(script);
    const reply = run(script);
    const {
      output,
      stderr = '',
      exit = 0,
      hang = false,
    } = typeof reply === 'string' ? { output: reply } : reply;
    const child = new FakeChild();
    setImmediate(() => {
      child.stdout.write(output);
      child.stderr.write(stderr);
      if (!hang) child.exit(exit);
    });
    return child;
  };
  const agent = fakeAgent({}, { adb });
  const scripts = () => commands.filter((command) => command.startsWith('m='));
  const dumps = () => commands.filter((command) => command.startsWith('uiautomator dump'));
  const call = async (args: unknown): Promise<Json> => {
    const outcome = await callTool(agent.ctx, 'run_inputs', args, true);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  };
  return { agent, call, scripts, dumps };
}

describe('run_inputs script', () => {
  it('is one shell script of numbers, allowlisted key codes and fractional sleeps', () => {
    const script = buildInputScript(
      [
        { type: 'tap', x: 540.4, y: 1200 },
        { type: 'wait', ms: 50 },
        { type: 'tap_element', x: 995, y: 140 },
        { type: 'key', key: 'back' },
      ],
      MARKER,
    );
    expect(script).toBe(
      [
        `m=${MARKER}`,
        't() { echo "$m $1 ${EPOCHREALTIME:-$(date +%s.%N)}"; }',
        'f() { echo "$m F $1 $2"; exit 0; }',
        't S',
        'input tap 540 1200 || f 0 $?',
        't 0',
        'sleep 0.050 || f 1 $?',
        't 1',
        'input tap 995 140 || f 2 $?',
        't 2',
        'input keyevent 4 || f 3 $?',
        't 3',
      ].join('; '),
    );
  });

  it('reads step ends in ms from the start, from a microsecond or a nanosecond clock', () => {
    const output = [
      'some other output',
      `${MARKER} S 1793366413.744071`,
      `${MARKER} 0 1793366413.771571`,
      `__LS_ffffffffffff__ 1 1793366499.000000`,
      `${MARKER} 1 1793366414.000000123`,
    ].join('\n');
    expect(parseScriptOutput(output, MARKER, 2)).toEqual({ ends: [27.5, 255.9], failed: null });
  });

  it('gives no timings for a clock without a fraction, and reports a failed step', () => {
    const output = [`${MARKER} S 1793366413.N`, `${MARKER} 0 1793366413.N`, `${MARKER} F 1 255`].join('\n');
    expect(parseScriptOutput(output, MARKER, 3)).toEqual({
      ends: [null],
      failed: { index: 1, exitCode: 255 },
    });
  });
});

describe('run_inputs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs taps, element taps, keys and waits in one shell call and times each step', async () => {
    const { call, scripts, dumps, agent } = inputAgent();
    const result = await call({
      steps: [
        { type: 'tap', x: 360, y: 800 },
        { type: 'wait', ms: 50 },
        { type: 'tap_element', desc: 'search' },
        { type: 'tap_element', id: 'title', nth: 2 },
        { type: 'key', key: 'back' },
      ],
      width: 720,
      height: 1600,
    });
    expect(scripts()).toHaveLength(1);
    expect(dumps()).toHaveLength(1);
    expect(scriptSteps(scripts()[0] ?? '').map((step) => step.command)).toEqual([
      'input tap 540 1200',
      'sleep 0.050',
      'input tap 995 140',
      'input tap 540 2200',
      'input keyevent 4',
    ]);
    expect(result).toMatchObject({
      untrusted: expect.any(String),
      serial: 'emulator-5554',
      totalMs: 154,
      steps: [
        { index: 0, type: 'tap', x: 540, y: 1200, atMs: 25, tookMs: 25 },
        { index: 1, type: 'wait', ms: 50, atMs: 79, tookMs: 54 },
        { index: 2, type: 'tap_element', x: 995, y: 140, element: { desc: 'Search' }, atMs: 104, tookMs: 25 },
        { index: 3, type: 'tap_element', x: 540, y: 2200, element: { class: 'LinearLayout' } },
        { index: 4, type: 'key', key: 'back', atMs: 154, tookMs: 25 },
      ],
    });
    expect(result.failed).toBeUndefined();
    // The screen changed: the next element tool dumps again.
    expect(agent.ctx.uiDumps.get('emulator-5554')?.at).toBe(-Infinity);
  });

  it('resolves elements from a fresh dump, not one cached a moment ago', async () => {
    const { call, dumps, agent } = inputAgent();
    await callTool(agent.ctx, 'get_ui_tree', {}, true);
    expect(dumps()).toHaveLength(1);
    await call({ steps: [{ type: 'tap_element', text: 'Row 1' }] });
    expect(dumps()).toHaveLength(2);
  });

  it('taps a listed element by index while the screen still shows it', async () => {
    const changed = DUMP.replace('content-desc="Search"', 'content-desc="Filter"');
    const { call, agent, scripts } = inputAgent([DUMP, DUMP, changed]);
    await expect(call({ steps: [{ type: 'tap_element', index: 3 }] })).rejects.toThrow(
      'steps[0]: No element with that index: call get_ui_tree first',
    );
    const listed = await callTool(agent.ctx, 'get_ui_tree', { filter: 'all' }, true);
    const search = (listed as Json).result.elements.find((element: Json) => element.desc === 'Search');
    const steps = [{ type: 'tap_element', index: search.index }];
    expect((await call({ steps })).steps[0]).toMatchObject({ x: 995, y: 140 });
    await expect(call({ steps })).rejects.toThrow('steps[0]: The screen changed');
    expect(scripts()).toHaveLength(1);
  });

  it('sends nothing when an element is missing, ambiguous or off the screen', async () => {
    const { call, scripts } = inputAgent();
    const tap = { type: 'key', key: 'back' };
    await expect(call({ steps: [tap, { type: 'tap_element', text: 'Pay now' }] })).rejects.toThrow(
      'steps[1]: Nothing on the screen matches text "Pay now"',
    );
    await expect(call({ steps: [tap, { type: 'tap_element', id: 'title' }] })).rejects.toThrow(
      'steps[1]: 2 elements match: pass nth',
    );
    await expect(call({ steps: [{ type: 'tap_element', id: 'title', nth: 3 }] })).rejects.toThrow(
      'steps[0]: Only 2 elements match id "title"',
    );
    await expect(call({ steps: [{ type: 'tap_element', exact: true }] })).rejects.toThrow(
      'steps[0]: Pass text, id, desc or hint',
    );
    expect(scripts()).toEqual([]);
  });

  it('sends nothing for a listed element that is off the screen', async () => {
    const { call, agent, scripts } = inputAgent();
    const listed = await callTool(agent.ctx, 'get_ui_tree', { filter: 'all' }, true);
    const offScreen = (listed as Json).result.elements.find(
      (element: Json) => element.desc === 'Remember me',
    );
    await expect(
      call({
        steps: [
          { type: 'key', key: 'back' },
          { type: 'tap_element', index: offScreen.index },
        ],
      }),
    ).rejects.toThrow('steps[1]: the element is off the screen');
    expect(scripts()).toEqual([]);
  });

  it('needs a screenshot (or width and height) for coordinate taps', async () => {
    const { call, scripts } = inputAgent();
    await expect(call({ steps: [{ type: 'tap', x: 10, y: 10 }] })).rejects.toThrow('Take a screenshot first');
    await expect(call({ steps: [{ type: 'tap', x: 800, y: 10 }], width: 720, height: 1600 })).rejects.toThrow(
      'outside the 720×1600 screenshot',
    );
    expect(scripts()).toEqual([]);
  });

  it.each([
    ['a key that is not allowed', { steps: [{ type: 'key', key: 'power' }] }, 'steps.0.key'],
    ['an unknown step', { steps: [{ type: 'swipe' }] }, 'steps.0.type'],
    ['no steps', { steps: [] }, 'steps'],
    [
      'too many steps',
      { steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ type: 'key', key: 'back' })) },
      'steps',
    ],
    [
      'waits over a minute',
      {
        steps: [
          { type: 'wait', ms: 40_000 },
          { type: 'wait', ms: 30_000 },
        ],
      },
      'waits add up to more than 60000 ms',
    ],
    [
      'more inputs and waits than the call has time for',
      {
        steps: [
          { type: 'wait', ms: 60_000 },
          ...Array.from({ length: 41 }, () => ({ type: 'key', key: 'back' })),
        ],
      },
      `the waits plus ${INPUT_ESTIMATE_MS} ms per input`,
    ],
    ['a fractional wait', { steps: [{ type: 'wait', ms: 0.5 }] }, 'steps.0.ms'],
    ['shell text as a coordinate', { steps: [{ type: 'tap', x: '1; reboot', y: 1 }] }, 'steps.0.x'],
  ])('refuses %s', async (_name, args, message) => {
    const { agent, scripts } = inputAgent();
    const outcome = await callTool(agent.ctx, 'run_inputs', args, true);
    expect(outcome).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      error: expect.stringContaining(message),
    });
    expect(scripts()).toEqual([]);
  });

  it('stops at a step that fails and says which', async () => {
    const { call } = inputAgent([DUMP], (script) => runScript(script, { fail: /^input keyevent/ }));
    const result = await call({
      steps: [
        { type: 'wait', ms: 10 },
        { type: 'key', key: 'home' },
        { type: 'key', key: 'back' },
      ],
    });
    expect(result.steps).toHaveLength(1);
    expect(result.failed).toMatchObject({ index: 1, exitCode: 1, type: 'key' });
    expect(result.untrusted).toBeUndefined();
  });

  it('returns the steps that ran when the device stops answering mid-sequence', async () => {
    const keys = [
      { type: 'key', key: 'back' },
      { type: 'key', key: 'back' },
    ];
    const cut = inputAgent([DUMP], (script) => runScript(script).split('\n').slice(0, 2).join('\n'));
    expect(await cut.call({ steps: keys })).toMatchObject({
      steps: [{ index: 0, atMs: 25 }],
      totalMs: 25,
      incomplete: {
        ran: 1,
        of: 2,
        reason: 'the device stopped answering',
        note: expect.stringContaining('may have run'),
      },
    });
    const offline = inputAgent([DUMP], (script) => ({
      output: runScript(script).split('\n').slice(0, 2).join('\n'),
      stderr: 'error: device offline\n',
      exit: 1,
    }));
    await callTool(offline.agent.ctx, 'get_ui_tree', {}, true);
    const result = await offline.call({ steps: keys });
    expect(result.incomplete).toMatchObject({ ran: 1, of: 2, reason: 'error: device offline' });
    expect(JSON.stringify(result)).not.toContain('keyevent');
    expect(offline.agent.ctx.uiDumps.get('emulator-5554')?.at).toBe(-Infinity);
  });

  it('stops waiting for a sequence that runs out of time, keeping what ran', async () => {
    const hung = inputAgent([DUMP], (script) => ({
      output: runScript(script).split('\n').slice(0, 2).join('\n'),
      hang: true,
    }));
    await callTool(hung.agent.ctx, 'get_ui_tree', {}, true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = hung.call({
      steps: [
        { type: 'key', key: 'back' },
        { type: 'wait', ms: 1000 },
      ],
    });
    // The first step's output arrives, then nothing more.
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;
    expect(result.incomplete).toMatchObject({ ran: 1, of: 2, reason: expect.stringContaining('timed out') });
    expect(hung.agent.ctx.uiDumps.get('emulator-5554')?.at).toBe(-Infinity);
  });

  it('gives no timings without a clock, and no total when nothing finished', async () => {
    const noClock = inputAgent([DUMP], (script) => runScript(script).replace(/ \d+\.\d+$/gm, ' 1793366413'));
    const result = await noClock.call({ steps: [{ type: 'key', key: 'back' }] });
    expect(result).toMatchObject({ totalMs: null, steps: [{ atMs: null, tookMs: null }] });
    expect(result.note).toContain('no timings');
    const first = inputAgent([DUMP], (script) => runScript(script, { fail: /^input/ }));
    const failed = await first.call({ steps: [{ type: 'key', key: 'back' }] });
    expect(failed).toMatchObject({ steps: [], totalMs: null, failed: { index: 0 } });
    expect(failed.note).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { callTool } from '../src/agent/registry.ts';
import { parseTopActivity, parseTopPackage, UI_DUMP_FAILED, UI_DUMP_TIMEOUT } from '../src/agent/uiDump.ts';
import { parseInputOrientation, parseWmSize, rotate } from '../src/agent/display.ts';
import {
  buildUiTree,
  clickTarget,
  distinctTargets,
  findElements,
  shortId,
  tapPoint,
  visibleBounds,
  visibleFraction,
} from '../src/agent/uiTree.ts';
import { decodeEntities, MAX_UI_NODES, parseUiXml, UiXmlError } from '../src/agent/uiXml.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import type { ExecOptions } from '../src/adb/adb.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';

const DUMP = fixture('ui-dump.xml');
const SCREEN = { width: 1080, height: 2400 };
const tree = () => buildUiTree(parseUiXml(DUMP), SCREEN);

function node(attributes: string, children = ''): string {
  return `<node class="android.view.View" package="com.example.shop" bounds="[0,0][100,100]" ${attributes}>${children}</node>`;
}

describe('parseUiXml', () => {
  it('reads nested nodes and decodes entities', () => {
    const hierarchy = parseUiXml(DUMP);
    expect(hierarchy.rotation).toBe(0);
    expect(hierarchy.roots).toHaveLength(1);
    expect(hierarchy.roots[0]?.children).toHaveLength(5);
    expect(decodeEntities('a &lt;b&gt; &amp; &quot;c&quot; &#65;&#x42; &nbsp;')).toBe(
      'a <b> & "c" AB &nbsp;',
    );
  });

  it('keeps a > inside a quoted value', () => {
    const parsed = parseUiXml(`<hierarchy rotation="1">${node('text="a > b"')}</hierarchy>`);
    expect(parsed.rotation).toBe(1);
    expect(parsed.roots[0]?.attributes.text).toBe('a > b');
  });

  it.each([
    ['a DOCTYPE', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><hierarchy>&e;</hierarchy>'],
    ['an unclosed node', '<hierarchy><node class="x">'],
    ['a stray close tag', '<hierarchy></node></hierarchy>'],
    ['an unterminated tag', '<hierarchy><node class="x"'],
    ['no hierarchy', '<node class="x"/>'],
    ['over 4 MB', `<hierarchy>${'x'.repeat(4 * 1024 * 1024 + 1)}</hierarchy>`],
  ])('refuses %s', (_name, xml) => {
    expect(() => parseUiXml(xml)).toThrow(UiXmlError);
  });

  it(`stops at ${MAX_UI_NODES} nodes`, () => {
    const many = Array.from({ length: MAX_UI_NODES + 10 }, () => node('', node(''))).join('');
    const parsed = parseUiXml(`<hierarchy>${many}</hierarchy>`);
    expect(parsed.truncated).toBe(true);
    const total = parsed.roots.reduce((sum, root) => sum + 1 + root.children.length, 0);
    expect(total).toBe(MAX_UI_NODES);
  });
});

describe('the UI tree', () => {
  it('turns nodes into elements in dump order, never exposing password text', () => {
    const { elements, screen, package: pkg } = tree();
    expect(screen).toEqual({ width: 1080, height: 2400 });
    expect(pkg).toBe('com.example.shop');
    expect(elements.map((element) => element.index)).toEqual(elements.map((_, i) => i));
    const password = elements.find((element) => element.id === 'password');
    expect(password).toMatchObject({ text: null, password: true, editable: true, hint: 'Password' });
    expect(JSON.stringify(elements)).not.toContain('hunter2');
    expect(elements.find((element) => element.text === 'Cart & checkout')?.className).toBe('TextView');
  });

  it('shortens the app’s own resource ids only', () => {
    expect(shortId('com.example.shop:id/email', 'com.example.shop')).toBe('email');
    expect(shortId('android:id/title', 'com.example.shop')).toBe('android:id/title');
    expect(shortId('nav_list', 'com.example.shop')).toBe('nav_list');
  });

  it('clips bounds to the screen', () => {
    const screen = { width: 1080, height: 2400 };
    expect(visibleBounds([-10, 2300, 500, 2500], screen)).toEqual([0, 2300, 500, 2400]);
    expect(visibleBounds([1100, 0, 1200, 10], screen)).toBeNull();
    expect(tapPoint([-10, 2300, 500, 2500], screen)).toEqual({ x: 250, y: 2350 });
    expect(visibleFraction([0, 0, 100, 100], [0, 50, 100, 200])).toBe(0.5);
  });

  it('matches text, desc and id, case-insensitively unless exact, on the screen only', () => {
    const t = tree();
    expect(findElements(t, { text: 'row' }).map((element) => element.text)).toEqual([
      'Row 1',
      'Row 2 <sale>',
    ]);
    expect(findElements(t, { text: 'row', exact: true })).toEqual([]);
    // text also matches a content description: the nav item and its label.
    expect(findElements(t, { text: 'List' }).map((element) => element.className)).toEqual([
      'View',
      'TextView',
    ]);
    expect(distinctTargets(t, findElements(t, { text: 'List' })).map((element) => element.id)).toEqual([
      'nav_list',
    ]);
    expect(findElements(t, { desc: 'list' }).map((element) => element.id)).toEqual(['nav_list']);
    expect(findElements(t, { id: 'title' })).toHaveLength(2);
    expect(findElements(t, { id: 'com.example.shop:id/email' })).toHaveLength(1);
    expect(findElements(t, { id: 'title', text: 'Row 2' })).toHaveLength(1);
    // Off the screen (the checkbox lies right of it).
    expect(findElements(t, { desc: 'Remember me' })).toEqual([]);
    const label = findElements(t, { text: 'Home' })[0];
    expect(label && clickTarget(t, label).selected).toBe(true);
  });

  it('reads the display size from wm size and the rotation', () => {
    expect(parseWmSize('Physical size: 1080x2424\nOverride size: 720x1616\n')).toEqual({
      width: 720,
      height: 1616,
    });
    expect(parseWmSize('Physical size: 1080x2424')).toEqual({ width: 1080, height: 2424 });
    expect(parseWmSize('error')).toBeNull();
    expect(
      parseInputOrientation(
        'Viewport INTERNAL: displayId=-1, uniqueId=, port=<none>, orientation=0, logicalFrame=[0, 0, 0, 0]\n' +
          'Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=3, logicalFrame=[0, 0, 2424, 1080]',
      ),
    ).toBe(3);
    expect(parseInputOrientation('Viewport INTERNAL: displayId=-1, orientation=0')).toBeNull();
    expect(rotate({ width: 1080, height: 2424 }, 1)).toEqual({ width: 2424, height: 1080 });
    expect(rotate({ width: 1080, height: 2424 }, 2)).toEqual({ width: 1080, height: 2424 });
  });

  it('reads the foreground activity from dumpsys', () => {
    expect(
      parseTopActivity('  topResumedActivity=ActivityRecord{7a1 u0 com.example.shop/.MainActivity t12}'),
    ).toBe('com.example.shop.MainActivity');
    expect(
      parseTopActivity(
        'mResumedActivity: ActivityRecord{1 u0 com.example.shop/com.example.shop.cart.CartActivity t3}',
      ),
    ).toBe('com.example.shop.cart.CartActivity');
    expect(parseTopActivity('nothing')).toBeNull();
    // Split screen: several resumed activities; the focused one (topResumedActivity) wins wherever it is listed.
    const split = [
      '    mResumedActivity: ActivityRecord{1b2 u0 com.example.other/.ListActivity t9}',
      '  topResumedActivity=ActivityRecord{7a1 u0 com.example.shop/.MainActivity t12}',
    ].join('\n');
    expect(parseTopActivity(split)).toBe('com.example.shop.MainActivity');
    expect(parseTopPackage(split)).toBe('com.example.shop');
    expect(
      parseTopPackage('    mResumedActivity: ActivityRecord{1b2 u0 com.example.other/.ListActivity t9}'),
    ).toBe('com.example.other');
    expect(parseTopPackage('nothing')).toBeNull();
  });
});

/** The markers a dump command asked for (they are random per call). */
function markers(command: string): string[] {
  return [...command.matchAll(/echo (__LS_[0-9a-f]+_[A-Z]+__)/g)].map((match) => match[1] ?? '');
}

/**
 * adb that answers `uiautomator dump` with the given dumps in turn (the last one repeats) and `wm size` with
 * `wmSize`; an entry 'hang' makes that dump time out.
 */
function uiAgent(dumps: readonly string[], wmSize = 'Physical size: 1080x2400') {
  let dumpIndex = 0;
  const commands: string[] = [];
  const adb = new FakeAdb((args) => {
    const command = String(args.at(-1));
    commands.push(command);
    if (!command.startsWith('uiautomator dump')) return '';
    const file = /uiautomator dump (\S+)/.exec(command)?.[1] ?? '';
    expect(command).toContain(`rm -f ${file}`);
    const [xmlMarker = '', wmMarker = '', topMarker] = markers(command);
    const xml = dumps[Math.min(dumpIndex++, dumps.length - 1)] ?? '';
    if (xml === 'hang') throw new Error(`adb -s emulator-5554 shell uiautomator dump failed: timed out`);
    const top =
      topMarker === undefined
        ? ''
        : `\n${topMarker}\n  topResumedActivity=ActivityRecord{1 u0 com.example.shop/.MainActivity t1}`;
    const status = xml.startsWith('ERROR') ? xml : `UI hierchary dumped to: ${file}`;
    const body = xml.startsWith('ERROR') ? '' : xml;
    return `${status}\n${xmlMarker}\n${body}\n${wmMarker}\n${wmSize}${top}`;
  });
  // execFile refuses a fractional timeout: every one must be a whole number of ms.
  const exec = adb.exec.bind(adb);
  adb.exec = (args: readonly string[], options?: ExecOptions) => {
    if (options?.timeoutMs !== undefined && !Number.isInteger(options.timeoutMs)) {
      throw new Error(`fractional timeout ${options.timeoutMs}`);
    }
    return exec(args);
  };
  const agent = fakeAgent({}, { adb });
  const inputs = () => commands.filter((command) => command.startsWith('input'));
  const call = async (name: string, args: unknown): Promise<Json> => {
    const outcome = await callTool(agent.ctx, name, args, true);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  };
  return { agent, call, inputs, commands };
}

describe('UI tools', () => {
  it('lists actionable elements with labels, screenshot-scale bounds and the foreground activity', async () => {
    const { call } = uiAgent([DUMP]);
    const result = await call('get_ui_tree', {});
    expect(result).toMatchObject({
      untrusted: expect.any(String),
      package: 'com.example.shop',
      activity: 'com.example.shop.MainActivity',
      screen: { width: 1080, height: 2400, rotation: 0 },
      screenshotSize: { width: 720, height: 1600 },
    });
    const search = result.elements.find((element: Json) => element.desc === 'Search');
    expect(search).toMatchObject({
      class: 'ImageButton',
      bounds: [930, 80, 1060, 200],
      shotBounds: [620, 53, 707, 133],
    });
    expect(search.flags).toEqual(['clickable']);
    const row = result.elements.find((element: Json) => element.label === 'Row 1');
    expect(row).toMatchObject({ class: 'LinearLayout', flags: ['clickable'] });
    // Wrapper-only nodes are left out of the actionable listing.
    expect(result.elements.some((element: Json) => element.id === 'toolbar')).toBe(false);
    expect((await call('get_ui_tree', { filter: 'all' })).elements).toHaveLength(result.nodes);
    expect((await call('get_ui_tree', { query: 'email' })).elements.map((e: Json) => e.hint)).toEqual([
      'Email',
    ]);
  });

  it('takes the screen size from the display, not from a dialog window on top', async () => {
    // A dialog's window: the only root is the dialog, far smaller than the screen.
    const dialog = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.shop" bounds="[47,1000][1033,1500]"><node class="android.widget.Button" text="OK" clickable="true" package="com.example.shop" bounds="[800,1380][1000,1480]" /></node></hierarchy>`;
    const { call, agent } = uiAgent([dialog]);
    const result = await call('get_ui_tree', {});
    expect(result.screen).toEqual({ width: 1080, height: 2400, rotation: 0 });
    expect(result.screenshotSize).toEqual({ width: 720, height: 1600 });
    expect(result.elements.find((element: Json) => element.text === 'OK').shotBounds).toEqual([
      533, 920, 667, 987,
    ]);
    expect(agent.ctx.screenshots.get('emulator-5554')?.device).toEqual({ width: 1080, height: 2400 });
  });

  it('turns the display size with a landscape dump', async () => {
    const landscape = `<hierarchy rotation="1"><node class="android.widget.FrameLayout" package="com.example.shop" bounds="[0,0][2400,1080]"><node class="android.widget.Button" text="Play" clickable="true" package="com.example.shop" bounds="[2000,900][2400,1080]" /></node></hierarchy>`;
    const { call, inputs } = uiAgent([landscape]);
    const result = await call('get_ui_tree', {});
    expect(result.screen).toEqual({ width: 2400, height: 1080, rotation: 90 });
    expect(result.screenshotSize).toEqual({ width: 1600, height: 720 });
    await call('tap_element', { text: 'play' });
    expect(inputs()).toEqual(['input tap 2200 990']);
  });

  it('keeps an existing screenshot scale of the same screen', async () => {
    const { call, agent } = uiAgent([DUMP]);
    agent.ctx.screenshots.set('emulator-5554', { shot: { width: 540, height: 1200 }, device: SCREEN });
    await call('get_ui_tree', {});
    expect(agent.ctx.screenshots.get('emulator-5554')?.shot).toEqual({ width: 540, height: 1200 });
  });

  it('reads sections at its own random markers, so app text cannot forge them', async () => {
    const forged = DUMP.replace('Cart &amp; checkout', '__LIONSCOPE_UI_XML__ &lt;hierarchy&gt;');
    const { call, commands } = uiAgent([forged]);
    const result = await call('get_ui_tree', {});
    expect(result.elements.some((element: Json) => element.text?.startsWith('__LIONSCOPE_UI_XML__'))).toBe(
      true,
    );
    const [first, second] = [commands[0] ?? '', ''].map(markers);
    expect(first).toHaveLength(3);
    expect(second).toEqual([]);
  });

  it('gives up on a dump that does not answer, and removes its file', async () => {
    const { call, commands } = uiAgent(['hang']);
    await expect(call('get_ui_tree', {})).rejects.toThrow(UI_DUMP_TIMEOUT);
    const file = /uiautomator dump (\S+)/.exec(commands[0] ?? '')?.[1];
    expect(commands).toContain(`rm -f ${file}`);
  });

  it('taps the center of a unique element and reports what took the tap', async () => {
    const { call, inputs } = uiAgent([DUMP]);
    const result = await call('tap_element', { desc: 'search' });
    expect(result).toMatchObject({ tapped: true, at: { x: 995, y: 140 }, element: { desc: 'Search' } });
    await call('tap_element', { text: 'Row 1', long: true });
    // The nav item's description and its label are one target.
    expect(await call('tap_element', { text: 'list' })).toMatchObject({
      tapped: true,
      element: { id: 'nav_list' },
    });
    expect(inputs()).toEqual(['input tap 995 140', 'input swipe 540 660 540 660 800', 'input tap 810 2300']);
  });

  it('returns the candidates instead of tapping when a selector is ambiguous', async () => {
    const { call, inputs } = uiAgent([DUMP]);
    const ambiguous = await call('tap_element', { id: 'title' });
    expect(ambiguous).toMatchObject({ tapped: false, ambiguous: true, matches: 2 });
    expect(ambiguous.candidates.map((candidate: Json) => candidate.text)).toEqual(['Row 1', 'Row 2 <sale>']);
    expect(inputs()).toEqual([]);
    // The second row is partly under the bottom bar: its visible part is tapped.
    const second = await call('tap_element', { id: 'title', nth: 2 });
    expect(second.at).toEqual({ x: 540, y: 2200 });
    expect(second.element.class).toBe('LinearLayout');
  });

  it('taps by index only while the screen still shows the listed element', async () => {
    const changed = DUMP.replace('content-desc="Search"', 'content-desc="Filter"');
    const { call, inputs } = uiAgent([DUMP, DUMP, changed]);
    await expect(call('tap_element', { index: 3 })).rejects.toThrow('call get_ui_tree first');
    const listed = await call('get_ui_tree', { filter: 'all' });
    const search = listed.elements.find((element: Json) => element.desc === 'Search');
    expect((await call('tap_element', { index: search.index })).tapped).toBe(true);
    // The tap changed the screen: the same index now names another element.
    await expect(call('tap_element', { index: search.index })).rejects.toThrow('The screen changed');
    expect(inputs()).toHaveLength(1);
  });

  it('refuses taps on nothing or off the screen', async () => {
    const { call } = uiAgent([DUMP]);
    await expect(call('tap_element', { text: 'Pay now' })).rejects.toThrow(
      'Nothing on the screen matches text "Pay now"',
    );
    await expect(call('tap_element', {})).rejects.toThrow('Pass text, id or desc');
    await expect(call('tap_element', { desc: 'Remember me' })).rejects.toThrow('Nothing on the screen');
  });

  it('retries a screen that is not idle, then suggests a screenshot', async () => {
    const busy = 'ERROR: could not get idle state.';
    expect((await uiAgent([busy, DUMP]).call('get_ui_tree', {})).nodes).toBeGreaterThan(0);
    await expect(uiAgent([busy]).call('get_ui_tree', {})).rejects.toThrow(UI_DUMP_FAILED);
    await expect(uiAgent(['<hierarchy><node>']).call('get_ui_tree', {})).rejects.toThrow(
      'Unreadable UI dump',
    );
  }, 10_000);

  it('waits for an element to appear or go away', async () => {
    const withDialog = DUMP.replace('Cart &amp; checkout', 'Promo');
    const shown = await uiAgent([DUMP, DUMP, withDialog]).call('wait_for', {
      text: 'Promo',
      intervalMs: 100,
    });
    expect(shown).toMatchObject({ met: true, matches: 1, element: { text: 'Promo' } });
    const gone = await uiAgent([withDialog, DUMP]).call('wait_for', {
      text: 'Promo',
      gone: true,
      intervalMs: 100,
    });
    expect(gone).toMatchObject({ met: true, matches: 0 });
    const timeout = await uiAgent([DUMP]).call('wait_for', {
      text: 'Promo',
      timeoutMs: 500,
      intervalMs: 100,
    });
    expect(timeout).toMatchObject({ met: false, timedOut: true });
  });

  it('scrolls the first scrollable container until the element is visible', async () => {
    const scrolled = DUMP.replace('Row 1', 'Row 9');
    const { call, inputs } = uiAgent([DUMP, scrolled]);
    const result = await call('scroll_to', { text: 'Row 9' });
    expect(result).toMatchObject({ found: true, swipes: 1, element: { text: 'Row 9' } });
    // Inside the list's bounds (560..2200), finger moving up.
    expect(inputs()).toEqual(['input swipe 540 1790 540 970 400']);
    const end = await uiAgent([DUMP]).call('scroll_to', { text: 'Row 42', maxSwipes: 5 });
    expect(end).toMatchObject({ found: false, swipes: 1, reachedEnd: true });
  });

  it('types into a field it taps first', async () => {
    const { call, inputs } = uiAgent([DUMP]);
    expect(await call('type_text', { text: 'a@b.c', field: { id: 'email' } })).toMatchObject({ typed: 5 });
    expect(inputs()).toEqual(['input tap 540 315', "input text 'a@b.c'"]);
    const ambiguous = await call('type_text', { text: 'x', field: { id: 'title' } });
    expect(ambiguous).toMatchObject({ typed: 0, field: { ambiguous: true } });
  });
});

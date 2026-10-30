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
import { aboveKeyboard, IME_COMMAND, onKeyboard, parseImeFrame } from '../src/agent/ime.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import type { Json } from './helpers/agentFixtures.ts';
import type { ExecOptions } from '../src/adb/adb.ts';
import type { UiHelpers } from '../src/agent/uiHelper.ts';
import { FakeAdb, fixture } from './helpers/fakes.ts';

const DUMP = fixture('ui-dump.xml');
/** The empty email field's text and id in DUMP. */
const EMAIL = 'text="" resource-id="com.example.shop:id/email"';
/** DUMP with the focus in the password field. */
const PASSWORD_FOCUSED = DUMP.replace('focused="true"', 'focused="false"').replace(
  'focused="false" scrollable="false" long-clickable="true" password="true"',
  'focused="true" scrollable="false" long-clickable="true" password="true"',
);
const withEmail = (text: string) =>
  DUMP.replace(EMAIL, `text="${text}" resource-id="com.example.shop:id/email"`);
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

  it('matches a field by its hint, also once it has text', () => {
    const t = tree();
    expect(findElements(t, { hint: 'mail' }).map((element) => element.id)).toEqual(['email']);
    expect(findElements(t, { hint: 'mail', exact: true })).toEqual([]);
    expect(findElements(t, { hint: 'Password', id: 'password' })).toHaveLength(1);
    const filled = buildUiTree(
      parseUiXml(DUMP.replace(EMAIL, 'text="a@b.c" resource-id="com.example.shop:id/email"')),
      SCREEN,
    );
    expect(findElements(filled, { hint: 'Email' }).map((element) => element.text)).toEqual(['a@b.c']);
    // Without a hint attribute, an empty field shows its hint as its text; a label with that text is no field.
    const legacy = buildUiTree(
      parseUiXml(
        `<hierarchy rotation="0">${node('class="android.widget.EditText" text="First name"')}${node('class="android.widget.TextView" text="First name"')}</hierarchy>`,
      ),
      SCREEN,
    );
    expect(findElements(legacy, { hint: 'first name' }).map((element) => element.className)).toEqual([
      'EditText',
    ]);
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

/** `dumpsys window displays` about a keyboard shown with `frame` (Android 14+). */
const imeLine = (frame: string) =>
  `        InsetsSource id=3 type=ime frame=${frame} visibleFrame=${frame} visible=true flags= sideHint=BOTTOM boundingRects=null\n`;

describe('the soft keyboard', () => {
  it('reads its frame while it is shown, from Android 11 and 14+ output', () => {
    expect(parseImeFrame(imeLine('[0,1541][1080,2424]'))).toEqual([0, 1541, 1080, 2424]);
    // Hidden: an empty frame, or visible=false.
    expect(
      parseImeFrame(
        'InsetsSource id=3 type=ime frame=[0,0][0,0] visibleFrame=[0,2424][1080,2424] visible=false flags= sideHint=NONE',
      ),
    ).toBeNull();
    expect(
      parseImeFrame('InsetsSource id=3 type=ime frame=[0,1541][1080,2424] visible=false flags='),
    ).toBeNull();
    // Older: ITYPE_IME, no id; the visible frame wins over the frame.
    expect(
      parseImeFrame(
        'InsetsSource type=ITYPE_IME frame=[0,1300][1080,2400] visibleFrame=[0,1500][1080,2400] visible=true',
      ),
    ).toEqual([0, 1500, 1080, 2400]);
    expect(parseImeFrame('InsetsSource type=ITYPE_IME frame=[0,1300][1080,2400] visible=true')).toEqual([
      0, 1300, 1080, 2400,
    ]);
    expect(parseImeFrame('')).toBeNull();
    expect(
      parseImeFrame('InsetsSource id=1 type=navigationBars frame=[0,2298][1080,2424] visible=true'),
    ).toBeNull();
  });

  it('tells a point on it and the part of an element above it', () => {
    const ime: [number, number, number, number] = [0, 1500, 1080, 2400];
    expect(onKeyboard(ime, { x: 540, y: 1500 })).toBe(true);
    expect(onKeyboard(ime, { x: 540, y: 1499 })).toBe(false);
    expect(onKeyboard(null, { x: 540, y: 2000 })).toBe(false);
    expect(aboveKeyboard([0, 560, 1080, 2200], ime)).toEqual([0, 560, 1080, 1500]);
    expect(aboveKeyboard([0, 1600, 1080, 2200], ime)).toBeNull();
    // A floating keyboard narrower than the element.
    expect(aboveKeyboard([0, 560, 1080, 2200], [100, 1500, 900, 2000])).toBeNull();
  });
});

/** The markers a dump command asked for (they are random per call). */
function markers(command: string): string[] {
  return [...command.matchAll(/echo (__LS_[0-9a-f]+_[A-Z]+__)/g)].map((match) => match[1] ?? '');
}

/**
 * adb that answers `uiautomator dump` with the given dumps in turn (the last one repeats) and `wm size` with
 * `wmSize`; an entry 'hang' makes that dump time out. With `api`, a UI helper that gives that API level (and no
 * dumps). `ime`, the keyboard's frame while it is shown.
 */
function uiAgent(
  dumps: readonly string[],
  {
    wmSize = 'Physical size: 1080x2400',
    api = undefined as number | undefined,
    ime = undefined as string | undefined,
  } = {},
) {
  let dumpIndex = 0;
  const commands: string[] = [];
  const adb = new FakeAdb((args) => {
    const command = String(args.at(-1));
    commands.push(command);
    if (command === IME_COMMAND && ime !== undefined) return imeLine(ime);
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
  if (api !== undefined) {
    agent.ctx.uiHelper = {
      apiLevel: () => Promise.resolve(api),
      unavailable: () => 'not in this test',
      isRunning: () => false,
    } as unknown as UiHelpers;
  }
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
    await expect(call('tap_element', {})).rejects.toThrow('Pass text, id, desc or hint');
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

  it('types into a field it taps first, then reads the field back', async () => {
    const typed = DUMP.replace(EMAIL, 'text="a@b.c" resource-id="com.example.shop:id/email"');
    const { call, inputs } = uiAgent([DUMP, typed]);
    expect(await call('type_text', { text: 'a@b.c', field: { id: 'email' } })).toMatchObject({
      typed: 5,
      field: { id: 'email', text: 'a@b.c', hint: 'Email' },
      sameField: true,
      matches: true,
    });
    expect(inputs()).toEqual(['input tap 540 315', "input text 'a@b.c'"]);
    const ambiguous = await call('type_text', { text: 'x', field: { id: 'title' } });
    expect(ambiguous).toMatchObject({ typed: 0, field: { ambiguous: true } });
  });

  it('reports a field that did not take the text, and finds a filled field by its hint', async () => {
    // The field still shows its hint as its text: nothing arrived.
    const unchanged = DUMP.replace(EMAIL, 'text="Email" resource-id="com.example.shop:id/email"');
    const { call } = uiAgent([unchanged]);
    expect(await call('type_text', { text: 'a@b.c', field: { hint: 'Email' } })).toMatchObject({
      field: { id: 'email' },
      matches: false,
    });
    const filled = DUMP.replace(EMAIL, 'text="old@b.c" resource-id="com.example.shop:id/email"');
    const again = uiAgent([filled]);
    expect(await again.call('type_text', { text: 'x', field: { hint: 'email' } })).toMatchObject({
      field: { text: 'old@b.c' },
      matches: false,
    });
    expect(again.inputs()).toEqual(['input tap 540 315', "input text 'x'"]);
  });

  it('compares with the field as it was before typing', async () => {
    const jakarta = DUMP.replace(EMAIL, 'text="Jakarta" resource-id="com.example.shop:id/email"');
    // Typing did nothing: the field already showed the text.
    expect(
      await uiAgent([jakarta]).call('type_text', { text: 'Jakarta', field: { id: 'email' } }),
    ).toMatchObject({ matches: false });
    const grown = DUMP.replace(EMAIL, 'text="Jakarta Jakarta" resource-id="com.example.shop:id/email"');
    expect(
      await uiAgent([jakarta, grown]).call('type_text', { text: ' Jakarta', field: { id: 'email' } }),
    ).toMatchObject({ matches: true });
    // A dump without hint attributes shows an empty field's hint as its text.
    const legacy = (text: string) =>
      `<hierarchy rotation="0"><node class="android.widget.EditText" text="${text}" focused="true" clickable="true" package="com.example.shop" bounds="[40,300][1040,420]" /></hierarchy>`;
    expect(
      await uiAgent([legacy('First name'), legacy('Ann')]).call('type_text', {
        text: 'Ann',
        field: { hint: 'First name' },
      }),
    ).toMatchObject({ matches: true });
    // Without field there is nothing from before to compare with.
    expect(await uiAgent([jakarta]).call('type_text', { text: 'Jakarta' })).toMatchObject({
      field: { text: 'Jakarta' },
      matches: null,
      note: expect.stringContaining('pass field'),
    });
    expect(await uiAgent([jakarta]).call('type_text', { text: 'Bandung' })).toMatchObject({ matches: false });
  });

  it('follows a field the keyboard moved up', async () => {
    // adjustPan: the screen moved up 600 px to keep the field above the keyboard.
    const panned = DUMP.replace(
      'text="" resource-id="com.example.shop:id/email" class="android.widget.EditText" package="com.example.shop" content-desc="" hint="Email" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[42,250][1038,380]"',
      'text="a@b.c" resource-id="com.example.shop:id/email" class="android.widget.EditText" package="com.example.shop" content-desc="" hint="Email" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[42,1850][1038,1980]"',
    );
    expect(panned).not.toBe(DUMP);
    expect(
      await uiAgent([DUMP, panned]).call('type_text', { text: 'a@b.c', field: { id: 'email' } }),
    ).toMatchObject({
      field: { text: 'a@b.c', bounds: [42, 1850, 1038, 1980] },
      sameField: true,
      matches: true,
    });
  });

  it('follows a compose box that moved up and widened, but not a twin field in a list', async () => {
    const box = (bounds: string, text: string) =>
      `<hierarchy rotation="0"><node class="android.widget.EditText" text="${text}" hint="Text message" resource-id="com.example.shop:id/compose" focused="true" clickable="true" package="com.example.shop" bounds="${bounds}" /></hierarchy>`;
    // The keyboard pushed it up; with text, the icons beside it are hidden and it grew to the right.
    expect(
      await uiAgent([box('[147,2130][639,2277]', 'Text message'), box('[147,1373][765,1520]', 'hello')]).call(
        'type_text',
        { text: 'hello', field: { id: 'compose' } },
      ),
    ).toMatchObject({ sameField: true, field: { text: 'hello' }, matches: true });
    // Two rows with the same field id: the focus moved to the second one.
    const rows = (focus: number, second: string) =>
      `<hierarchy rotation="0">${[1, 2]
        .map(
          (row) =>
            `<node class="android.widget.EditText" text="${row === 2 ? second : ''}" resource-id="com.example.shop:id/qty" focused="${focus === row}" clickable="true" package="com.example.shop" bounds="[40,${row * 200}][1040,${row * 200 + 150}]" />`,
        )
        .join('')}</hierarchy>`;
    const twin = await uiAgent([rows(1, ''), rows(2, '3')]).call('type_text', {
      text: '3',
      field: { nth: 1, id: 'qty' },
    });
    expect(twin).toMatchObject({ sameField: false });
    expect(twin.field).not.toHaveProperty('text');
  });

  it('leaves out the text of a field other than the one tapped', async () => {
    const code = (focus: number, second: string) =>
      `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.shop" bounds="[0,0][1080,2400]"><node class="android.widget.EditText" text="" resource-id="com.example.shop:id/code1" focused="${focus === 1}" clickable="true" package="com.example.shop" bounds="[40,300][240,420]" /><node class="android.widget.EditText" text="${second}" resource-id="com.example.shop:id/code2" focused="${focus === 2}" clickable="true" package="com.example.shop" bounds="[280,300][480,420]" /></node></hierarchy>`;
    // The first box took one digit and moved the focus on to the second.
    const result = await uiAgent([code(1, ''), code(2, '4')]).call('type_text', {
      text: '84',
      field: { id: 'code1' },
    });
    expect(result).toMatchObject({ field: { id: 'code2' }, sameField: false, matches: false });
    expect(result.field).not.toHaveProperty('text');
    expect(result.note).toContain('not the one tapped');
  });

  it('appends or replaces with ctrl keys on Android 13 and later', async () => {
    const appended = uiAgent([withEmail('ab'), withEmail('ab'), withEmail('abcd')], { api: 34 });
    expect(
      await appended.call('type_text', { text: 'cd', mode: 'append', field: { id: 'email' } }),
    ).toMatchObject({ typed: 2, field: { text: 'abcd' }, matches: true });
    expect(appended.inputs()).toEqual([
      'input tap 540 315',
      'input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END',
      "input text 'cd'",
    ]);
    // End did not take: the text went in where the caret was.
    const middle = uiAgent([withEmail('ab'), withEmail('ab'), withEmail('acdb')], { api: 34 });
    expect(
      await middle.call('type_text', { text: 'cd', mode: 'append', field: { id: 'email' } }),
    ).toMatchObject({ matches: false });
    const replaced = uiAgent([withEmail('old'), withEmail('old'), withEmail('new')], { api: 34 });
    expect(
      await replaced.call('type_text', { text: 'new', mode: 'replace', field: { id: 'email' } }),
    ).toMatchObject({ matches: true });
    expect(replaced.inputs()).toEqual([
      'input tap 540 315',
      'input keycombination KEYCODE_CTRL_LEFT KEYCODE_A',
      'input keyevent 67',
      "input text 'new'",
    ]);
    // Select all did not take: the old text is still there.
    const kept = uiAgent([withEmail('old'), withEmail('old'), withEmail('oldnew')], { api: 34 });
    expect(
      await kept.call('type_text', { text: 'new', mode: 'replace', field: { id: 'email' } }),
    ).toMatchObject({ matches: false });
  });

  it('clears a field with an empty replace, and refuses empty text otherwise', async () => {
    const { call, inputs } = uiAgent([withEmail('old'), withEmail('old'), DUMP], { api: 34 });
    expect(await call('type_text', { text: '', mode: 'replace', field: { id: 'email' } })).toMatchObject({
      typed: 0,
      field: { id: 'email' },
      matches: true,
    });
    expect(inputs()).toEqual([
      'input tap 540 315',
      'input keycombination KEYCODE_CTRL_LEFT KEYCODE_A',
      'input keyevent 67',
    ]);
    // An empty field (showing its hint) needs no keys.
    const empty = uiAgent([DUMP.replace(EMAIL, 'text="Email" resource-id="com.example.shop:id/email"')], {
      api: 34,
    });
    await empty.call('type_text', { text: '', mode: 'replace', field: { id: 'email' } });
    expect(empty.inputs()).toEqual(['input tap 540 315']);
    await expect(call('type_text', { text: '' })).rejects.toThrow('only clears a field, with mode replace');
  });

  it('appends or replaces only in a text field', async () => {
    const noFocus = DUMP.replace('focused="true"', 'focused="false"');
    const { call, inputs } = uiAgent([noFocus], { api: 34 });
    await expect(call('type_text', { text: 'x', mode: 'replace' })).rejects.toThrow('No focused text field');
    await expect(call('type_text', { text: 'x', mode: 'append', field: { desc: 'Search' } })).rejects.toThrow(
      'did not take the focus',
    );
    // Only the tap on the search button: no key reached the screen.
    expect(inputs()).toEqual(['input tap 995 140']);
    // Without field, the focused field.
    const focused = uiAgent([withEmail('old'), withEmail('new')], { api: 34 });
    expect(await focused.call('type_text', { text: 'new', mode: 'replace' })).toMatchObject({
      matches: true,
    });
    expect(focused.inputs()).toHaveLength(3);
  });

  it('sends no key when the tapped field did not take the focus', async () => {
    // A field that opens a picker: after the tap nothing is focused.
    const picker = uiAgent([withEmail('Jakarta'), DUMP.replace('focused="true"', 'focused="false"')], {
      api: 34,
    });
    await expect(
      picker.call('type_text', { text: 'Bandung', mode: 'replace', field: { id: 'email' } }),
    ).rejects.toThrow('did not take the focus');
    expect(picker.inputs()).toEqual(['input tap 540 315']);
    // The focus stayed in another field.
    const other = uiAgent([withEmail('Jakarta'), PASSWORD_FOCUSED], { api: 34 });
    await expect(
      other.call('type_text', { text: 'x', mode: 'append', field: { id: 'email' } }),
    ).rejects.toThrow('did not take the focus');
    expect(other.inputs()).toEqual(['input tap 540 315']);
  });

  it('falls back to End and key-by-key deletes before Android 13', async () => {
    const appended = uiAgent([withEmail('ab'), withEmail('ab'), withEmail('abcd')], { api: 30 });
    await appended.call('type_text', { text: 'cd', mode: 'append', field: { id: 'email' } });
    expect(appended.inputs()).toEqual(['input tap 540 315', 'input keyevent 123', "input text 'cd'"]);
    // A single-line field: End, then Delete once per character.
    const replaced = uiAgent([withEmail('ab'), withEmail('ab'), withEmail('x')], { api: 30 });
    expect(
      await replaced.call('type_text', { text: 'x', mode: 'replace', field: { id: 'email' } }),
    ).toMatchObject({ matches: true });
    expect(replaced.inputs()).toEqual(['input tap 540 315', 'input keyevent 123 67 67', "input text 'x'"]);
    // Line breaks: the caret may be on any line, so Delete and Forward delete once per character each.
    const lines = uiAgent([withEmail('a&#10;b'), withEmail('a&#10;b'), DUMP], { api: 30 });
    await lines.call('type_text', { text: '', mode: 'replace', field: { id: 'email' } });
    expect(lines.inputs()).toEqual(['input tap 540 315', 'input keyevent 67 67 67 112 112 112']);
    const long = uiAgent([withEmail('a'.repeat(150)), withEmail('a'.repeat(150)), DUMP], { api: 30 });
    await long.call('type_text', { text: '', mode: 'replace', field: { id: 'email' } });
    const deletes = long.inputs().filter((command) => command.startsWith('input keyevent'));
    expect(deletes.map((command) => command.split(' ').length - 2)).toEqual([100, 51]);
  });

  it('refuses to replace a password field key by key, before sending any key', async () => {
    const old = uiAgent([PASSWORD_FOCUSED], { api: 30 });
    await expect(
      old.call('type_text', { text: 'hunter3', mode: 'replace', field: { id: 'password' } }),
    ).rejects.toThrow('before Android 13');
    expect(old.inputs()).toEqual(['input tap 540 465']);
    // The version could not be read: no claim about Android 13.
    const unknown = uiAgent([PASSWORD_FOCUSED]);
    await expect(
      unknown.call('type_text', { text: 'hunter3', mode: 'replace', field: { id: 'password' } }),
    ).rejects.toThrow('Android version could not be read');
  });

  it('never echoes what was typed into a password field', async () => {
    const { call } = uiAgent([PASSWORD_FOCUSED]);
    const result = await call('type_text', { text: 'hunter2', field: { id: 'password' } });
    expect(result).toMatchObject({ typed: 7, field: { id: 'password' }, matches: null });
    expect(result.field.flags).toContain('password');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('says so when no field can be read back after typing', async () => {
    const noFocus = DUMP.replace('focused="true"', 'focused="false"');
    expect(await uiAgent([noFocus]).call('type_text', { text: 'x' })).toMatchObject({
      typed: 1,
      field: null,
      matches: null,
      note: expect.stringContaining('No focused text field'),
    });
    const { call, inputs } = uiAgent([DUMP, 'hang']);
    expect(await call('type_text', { text: 'x', field: { id: 'email' } })).toMatchObject({
      typed: 1,
      field: null,
      matches: null,
      note: `Could not read the field back: ${UI_DUMP_TIMEOUT}`,
    });
    expect(inputs()).toEqual(['input tap 540 315', "input text 'x'"]);
  });

  it('does not tap an element the keyboard covers, and taps the part of one above it', async () => {
    const covered = uiAgent([DUMP], { ime: '[0,1500][1080,2400]' });
    await expect(covered.call('tap_element', { text: 'list' })).rejects.toThrow(
      'The keyboard covers the element (the keyboard starts at y 1500): nothing was tapped. Hide it with press_key back',
    );
    expect(covered.inputs()).toEqual([]);
    // The list's center is above the keyboard.
    expect(await covered.call('tap_element', { id: 'list', readBack: false })).toMatchObject({
      at: { x: 540, y: 1380 },
    });
    // Its center is on the keyboard, its top part is not.
    const high = uiAgent([DUMP], { ime: '[0,1000][1080,2400]' });
    expect(await high.call('tap_element', { id: 'list', readBack: false })).toMatchObject({
      at: { x: 540, y: 780 },
    });
    // A floating keyboard over its center.
    const floating = uiAgent([DUMP], { ime: '[100,1200][900,1700]' });
    await expect(floating.call('tap_element', { id: 'list' })).rejects.toThrow('The keyboard covers');
    expect(floating.inputs()).toEqual([]);
  });

  it('reads the screen again instead of a recent dump while the keyboard is shown', async () => {
    // The keyboard finished sliding in after the last dump, and the layout moved up.
    const moved = DUMP.replace('bounds="[930,80][1060,200]"', 'bounds="[930,300][1060,420]"');
    const shown = uiAgent([DUMP, moved], { ime: '[0,1500][1080,2400]' });
    await shown.call('get_ui_tree', {});
    expect(await shown.call('tap_element', { desc: 'search', readBack: false })).toMatchObject({
      at: { x: 995, y: 360 },
    });
    const hidden = uiAgent([DUMP, moved]);
    await hidden.call('get_ui_tree', {});
    expect(await hidden.call('tap_element', { desc: 'search', readBack: false })).toMatchObject({
      at: { x: 995, y: 140 },
    });
  });

  it('reads the tapped element back after the tap', async () => {
    const toggle = (checked: boolean) =>
      `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.example.shop" bounds="[0,0][1080,2400]"><node class="android.widget.Switch" text="Dark mode" resource-id="com.example.shop:id/dark" checkable="true" checked="${checked}" clickable="true" package="com.example.shop" bounds="[0,300][1080,420]" /></node></hierarchy>`;
    const switched = await uiAgent([toggle(false), toggle(true)]).call('tap_element', { text: 'dark mode' });
    expect(switched).toMatchObject({
      tapped: true,
      element: { id: 'dark' },
      after: { id: 'dark' },
      checked: { before: false, after: true },
      screenChanged: true,
    });
    expect(switched.element.flags).not.toContain('checked');
    expect(switched.after.flags).toContain('checked');
    // The tap opened another screen.
    expect(await uiAgent([toggle(false), DUMP]).call('tap_element', { text: 'dark mode' })).toMatchObject({
      tapped: true,
      after: null,
      note: expect.stringContaining('moved or is gone'),
    });
    const { call, commands } = uiAgent([toggle(false)]);
    const quick = await call('tap_element', { text: 'dark mode', readBack: false });
    expect(quick).toMatchObject({ tapped: true, element: { id: 'dark' } });
    expect(quick).not.toHaveProperty('after');
    expect(commands.filter((command) => command.startsWith('uiautomator'))).toHaveLength(1);
  });

  it('reports the switch inside a tapped row', async () => {
    // A Preference: the row takes the tap, its Switch is not clickable.
    const preference = (checked: boolean) =>
      `<hierarchy rotation="0"><node class="android.widget.LinearLayout" clickable="true" package="com.example.shop" bounds="[0,300][1080,480]"><node class="android.widget.TextView" text="Dark theme" package="com.example.shop" bounds="[40,320][800,400]" /><node class="android.widget.Switch" checkable="true" checked="${checked}" package="com.example.shop" bounds="[900,340][1040,440]" /></node></hierarchy>`;
    const result = await uiAgent([preference(false), preference(true)]).call('tap_element', {
      text: 'Dark theme',
    });
    expect(result).toMatchObject({
      element: { class: 'LinearLayout', label: 'Dark theme' },
      after: { class: 'LinearLayout' },
      checked: { before: false, after: true },
    });
  });

  it('finds a toggle again when its text shows its state', async () => {
    const toggle = (id: string, label: string, checked: boolean) =>
      `<hierarchy rotation="0"><node class="android.widget.ToggleButton" text="${label}"${id} checkable="true" checked="${checked}" clickable="true" package="com.example.shop" bounds="[40,300][400,420]" /></hierarchy>`;
    const id = ' resource-id="com.example.shop:id/follow"';
    expect(
      await uiAgent([toggle(id, 'Follow', false), toggle(id, 'Following', true)]).call('tap_element', {
        text: 'Follow',
      }),
    ).toMatchObject({ after: { text: 'Following' }, checked: { before: false, after: true } });
    // Without an id, another toggle in its place can't be told apart.
    expect(
      await uiAgent([toggle('', 'Follow', false), toggle('', 'Following', true)]).call('tap_element', {
        text: 'Follow',
      }),
    ).toMatchObject({ after: null, checked: { before: false, after: null } });
  });

  it('reports no checked state for a row with several toggles', async () => {
    const row = `<hierarchy rotation="0"><node class="android.widget.LinearLayout" clickable="true" package="com.example.shop" bounds="[0,300][1080,480]"><node class="android.widget.TextView" text="Notifications" package="com.example.shop" bounds="[40,320][600,400]" /><node class="android.widget.CheckBox" checkable="true" package="com.example.shop" bounds="[700,340][840,440]" /><node class="android.widget.Switch" checkable="true" package="com.example.shop" bounds="[900,340][1040,440]" /></node></hierarchy>`;
    const result = await uiAgent([row]).call('tap_element', { text: 'Notifications' });
    expect(result).toMatchObject({ tapped: true, after: { class: 'LinearLayout' }, screenChanged: false });
    expect(result).not.toHaveProperty('checked');
  });

  it('does not take another row that slid into the tapped place for the tapped one', async () => {
    const rows = (...titles: string[]) =>
      `<hierarchy rotation="0"><node class="androidx.recyclerview.widget.RecyclerView" scrollable="true" package="com.example.shop" bounds="[0,0][1080,2400]">${titles
        .map(
          (title, i) =>
            `<node class="android.widget.LinearLayout" clickable="true" package="com.example.shop" bounds="[0,${i * 200}][1080,${i * 200 + 200}]"><node class="android.widget.TextView" text="${title}" resource-id="com.example.shop:id/title" package="com.example.shop" bounds="[40,${i * 200 + 40}][1040,${i * 200 + 160}]" /></node>`,
        )
        .join('')}</node></hierarchy>`;
    // Swiping the first row away deletes it: the second one moves up into its place.
    const deleted = await uiAgent([rows('Order 1', 'Order 2'), rows('Order 2')]).call('tap_element', {
      text: 'Order 1',
    });
    expect(deleted).toMatchObject({ tapped: true, after: null, screenChanged: true });
    expect(deleted.note).toContain('moved or is gone');
    // The same title in the same place on another screen is found again, but the screen changed.
    const next = await uiAgent([rows('Next', 'Step 1'), rows('Next', 'Step 2')]).call('tap_element', {
      text: 'Next',
    });
    expect(next).toMatchObject({ after: { label: 'Next' }, screenChanged: true });
    expect(await uiAgent([rows('Next')]).call('tap_element', { text: 'Next' })).toMatchObject({
      screenChanged: false,
    });
  });
});

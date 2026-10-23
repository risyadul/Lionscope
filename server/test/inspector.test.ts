import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceInfo, InspectorNode, ServerMessage } from '@lionscope/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUiTree } from '../src/agent/uiTree.ts';
import { parseUiXml } from '../src/agent/uiXml.ts';
import { SdkInspectError } from '../src/device/sdkLink.ts';
import type { SdkInspection, SdkLink } from '../src/device/sdkLink.ts';
import { PublicError } from '../src/errors.ts';
import { log } from '../src/log.ts';
import { serveInspectorPng } from '../src/http/inspectorFiles.ts';
import { buildAllowedOrigins } from '../src/http/wsGateway.ts';
import type { InspectLinkReadiness } from '../src/device/inspectLinks.ts';
import { InspectorService, MAX_KEPT_SNAPSHOTS } from '../src/inspector/inspectorService.ts';
import type { InspectorLinks, InspectorServiceOptions } from '../src/inspector/inspectorService.ts';
import type { InspectorSessionSource } from '../src/session/sessionManager.ts';
import { fixture } from './helpers/fakes.ts';
import { rgbPng } from './helpers/png.ts';
import { rawRequest } from './helpers/net.ts';

const SERIAL = 'emulator-5554';
const PKG = 'com.example.shop';
const DEVICES: DeviceInfo[] = [
  { serial: SERIAL, state: 'device' },
  { serial: 'R58M123ABC', state: 'unauthorized' },
];
const PNG = rgbPng(108, 240, () => [200, 200, 200]);
const OTHER = 'com.example.other';
const otherInFront = async () => OTHER;
const uiTree = () => buildUiTree(parseUiXml(fixture('ui-dump.xml')), { width: 1080, height: 2400 });

function sdkNode(id: number, overrides: Partial<InspectorNode> = {}): InspectorNode {
  return {
    id,
    parent: id === 0 ? null : 0,
    window: 0,
    className:
      id === 0
        ? 'com.android.internal.policy.DecorView'
        : 'com.google.android.material.button.MaterialButton',
    resourceId: id === 0 ? null : 'btn_share',
    text: id === 0 ? null : 'Share',
    contentDescription: null,
    bounds: [0, id * 100, 1080, id * 100 + 100],
    visibleBounds: [0, id * 100, 1080, id * 100 + 100],
    visibility: 'visible',
    alpha: 1,
    enabled: true,
    clickable: id !== 0,
    focused: false,
    selected: false,
    checked: null,
    padding: [0, 0, 0, 0],
    margin: null,
    layoutWidth: 'match_parent',
    layoutHeight: 'wrap_content',
    source: id === 0 ? null : { layout: 'view_dashboard_actions', line: 15 },
    fragment: id === 0 ? null : 'com.example.shop.ui.home.HomeFragment',
    activity: 'com.example.shop.ui.MainActivity',
    ...overrides,
  };
}

function inspection(nodes: InspectorNode[] = [sdkNode(0), sdkNode(1)], compose = false): SdkInspection {
  return {
    begin: {
      type: 'inspectBegin',
      requestId: 1,
      ts: 1792516376500,
      screen: 'homepage',
      display: { width: 1080, height: 2400, rotation: 0 },
      windows: [{ id: 0, type: 1, bounds: [0, 0, 1080, 2400] }],
      nodeCount: nodes.length,
      truncated: false,
      captureMs: 2.4,
      compose,
    },
    nodes,
  };
}

function fakeLink(
  protocolVersion: number,
  answer: () => Promise<SdkInspection>,
): SdkLink & { calls: number } {
  const link = {
    protocolVersion,
    calls: 0,
    close: () => undefined,
    sendConfig: () => undefined,
    inspect: () => {
      link.calls += 1;
      return answer();
    },
  };
  return link;
}

function setup(options: Partial<InspectorServiceOptions> & { source?: InspectorSessionSource | null } = {}) {
  const messages: ServerMessage[] = [];
  const calls = { dumps: 0, screencaps: 0, foregrounds: 0 };
  let clock = 1_800_000_000_000;
  const service = new InspectorService({
    sessions: {
      getDevices: () => DEVICES,
      inspectorSource: (serial) => (serial === SERIAL ? (options.source ?? null) : null),
    },
    dumpUi: async () => {
      calls.dumps += 1;
      return uiTree();
    },
    screencap: async () => {
      calls.screencaps += 1;
      return PNG;
    },
    broadcast: (message) => messages.push(message),
    now: () => (clock += 1000),
    // The dump fixture's app is in the foreground.
    foregroundPackage: async () => {
      calls.foregrounds += 1;
      return PKG;
    },
    ...options,
  });
  return { service, messages, calls };
}

describe('Inspector service', () => {
  it('takes the SDK snapshot of a v4 link, with a screenshot, and broadcasts it', async () => {
    const link = fakeLink(4, async () => inspection());
    const { service, messages, calls } = setup({ source: { packageName: PKG, link, screen: 'homepage' } });
    const snapshot = await service.inspect(SERIAL);
    expect(snapshot).toMatchObject({
      serial: SERIAL,
      packageName: PKG,
      source: 'sdk',
      screen: 'homepage',
      display: { width: 1080, height: 2400, rotation: 0 },
      truncated: false,
      captureMs: 2.4,
      fallbackReason: null,
    });
    expect(snapshot.id).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshot.nodes).toEqual(inspection().nodes);
    expect(calls).toEqual({ dumps: 0, screencaps: 1, foregrounds: 0 });
    expect(messages).toEqual([{ type: 'inspection', snapshot }]);
    expect(service.current).toBe(snapshot);
    expect(service.png(snapshot.id)).toBe(PNG);
  });

  it.each([
    ['no session on the device', null, 'no_sdk'],
    ['a session without an SDK link', { packageName: PKG, link: null, screen: null }, 'no_sdk'],
    [
      'an SDK link below v4',
      { packageName: PKG, link: fakeLink(3, async () => inspection()), screen: null },
      'old_sdk',
    ],
  ] as const)('falls back to uiautomator with %s', async (_name, source, reason) => {
    const { service, calls } = setup({ source });
    const snapshot = await service.inspect(SERIAL);
    expect(snapshot).toMatchObject({ source: 'uiautomator', fallbackReason: reason, captureMs: null });
    expect(calls.dumps).toBe(1);
    if (source?.link) expect((source.link as { calls: number }).calls).toBe(0);
  });

  it.each([
    ['background', 'background'],
    ['no_window', 'no_window'],
    ['disabled', 'sdk_disabled'],
    ['failed', 'sdk_failed'],
    ['invalid', 'sdk_failed'],
    ['timeout', 'sdk_timeout'],
    ['closed', 'no_sdk'],
  ] as const)('falls back to uiautomator when the SDK answers %s', async (failure, reason) => {
    const link = fakeLink(4, () => Promise.reject(new SdkInspectError(failure)));
    const { service } = setup({ source: { packageName: PKG, link, screen: 'homepage' } });
    expect(await service.inspect(SERIAL)).toMatchObject({ source: 'uiautomator', fallbackReason: reason });
  });

  it('prefers uiautomator when an AndroidComposeView fills the top window, not for a small one', async () => {
    const compose = (bottom: number) =>
      sdkNode(1, {
        className: 'androidx.compose.ui.platform.AndroidComposeView',
        visibleBounds: [0, 0, 1080, bottom],
      });
    const big = setup({
      source: {
        packageName: PKG,
        link: fakeLink(4, async () => inspection([sdkNode(0), compose(2000)], true)),
        screen: null,
      },
    });
    expect(await big.service.inspect(SERIAL)).toMatchObject({
      source: 'uiautomator',
      fallbackReason: 'compose',
    });
    const small = setup({
      source: {
        packageName: PKG,
        link: fakeLink(4, async () => inspection([sdkNode(0), compose(300)], true)),
        screen: null,
      },
    });
    expect(await small.service.inspect(SERIAL)).toMatchObject({ source: 'sdk' });
  });

  it('uses the SDK for a Compose top window it read (v6), else says why it could not', async () => {
    const composeView = (composition?: InspectorNode['composition']) =>
      sdkNode(1, {
        className: 'androidx.compose.ui.platform.AndroidComposeView',
        visibleBounds: [0, 0, 1080, 2400],
        ...(composition ? { composition } : {}),
      });
    const button = sdkNode(2, {
      parent: 1,
      className: 'Button',
      composable: { file: 'CartScreen.kt', line: 87 },
    });
    const inspect = async (nodes: InspectorNode[]) =>
      setup({
        source: { packageName: PKG, link: fakeLink(6, async () => inspection(nodes, true)), screen: 'cart' },
      }).service.inspect(SERIAL);
    const read = await inspect([sdkNode(0), composeView('read'), button]);
    expect(read).toMatchObject({ source: 'sdk', fallbackReason: null });
    expect(read.nodes[2]).toMatchObject({
      className: 'Button',
      composable: { file: 'CartScreen.kt', line: 87 },
    });
    for (const [status, reason] of [
      ['disabled', 'compose_disabled'],
      ['no_source', 'compose_no_source'],
      ['failed', 'compose_failed'],
      [undefined, 'compose'],
    ] as const) {
      expect(await inspect([sdkNode(0), composeView(status)])).toMatchObject({
        source: 'uiautomator',
        fallbackReason: reason,
      });
    }
  });

  it('maps a uiautomator dump: clipped bounds, no password text, SDK-only fields null', async () => {
    const { service } = setup({ source: { packageName: PKG, link: null, screen: 'Cart' } });
    const snapshot = await service.inspect(SERIAL);
    expect(snapshot).toMatchObject({
      packageName: PKG,
      // The SDK's screen name is kept: the dump is of the session's app.
      screen: 'Cart',
      windows: [{ id: 0, type: null, bounds: [0, 0, 1080, 2400] }],
      display: { width: 1080, height: 2400, rotation: 0 },
    });
    const byText = (text: string) => snapshot.nodes.find((node) => node.text === text);
    expect(byText('Cart & checkout')).toMatchObject({
      className: 'android.widget.TextView',
      parent: 1,
      alpha: null,
      padding: null,
      source: null,
      fragment: null,
      layoutWidth: null,
      checked: null,
    });
    // Row 2 sticks out of the list below it: clipped to the list.
    expect(byText('Row 2 <sale>')).toMatchObject({
      bounds: [42, 2140, 1038, 2260],
      visibleBounds: [42, 2140, 1038, 2200],
    });
    const password = snapshot.nodes.find((node) => node.resourceId === 'password');
    expect(password?.text).toBeNull();
    // Off the right edge of the screen.
    expect(snapshot.nodes.find((node) => node.className === 'android.widget.CheckBox')).toMatchObject({
      checked: true,
      enabled: false,
      contentDescription: 'Remember me',
      visibleBounds: null,
    });
    snapshot.nodes.forEach((node, index) => {
      expect(node.id).toBe(index);
      expect(node.parent === null || node.parent < index).toBe(true);
    });
  });

  it('joins a capture already running for the device', async () => {
    let finish: (value: SdkInspection) => void = () => undefined;
    const answer = new Promise<SdkInspection>((resolve) => (finish = resolve));
    const link = fakeLink(4, () => answer);
    const { service, calls } = setup({ source: { packageName: PKG, link, screen: null } });
    const first = service.inspect(SERIAL);
    const second = service.inspect(SERIAL);
    await new Promise((resolve) => setImmediate(resolve));
    finish(inspection());
    expect(await first).toBe(await second);
    expect(link.calls).toBe(1);
    expect(calls.screencaps).toBe(1);
    await service.inspect(SERIAL);
    expect(link.calls).toBe(2);
  });

  it('refuses a device that is not ready, and fails on a missing screenshot or unreadable screen', async () => {
    const { service } = setup();
    await expect(service.inspect('192.168.1.5:5555')).rejects.toEqual(
      new PublicError('Device 192.168.1.5:5555 is not connected'),
    );
    await expect(service.inspect('R58M123ABC')).rejects.toEqual(
      new PublicError('Device R58M123ABC is unauthorized'),
    );
    const noShot = setup({ screencap: () => Promise.reject(new Error('adb: no display')) });
    await expect(noShot.service.inspect(SERIAL)).rejects.toThrow(`Could not take a screenshot of ${SERIAL}`);
    const notPng = setup({ screencap: async () => Buffer.from('error: no display') });
    await expect(notPng.service.inspect(SERIAL)).rejects.toThrow('no PNG');
    const noDump = setup({
      dumpUi: () => Promise.reject(new Error('uiautomator could not read the screen')),
    });
    await expect(noDump.service.inspect(SERIAL)).rejects.toThrow(
      `Could not inspect the screen of ${SERIAL}: uiautomator could not read the screen`,
    );
    expect(noDump.service.current).toBeNull();
    expect(noDump.messages).toEqual([]);
  });

  it(`keeps the last ${MAX_KEPT_SNAPSHOTS} snapshots, and fewer when they are large`, async () => {
    const { service } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_KEPT_SNAPSHOTS + 2; i++) ids.push((await service.inspect(SERIAL)).id);
    expect(ids.map((id) => service.png(id) !== null)).toEqual([false, false, true, true, true, true, true]);
    expect(service.current?.id).toBe(ids.at(-1));

    const tight = setup({ maxKeptBytes: PNG.length * 2 });
    const kept: string[] = [];
    for (let i = 0; i < 3; i++) kept.push((await tight.service.inspect(SERIAL)).id);
    // Each takes a PNG plus its JSON: only the newest fits.
    expect(kept.map((id) => tight.service.png(id) !== null)).toEqual([false, false, true]);
  });

  describe('selection', () => {
    async function selected() {
      const link = fakeLink(4, async () => inspection());
      const setupResult = setup({ source: { packageName: PKG, link, screen: null } });
      const snapshot = await setupResult.service.inspect(SERIAL);
      return { ...setupResult, link, snapshot };
    }

    it('selects a node of the current snapshot, broadcasts it once, and clears it', async () => {
      const { service, messages, snapshot } = await selected();
      const selection = service.select(snapshot.id, 1, 'user');
      expect(selection).toEqual({
        snapshotId: snapshot.id,
        nodeId: 1,
        ts: expect.any(Number) as number,
        origin: 'user',
      });
      expect(service.select(snapshot.id, 1, 'user')).toBe(selection);
      expect(messages.filter((message) => message.type === 'inspectorSelection')).toEqual([
        { type: 'inspectorSelection', selection },
      ]);
      // The same node picked by the agent is a new selection (its origin changed).
      expect(service.select(snapshot.id, 1, 'agent')).toMatchObject({ nodeId: 1, origin: 'agent' });
      expect(service.select(snapshot.id, null, 'user')).toBeNull();
      expect(service.select(snapshot.id, null, 'user')).toBeNull();
      expect(messages.filter((message) => message.type === 'inspectorSelection')).toHaveLength(3);
      expect(service.selection).toBeNull();
    });

    it('refuses another snapshot or a node it does not have', async () => {
      const { service, snapshot } = await selected();
      expect(() => service.select('0123456789abcdef', 0, 'user')).toThrow(PublicError);
      expect(() => service.select(snapshot.id, 2, 'user')).toThrow('The Inspector snapshot has no node 2');
      await service.inspect(SERIAL);
      expect(() => service.select(snapshot.id, 0, 'user')).toThrow('not the current one');
    });

    it('moves to the same element in a new snapshot, keeping who picked it', async () => {
      const { service, messages, snapshot, link } = await selected();
      const first = service.select(snapshot.id, 1, 'agent');
      const next = await service.inspect(SERIAL);
      expect(service.selection).toEqual({ snapshotId: next.id, nodeId: 1, ts: first?.ts, origin: 'agent' });
      expect(messages.slice(-2).map((message) => message.type)).toEqual(['inspection', 'inspectorSelection']);

      // The list scrolled: the button moved, but it is still the only btn_share with that text.
      link.inspect = async () =>
        inspection([
          sdkNode(0),
          sdkNode(1, { className: 'android.widget.TextView', resourceId: 'title', text: 'Deals' }),
          sdkNode(2, { bounds: [0, 500, 1080, 600] }),
        ]);
      await service.inspect(SERIAL);
      expect(service.selection).toMatchObject({ nodeId: 2 });
    });

    it('matches by position (within 24 px) when the identity is ambiguous, else clears', async () => {
      const { service, snapshot, link } = await selected();
      service.select(snapshot.id, 1, 'user');
      // Two buttons alike: the one that moved by 20 px is taken.
      link.inspect = async () =>
        inspection([
          sdkNode(0),
          sdkNode(1, { bounds: [20, 120, 1060, 220] }),
          sdkNode(2, { bounds: [0, 900, 1080, 1000] }),
        ]);
      await service.inspect(SERIAL);
      expect(service.selection).toMatchObject({ nodeId: 1 });
      // Two alike and neither near: cleared.
      link.inspect = async () =>
        inspection([
          sdkNode(0),
          sdkNode(1, { bounds: [0, 500, 1080, 600] }),
          sdkNode(2, { bounds: [0, 900, 1080, 1000] }),
        ]);
      await service.inspect(SERIAL);
      expect(service.selection).toBeNull();
    });
  });

  it('takes a new screenshot with the uiautomator dump when the SDK could not answer', async () => {
    const shots: number[] = [];
    let n = 0;
    const link = fakeLink(4, () => Promise.reject(new SdkInspectError('timeout')));
    const { service } = setup({
      source: { packageName: PKG, link, screen: null },
      screencap: async () => {
        n += 1;
        shots.push(n);
        return rgbPng(10 * n, 20, () => [0, 0, 0]);
      },
    });
    const snapshot = await service.inspect(SERIAL);
    expect(shots).toEqual([1, 2]);
    // The second picture is kept: the one taken with the dump.
    expect(service.png(snapshot.id)).toEqual(rgbPng(20, 20, () => [0, 0, 0]));
    expect(snapshot.fallbackReason).toBe('sdk_timeout');

    // Without an SDK to ask, the first picture already goes with the dump.
    const plain = setup();
    await plain.service.inspect(SERIAL);
    expect(plain.calls.screencaps).toBe(1);
  });

  it('falls back to uiautomator when the SDK snapshot is over 8 MB, and fails on such a dump', async () => {
    const huge = 'x'.repeat(500);
    const many = Array.from({ length: 5000 }, (_, id) =>
      sdkNode(id, { text: huge, contentDescription: huge, className: `com.example.${'c'.repeat(180)}` }),
    );
    const link = fakeLink(4, async () => inspection(many));
    const { service } = setup({ source: { packageName: PKG, link, screen: null } });
    expect(await service.inspect(SERIAL)).toMatchObject({
      source: 'uiautomator',
      fallbackReason: 'sdk_too_large',
    });
    const sdkFailure = setup({
      source: {
        packageName: PKG,
        link: fakeLink(4, () => Promise.reject(new SdkInspectError('too_large'))),
        screen: null,
      },
    });
    expect(await sdkFailure.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'sdk_too_large' });
  });
});

/** Inspect-only links that report `ready` on every prepare; `oldSdks`: packages with an SDK below v5. */
function fakeLinks(ready: Partial<InspectLinkReadiness> = {}, oldSdks: readonly string[] = []) {
  const calls = { notes: [] as string[], prepares: 0 };
  const links: InspectorLinks = {
    noteInspect: (serial) => {
      calls.notes.push(serial);
    },
    prepare: async () => {
      calls.prepares += 1;
      return { sources: [], reason: null, waited: false, ...ready };
    },
    needsSession: (serial, packageName) => serial === SERIAL && oldSdks.includes(packageName),
  };
  return { links, calls };
}

describe('Inspector service with inspect-only links', () => {
  it('takes the snapshot from the inspect-only link of the app on top, and every inspect keeps the link', async () => {
    const link = fakeLink(5, async () => inspection());
    const { links, calls } = fakeLinks({ sources: [{ packageName: PKG, link, screen: 'homepage' }] });
    const { service } = setup({ links });
    expect(await service.inspect(SERIAL)).toMatchObject({
      source: 'sdk',
      packageName: PKG,
      fallbackReason: null,
    });
    await service.inspect(SERIAL);
    expect(calls.notes).toEqual([SERIAL, SERIAL]);
    expect(link.calls).toBe(2);
  });

  it("asks the session's link first while its app is on top, then the linked apps on top in turn", async () => {
    const sessionLink = fakeLink(4, async () => inspection());
    const onTop = fakeLinks({
      sources: [
        { packageName: 'com.example.other', link: fakeLink(5, async () => inspection()), screen: 'x' },
      ],
    });
    const first = setup({
      source: { packageName: PKG, link: sessionLink, screen: 'homepage' },
      links: onTop.links,
      foregroundPackage: otherInFront,
    });
    expect(await first.service.inspect(SERIAL)).toMatchObject({ source: 'sdk', packageName: PKG });
    expect(onTop.calls.prepares).toBe(0);

    // The session's app went to the background: the foreground app's link answers; another app that says it is on
    // top but is not the foreground app is not asked.
    const background = fakeLink(4, () => Promise.reject(new SdkInspectError('background')));
    const stale = fakeLink(5, () => Promise.reject(new SdkInspectError('background')));
    const other = fakeLink(5, async () => inspection());
    const { links } = fakeLinks({
      sources: [
        { packageName: 'com.example.stale', link: stale, screen: 'gone' },
        { packageName: 'com.example.other', link: other, screen: 'x' },
      ],
    });
    const second = setup({
      source: { packageName: PKG, link: background, screen: 'homepage' },
      links,
      foregroundPackage: otherInFront,
    });
    expect(await second.service.inspect(SERIAL)).toMatchObject({
      source: 'sdk',
      packageName: 'com.example.other',
    });
    expect([background.calls, stale.calls, other.calls]).toEqual([1, 0, 1]);
  });

  it('asks a session app that seems to be in the background last', async () => {
    const sessionLink = fakeLink(4, () => Promise.reject(new SdkInspectError('background')));
    const other = fakeLink(5, async () => inspection());
    const withOther = fakeLinks({
      sources: [{ packageName: 'com.example.other', link: other, screen: 'x' }],
    });
    const first = setup({
      source: { packageName: PKG, link: sessionLink, screen: null },
      links: withOther.links,
      foregroundPackage: otherInFront,
    });
    expect(await first.service.inspect(SERIAL)).toMatchObject({ packageName: 'com.example.other' });
    expect(sessionLink.calls).toBe(0);

    const alone = setup({
      source: { packageName: PKG, link: sessionLink, screen: null },
      links: fakeLinks().links,
    });
    expect(await alone.service.inspect(SERIAL)).toMatchObject({
      source: 'uiautomator',
      fallbackReason: 'background',
    });
    expect(sessionLink.calls).toBe(1);
  });

  it.each([
    ['sdk_linking', { reason: 'sdk_linking', waited: true }, 2],
    ['sdk_link_busy', { reason: 'sdk_link_busy' }, 1],
    ['no_sdk', {}, 1],
  ] as const)('falls back with %s', async (reason, ready, screencaps) => {
    const { links } = fakeLinks(ready);
    const { service, calls } = setup({ links });
    expect(await service.inspect(SERIAL)).toMatchObject({ source: 'uiautomator', fallbackReason: reason });
    // After the wait window the first picture is stale: a new one goes with the dump.
    expect(calls.screencaps).toBe(screencaps);
  });

  it('says sdk_needs_session when the app on top has an SDK too old to link outside a session', async () => {
    const linking = setup({ links: fakeLinks({ reason: 'sdk_linking', waited: true }, [PKG]).links });
    expect(await linking.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'sdk_needs_session' });
    const none = setup({ links: fakeLinks({}, [PKG]).links });
    expect(await none.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'sdk_needs_session' });
    // Another app's old SDK says nothing about the one on top (the dump's package).
    const elsewhere = setup({ links: fakeLinks({}, ['com.example.other']).links });
    expect(await elsewhere.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'no_sdk' });
    // A busy link stays busy.
    const busy = setup({ links: fakeLinks({ reason: 'sdk_link_busy' }, [PKG]).links });
    expect(await busy.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'sdk_link_busy' });
  });

  it("names the screen from the linked app's SDK when the dump shows that app", async () => {
    const link = fakeLink(5, () => Promise.reject(new SdkInspectError('no_window')));
    const { links } = fakeLinks({ sources: [{ packageName: PKG, link, screen: 'homepage' }] });
    const { service } = setup({ links });
    expect(await service.inspect(SERIAL)).toMatchObject({
      source: 'uiautomator',
      fallbackReason: 'no_window',
      screen: 'homepage',
    });
  });
});

describe('Inspector service: which inspect-only link may answer', () => {
  it('asks only the link of the foreground app, whatever the others claim, with a picture taken then', async () => {
    const impostor = fakeLink(5, async () => inspection());
    const { links } = fakeLinks({ sources: [{ packageName: OTHER, link: impostor, screen: 'login' }] });
    // The app in front (the dump's) is not the one claiming to be on top.
    const { service, calls } = setup({ links });
    expect(await service.inspect(SERIAL)).toMatchObject({ source: 'uiautomator', fallbackReason: 'no_sdk' });
    expect(impostor.calls).toBe(0);
    expect(calls.foregrounds).toBe(1);

    const unknown = setup({ links, foregroundPackage: async () => null });
    expect(await unknown.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'no_sdk' });
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const failing = setup({
      links,
      foregroundPackage: () => Promise.reject(new Error('device offline')),
    });
    expect(await failing.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'no_sdk' });
    // Without a way to tell the foreground app, no inspect-only link is asked at all.
    const without = setup({ links, foregroundPackage: undefined });
    expect(await without.service.inspect(SERIAL)).toMatchObject({ fallbackReason: 'no_sdk' });
    expect(impostor.calls).toBe(0);
    vi.restoreAllMocks();
  });

  it('takes a new picture with the foreground check after waiting for the link', async () => {
    const link = fakeLink(5, async () => inspection());
    const { links } = fakeLinks({ sources: [{ packageName: PKG, link, screen: 'homepage' }], waited: true });
    const order: string[] = [];
    const { service } = setup({
      links,
      screencap: async () => {
        order.push('screencap');
        return PNG;
      },
      foregroundPackage: async () => {
        order.push('foreground');
        return PKG;
      },
    });
    expect(await service.inspect(SERIAL)).toMatchObject({ source: 'sdk' });
    expect(order).toEqual(['screencap', 'screencap', 'foreground']);
  });
});

describe('GET /inspector/<id>.png', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve(png: Buffer | null) {
    let port = 0;
    const server = createServer((req, res) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      serveInspectorPng(req, res, pathname, {
        png: (id) => (id === '0123456789abcdef' ? png : null),
        allowedOrigins: () => buildAllowedOrigins(port, false),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return port;
  }

  it('serves a kept snapshot as a same-origin PNG', async () => {
    const port = await serve(PNG);
    const res = await rawRequest(port, '/inspector/0123456789abcdef.png', 'GET', {
      'Sec-Fetch-Site': 'same-origin',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    const head = await rawRequest(port, '/inspector/0123456789abcdef.png', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const sameOrigin = await rawRequest(port, '/inspector/0123456789abcdef.png', 'GET', {
      Origin: `http://localhost:${port}`,
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('404s unknown, evicted and malformed ids', async () => {
    const port = await serve(PNG);
    for (const path of [
      '/inspector/fedcba9876543210.png',
      '/inspector/0123456789ABCDEF.png',
      '/inspector/0123456789abcdef.jpg',
      '/inspector/../0123456789abcdef.png',
      '/inspector/',
    ]) {
      expect((await rawRequest(port, path)).status).toBe(404);
    }
  });

  it('refuses cross-site requests and foreign origins', async () => {
    const port = await serve(PNG);
    const path = '/inspector/0123456789abcdef.png';
    expect((await rawRequest(port, path, 'GET', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await rawRequest(port, path, 'GET', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await rawRequest(port, path, 'GET', { Origin: 'null' })).status).toBe(403);
  });
});

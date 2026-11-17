import { UNTRUSTED_NOTE } from '../src/agent/tool.ts';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOLS,
  availableTools,
  callTool,
  STORAGE_READ_DISABLED,
  STORAGE_WRITE_DISABLED,
} from '../src/agent/registry.ts';
import type { SdkStorageResult } from '../src/device/sdkLink.ts';
import { StorageService } from '../src/storage/storageService.ts';
import { fakeAgent } from './helpers/agentFixtures.ts';
import { FakeLink } from './helpers/sdkSession.ts';

const STORAGE_TOOLS = ['list_storage', 'read_storage', 'write_storage', 'get_storage_audit'];

function agentWith(consent: 'off' | 'read' | 'read_write') {
  const agent = fakeAgent();
  const link = new FakeLink(11);
  const service = new StorageService({
    consent,
    target: () => ({ serial: 'emulator-5640', packageName: 'com.example.shop', link, ready: true }),
  });
  agent.ctx.storage = service;
  return { agent, link };
}

describe('storage agent tools', () => {
  it('lists the storage tools only as far as the consent goes, whatever device control says', () => {
    const names = (deviceControl: boolean, consent: 'off' | 'read' | 'read_write') =>
      availableTools(deviceControl, consent).map((tool) => tool.name);
    for (const deviceControl of [false, true]) {
      expect(names(deviceControl, 'off')).not.toEqual(expect.arrayContaining(['list_storage']));
      for (const name of STORAGE_TOOLS) expect(names(deviceControl, 'off')).not.toContain(name);
      expect(names(deviceControl, 'read')).toEqual(
        expect.arrayContaining(['list_storage', 'read_storage', 'get_storage_audit']),
      );
      expect(names(deviceControl, 'read')).not.toContain('write_storage');
      expect(names(deviceControl, 'read_write')).toEqual(expect.arrayContaining(STORAGE_TOOLS));
    }
    expect(availableTools(true).map((tool) => tool.name)).not.toContain('read_storage');
  });

  it('warns that storage is untrusted data and marks only write_storage as destructive', () => {
    for (const name of STORAGE_TOOLS) {
      const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.access).toMatch(/^storage_/);
      expect(tool?.annotations.destructiveHint ?? false).toBe(name === 'write_storage');
    }
  });

  it('refuses a call the server flags do not allow, before anything reaches the device', async () => {
    const off = agentWith('off');
    expect(await callTool(off.agent.ctx, 'list_storage', {}, true)).toEqual({
      ok: false,
      code: 'forbidden',
      error: STORAGE_READ_DISABLED,
    });
    const read = agentWith('read');
    expect(
      await callTool(
        read.agent.ctx,
        'write_storage',
        {
          store: 'prefs',
          name: 'p',
          op: 'update',
          key: 'k',
          expected: { t: 'int', v: '1' },
          value: { t: 'int', v: '2' },
        },
        true,
      ),
    ).toEqual({ ok: false, code: 'forbidden', error: STORAGE_WRITE_DISABLED });
    expect(off.link.storageRequests).toEqual([]);
    expect(read.link.storageRequests).toEqual([]);
  });

  it('returns storage data marked untrusted, and an integer given as a JSON number as invalid_value', async () => {
    const { agent, link } = agentWith('read_write');
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        entries: [{ key: 'count', value: { t: 'long', v: '9223372036854775807' } }],
        nextCursor: null,
        truncated: false,
      } satisfies SdkStorageResult);
    const outcome = await callTool(agent.ctx, 'read_storage', { store: 'prefs', name: 'app' }, false);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        untrusted: UNTRUSTED_NOTE,
        kind: 'prefs',
        entries: [{ key: 'count', value: { t: 'long', v: '9223372036854775807' } }],
      },
    });
    const number = await callTool(
      agent.ctx,
      'write_storage',
      {
        store: 'prefs',
        name: 'app',
        op: 'update',
        key: 'count',
        expected: { t: 'long', v: Number('9007199254740993') },
        value: { t: 'long', v: '1' },
      },
      false,
    );
    expect(number).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid_value/) });
    expect(link.storageRequests.map((request) => request.type)).toEqual(['storageRead']);
  });

  it('hands an agent a cut key with its keyLength, and says such a key is not one to write', async () => {
    const { agent, link } = agentWith('read');
    const prefix = 'k'.repeat(1024);
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        entries: [
          { key: prefix, value: { t: 'int', v: '3' } },
          { key: prefix, keyLength: 1030, value: { t: 'int', v: '3' } },
        ],
        nextCursor: null,
        truncated: false,
      } satisfies SdkStorageResult);
    const outcome = await callTool(agent.ctx, 'read_storage', { store: 'prefs', name: 'app' }, false);
    if (!outcome.ok) throw new Error(outcome.error);
    const entries = (outcome.result as { entries: { keyLength?: number }[] }).entries;
    expect(entries.map((entry) => entry.keyLength)).toEqual([undefined, 1030]);
    const description = AGENT_TOOLS.find((tool) => tool.name === 'read_storage')!.description;
    expect(description).toMatch(/keyLength/);
    expect(AGENT_TOOLS.find((tool) => tool.name === 'write_storage')!.description).toMatch(/keyLength/);
  });

  it('turns a refusal into a tool error with its code (needs_sdk on an old link)', async () => {
    const agent = fakeAgent();
    agent.ctx.storage = new StorageService({
      consent: 'read',
      target: () => ({ serial: 's', packageName: 'p', link: new FakeLink(10), ready: true }),
    });
    expect(await callTool(agent.ctx, 'list_storage', {}, false)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^needs_sdk: /),
    });
  });

  it('never hands an agent a credential through a cursor or a view, and binds edits to the link read', async () => {
    const { agent, link } = agentWith('read_write');
    link.answerStorage = () =>
      Promise.resolve({
        type: 'storageReadResult',
        requestId: 1,
        code: 'ok',
        pages: [
          {
            table: 'readable_view',
            columns: ['id', 'value'],
            pk: [],
            readOnly: 'view',
            rows: [
              {
                cells: [
                  { t: 'integer', v: '1' },
                  { t: 'string', v: 'fixture-secret-in-view' },
                ],
                digest: null,
              },
            ],
            nextCursor: '{"k":[{"t":"string","v":"fixture-secret-alpha"}]}',
            truncated: false,
          },
        ],
        txMs: 1,
      } satisfies SdkStorageResult);
    const read = await callTool(
      agent.ctx,
      'read_storage',
      { store: 'db', name: 'app.db', pages: [{ table: 'readable_view' }] },
      false,
    );
    expect(read).toMatchObject({ ok: true, result: { kind: 'pages', target: { link: 1 } } });
    expect(JSON.stringify(read)).not.toContain('fixture-secret');
    // An edit naming another link than the current one is refused before it reaches the app.
    const stale = await callTool(
      agent.ctx,
      'write_storage',
      {
        store: 'prefs',
        name: 'app',
        op: 'update',
        key: 'count',
        expected: { t: 'int', v: '1' },
        value: { t: 'int', v: '2' },
        target: { serial: 'emulator-5640', packageName: 'com.example.shop', link: 7 },
      },
      false,
    );
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/^failed: .*Read again/) });
    expect(link.storageRequests.map((request) => request.type)).toEqual(['storageRead']);
  });
});

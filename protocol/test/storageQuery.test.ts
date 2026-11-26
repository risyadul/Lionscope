/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseClientMessage,
  parseDeviceMessage,
  storageQueryInputSchema,
  storageTargetSchema,
} from '../src/index.ts';
import { planStorageSql } from '../src/storageSql.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const cases: { sql: string; reject?: boolean; readOnly?: boolean; table?: string | null }[] = JSON.parse(
  fixture('storage-sql-plans.json'),
);

describe('SQL console contract', () => {
  for (const entry of cases)
    it(`classifies ${JSON.stringify(entry.sql)}`, () => {
      const result = planStorageSql(entry.sql);
      if (entry.reject) expect(typeof result).toBe('string');
      else expect(result).toMatchObject({ readOnly: entry.readOnly, table: entry.table });
    });

  it('requires a bounded query and its original app link', () => {
    const query = {
      name: 'shop.db',
      sql: 'SELECT 1',
      target: { serial: 'emulator-5554', packageName: 'com.example.shop', link: 1 },
    };
    expect(parseClientMessage(JSON.stringify({ type: 'storageQuery', requestId: 1, query })).ok).toBe(true);
    for (const invalid of [
      { ...query, target: undefined },
      { ...query, sql: 'x'.repeat(16385) },
      { ...query, limit: 201 },
      { ...query, offset: 1000001 },
    ])
      expect(storageQueryInputSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts valid long wireless serials (136 and 259 chars) in storage query and write targets', () => {
    const host130 = `${'a'.repeat(62)}.${'b'.repeat(62)}.test`; // 130 chars -> + ':65535' = 136 chars
    const serial136 = `${host130}:65535`;
    expect(serial136.length).toBe(136);

    const host253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(56)}.test`; // 253 chars -> + ':65535' = 259 chars
    const serial259 = `${host253}:65535`;
    expect(serial259.length).toBe(259);

    for (const serial of [serial136, serial259]) {
      const target = { serial, packageName: 'com.example.shop', link: 1 };
      expect(storageTargetSchema.safeParse(target).success, `storageTarget ${serial.length}`).toBe(true);
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'storageQuery',
            requestId: 2,
            query: { name: 'shop.db', sql: 'SELECT 1', target },
          }),
        ).ok,
        `storageQuery ${serial.length}`,
      ).toBe(true);
    }

    expect(
      storageTargetSchema.safeParse({ serial: '-bad;serial', packageName: 'com.example.shop', link: 1 })
        .success,
    ).toBe(false);
  });

  it('accepts query golden results only after v13 negotiation', () => {
    for (const line of fixture('storage-query-results.ndjson').trim().split('\n')) {
      expect(parseDeviceMessage(line, 13)).toHaveProperty('ok', true);
      expect(parseDeviceMessage(line, 12)).toMatchObject({ ok: false, unnegotiated: { since: 13 } });
    }
  });
});

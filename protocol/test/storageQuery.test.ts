/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseDeviceMessage, storageQueryInputSchema } from '../src/index.ts';
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

  it('accepts query golden results only after v13 negotiation', () => {
    for (const line of fixture('storage-query-results.ndjson').trim().split('\n')) {
      expect(parseDeviceMessage(line, 13)).toHaveProperty('ok', true);
      expect(parseDeviceMessage(line, 12)).toMatchObject({ ok: false, unnegotiated: { since: 13 } });
    }
  });
});

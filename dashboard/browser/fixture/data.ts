import type {
  ClientMessage,
  StorageResponse,
  StorageTable,
  StorageTarget,
  StorageValue,
} from '@lionscope/protocol/wire';
import { createStore } from '../../src/lib/store.ts';
import { createSignal } from '../../src/lib/signal.ts';
import type { DashboardServices } from '../../src/app/services.ts';
import type { LiveStats } from '../../src/lib/stats.ts';

export const DATABASE = 'synthetic_debug_inventory_database_with_a_long_name';
export const ARCHIVE = 'synthetic_archive_database';
export const LONG_PREFERENCE = 'analytics_a_long_synthetic_preference_file_name';
export const LONG_TABLE = 'InventoryHistoryWithALongSyntheticTableName';
const columns = [
  { name: 'id', type: 'INTEGER', notNull: true, pk: 1 },
  { name: 'code', type: 'TEXT', notNull: false, pk: 0 },
  { name: 'city', type: 'TEXT', notNull: false, pk: 0 },
];
const tables: StorageTable[] = ['item', LONG_TABLE].map((name) => ({
  name,
  kind: 'table',
  columns,
  pk: ['id'],
  readOnly: null,
  withoutRowid: false,
}));
tables.push({
  name: 'visible_items',
  kind: 'view',
  columns,
  pk: ['id'],
  readOnly: 'view',
  withoutRowid: false,
});
const target: StorageTarget = { serial: 'synthetic-device', packageName: 'com.example.inventory', link: 1 };

export const stats: LiveStats = {
  cpuPercent: 24,
  cpuSingleCorePercent: 48,
  threads: 42,
  pssMb: 120,
  javaMb: 80,
  nativeMb: 40,
  fps: 44,
  jankPercent: 8,
  jankFrames: 8,
  slowFrames: 10,
  renderedFrames: 100,
  p90Ms: 38,
  frameIntervalMs: 16.7,
  isFrameIntervalAssumed: false,
  hasNoUiFrames: false,
  noFramesLabel: '',
  noFramesHint: '',
};

export function createFixtureServices(): DashboardServices {
  const store = createStore();
  let rows: StorageValue[][] = Array.from({ length: 80 }, (_, index) => [
    { t: 'integer', v: String(index + 2) },
    { t: 'string', v: `SYN-${index + 2}` },
    { t: 'string', v: 'Example City' },
  ]);
  const preferences = new Map<string, StorageValue>([
    ['enabled', { t: 'bool', v: true }],
    ['label', { t: 'string', v: 'Synthetic setting' }],
  ]);
  let operation = 0;

  function answer(message: ClientMessage): StorageResponse {
    if (message.type === 'storageList')
      return {
        ok: true,
        kind: 'list',
        target,
        prefs: [
          { name: 'settings', backupOnly: false },
          { name: LONG_PREFERENCE, backupOnly: false },
        ],
        prefsTruncated: false,
        databases: [
          { name: DATABASE, status: 'ok' },
          { name: ARCHIVE, status: 'ok' },
        ],
      };
    if (message.type === 'storageAudit') return { ok: true, kind: 'audit', entries: [] };
    if (message.type === 'storageRead') {
      const input = message.read;
      if (input.store === 'prefs')
        return {
          ok: true,
          kind: 'prefs',
          target,
          name: input.name,
          entries: [...preferences].map(([key, value]) => ({ key, value })),
          nextCursor: null,
          truncated: false,
        };
      if (!input.pages)
        return { ok: true, kind: 'schema', target, name: input.name, tables, tablesTruncated: false };
      return {
        ok: true,
        kind: 'pages',
        target,
        name: input.name,
        txMs: 1,
        pages: input.pages.map((page) => ({
          table: page.table,
          columns: columns.map((column) => column.name),
          pk: ['id'],
          readOnly: page.table === 'visible_items' ? 'view' : null,
          rows: rows.slice(0, 50).map((cells) => ({ cells, digest: 'a'.repeat(64) })),
          nextCursor: null,
          truncated: false,
        })),
      };
    }
    if (message.type === 'storageQuery') {
      const { sql, offset = 0 } = message.query;
      if (sql.includes('missing_column'))
        return {
          ok: true,
          kind: 'query',
          target,
          outcome: {
            opId: `fixture-${++operation}`,
            code: 'failed',
            late: false,
            queryError: 'no such column: missing_column',
          },
        };
      const result = sql.includes('WHERE 0') ? [] : rows.slice(offset, offset + 50);
      return {
        ok: true,
        kind: 'query',
        target,
        outcome: {
          opId: `fixture-${++operation}`,
          code: 'ok',
          late: false,
          txMs: 1,
          query: {
            readOnly: true,
            columns: columns.map((column) => column.name),
            rows: result,
            offset,
            hasMore: !sql.includes('WHERE 0') && offset + result.length < rows.length,
            truncated: false,
          },
        },
      };
    }
    if (message.type === 'storageWrite') {
      const input = message.write;
      const opId = `fixture-${++operation}`;
      if (input.store === 'prefs') {
        if (input.op === 'remove') preferences.delete(input.key);
        else preferences.set(input.key, input.value);
        return {
          ok: true,
          kind: 'write',
          target,
          outcome: { opId, code: 'ok', late: false, phase: 'final', persisted: true, memory: 'applied' },
        };
      }
      const row = rows.find((cells) => JSON.stringify(cells[0]) === JSON.stringify(input.pk[0]));
      if (!row) return { ok: true, kind: 'write', target, outcome: { opId, code: 'not_found', late: false } };
      if (input.op === 'delete') rows = rows.filter((candidate) => candidate !== row);
      else {
        const edits = input.op === 'updateRow' ? input.edits : [{ column: input.column, value: input.value }];
        for (const edit of edits) {
          const index = columns.findIndex((column) => column.name === edit.column);
          if (index >= 0) row[index] = edit.value;
        }
      }
      return {
        ok: true,
        kind: 'write',
        target,
        outcome: {
          opId,
          code: 'ok',
          late: false,
          phase: 'final',
          changes: 1,
          pk: [row[0]!],
          storedFields: columns.map((column, index) => ({ column: column.name, value: row[index]! })),
          rowDigest: 'b'.repeat(64),
        },
      };
    }
    return {
      ok: false,
      code: 'unsupported:fixture',
      message: 'This synthetic fixture only implements Storage requests.',
    };
  }

  return {
    store,
    probeTs: createSignal(null),
    cursorX: createSignal(null),
    send(message) {
      if (!('requestId' in message)) return false;
      const requestId = message.requestId;
      const response = answer(message);
      window.setTimeout(
        () => store.dispatch({ kind: 'server', msg: { type: 'storage', requestId, response } }),
        0,
      );
      return true;
    },
  };
}

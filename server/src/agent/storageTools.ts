/**
 * The storage inspector for agents (0.13.0): the session app's SharedPreferences and the Room databases it registers
 * (`Lionscope.trackDatabase`), read and edited live through its SDK link. Listed and callable only as far as the
 * server's --allow-storage-read / --allow-storage-write go (registry.ts); the same service as the dashboard's tab.
 */
import { z } from 'zod';
import {
  MAX_STORAGE_CURSOR_CHARS,
  MAX_STORAGE_KEYS,
  MAX_STORAGE_NAME_CHARS,
  MAX_STORAGE_PAGES,
  MAX_STORAGE_ROWS,
  storageWriteInputSchema,
} from '@lionscope/protocol';
import type { StorageReadInput, StorageResponse } from '@lionscope/protocol';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext, AgentStorage } from './tool.ts';

const NO_STORAGE =
  'The storage inspector is off. Start Lionscope with --allow-storage-read (and --allow-storage-write to edit values).';

export const VALUES_NOTE =
  'Values are typed: {"t":"string"|"int"|"long"|"integer"|"float"|"real"|"bool"|"stringSet"|"blob"|"null", ...}. Integers are decimal strings (never numbers); float/real carry "bits" (raw IEEE bits, the exact value) and "v" (display only). {"t":"redacted"} values look like credentials: never shown, never editable. complete:false values were cut: read-only. A prefs entry with "keyLength" has a key too long to send: "key" is only its first code units, read-only (written as a key, that prefix would name ANOTHER key).';

const name = z.string().min(1).max(MAX_STORAGE_NAME_CHARS);

function storage(ctx: AgentContext): AgentStorage {
  if (!ctx.storage || ctx.storage.consent === 'off') throw new ToolError(NO_STORAGE);
  return ctx.storage;
}

/** A refusal is the tool's error (`code: message`); anything else is returned as data. */
function answer(response: StorageResponse): Exclude<StorageResponse, { ok: false }> {
  if (!response.ok) throw new ToolError(`${response.code}: ${response.message}`);
  return response;
}

export const listStorageTool = defineTool({
  name: 'list_storage',
  title: 'List app storage',
  description:
    'Lists the profiled app\'s SharedPreferences files (shared_prefs/*.xml, names without .xml) and the Room databases it registered with Lionscope.trackDatabase (status ok, or unsupported:closed / unsupported:driver). Needs a profiling session of an app with the Lionscope SDK 0.13.0+ and a server started with --allow-storage-read. Reads in the app\'s own process: nothing is copied off the device. "target" names the app link answering (device, app, link generation).',
  access: 'storage_read',
  input: z.object({}),
  annotations: READ_ONLY,
  async run(_args, ctx) {
    const { target, prefs, prefsTruncated, databases } = answer(await storage(ctx).list()) as Extract<
      StorageResponse,
      { kind: 'list' }
    >;
    return { data: { untrusted: UNTRUSTED_NOTE, target, prefs, prefsTruncated, databases } };
  },
});

export const readStorageTool = defineTool({
  name: 'read_storage',
  title: 'Read app storage',
  description: `Reads the profiled app's storage through its SDK, live (needs --allow-storage-read): a SharedPreferences file (store "prefs": its keys in order with typed values, ${MAX_STORAGE_KEYS} at most per call; pass nextCursor back as cursor for more), a registered database's schema (store "db" without pages: tables with columns, primary key and why a table is read-only), or up to ${MAX_STORAGE_PAGES} table pages read in ONE transaction (store "db" with pages: [{table, columns?, cursor?, limit? (1-${MAX_STORAGE_ROWS}, default 50)}], rows in primary key order, each with the digest a delete needs). Cursors are opaque tokens: pass a nextCursor back as it came (valid for that file or table while the app's link lasts). A page with truncated:true was cut to stay under the answer size (rows left out, or a row too large sent with its values cut): its nextCursor continues. Values of views and virtual tables are all redacted (which table column they come from is not known). Reading a database holds the app's writers while it runs (a 250 ms budget checked between statements, so a slow statement can run past it). The answer's "target" names the app link it came from: pass it to write_storage so an edit never goes to another app, process or link. ${VALUES_NOTE} Use list_storage first for the names.`,
  access: 'storage_read',
  input: z.object({
    store: z.enum(['prefs', 'db']).describe('prefs: a SharedPreferences file; db: a registered database'),
    name: name.describe('The prefs file name (without .xml) or the registered database name (list_storage)'),
    cursor: z
      .string()
      .max(MAX_STORAGE_CURSOR_CHARS)
      .optional()
      .describe('prefs only: nextCursor of the previous call (an opaque token)'),
    limit: z.number().int().min(1).max(MAX_STORAGE_KEYS).optional().describe('prefs only: keys per call'),
    pages: z
      .array(
        z.object({
          table: name,
          columns: z.array(name).min(1).max(256).optional().describe('Exact column names (default: all)'),
          cursor: z.string().max(MAX_STORAGE_CURSOR_CHARS).optional().describe('nextCursor of that table'),
          limit: z.number().int().min(1).max(MAX_STORAGE_ROWS).optional(),
        }),
      )
      .min(1)
      .max(MAX_STORAGE_PAGES)
      .optional()
      .describe('db only: the table pages to read together; omitted: the schema'),
  }),
  annotations: READ_ONLY,
  async run({ store, name, cursor, limit, pages }, ctx) {
    if (store === 'prefs' && pages) throw new ToolError('pages are for store "db"');
    if (store === 'db' && (cursor !== undefined || limit !== undefined)) {
      throw new ToolError('cursor and limit are per page for store "db": put them in pages');
    }
    const read: StorageReadInput =
      store === 'prefs'
        ? { store, name, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) }
        : { store, name, ...(pages ? { pages } : {}) };
    const response = answer(await storage(ctx).read(read));
    const { ok: _ok, ...data } = response;
    return {
      data: {
        untrusted: UNTRUSTED_NOTE,
        ...data,
        ...(response.kind === 'pages'
          ? {
              note: 'Consistent within this call only (one transaction); another call may see later changes.',
            }
          : {}),
      },
    };
  },
});

export const writeStorageTool = defineTool({
  name: 'write_storage',
  title: 'Edit app storage',
  description: `Edits one value of the profiled app's storage live, compare-and-set (needs --allow-storage-write): nothing is written unless the current value equals "expected" exactly (same type; floats by bits). prefs: op "update" (key, expected, value of the SAME type) or "remove" (key, expected). db: op "update" one cell (table, column, pk = the row's primary key values in key order, expected, value; primary key columns and redacted cells are read-only) or "delete" one row (table, pk, rowDigest from read_storage). Codes: ok, conflict (current holds the app's value), already_applied_or_concurrent (it already was the new value: e.g. a retry after a lost answer; nothing written), type_mismatch, read_only:<why> (the schema says why a table is read-only, before you try), unsupported:<why> (e.g. deferred_fk: an edit that could fail at COMMIT on a deferred foreign key; defer_foreign_keys: the app left PRAGMA defer_foreign_keys on, nothing written), invalid_value[:nan_not_storable|nan_payload|lone_surrogate], constraint_failed, not_found, timeout (may still have been applied: read again; never undoable), busy. Prefs report memory (in the app), persisted (true/false/"timeout"; not true = in memory only) and observers "posted_unverified"; a database reports changes and observers "room_invalidation" (Room was told; screens that don't observe the database won't change until they reload). Only an ok final answer carries "undo": call write_storage with exactly that object to revert (it fails as conflict if the app changed the value since, and is refused once the app's link changed: a new session, another app, a restart or reconnect). Pass "target" from the read_storage answer the values came from: the edit is refused (nothing written) when the app's link is another one now. The server never retries. ${VALUES_NOTE}`,
  access: 'storage_write',
  input: z.object({
    store: z.enum(['prefs', 'db']),
    name,
    op: z.enum(['update', 'remove', 'delete']),
    key: name.optional().describe('prefs: the key'),
    table: name.optional().describe('db: the table'),
    column: name.optional().describe('db update: the column'),
    pk: z
      .array(z.unknown())
      .min(1)
      .max(64)
      .optional()
      .describe('db: the row primary key, typed values in key order'),
    expected: z.unknown().optional().describe('The typed value the app must hold now'),
    value: z.unknown().optional().describe('update: the new typed value'),
    rowDigest: z.string().optional().describe('db delete: the row digest from read_storage'),
    undoOf: z.string().optional().describe('Only as given in an "undo" object'),
    target: z
      .unknown()
      .optional()
      .describe('The "target" of the read_storage answer the values came from ({serial, packageName, link})'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const service = storage(ctx);
    const defined = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
    const parsed = storageWriteInputSchema.safeParse(defined);
    if (!parsed.success) {
      throw new ToolError(
        `invalid_value: ${parsed.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message).join('; ')}`,
      );
    }
    const response = answer(await service.write(parsed.data));
    if (response.kind !== 'write') throw new ToolError('failed: unexpected answer');
    return { data: { untrusted: UNTRUSTED_NOTE, ...response.outcome } };
  },
});

export const storageAuditTool = defineTool({
  name: 'get_storage_audit',
  title: 'Storage edit audit',
  description:
    'Every storage edit this server sent or refused (newest last, at most 1000), WITHOUT values: time, opId, device, app, prefs file / database, table, key or column (credential-looking names as [redacted-name]), primary key digest, op, code, phase, late, persisted, changes. A late:true entry is a final answer that came after its write timed out: use it (by opId) to learn whether a timed-out edit was applied. Needs --allow-storage-read.',
  access: 'storage_read',
  input: z.object({
    opId: z.string().max(64).optional().describe("Only this write's entries"),
    last: z.number().int().min(1).max(1000).optional().describe('Only the last N entries (default 100)'),
  }),
  annotations: READ_ONLY,
  run({ opId, last }, ctx) {
    const entries = storage(ctx).auditEntries(opId);
    const shown = entries.slice(-(last ?? 100));
    return Promise.resolve({
      data: {
        untrusted: UNTRUSTED_NOTE,
        total: entries.length,
        entries: shown.map((entry) => ({ ...entry, time: new Date(entry.ts).toISOString() })),
      },
    });
  },
});

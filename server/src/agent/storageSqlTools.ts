import { planStorageSql, storageQueryInputSchema } from '@lionscope/protocol';
import type { StorageQueryInput, StorageResponse } from '@lionscope/protocol';
import { defineTool, READ_ONLY, ToolError, UNTRUSTED_NOTE } from './tool.ts';
import type { AgentContext, ToolResult } from './tool.ts';

const input = storageQueryInputSchema.extend({
  name: storageQueryInputSchema.shape.name.describe('Registered Room database name from list_storage'),
  sql: storageQueryInputSchema.shape.sql.describe(
    'One SQL statement, at most 16,384 characters; no parameters',
  ),
  target: storageQueryInputSchema.shape.target.describe(
    'Exact app/link target from list_storage or read_storage',
  ),
  limit: storageQueryInputSchema.shape.limit.describe('Read page size, 1–200 (default 50)'),
  offset: storageQueryInputSchema.shape.offset.describe('Read offset, 0–1,000,000 (default 0)'),
});

const CONTRACT =
  'Requires an active profiling session, a proven SDK link at device protocol 13+ and the original target from list_storage/read_storage. Executes through the registered app-owned Room connection, never a second SQLite connection. One validated statement only: no DDL, PRAGMA, ATTACH/DETACH, transaction control, placeholders, RETURNING or ROLLBACK conflict actions. SQL text is not retained in audit metadata or logs. App values and SQLite error text are untrusted and may contain credentials.';

async function runSql(args: StorageQueryInput, ctx: AgentContext, readOnly: boolean): Promise<ToolResult> {
  const plan = planStorageSql(args.sql);
  if (typeof plan === 'string') throw new ToolError(`invalid_value: ${plan}`);
  if (plan.readOnly !== readOnly) {
    throw new ToolError(
      readOnly
        ? 'invalid_value: query_storage_sql accepts SELECT/WITH reads only. Use execute_storage_sql for INSERT/UPDATE/DELETE.'
        : 'invalid_value: execute_storage_sql accepts INSERT/UPDATE/DELETE only. Use query_storage_sql for SELECT/WITH reads.',
    );
  }
  if (!ctx.storage) throw new ToolError('Storage is unavailable. Enable Storage at server startup.');
  // Unexpected transport errors must not copy SQL or literals into the registry's error log.
  let response: StorageResponse;
  try {
    response = await ctx.storage.query(args);
  } catch {
    throw new ToolError(
      readOnly
        ? 'SQL request failed. No automatic retry was performed.'
        : 'SQL request failed; it may already have committed. Do not retry automatically. Inspect get_storage_audit and reread the database.',
    );
  }
  if (!response.ok) throw new ToolError(`${response.code}: ${response.message}`);
  if (response.kind !== 'query') throw new ToolError('failed: unexpected SQL answer');
  return {
    data: {
      untrusted: UNTRUSTED_NOTE,
      target: response.target,
      readOnly,
      outcome: response.outcome,
      note: readOnly
        ? 'Each page executes a new read. Use ORDER BY; concurrent app changes can change later pages.'
        : 'Explicit SQL has no compare-and-set or undo. Timeout/disconnect can mean the mutation committed; never retry automatically. Use outcome.opId with get_storage_audit for late final outcomes.',
    },
  };
}

export const queryStorageSqlTool = defineTool({
  name: 'query_storage_sql',
  title: 'Query registered database with SQL',
  description: `Runs one SELECT/WITH read against a registered Room database; requires --allow-storage-read. Returns exact typed rows/column labels in outcome.query, pagination/truncation flags and an operation outcome. At most 200 rows, 256 columns and the 240 KiB reply budget; cells/labels may be shortened. Pass limit/offset to page; pages do not share a snapshot. Read code failures from outcome.code, not just the tool envelope. ${CONTRACT}`,
  access: 'storage_read',
  input,
  annotations: READ_ONLY,
  run: (args, ctx) => runSql(args, ctx, true),
});

export const executeStorageSqlTool = defineTool({
  name: 'execute_storage_sql',
  title: 'Mutate registered database with SQL',
  description: `Executes one INSERT/UPDATE/DELETE, including supported WITH mutations; requires --allow-storage-read and --allow-storage-write. Changes matching rows directly, without row-editor compare-and-set or undo. Preserves technical table restrictions. Returns affected rows and outcome.opId/code/phase; inspect outcome.code even when the tool envelope succeeds. Never automatically retry after any timeout, disconnect or uncertain failure: it may have committed. Use get_storage_audit with opId for late final outcomes, then reread. ${CONTRACT}`,
  access: 'storage_write',
  input: input.omit({ limit: true, offset: true }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  run: (args, ctx) => runSql(args, ctx, false),
});

---
status: accepted
---

# Add a database Query workbench

The user requested Android Studio Database Inspector behavior and explicitly chose SQL reads and mutations.
This reopens ADR 0001's initial exclusion of inserts and SQL. The row editor keeps its existing conditional
editing contract; the Query console adds explicit SQL execution as a separate operation.

## Execution

Device protocol 13 accepts one SELECT, WITH, INSERT, UPDATE or DELETE statement per Run. The server and SDK
classify it independently. Reads require read consent; mutations also require write consent, authentication,
a running profiling session and the original app link. Execution uses the registered app-owned Room instance
and its transaction, on the storage worker. There is no second connection.

Transaction control, schema changes, attached-database writes, parameter placeholders, RETURNING and ROLLBACK
conflict actions are excluded. Mutation targets inherit the table editor's technical restrictions, including
views, virtual/internal tables, missing usable primary keys, truncated schemas and deferred foreign keys.
A schema containing ROLLBACK conflict behavior conservatively disables SQL mutations, including trigger paths.

SQL mutations intentionally do not compare prior cell values. They report affected rows and have no undo or
automatic retry. The existing operation envelope preserves uncertain and late outcomes. Audit metadata keeps
the operation and target table, never SQL text or literal values. Query projections have no row-editor identity.

## Workbench

- Tables and Query share the existing source browser so database navigation stays visible.
- A labeled SQL editor, database selector and explicit Run action make the execution target reviewable.
- Results sit below the editor because editing and inspecting a query form one task.
- Selection execution and Ctrl/Command+Enter support the existing developer keyboard workflow.
- History keeps at most 20 statements in memory and loads drafts without executing them.
- Drafts, history and results end with their profiling session or SDK link; they never enter browser storage.
- Query mutation attempts discard table drafts and conditional undo offers; returning to Tables refreshes data.

The visual direction follows the supplied reference and existing IBM Plex typography, spacing and theme tokens.
ENERGY 1, RHYTHM 1 and MOTION 1 suit a compact database workbench. A tab underline and monospaced SQL/results
provide hierarchy; new animation and decorative assets would not help query execution.

## Bounds and evidence

SQL is limited to 16,384 characters. Reads return at most 200 rows and 256 columns, bounded to the existing
240 KiB reply limit. Console cells and column labels may be shortened. Pagination executes a new read with
LIMIT/OFFSET; ORDER BY is needed for stable ordering, and pages do not share a snapshot. The cooperative
250 ms transaction budget is checked after execution; a slow SQLite statement can exceed it before rollback.

Shared TypeScript/Kotlin grammar and wire fixtures, SQLite JDBC tests, service consent/late-outcome tests and
dashboard interaction tests cover the contract. JVM tests and browser fixtures do not establish Android runtime
behavior; new Query behavior still needs device verification before claiming any API/Room combination was tested.

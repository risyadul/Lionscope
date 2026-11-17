# Storage SQL agent tools verification

Verified locally on 17 November 2026 in `/tmp/lionscope-storage-sql-agent-tools`, based on the 0.13.0
candidate. No user profiling session was replaced and no package was published.

## Behavior

`query_storage_sql` exposes SELECT/WITH reads; `execute_storage_sql` exposes INSERT/UPDATE/DELETE,
including supported WITH mutations. Both use the existing Storage service and registered Room query path,
device protocol 13, original app/link target, statement validation and reply limits. There are no protocol,
Android implementation or dashboard changes. Mutations require read and write consent, have no compare-and-set
or undo, and are never automatically replayed by MCP reconnection.

## Checks

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`,
  `npm run release:check`, `npm run build:cli` and `git diff --check`: passed.
- `npm test -- --maxWorkers=2`: final complete rerun passed **2,440 tests / 145 files**, including 21 new
  SQL tool/transport cases. The preceding complete run's failure is investigated below.
- Agent tests cover tool discovery/consent, separate read/write classification, exact typed values and paging,
  invalid SQL/arguments, old SDK/proof/stale-target refusals, mutation audit without SQL or literals,
  timeout/late final outcomes without replay, and sanitization of unexpected exceptions.
- Transport tests use a real HTTP server and MCP clients over HTTP and stdio, plus CLI JSON aliases.
  They verify reads, target-bound mutations, audit, client read-only permissions and no mutation replay when
  the attached server disappears. The SDK is a synthetic protocol-13 fake; this is not Android runtime evidence.
- A freshly installed 29-file npm tarball passed on Node 22.12.0: version/help, SQL tool schemas, background
  start/status/query/logs/stop, Storage read/write permissions and dashboard HTTP. Its bundled MCP stdio command
  discovered both tools and refused SQL without a profiling session. State and ports were isolated, with an
  unusable adb path. The package SHA-256 is
  `73afa0ed70f764e728fb690d27a1a120aacdd7eccfbaa542369cda9abcfbcdf9`.
- Existing Vite chunk-size advice remains. Android and browser layout checks were not repeated because their
  implementation and contracts did not change; earlier candidate evidence retains its original scope.

## Failures investigated

The first transport test assumed CLI success output used the HTTP envelope. The CLI returns the direct result;
the assertion was corrected. Typecheck also required narrowing MCP structured content before accessing its
target; that test was corrected before the passing checks.

The first complete test run had 2,439 passes and one failed assertion in the pre-existing v3 gateway fixture:
the server had processed its view tree, but the TCP client's first raw line was still undefined. That fixture
passed in isolation both on the preceding release candidate and the feature tree. Pausing client reception
for 200 ms reproduced the same assertion failure; awaiting the client's config message made the delayed case
pass. Commit `78c6d30` adds that receipt wait separately. Temporary pause/timer instrumentation was removed,
then all eight gateway fixture tests passed. This changes test synchronization, not the gateway implementation.

The final complete-suite result is recorded in the [candidate verification](release-0.13.0.md).

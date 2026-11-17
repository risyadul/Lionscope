# Release 0.13.0 candidate verification

Candidate prepared and locally verified on 17 November 2026; no tag or package has been published.

The local integration is based on PR #34 (`88a2792`), #36 (`a3affcd`) and #37 (`a562379`), combined in
`b92f99a`. The version-preparation commit follows that integration. Research and unfinished mirror transport
changes in the primary workspace are excluded. Package version is 0.13.0; dashboard/device protocols remain 14.

## Release metadata

All five npm workspace versions, internal dependencies/lockfile entries, Android SDK/no-op version, MCP metadata,
Claude Code plugin pins, packaged skill and current install snippets agree on **0.13.0**. Historical 0.12.0+
compatibility references and golden fixtures remain unchanged. External lockfile dependencies did not change.
`npm run release:check` enforces this consistency in CI. A negative probe with stale MCP metadata exited 1 as
expected; the original file was restored and the positive check passed.

Android implementation sources match the reviewed Network branch. The protocol adds optional dashboard
permission state; SDK consent reuses the existing version-gated config field. No raw screen transport or
research files are in the candidate. The primary workspace, its unfinished edits and active Consumer session
were left in place; initial release builds ran in `/tmp/lionscope-release-0.13.0`, and the SQL agent-tools
follow-up was built in `/tmp/lionscope-storage-sql-agent-tools` before integration into the candidate.

## Checks and artifacts

The initial preparation checks below precede the follow-ups. The latest runtime candidate passed **2,459
TypeScript tests / 148 files**, **48 browser cases**, and **16 focused SDK JVM tests**, as detailed under
[Runtime permissions](#runtime-permissions-follow-up). Earlier full Android results retain their original
scope. The artifact table identifies the latest tested npm tarball.

- `npm ci --offline --ignore-scripts`, `npm run release:check`, `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run docs:check`, `npm run build:cli` and `git diff --check`: passed.
- `npm test -- --maxWorkers=2`: **2,419 tests / 143 files passed**. The focused packaged-skill check also passed
  all five cases after its documentation correction.
- `npm run test:ui`: **42 cases passed** across six Chromium mouse/touch and light/dark configurations. The
  320 px dark Network screenshot was inspected. These are synthetic component checks, not device evidence.
- `./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug :ui-helper:test :ui-helper:helperJar :lionscope:lint :lionscope-noop:lint --max-workers=2`:
  passed in 7m34s with JDK 17. SDK debug, release and OkHttp 5 each passed **645 tests**; UI-helper passed **9**.
  No-op and sample assembly passed. Debug SDK lint had **0 errors, 94 warnings, 12 informational findings**;
  no-op lint had no findings.
- `./gradlew :lionscope:lintRelease :lionscope-noop:lintRelease --max-workers=2`: passed. SDK release lint had
  **0 errors, 68 warnings, 8 informational findings**; no-op had none. Findings include dependency/version advice,
  API usage and CheckResult warnings; a passing task does not mean a warning-free report.
- Rebuilt UI-helper SHA-256 matched the vendored jar:
  `6912534db3c6edcdb9eb1c5fafe98e3d717bbbf59d3d49495d77bb56ad8471b2`.
- `npm pack --workspace lionscope --ignore-scripts --pack-destination /tmp/lionscope-release-artifacts --json`:
  produced a **29-file** tarball with the built CLI, dashboard, LICENSE and NOTICE; no research/fixture files.
  A temporary consumer installed that exact tarball offline. On **Node 22.12.0**, version/help, background
  start/status/query/logs/stop and foreground HTTP serving all passed, using isolated state/ports and nonexistent
  adb. The API reported server version 0.13.0. The official Node archive's SHA-256 was checked before use.
- JitPack-mode publication used `JITPACK=true VERSION=0.13.0` and
  `./gradlew :lionscope:publishToMavenLocal :lionscope-noop:publishToMavenLocal -Dmaven.repo.local=/tmp/lionscope-release-artifacts/maven-repo --max-workers=2`:
  passed. Both POMs have the expected group/artifact/version; both AARs embed `Lionscope.VERSION = "0.13.0"`.
  The SDK POM has only `androidx.startup:startup-runtime`; no-op has no dependencies. Room, Compose, RxJava and
  OkHttp did not become mandatory published dependencies.
- `mcp-publisher validate`: passed schema and semantic validation of `server.json` without publication.

Artifacts are local under `/tmp/lionscope-release-artifacts/`:

| Artifact                  | SHA-256                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| lionscope-0.13.0.tgz      | ad966ccad7435f7c2eed619c6cc349a4c161da9a321821f5fcc4f143ddcc6b4c |
| lionscope-0.13.0.aar      | 70e5addb8b681a7b60dc0714e8916810d69507c21bb597c58e00239c678a0546 |
| lionscope-noop-0.13.0.aar | b158a84d3789c55b2a462c6077b9b0d1ac55f7a5a877e81eab8503661cf27b5e |

The existing Vite large-chunk advisory remains. Android lint emits warnings, recorded above. This run does not
prove remote JitPack resolution, Windows/Linux installed-package behavior, physical-device behavior or a new
runtime deployment of this candidate into Consumer. Earlier API 28/Room 2.7.2 Storage and API 36 Consumer Network
evidence remains scoped as described in the [release notes](../releases/0.13.0.md).

## Documentation audit follow-up

A follow-up audit completed the root/npm README feature summaries and flags, Room registration/no-op guidance,
the Storage agent-tool inventory and packaged-skill playbook, Query console discoverability, and protocol/line-cap
architecture notes. General CPU-overhead claims now point to the measured baseline and its limits. Android
requirements describe API 23 profiling with API 24 feature boundaries; the obsolete API 23 PID/logcat limitation
was replaced after checking `appPids`, the legacy log stream and UI-helper guards.

The follow-up changed documentation plus the skill contract assertions, not runtime code. Its checks passed:
23 tests across `agentSkill`, `appPids` and `logcatStreamLegacy`; typecheck, lint, formatting, documentation links,
release metadata and MCP schema validation. The full suites above belong to the preceding preparation run and
were not repeated for this documentation change.

Because the npm README ships in the package, the CLI was rebuilt/repacked and the tarball checksum in the table
updated. A fresh offline consumer installed it on Node 22.12.0 and verified the new README, help/version, Storage
read/write startup permissions, background lifecycle/query/logs and foreground HTTP. No real app/session was
used in that smoke. The AARs and their checksums are unchanged.

## SQL agent-tools follow-up

The candidate now exposes `query_storage_sql` and `execute_storage_sql` through MCP HTTP, MCP stdio and CLI.
Both share the existing validated Room execution path. The final complete rerun of
`npm test -- --maxWorkers=2` passed **2,440 tests / 145 files**, including 21 new SQL tool/transport cases.
Typecheck, lint, formatting, documentation links, release metadata, CLI build and diff whitespace checks passed.
The rebuilt 29-file npm tarball passed installed-package smoke checks on Node 22.12.0, including MCP SQL
discovery. The tarball checksum above is for this follow-up; AARs are unchanged.

The first complete run had one pre-existing gateway fixture assertion failure and 2,439 passes. Delaying client
reception reproduced a missing handshake receipt wait; the separate `78c6d30` test fix awaits config before
inspecting raw lines. The delayed reproduction then passed, temporary instrumentation was removed, all eight
fixture cases passed, and the final complete rerun passed. The initial failure is not counted as a clean run.
See [SQL verification](storage-sql-agent-tools-2026-11-17.md) for transport evidence and limitations. Android and
layout checks above were not repeated for unchanged SDK/dashboard code; this adds no device runtime claim.

## Failures found during preparation

1. The new metadata checker initially failed ESLint for missing `URL` import and a two-space regex. Importing
   `URL` from `node:url` and using an explicit repetition fixed both; subsequent lint passed.
2. The documentation checker rejected three GitHub PR URLs because it only validates supported repository-file
   URLs. Release notes now use PR numbers rather than unsupported links; subsequent docs checks passed.
3. The packaged-skill contract test associated a bare `--foreground` span with the previous query example.
   Writing the complete pinned foreground command made the instruction explicit and the test passed. The full
   initial run had one failed assertion and 2,418 passes; the final run passed all 2,419.
4. Two npm-exec attempts to acquire Node 22 failed because the `node` package installer could not resolve its
   platform binary module. Downloading the official Node 22.12.0 Darwin arm64 archive and verifying its checksum
   provided the runtime used for the successful installed-tarball smoke. This was an environment/install failure,
   not a failed Lionscope runtime test.

## Runtime permissions follow-up

The runtime-permissions follow-up adds enabled defaults, live dashboard/CLI changes and private per-port
persistence. Its complete TypeScript run passed **2,459 tests / 148 files**, all static checks and the CLI build
passed, and the complete browser run passed **48 cases**. The six Permissions browser cases passed again after
focus restoration refinement. Android StorageRequests passed **16 JVM tests**; there is no new device runtime
claim. The rebuilt 29-file npm tarball passed isolated installed-package checks on Node 22.12.0, including
same-PID changes, persistence/restart, MCP stdio and dashboard WebSocket updates. Its current hash is in the
table above; AARs are unchanged. See [permission verification](runtime-permissions-2026-11-17.md) for exact checks,
failures investigated and limitations. Builds ran in `/tmp/lionscope-runtime-permissions`.

## Merge handoff and manual publication

The release-scope follow-up moved permissions into the versioned **0.13.0** changelog and release notes.
Its formatting, documentation links, release metadata and artifact-integrity checks passed. The tested npm
tarball and AARs remain byte-identical; their checksums are in the artifact table.

During the merge handoff, PR #34 (Storage) merged as `92a59bc` and PR #36 (background CLI) merged as `78b5e3f`,
after their required GitHub checks passed. Network PR #37 was updated against `main`; its only conflict was
CHANGELOG.md. The resolved combined feature tree exactly matches the previously verified `b92f99a` tree.
Its new head `aabe3fe` runs CI again. The release follow-up is stacked on that head as a Draft while CI runs;
it must merge after #37, with its own required checks green. The final source branch carries the six prepared
follow-up commits, rebased without importing the old local integration merge.

Fresh local verification during this handoff passed:

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, `npm run release:check`;
- `npm test -- --maxWorkers=2`: **2,459 tests / 148 files**;
- `./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug :ui-helper:test :ui-helper:helperJar --max-workers=2`:
  passed in 6m53s with JDK 17. SDK debug, release and OkHttp 5 each passed **646 tests**, UI-helper passed **9**,
  and sample/no-op assembly passed. The helper SHA-256 still matches the vendored jar.

The rebase preserved the entire verified candidate tree before this documentation update. The earlier
**48 browser cases**, focused permission rerun and Node 22.12 installed-package evidence therefore apply to
unchanged runtime sources. Full Android verification ran in `/tmp/lionscope-runtime-permissions`; final
TypeScript verification ran in `/tmp/lionscope-release-final`. No active app session was replaced, and these
checks add no new device/API runtime claim.

The maintainer requested **merge only** and will publish npm and MCP metadata themselves. Before publishing:

1. Confirm #34, #36, #37 and the release follow-up have merged into `main` with required CI green. Use the final
   reviewed main commit, not the earlier local integration branch.
2. Check the final tree and artifact checksums. The prepared tarball was smoke-tested on Node 22.12.0 and must
   be published unchanged. Rebuild/retest if runtime or packaged files change; npm versions are immutable.
3. Set the actual release date; recheck that npm version and tag `0.13.0` are unused. At the authentication
   check during this handoff, `npm whoami` returned **E401 Unauthorized** and npm latest was **0.12.0**.
   The maintainer will handle npm login; no credentials were changed by this task.
4. Create the annotated `0.13.0` tag, publish the tested npm tarball, verify both JitPack coordinates, create
   the GitHub release and publish `server.json` through MCP Publisher. These publication steps were not run
   during the merge-only handoff. Follow the [release procedure](../releasing.md).

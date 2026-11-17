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

Protocol and Android implementation sources match the reviewed Network branch. No raw screen transport or
research files are in the candidate. The primary workspace, its unfinished edits and active Consumer session
were left in place; all release builds ran in `/tmp/lionscope-release-0.13.0`.

## Checks and artifacts

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
| lionscope-0.13.0.tgz      | 16cf67f8bb56c478b460ac12db0c1dc45e4b7cd22705d35fd2a8d355061f3e02 |
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

## Publication prerequisites still open

- PR #34 is open with passing CI. PR #36 and #37 are drafts based on its branch. Merge #34, retarget/rebase
  the two feature PRs onto `main`, and require their CI before merging them. Do not merge them into the Storage
  branch just to collect the release.
- Reapply the separate version-preparation and documentation follow-up commits to the final reviewed `main`
  tree and rerun affected checks. The local `prepare-0.13.0.patch` mailbox contains both preparation commits.
  The current local integration branch is not an approved release target by itself.
- npm's public registry still listed **0.12.0** as latest and did not list 0.13.0; the remote 0.13.0 tag was absent.
  `npm whoami` returned **E401 Unauthorized**. Refresh npm publishing authentication before requesting publication;
  the failure was not bypassed and no login credentials were changed.
- Approve the final release commit/date and publication. No annotated tag, GitHub release, npm publish,
  JitPack remote build or MCP registry update has been performed. Follow the [release procedure](../releasing.md).

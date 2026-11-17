# Working on Lionscope

Lionscope is a local Android profiler and Layout Inspector with a browser dashboard, an optional debug SDK,
and CLI/MCP tools. Read `README.md` for usage and `docs/architecture.md` for the data flow. This file applies to
the entire repository; follow any more specific `AGENTS.md` in a directory you change.

## Git preferences

- For future tasks, commit each completed scope/task separately after its relevant checks pass. Keep its
  implementation, regression tests, and documentation together; split independent scopes into separate commits.
- Use Conventional Commits 1.0.0: `<type>[optional scope][!]: <description>`.
- Use descriptive branch prefixes such as `feat/`, `fix/`, or `backport/` instead of `codex/`.

## Repository map

- `protocol/`: shared TypeScript wire types, Zod validators, pure analysis helpers, and golden NDJSON fixtures.
- `server/`: Node.js/TypeScript server, ADB collectors, SDK TCP gateway, sessions, device control, and agent tools.
- `dashboard/`: React + Vite UI, uPlot charts, client state, and feature panels.
- `cli/`: npm package `lionscope`; its build bundles the server and copies the production dashboard.
- `android-sdk/`: Gradle modules `lionscope`, `lionscope-noop`, `sample`, and `ui-helper`.
- `docs/`: feature documentation, security model, limitations, configuration, and development instructions.
- `server/vendor/`: vendored device helpers and their checksums. Consult its README before replacing artifacts.

## Setup and commands

Use Node.js >= 22.12 (CI uses Node 22), npm workspaces, and the committed `package-lock.json`. Use `npm ci`
for a clean install. Android work needs JDK 17, Android SDK platform 36, and the committed Gradle wrapper.
Keep local SDK paths in the ignored `android-sdk/local.properties`, not in tracked files.

Run these from the repository root:

```sh
npm run dev             # server + Vite dashboard at http://localhost:5173
npm run lionscope       # build dashboard and start the server at http://localhost:8701
npm run typecheck       # all workspaces
npm run lint
npm run format:check
npm run docs:check
npm test                # protocol, server, and dashboard tests
npm run test:ui          # dashboard browser layout contracts; browser install in docs/development.md
npm run build:cli       # production dashboard plus bundled npm CLI
```

For focused tests, use `npm test -- --project server test/storageService.test.ts`, adjusting the project and
test path as needed. `--maxWorkers=2` can reduce load during Vitest runs. `npm run build` builds only the
dashboard; it does not compile Android or bundle the CLI.

Run Android checks from `android-sdk/`:

```sh
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug :ui-helper:test
./gradlew :lionscope:testDebugUnitTest --tests '*StorageInspectorTest'
```

`:lionscope:test` includes debug, release, and an additional OkHttp 5 test run. Run Gradle invocations
sequentially to avoid competing builds. See `.github/workflows/ci.yml` for the full CI contract, including
the CLI smoke test and rebuilding/comparing the UI helper jar.

## Implementation conventions

- Before changing dashboard UI or reviewing layout, controls, themes or responsive behavior, read
  [DESIGN.md](DESIGN.md). Reuse its tokens/components and run the browser checks relevant to the affected contracts.

- Follow nearby code and existing abstractions. TypeScript uses ES modules, explicit `.ts` import extensions,
  and strict checking; avoid bypassing validation with unchecked casts or `any`.
- Use the repository ESLint and Prettier configuration. Format changed files rather than unrelated files.
- Keep Android library code compatible with its configured minimum SDK and Kotlin API/language level;
  do not infer compatibility from the sample app's dependencies alone.
- Optional app integrations use `compileOnly` and runtime availability checks. Do not make Room, Compose,
  RxJava, or OkHttp mandatory runtime dependencies of host apps unintentionally.
- Keep public SDK APIs and the release no-op artifact in sync. `NoopParityTest` checks their compatibility.
- Never edit generated build outputs. Do not bump versions or replace vendored binaries as a side effect of
  unrelated work. Feature and fix notes go under `[Unreleased]` in `CHANGELOG.md` when applicable.

## Protocol and trust boundaries

- For wire changes, update `protocol/src/wire.ts`, the relevant validators in `protocol/src/index.ts` or
  `protocol/src/storage.ts`, the Kotlin encoder/parser and constants, and the affected golden files under
  `protocol/fixtures/`. SDK-to-server and server-to-SDK fixtures have separate tests.
- Respect negotiated device protocol versions. New messages and fields must be gated so older SDK/server
  combinations continue working. Keep TypeScript and Kotlin limits and value semantics aligned.
- Server listeners stay on `127.0.0.1`. Preserve Host/Origin checks, SDK link proof, and capability flags;
  read `docs/security.md` before changing these paths.
- Treat device/app content as untrusted data. Preserve each feature's redaction policy, payload bounds, and the untrusted-data
  annotations in agent responses. Tests and screenshots must use synthetic app data, never private data.
- Keep SDK work off the app's main thread where required, and contain SDK failures so profiling does not
  crash the host app. Check CPU, memory, and queue bounds for processing potentially large app values.

## Storage Inspector invariants

Read `docs/features/storage.md` before changing storage behavior.

- Permissions start enabled and can be disabled live from the dashboard or CLI, with choices saved per server port.
  Storage reads require enabled read permission; writes also require enabled write permission, an active profiling
  session and its authenticated SDK link. Retain enforcement on both server and SDK; client flags cannot override
  disabled server settings. SDK consent still starts off until an authenticated link receives its config.
- Database access uses the registered app-owned Room instance and its transactions. Do not open a second
  SQLite connection. The protocol 13 Query console accepts one validated SELECT/WITH or INSERT/UPDATE/DELETE
  statement; keep its statement, target-table, transaction-control, consent and result-size checks on both sides.
  Row-editor SQL identifiers must still come from checked schema names.
- Preserve row-editor compare-and-set semantics, exact numeric types/bits, row digests, and link-bound write targets.
  Explicit SQL mutations do not use compare-and-set and never offer row-editor undo. Never retain SQL text in audit metadata.
  Prefs compare-and-set is not atomic against app writes; do not describe it as an atomic transaction.
- On device protocol 12 links, return original Storage values, including credentials, and allow primary-key
  edits. Older negotiated links retain their legacy redaction and primary-key restrictions. Preserve technical
  restrictions on views, virtual/internal tables, deferred foreign keys, and truncated values. Review paging and
  total reply size together.
- Never automatically retry a write after timeout or disconnect: it may already have committed. Distinguish
  provisional, final, and late outcomes. Offer undo only for confirmed eligible writes on the same app link.
- Bind dashboard drafts and outcomes to their original row, field, and link. Refresh or navigation must not
  retarget an edit; confirmed disappearance must clear the associated draft.

## Verification and handoff

Add or update focused regression tests for behavior changes, then run the relevant checks above. For changes
spanning protocol, server, and dashboard, run the complete TypeScript checks and CLI build. Include Android
checks when SDK code or its contract changes. A documentation-only change needs formatting and applicable
documentation checks, not an unrelated full build.

For dashboard layout changes, run the relevant `npm run test:ui` cases and inspect their screenshot artifacts.
Update fixtures and assertions alongside deliberate changes to [DESIGN.md](DESIGN.md).

Report the exact checks run and their outcomes. Distinguish a failed assertion from a timeout, an interrupted
run, or an environment failure. A passing rerun does not erase an earlier failure: investigate or report it.
Unit tests and APK compilation do not prove behavior on a real device. Storage runtime evidence currently
documented in this tree covers API 28 with Room 2.7.2; verify other API/Room versions before claiming support
was tested there.

Keep changes scoped and preserve unrelated local edits. When reviewing, give actionable findings with file
locations, triggers, and impact; separate reproduced bugs from hypotheses. Use Conventional Commit prefixes
following the Git preferences above and `CONTRIBUTING.md`.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `risyadul/Lionscope`.
Before reading or publishing tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels.
Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`.
Before exploring domain concepts or decisions, read `docs/agents/domain.md`.

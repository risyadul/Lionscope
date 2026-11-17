# Runtime permissions verification

Verified locally on 17 November 2026 in `/tmp/lionscope-runtime-permissions`, based on the 0.13.0 candidate.
All app/device data in these checks was synthetic. The user's active Consumer session was not replaced.

## Result and checks

A fresh installation enables all four permissions. Dashboard Permissions, `lionscope permissions` and explicit
startup flags can change them without restarting the server. Choices are saved privately by server port.
Disabling Storage read disables writes; enabling writes enables reads. Server restrictions remain authoritative
over MCP/CLI client flags and legacy allow headers. Existing work may finish; no write is replayed or undone.

- `npm test -- --maxWorkers=2`: **2,459 tests / 148 files passed**, including 19 new protocol, server and
  dashboard cases. Coverage includes serialized updates, save failure, private persistence, invalid settings,
  request boundaries, device/Storage revocation, read/write dependencies, MCP HTTP/stdio changes and client/server
  permission separation. Background CLI tests verify the same PID and saved choices after restart.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, `npm run release:check`,
  `npm run build:cli` and `git diff --check`: passed.
- `npm run test:ui`: **48 passed** across six Chromium mouse/touch and light/dark configurations. Permissions
  runs inside the full app header at 320, 430, 768 and 1440 px; switches, dependent disablement, errors, viewport
  bounds and keyboard focus are checked. Desktop light and 320 px dark screenshots were inspected. After
  refining focus restoration, the six Permissions cases passed again.
- With JDK 17 and Android SDK configured,
  `./gradlew :lionscope:testDebugUnitTest --tests '*StorageRequestsTest' --max-workers=2` passed:
  **16 tests**, no failures/errors. The new case revokes queued reads/writes and re-enables reads on the same
  connection. TypeScript SDK-session tests cover current and future links receiving changed consent without
  replacing the session/link. This is JVM/fake-link evidence, not a new Android device runtime test.
- A freshly installed **29-file npm tarball** passed on **Node 22.12.0**: fresh defaults, help/version,
  same-PID CLI permission changes, dependency normalization, private saved files, persistence across restart,
  background lifecycle/status/logs, dashboard HTTP, MCP stdio discovery/revocation and dashboard WebSocket
  updates. A foreground server with an ephemeral port was changed through the CLI and saved under its actual
  bound port. The checks used isolated state/ports and an unusable adb path.

The tested tarball SHA-256 is
`ad966ccad7435f7c2eed619c6cc349a4c161da9a321821f5fcc4f143ddcc6b4c`.
The installed-package consumer path is recorded in `/tmp/lionscope-permissions-package-consumer-path.txt`.
Existing Vite chunk-size advice remains. Kotlin implementation/public APIs, SDK protocol and AARs are unchanged;
the pre-existing version-gated SDK config carries consent. Android full-suite and platform coverage retain the
limits recorded in the [candidate verification](release-0.13.0.md).

## Failures investigated

- The first complete run had 17 failed assertions across seven files against the previous opt-in behavior or
  exhaustive greeting/control-message expectations. Assertions were updated to verify the new defaults,
  authoritative restrictions and additive permission state. A later run had one remaining assertion expecting
  the old Network instruction flag; it now checks the permission wording. The final full run above passed.
- Initial typecheck found the new message missing from the dashboard's exhaustive test list. Initial lint
  rejected inline import types. Explicit type imports and the updated exhaustive list fixed both.
- The initial six browser cases used a fixture with no open connection, leaving the trigger disabled. The
  fixture now supplies the same connected state as a running dashboard; those cases passed.
- A stronger Escape regression deliberately exposed propagation to underlying document handlers. Handling
  only the dialog's bubble event was insufficient when saving had disabled the focused input. A capture-phase
  handler now consumes Escape before underlying panels, and focus returns after saving/closing. The complete
  48-case rerun and focused six-case rerun passed, including the propagation assertion.
- The first installed-package WebSocket smoke omitted the required Origin and received HTTP 403. Supplying
  the allowed dashboard Origin fixed the harness; the server's Origin checks were retained. The final installed
  smoke above passed. No package publication or user-session replacement was used to resolve failures.

# Background CLI, 17 November 2026

The user requested a globally available `lionscope` command that returns the terminal while its server stays
running, and selected a reusable CLI feature plus setup on this Mac.

## Result

- Bare `lionscope` and `lionscope start` launch a detached Node process, with stdin ignored, stdout/stderr in a
  private log and an IPC readiness handshake. The terminal returns only after the child publishes its ownership
  record and answers an authenticated status request.
- `stop`, `status`, `logs` and `logs --follow` select the same instance by dashboard port. Logs read at most
  256 KiB per update; startup rotates a log at least 5 MiB into one archive. Continuous runtime rotation and
  reboot/login autostart are outside this scope.
- `--foreground` retains the attached lifecycle. Development npm scripts explicitly use it. MCP and query
  dispatch retain their existing behavior; MCP still owns and cleans up an in-process server where applicable.
- The OS listening-port bind determines the winning concurrent start. A losing launcher can reuse the winner's
  verified record. Repeated starts keep existing options; a request to add permissions requires stop/start.
- Stop authenticates to a private loopback HTTP control route with a random key stored in a mode-0600 ownership
  record. It never signals a PID from that record. Foreground/MCP servers expose no lifecycle control route.
  Host/port, method, content type, Origin and token checks preserve browser request protections.
- Graceful stop retains the existing session/device cleanup, including shutting down emulators this instance
  booted. An instance launched elsewhere is reported and left to its original owner.

## Checks

- Focused lifecycle, control, config and MCP/query checks: 67 tests across four files passed. They cover a live
  server after the launcher exits, idempotent/concurrent starts, permission propagation, stale ownership after
  an owned test process is killed, unrelated occupied ports, foreground behavior, SIGTERM cleanup, bounded log
  history/follow, inherited logging preferences, flag validation and authenticated/browser-shaped control requests.
- `npm test -- --maxWorkers=2`: 2,409 tests across 142 files passed.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check` and `git diff --check` passed.
- `npm run build:cli` passed, retaining the existing dashboard large-chunk advisory. The bundle contained no
  absolute local build paths. `npm pack --dry-run --ignore-scripts --workspace lionscope` passed.
- A production-bundle smoke test launched from an unrelated temporary working directory and verified readiness,
  served dashboard HTML, status, logs and graceful stop. An additional smoke test used the actual globally
  linked `lionscope` command from an unrelated directory and passed the same checks.

Early typechecks found optional IPC disconnect handling and a test helper's string/number exit-code type;
both were corrected. Lint also identified two forward declarations for cleanup, which were corrected. The
completed focused/full test runs had no failed assertions or timeouts.

All owned test servers used isolated ports/state directories and an unusable ADB path. They were stopped and
their temporary files removed. No Android app, SDK wire contract or dashboard layout changed, so Android and
browser layout suites were not rerun. Runtime verification was on macOS; the Ubuntu CI smoke step is configured
but has not run here, and Windows runtime behavior remains unverified.

## Local installation

`npm link --workspace lionscope --ignore-scripts` installed this checkout's built command at
`~/.local/bin/lionscope`, already on PATH. `lionscope --version` returned 0.12.0, the unchanged repository label.
Future rebuilds update what this link runs; no npm registry release was published.

The pre-existing server on port 8701 was launched through an older npx installation (PID 25100). The linked
command correctly reports it as started elsewhere and does not restart it. Bare `lionscope` and `lionscope
status` were verified against it without changing its session or device state. The private state/log files
for a newly managed default instance will be under `~/.lionscope` when port 8701 is available.

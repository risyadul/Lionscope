# Changelog

All notable changes to Lionscope are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). The npm package, the server and the Android SDK share one version.

## [0.2.0] - 2026-10-21

### Added

- Main-thread stall detection: a watchdog posts a tick to the main thread every 50 ms and, when one is late by
  more than the threshold (100, 150, 250, 500 or 1000 ms; default 150 ms), samples the main thread's stack until
  it is free. Each stall reports its start, duration, screen, whether a debugger was attached and the most
  frequent sampled stack; a block is cut at 30 s. It runs only while a dashboard is connected at protocol v2 and
  an activity is started.
- Opt-in StrictMode reporting (API 28+, off by default): disk, network, slow-call and leaked-closable violations
  with their stacks. It extends and never replaces the app's policies, refuses policies with death, dialog,
  flash or dropbox penalties or an app listener, never re-arms death-on-network, coalesces to 1 per second per
  stack and 10 per second overall, and restores the app's policies when disabled or when the link closes.
- Dashboard: a Main thread lane under Frame time, a Stalls tab (offenders by culprit line, event list, stack
  detail with framework frames collapsed, copy), a Stalls column in the Screens table, and controls for the
  threshold and StrictMode. The culprit is the first app frame, past generated ViewBinding/DataBinding classes;
  without one, the first third-party library frame, so an SDK waiting on its own lock is named instead of
  `Unsafe.park`.
- Device protocol v2: `stall` and `strictmode` messages from the SDK and a `config` message from the server. It
  is negotiated, so a 0.1.1 server or SDK keeps working with a 0.2.0 one at protocol v1.

### Changed

- The server sanitizes or drops invalid stall and StrictMode messages instead of closing the link.
- The SDK removes control and format characters from every text field it sends.
- Generic package roots (`io.github`, `com.google`, ...) use three segments when deciding which frames and
  screens belong to the app.

## [0.1.1] - 2026-10-21

### Added

- `npx lionscope`: the new [`lionscope`](https://www.npmjs.com/package/lionscope) npm package runs the server and
  dashboard without cloning the repository. It is a single esbuild bundle (server, protocol, `ws`, `zod`) plus
  the built dashboard, with no runtime dependencies. `--port`, `--device-port` and `--adb` override the existing
  `LIONSCOPE_PORT`, `LIONSCOPE_DEVICE_PORT` and `LIONSCOPE_ADB` environment variables; `--help` and `--version`
  print the usage and the version. There is no option to listen on anything but `127.0.0.1`.
- Device protocol negotiation: the server accepts a `hello.protocolVersion` from `MIN_DEVICE_PROTOCOL_VERSION`
  (1) to `MAX_DEVICE_PROTOCOL_VERSION` (1000, a sanity cap) and answers `welcome` with the lower of the SDK's and
  its own version; out-of-range versions are logged as unsupported. The SDK stores the negotiated version.

### Changed

- The server skips and counts (with a throttled log line) SDK messages of a type it does not know instead of
  closing the connection. Known message types are still validated strictly. Together with negotiation, this
  lets an SDK and a server from different releases work together from 0.1.1 on; a 0.1.0 server still rejects
  any protocol version other than 1 and closes the connection on unknown types.
- Port values (flags and `LIONSCOPE_PORT` / `LIONSCOPE_DEVICE_PORT`) must be plain decimal numbers from 0 to
  65535; hex, exponents and padded values are rejected.
- `Lionscope.VERSION` in both SDK artifacts comes from the Gradle build version (the git tag on JitPack) instead
  of a hard-coded string.
- The server finds the dashboard in `LIONSCOPE_DASHBOARD_DIR`, then next to the running bundle (npm package,
  which never falls back to other directories), then in the repository's `dashboard/dist`.

### Fixed

- SDK: library fragments are no longer reported as the top screen. A map or other library child fragment (e.g.
  `SupportMapFragment`) inside an app fragment used to replace it in the screens lane; the SDK now reports the
  deepest app-owned fragment of the shown chain (same first two package segments as the top Activity), still
  descends through library containers such as `NavHostFragment`, and a library dialog falls back to the screen
  beneath.

## [0.1.0] - 2026-10-21

Initial open-source release.

### Added

- Server (Node.js, `127.0.0.1` only): ADB-only collectors for CPU and threads (`/proc/<pid>/stat`), memory
  (`dumpsys meminfo --local`), frames (`dumpsys gfxinfo framestats`), logcat for the app's PID and process
  start / restart / death markers, kept in 10-minute ring buffers and streamed over a WebSocket.
- Dashboard (React + uPlot): device and app picker, stacked charts on one shared time axis (1, 5 or 10 minutes,
  pausable), logcat side panel, SDK connection status with install instructions.
- Optional Android SDK on JitPack (`com.github.risyadul.Lionscope:lionscope`, debug builds only) and a no-op
  artifact for release builds: top-screen tracking (Activity, Fragment, DialogFragment, with optional screen
  aliases), per-frame `FrameMetrics` with a stage breakdown, a per-screen table, and a sample app.
- SDK gateway over `adb reverse` (NDJSON over TCP): hello timeout, rate limits, line and connection caps, and
  PID verification against the session's device before any data is accepted.

[0.2.0]: https://github.com/risyadul/Lionscope/compare/0.1.1...0.2.0
[0.1.1]: https://github.com/risyadul/Lionscope/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/risyadul/Lionscope/releases/tag/0.1.0

# Changelog

All notable changes to Lionscope are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). The npm package, the server and the Android SDK share one version.

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

[0.1.1]: https://github.com/risyadul/Lionscope/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/risyadul/Lionscope/releases/tag/0.1.0

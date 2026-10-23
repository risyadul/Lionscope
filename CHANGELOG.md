# Changelog

All notable changes to Lionscope are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). The npm package, the server and the Android SDK share one version.

## [Unreleased]

## [0.4.1] - 2026-10-23

### Added

- AI agents can use Lionscope (README: "Use with AI agents"): one tool layer in the server, served three ways.
  - **MCP over stdio**: `lionscope mcp` attaches to the Lionscope server running on `--port` or, when none
    answers, starts one in its own process (dashboard still at http://localhost:8701) that stops when the MCP
    client disconnects; if the server it uses stops, the next call starts one. Works with Claude Code, Cursor, VS Code, Codex, Gemini CLI, Devin Desktop (Windsurf) and Claude
    Desktop.
  - **Streamable HTTP MCP** at `http://localhost:8701/mcp` on the running server.
  - **`lionscope query <tool>`** for agents with only a shell: prints the tool's JSON result
    (`lionscope query stalls`, `lionscope query logcat --level E --limit 50`); `--list` prints every tool and
    its input schema.
- Read tools: `status`, `list_apps`, `get_summary`, `get_screens`, `get_stalls`, `get_strictmode`, `get_layouts`,
  `get_view_tree`, `search_logcat`. Session tools: `start_session`, `stop_session`, `set_sdk_options`. They
  compute the same numbers as the dashboard: the Screens, Stalls, Layouts and Logcat figures and the stat strip
  now come from one shared, dependency-free module (`@lionscope/protocol/insights`). Results that carry
  strings from the app (log lines, screen, layout and class names, stacks) are marked as untrusted data.
- Device-control tools, off unless Lionscope (or `lionscope mcp`) runs with `--allow-device-control`:
  `screenshot` (scaled to 720 px on the short edge), `tap`, `swipe`, `type_text`, `press_key` (navigation and
  editing keys only; no power, sleep or lock), `launch_app`, `boot_emulator`, `shutdown_emulator`. They use adb
  (`screencap`, `input`, `am start`) and the dashboard's emulator manager; at most two run at once per device.
- Element-based device control (same opt-in): `get_ui_tree` lists the screen's elements from `uiautomator dump`
  (text, content description, resource id, hint, bounds in device and screenshot pixels, flags; password text is
  never returned), `tap_element` taps the exact center of an element found by text, id or description (an
  ambiguous selector returns the candidates instead of tapping), `wait_for` waits for an element to appear or
  go away, `scroll_to` scrolls until an element is visible, and `type_text` can tap a field before typing. The
  dump is parsed by a strict, size-capped parser that never resolves entities.

### Security

- `/mcp` and `/api/agent/*` answer only a Host naming the server on loopback at its own port. `/mcp` refuses any
  `Origin` other than the dashboard's and the JSON tool API any `Origin` at all; the JSON tool API also requires
  `Content-Type: application/json` and an `X-Lionscope-Agent: 1` header, so a web page cannot call it without a
  CORS preflight, which is never approved. Text typed with `type_text` never reaches an error or a log line
  (adb errors no longer repeat the command line).
  Device control over HTTP MCP follows the server's flag only; the opt-in of `lionscope mcp` applies to its own
  client. It is an autonomy guard for AI agents, not a security boundary: local processes are trusted (as with
  adb), browsers are not.

### Changed

- The Android SDK is unchanged from 0.4.0 (only its version); 0.4.x SDKs and servers work together.

## [0.4.0] - 2026-10-22

### Added

- Layout inflation timing (SDK, Android 10+, `AppCompatActivity` screens only; plain `Activity` and
  `ComponentActivity` screens are not timed). The SDK installs a `LayoutInflater.Factory2` on each Activity
  before it is created (only when the Activity has none) and times view creation per XML layout, handing views
  on to AppCompat, so `MaterialButton` and the other substitutions are unchanged. Layouts inflated inside another
  one (`nested`) are also reported on their own, but per-screen totals count each inflation once; layouts are attributed to the Activity, Fragment or dialog whose
  view was being built. No Gradle plugin and no app changes. On by default; turn it off from the dashboard, or
  for the whole app with the `io.github.risyadul.lionscope.inflateTracking` meta-data set to `false` in the
  debug manifest (for apps that set their own `LayoutInflater` factory; see the README).
- View trees (SDK, all Android versions): once per screen visit, after its first frame and on main-thread idle,
  the SDK counts the window's views and finds its depth, the deepest path and the most common view classes.
- **Layouts** tab: the XML layouts the app inflates on the main thread, with count, total, mean and slowest
  time, views of the slowest inflation and the screens it ran on. Nested layouts (`<include>`s) get their own
  row, marked "nested": their time is already part of the layout around them. Sortable; library and framework layouts are hidden until
  "Show library layouts" is on. The tab explains when the device is older than Android 10, the SDK or server
  is too old, or tracking is off.
- Screens tab: **Inflate** (inflation time per screen, slowest layout in the tooltip) and **Views** (view count
  and depth from the latest view tree, deepest path in the tooltip) columns; in a narrow panel Views folds into
  the line under the screen name. Inflate counts each inflation once (nested ones are left out).
- Main thread lane: gold bars on the rail under the baseline for layout inflations of 16 ms or more, with a
  tooltip (layout, time, views, screen); a click opens the Layouts tab.
- "Inflation tracking" switch next to StrictMode in the Stalls tab.
- Sample app: a heavier Home screen (nested cards with includes and a `<merge>`) and an off-main-thread inflate
  button.

- Logcat: copy lines. Click a line to select it (shift-click for a range, Cmd/Ctrl-click to add or remove,
  Cmd/Ctrl+A for all) and press Cmd/Ctrl+C, or use the copy button on a line; lines are copied as
  `HH:MM:SS.mmm L Tag: message`.

### Changed

- Logcat drawer: one toolbar row instead of three (grip, pid, "matched of buffered" line count, level chips,
  search, Clear, collapse), so many more lines fit. The whole bar is the resize handle: drag anywhere but its
  controls, double-click it to toggle the maximum height; the grip keeps the keyboard splitter. Warning and
  error lines get a left rule and a light wash instead of a full tint.
- Device protocol 3 (`inflate`, `viewtree`, `config.inflateTracking`) and dashboard protocol 3. 0.2.x and 0.3.x
  SDKs keep working with this server (they negotiate 2 and send nothing new), and a 0.4.0 SDK works with older
  servers.

### Fixed

- The logcat drawer's size limits: the column was never measured, so the default and maximum heights were
  fixed numbers, and a maximised drawer could slide under the timeline toolbar.

## [0.3.1] - 2026-10-22

### Added

- Physical devices in the Device column: pick a phone connected over USB and see and operate its screen like
  an emulator's (touch, multi-touch, wheel, keys, Share clipboard, navigation, rotation, screenshot, frame size).
  Lionscope pushes the bundled scrcpy-server v5.0.1 (Apache-2.0, SHA-256 checked) over adb while the column is
  open; the phone's hardware encoder streams H.264 that the browser decodes with WebCodecs. Nothing is installed.
- **Shut down emulator** in the Device column and next to the picker, for any running emulator: one Lionscope
  didn't boot (e.g. from Android Studio), or one with a profiling session on it, is shut down after a
  confirmation; a running session is stopped first. The Android power key's tooltip now says it only turns the
  screen on/off.
- Clear messages when a phone refuses injected input (Xiaomi / HyperOS: "USB debugging (Security settings)"),
  when the mirroring server can't start, and when the browser can't decode H.264.

### Fixed

- The top bar no longer switches between one and two rows as the session status changes (PID, elapsed time,
  frames from SDK), which made the device screen shrink and grow. From 1280 px up it is one fixed-height row;
  when space is short, secondary status details collapse and stay available in the tooltips.

## [0.3.0] - 2026-10-22

### Added

- Emulators in the dashboard. The device picker lists every AVD, also the ones that are off, and boots them
  headless on the host GPU (`-no-window -gpu host`) as a Quick boot (snapshot) or a Cold boot
  (`-no-snapshot-load`). Emulators Lionscope booted can be shut down from the dashboard and are shut down when
  the server stops; emulators you started yourself are never shut down.
- Device column: the emulator's screen, live, operated from the browser: touch and drag, multi-touch (Alt+drag
  pinch), wheel scrolling, keyboard and pasted text, Back / Home / Recents / Power, rotation, a full-resolution
  screenshot, and a frame size of 360, 540 or 720 px. It uses the emulator's own gRPC endpoint, so nothing runs
  inside Android and the app's measurements are unaffected; it works with or without a profiling session.
- Share clipboard (on by default, can be turned off): desktop text goes onto Android's clipboard when you click
  or focus the emulator's screen (so Android's own Paste has it), text copied in Android lands on the desktop
  clipboard, and Cmd/Ctrl+V on the screen pastes into the focused field; any Unicode text up to 32 KB.
- A warning when the selected emulator renders in software (SwiftShader): frame times are then not
  representative.

### Changed

- Layout: Device column on the left, logcat in a resizable, collapsible drawer below the timeline, Screens and
  Stalls tabs on the right; below 1280 px the device screen opens as a drawer. The Screens table folds the dominant
  stage under the screen name in a narrow panel, so names stay readable.
- Dashboard protocol version 2 (the dashboard and the server ship together).
- The CLI bundle includes a gRPC client (`@grpc/grpc-js`, `@grpc/proto-loader`); the npm package still has no
  runtime dependencies.

### Fixed

- Starting a second Lionscope server on the same machine no longer removes the first one's `adb reverse` mapping
  (which cut its SDK link mid-session).

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

[Unreleased]: https://github.com/risyadul/Lionscope/compare/0.4.1...HEAD
[0.4.1]: https://github.com/risyadul/Lionscope/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/risyadul/Lionscope/compare/0.3.1...0.4.0
[0.3.1]: https://github.com/risyadul/Lionscope/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/risyadul/Lionscope/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/risyadul/Lionscope/compare/0.1.1...0.2.0
[0.1.1]: https://github.com/risyadul/Lionscope/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/risyadul/Lionscope/releases/tag/0.1.0

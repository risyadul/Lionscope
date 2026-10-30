# Changelog

All notable changes to Lionscope are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). The npm package, the server and the Android SDK share one version.

## [Unreleased]

### Added

- Agent tool `get_crashes`: the app's crashes since the session started, read from logcat's `crash` buffer (the
  package's process and its `<package>:*` processes, not just the PID being followed), so a crash is kept even when
  the app's own logcat turns over within a minute, when the process died before Lionscope saw its PID (a
  start-and-crash loop), and for the app's other processes (`:remote`). Uncaught Java/Kotlin exceptions
  (`FATAL EXCEPTION`) and native crashes (crash_dump's report: signal, cause, abort message, backtrace), the last 50
  per session, with time, pid, thread, process, exception and message, and the stack (every `Caused by`, the first
  12 frames of each exception). Stored redacted; other apps' crash lines are passed over and never stored.
- `search_logcat` returns `retained` (`entries`, `capacity`, `oldest`, `newest`): how far back the log buffer
  reaches, so an empty result can be told apart from lines already dropped.

### Fixed

- `search_logcat` said it searched up to 10 minutes of logcat; the buffer holds the newest 5000 lines (at most 8 MB)
  of those 10 minutes, which an app logging its HTTP traffic fills in well under a minute. The description now says
  so.

### Security

- `search_logcat` redacts credentials in log messages before it matches and cuts them: `Authorization`, `Cookie` and
  hyphenated sensitive header lines as HTTP logging prints them (also OkHttp's `{Authorization=[Bearer …]}`),
  `Bearer` values, `Basic` / `Token` values that look like credentials, JWTs with or without `Bearer`, JSON values,
  XML elements and `name=value` pairs of sensitive names (also in bodies logged one line or one 4000-character chunk
  at a time, and PKCE's `code_verifier`), OAuth `code` values (not status codes like `code=500`), values after
  `…password:` or `…secret:`, credential-shaped values after `…token:` or `…api-key:` and after a sensitive name at
  the start of a line (`token: abc123`), and sensitive URL parameters. A query for a credential no longer finds it,
  and the 500-character cut can no longer split a token. Always on; the dashboard's Logcat panel still shows lines as
  logged.

## [0.10.0] - 2026-10-27

### Added

- **Location** in the Device column (the pin in its toolbar), like the Android Studio emulator's Location controls:
  pick a point on an OpenStreetMap map, type coordinates or paste a Google Maps / OpenStreetMap link, save places in
  the browser, Set location and Reset. Emulators get it as their GPS fix (gRPC `setGps`, or `adb emu geo fix`);
  physical devices with Android 12+ get it from test location providers for `gps`, `network` and `fused` (`cmd
location`, refreshed every second; apps see `Location.isMock()`). Phones get their real location back on Reset,
  when the server stops, and after a crash the next time a server sees them. The panel warns when the device's
  location switch is off.
- Agent tools `get_location` (always) and `set_location` / `clear_location` (device control).
- Dashboard protocol 9: `locations` (server → dashboard), `setLocation` and `clearLocation`.

### Changed

- The dashboard's CSP allows images from `https://tile.openstreetmap.org` (the Location panel's map, loaded only
  while it is open). Leaflet 1.9.4 is loaded with the panel, not with the dashboard.

## [0.9.0] - 2026-10-25

This release brings together the work planned as 0.5.2, 0.6.0, 0.7.0, 0.8.0 and 0.9.0, which were never published
separately. Where an entry below names one of those SDK versions, use SDK 0.9.0 (server, npm package and SDK share
one version). The device protocol versions they name (v5 to v9) are unchanged.

### Added

- An agent skill, `skills/lionscope/SKILL.md` (the Agent Skills format, so Claude Code, Codex, OpenCode, Hermes Agent
  and other harnesses that read `SKILL.md` can use it). It has playbooks for a janky screen, a blocked main thread,
  the element picked in the Inspector, the app's requests and mocked error states, and checking a fix, and it works
  through the MCP tools or `npx lionscope query`. A test checks that every tool, argument and value it names
  exists and is valid, and that its versions match the release.
- Claude Code plugins from this repository's marketplace: `lionscope` (the MCP server's read tools and sessions,
  plus the skill) and `lionscope-device-control` (also the device tools), pinned to the released npm version.
- MCP Registry metadata: `mcpName` `io.github.risyadul/lionscope` in the npm package and `server.json`.
- Network inspector (SDK 0.7.0). `Lionscope.okHttpInterceptor()` (in both artifacts; the no-op one passes requests
  on) records the app's OkHttp requests during a profiling session: method, URL, headers, status, timings (to the
  response headers and to the end of the body) and, for text types, up to 64 KB of each body (gzip the app asked
  for itself is unzipped; Brotli and other encodings are flagged). Retrofit and Ktor's OkHttp engine on Android work
  with one `addInterceptor` line; OkHttp 4.x and 5.x are supported (`compileOnly` in the SDK). The response body is
  never read by Lionscope (it copies what the app reads), an SDK error never fails or changes the app's call, and
  outside a session the interceptor is a plain `chain.proceed`. At most 20 requests per second are recorded.
- Redaction on the device and again on the server of credential-looking values in headers, URLs, forms, JSON and XML
  (see Security). Requests stay in the server's memory only (10 minutes, 5000 requests, 32 MB).
- Dashboard **Network** tab: the request list (filter by text, method and status class; mocked, failed and pending
  ones marked), a detail pane (overview, headers, bodies with JSON pretty-printing, timing) and a **Network** lane on
  the timeline (one bar per request, coloured by status; click to open it).
- Mocks: rules (a method or any, an exact, prefix or `*` glob URL pattern, and a response or a timeout / connection
  error, with an optional delay up to 30 s) set from the dashboard, or pre-filled with **Mock this response**. They
  answer matching requests in the app without a network call, belong to the running session, and show as
  **N mocks active** in the top bar of every view; mocked requests are marked and get one `Lionscope` logcat line.
- Agent tools: `get_network` and `get_network_request` (read; bodies only with the new `--allow-network-bodies` flag
  of the server, `lionscope mcp` and `lionscope query`, marked as untrusted data), `set_network_mock` and
  `clear_network_mocks` (with `--allow-device-control`). `status` reports the network capture and the mocks.
- The sample app's network demo (More → Open the network demo) and its local API, `android-sdk/sample/sample-api.mjs`.
- Device protocol v7 (v6 plus the network inspector): SDK → server `httpRequest`, `httpResponse` and `mocksApplied`,
  server → SDK `mocks` and `mock` (flat lines, golden file `protocol/fixtures/gateway-messages.ndjson`). HTTP lines
  may be up to 256 KB, server → SDK lines up to 512 KB. Dashboard protocol 6: `http`, `httpExchange` and
  `networkMocks`; `getHttpExchange`, `setNetworkMock` (up to 1 MB) and `clearNetworkMocks`.

- The Layout Inspector uses the SDK without a profiling session (SDK 0.5.2). While a dashboard shows the Inspector
  for a device, and for 5 minutes after the last Inspect of it (from the dashboard or an agent's `inspect_screen`),
  the server keeps an inspect-only link to the debuggable SDK apps on that device: Inspect gets the SDK tree
  (layout sources, owners, padding and margins) without pressing Start. On that link the SDK only reports the top
  screen and answers Inspect; frames, the watchdog, StrictMode and layout reports start with a session as before.
  Starting a session moves its app over to the session (it reconnects in about a second) and stopping one moves it
  back while you still inspect. New fallback reasons, shown under the badge: `sdk_linking` (the first Inspect
  waited up to 6 s for the app to connect), `sdk_needs_session` (an app with SDK 0.5.0 or 0.5.1, which still links
  only during a session) and `sdk_link_busy` (another running Lionscope server holds the device's link).
- Device protocol v5: `welcome.mode` (`session` or `inspect`; servers and SDKs before v5 behave as before), and
  the dashboard's `inspectorFocus` message (dashboard protocol 5).
- Jetpack Compose in the Layout Inspector. On a Compose screen the SDK now sends the composables themselves instead
  of one opaque `AndroidComposeView`: the composables called from your code (`ProductCard`, `Button`, `Text`; the
  androidx Compose, Material and Navigation internals they call are folded in), each with the **Kotlin file and
  line it is called from** (`CartScreen.kt:87`), its `testTag` as id, text, content description and flags from its
  semantics, and bounds. Lazy list items hang under their list, an `AndroidView`'s View under its composable, and a
  `ComposeView` inside an XML layout under its views; Compose dialogs and popups are their own windows. The SDK
  turns Compose's tooling data on when it starts (before anything is composed), as Android Studio's Layout
  Inspector does; an app can opt out with the `io.github.risyadul.lionscope.composeInspection` meta-data. Password
  fields (password semantics or a password content type) never send their text. Compose UI stays a compile-only
  dependency: apps without Compose are untouched. Works with Jetpack Compose 1.6+ and Compose Multiplatform 1.8+ on
  Android.
- Picking on the Inspector's screen looks through composables that draw nothing and have no text, content
  description, test tag or click (an idle toast or snackbar host over the whole screen); they stay in the tree, and
  clicking again on the same spot steps to the view below. The SDK says whether a composable's own layout nodes
  paint anything (`composable.draws`: a background, border, image, text or draw modifier; omitted when it cannot
  tell); without it the dashboard looks through such composables only when they have no children.
- `Lionscope.trackNavigation(navController)` (also in `lionscope-noop`): navigation-compose destinations become
  screens, named by their route pattern (`product/{id}`, never argument values; a type-safe route by its class),
  with `dialog()` destinations as dialogs. The Screens lane, per-screen jank, stalls and the Inspector's screen
  follow them, and a composable's owner shows the destination it is drawn for. The README shows how to call it
  from a Kotlin Multiplatform `androidMain`.
- Dashboard: composables are tinted in the Inspector tree; their attributes show the call site ("call site"
  instead of the XML "end of start tag" note), the testTag, the destination as owner, and leave out alpha, layout
  params and the box model. Search also matches source files and destinations. Destination is a screen kind in
  the Screens lane.
- Agent tools: `inspect_screen` and `get_inspector_selection` label composables by name and testTag, give their
  Kotlin call site (`kind: compose`) instead of an XML layout, their destination, and `query` matches source files
  and destinations.
- Sample app: a Compose card inside the XML More screen, and a navigation-compose shop (lazy catalog under an idle
  full-size toast host, a product with an `AndroidView`, a sign-in form with password fields, a dialog
  destination).
- Live view editing in the Layout Inspector (SDK 0.8.0). The attributes pane of a selected View edits it on the
  running app: visibility (segmented control), alpha (slider and number), enabled, padding and margins (the
  box-model figure takes a number per side), layout width and height (`match_parent` / `wrap_content` / px),
  translation, elevation, background color, and on TextViews text, text size (sp) and text color (hex input with a
  swatch). Enter commits, Esc cancels; the field shows that the edit is applying and why one failed. The server
  applies it through the SDK link that captured the snapshot, then takes a new snapshot that keeps the view
  selected. Edits are temporary: they last until reverted, until the app sets the property itself (a rebound
  RecyclerView row) or until the view is recreated. Each edited field has a Revert button, and the tab's header shows
  "N live edits (temporary)" with Revert all. Needs a profiling session (the app takes edits only from a link with
  the link proof); without one the values show read-only with a hint to press Start. Composables, uiautomator
  snapshots and older SDKs are read-only (the pane says why; a composable points at its call site), and the text
  of password fields is never read, shown or set. A background color replaces the view's background (and turns
  its tint off) until reverted; the revert restores the drawable and its tint, keeping the view's padding.
- A color picker on the background and text color fields: the swatch opens a saturation/brightness square with hue
  and alpha sliders, the colors the screen's views already use, the recent ones, and an eyedropper that takes a pixel
  of the frozen screen (in every browser: it reads the snapshot's screenshot). Like the alpha slider it sends the color
  it rests on (on release, or 250 ms after the last key), never every step.
- Agent tools (device control): `set_view_property` (one property, or `padding` / `margin` as one number or four;
  answers with the element as the next snapshot shows it) and `revert_view_properties` (a property, a node, or every
  live edit). `get_inspector_selection` lists a node's `editable` properties, the state they need and its live
  edits; `inspect_screen` marks editable nodes; snapshots report `liveEdits`.
- Sample app: the Detail screen has a solid-color price tag, a PIN field and a Pay button to try live edits on.
- Stall origins (SDK 0.9.0): every main-thread stall says where its work came from: an RxJava task (the operator,
  the chain's consumer and **the line that subscribed the chain**), a coroutine (dispatcher, resumed continuation
  and, in kotlinx.coroutines debug mode, its name), a posted Runnable or Handler message (`LiveData.postValue`,
  `lambda in HomeFragment`), an input event or click, a Choreographer frame (layout and draw, animators, Compose),
  an ActivityThread callback or an idle handler. The Stalls tab has a **By line / By origin** switch over its
  ranking (a row filters the events), the stall detail an Origin section (with the subscribe stack and, for a cut
  stack, the outermost frames), and the Main thread lane's tooltip the origin. Stalls from older SDKs get an origin
  from their stack when it reaches the Looper.
- RxJava tracking (on by default; a switch in the Stalls tab, `set_sdk_options { rxTracking }`): during a session
  the SDK chains an `RxJavaPlugins` schedule handler and subscribe hooks after the app's own, keeps the stack of
  each `observeOn` subscription unmaterialised (at most 100 per second) and reads the chain only for a stall.
  About 1-3 µs per `observeOn` subscription, nothing measurable per scheduled task. RxJava 2 stays compile-only;
  apps without it, inspect-only links and processes without a session are untouched.
- Agent tools: `get_stalls` adds `origins` (stalls grouped by origin, the subscribe stack with `includeStacks`) and
  each recent stall's `origin`.
- Sample app: Home has an RxJava chain and a coroutine (`refresh-cart`) that block the main thread for 300 ms; the
  sample turns kotlinx.coroutines debug mode on.

### Security

- Network capture and mocks need a link proof: the server hands the app a per-process key through the SDK's
  `LinkKeyReceiver` (guarded by `android.permission.DUMP`, with `adb shell am broadcast`), and the SDK records
  requests and accepts mock rules only after the welcome's HMAC over its hello nonce checks out (`hello.nonce`,
  `welcome.proof`, `SdkStatus.network`). An app listening on `127.0.0.1:8700` in the server's place gets no network
  data and can't inject mocks.
- Redaction covers JSON keys at any depth, XML elements and attributes, fragment parameters, URL userinfo, URLs in
  `Location` / `Content-Location` / `Referer` / `Link`, error messages, and more names (`key`, `code`, `sig`,
  `signature`, `credential`, `jwt`, `pwd`, `*_key`, `X-Amz-*`, `X-Firebase-AppCheck`, …).

### Changed

- Each device with an inspect-only link gets its own SDK gateway listener, so every link is tied to the device it
  came from; the `adb reverse tcp:8700` mapping for it is made only while someone inspects that device and is
  never taken from, or removed for, another running Lionscope server.
- Device protocol v6 (v5 plus Compose): Inspector nodes may carry `composable`, `composition` and `destination`,
  and `screen.kind` may be `destination`, on session and inspect-only links alike. An SDK sends none of it to an
  older server (a destination is then a `fragment`), and an older SDK keeps working. The dashboard protocol stays 5.
- Device protocol v8 (v7 plus live view edits): SDK View nodes carry `view` (a key that names the View object for as
  long as it lives, and its editable state) and `inspectBegin` carries `liveEdits`; the server sends
  `setViewProperty` / `revertViewProperties`, answered by `viewPropertyResult`. The SDK applies edits only on a link
  with the v7 link proof (a profiling session) and answers anything else `unauthenticated`; snapshots say why their
  views can't be edited (`editBlocked`). Server → SDK lines stay flat JSON with `type` first; their golden lines are
  in `protocol/fixtures/gateway-messages.ndjson`. Dashboard protocol 7: `setViewProperty`, `revertViewProperties`
  and their `viewEdit` answer. Nothing changes on a link below v8, byte for byte.
- Device protocol v9 (v8 plus stall origins): `stall` may carry `outerFrames` (the outermost 16 frames of a stack
  cut at 64), `rx` (`task`, `consumer`, `subscribedAt`) and `coroutine`; `config` carries `rxTracking`, appended
  last, on v9 links only. Nothing changes on a link below v9, byte for byte. Dashboard protocol 8:
  `SdkOptions.rxTracking`, `setSdkOptions.rxTracking` and the new optional `StallSample` fields.
- The Inspector keeps a selection on the same view by its key when the SDK sends one, so it survives an edit of its
  text, size or position.
- A Compose top window now falls back to uiautomator only when the SDK could not read its composition, and says
  why: `compose_disabled` (composed before the SDK started, or opted out: restart the app), `compose_no_source`
  (built without Compose source information), `compose_failed`; `compose` remains for SDKs before 0.6.0.

### Fixed

- The SDK gateway sent `welcome` before checking the app's PID, so a local probe claiming a package could tell
  whether that package was being profiled. It now answers nothing until the PID is verified on the device the
  connection came from, and every refusal looks the same.

## [0.5.1] - 2026-10-24

### Added

- Dashboard views: a **Profiler · Inspector · Device** switch at the right of the top bar. **Inspector** shows
  only the device and the Layout Inspector, with the tree and the attributes side by side; **Device** shows only
  the device screen, larger, beside how to let an AI agent operate it (the `--allow-device-control` command to
  copy). Neither renders the charts or logcat, so nothing hidden keeps redrawing; a running session keeps
  recording. The view is in the address (`?view=inspect`, `?view=device`) and remembered per browser, the
  device column stays open in both, and pressing Inspect in the Device view switches to the Inspector view.

### Changed

- The README, the npm description and keywords, and the SDK's POM description now present Lionscope as a
  lightweight Android profiler and Layout Inspector in your browser that AI agents can use (MCP and CLI).
- Between 1280 and 1599 px the one-row top bar sits a little tighter and the server link shows only its status
  dot (the state stays in its tooltip and to screen readers), so Start / Stop keeps its label beside the new
  view switch.

### Fixed

- The Inspector tree now opens the path to a selection that was already there when it appeared (after reloading
  the page, or when a new snapshot keeps the selected view), instead of leaving it inside a closed branch.

## [0.5.0] - 2026-10-23

### Added

- Layout Inspector in the dashboard. An **Inspect** toggle in the device toolbar freezes the screen to a snapshot
  with an overlay: hover highlights the view under the pointer with its `Class#id` label, click selects it (the
  top-most window first, so a dialog is inspectable together with the screen behind it), `Esc` or the toggle
  returns to the live screen. The snapshot refreshes on its own about 0.7 s after the top screen changes, and on
  demand, with capturing and error states. Works for emulators and physical devices.
- **Inspector** side tab: a collapsible, searchable hierarchy with arrow-key navigation that follows the selection
  and syncs hover with the overlay, and an attributes panel (class, id, text, bounds, visibility, alpha, layout
  width and height, padding and margin with a box-model figure, flags, the owning Fragment and Activity, and the
  layout source as `layout.xml:line` with an "end of start tag" note). Badges show whether the tree came from the
  `SDK` or from `uiautomator` (with the reason), the capture time and the node count. A selection made by an AI
  agent shows up in the tab and on the screen.
- Agent tools for the Inspector: `get_inspector_selection` (always on, read-only) returns the element the user
  selected in the dashboard with all its attributes, its XML layout and line (noted as the end of the start tag),
  owner, ancestor path, children, the snapshot's device, screen, age and source, and a crop of the screenshot
  around the element (at most 512 px; none for window roots or elements over half the screen);
  `select_inspector_node` (always on) highlights a node in the dashboard as the AI's pick, and for such a node
  `get_inspector_selection` returns its structure only (no text, content description or image);
  `inspect_screen` (device control) takes a snapshot and lists its visible nodes. The MCP instructions tell agents
  to call `get_inspector_selection` when the user means "this element". On-screen text, content descriptions,
  resource ids and crops are marked as app data.
- Server: Inspector snapshots come from the SDK (device protocol 4) when the session's app on that device is
  linked and on top, else from `uiautomator dump` (also for Compose screens), with a `screencap` taken at the same
  moment. The last 5 snapshots (64 MB at most) stay in memory and their screenshots are served at
  `/inspector/<id>.png` (loopback Host, same origin only, never cached). When the SDK can't answer, the
  uiautomator dump gets a screenshot of its own. Snapshots over 8 MB fall back to uiautomator (`sdk_too_large`).
  New dashboard protocol 4 messages `inspect`, `selectInspectorNode`, `inspection` and `inspectorSelection` (with
  who selected: `user` or `agent`); the selection follows the element into a refreshed snapshot (same class, id
  and text, or the same class within 24 px) and is cleared otherwise.
- Device protocol 4: the server sends `inspect` and the SDK answers with `inspectBegin` and `inspectNodes` chunks
  (at most 32 KB each) or `inspectError`. The server reassembles and checks the chunks (in any order), gives up
  5 s after the request or its last line (15 s in all), and lets a pending request's own lines past the per-link
  line budget, up to the announced node count and 8 MB per answer. A malformed or too large answer fails that
  request only; the link stays up and the snapshot falls back to uiautomator. A line whose type changes between
  the first key and the parsed message closes the link.

### Changed

- UI trees for the agent tools and the Inspector's fallback are read by a small helper
  (`lionscope-ui-helper-v1.jar`, built from `android-sdk/ui-helper`, checksum-verified) that Lionscope pushes to
  `/data/local/tmp` and runs with `app_process` while it is in use, instead of a new `uiautomator dump` each time. It
  waits at most 500 ms for the screen to settle, so screens that keep animating (carousels, shimmer) no longer time
  out, and a read takes a few hundred milliseconds instead of seconds. It stops 20 s after the last read and removes
  itself; while it is connected, apps see accessibility as enabled and other automation (Appium, UiAutomator tests)
  can't connect. Not used below Android 7, where `uiautomator dump` stays the only path; it is also the fallback.

### Fixed

- The device toolbar no longer overflows its column (which made the FPS readout overlap the controls): the FPS
  readout moved to the navigation row under the screen.

- README: the device-control tools launch apps with `am start -W`, not `monkey`.

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

[Unreleased]: https://github.com/risyadul/Lionscope/compare/0.10.0...HEAD
[0.10.0]: https://github.com/risyadul/Lionscope/compare/0.9.0...0.10.0
[0.9.0]: https://github.com/risyadul/Lionscope/compare/0.5.1...0.9.0
[0.5.1]: https://github.com/risyadul/Lionscope/compare/0.5.0...0.5.1
[0.5.0]: https://github.com/risyadul/Lionscope/compare/0.4.1...0.5.0
[0.4.1]: https://github.com/risyadul/Lionscope/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/risyadul/Lionscope/compare/0.3.1...0.4.0
[0.3.1]: https://github.com/risyadul/Lionscope/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/risyadul/Lionscope/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/risyadul/Lionscope/compare/0.1.1...0.2.0
[0.1.1]: https://github.com/risyadul/Lionscope/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/risyadul/Lionscope/releases/tag/0.1.0

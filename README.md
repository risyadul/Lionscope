# Lionscope

Lionscope is a lightweight Android profiler with a web dashboard. It shows CPU, memory, frame rendering and
logcat for one app on a connected device, on a single shared time axis, without opening Android Studio.

It works in two modes:

- **ADB-only** (no app changes): everything is collected through `adb shell` (`/proc`, `dumpsys`, `logcat`).
- **With the optional SDK** in the app's **debug** build: adds which screen is on top (Activity, Fragment,
  DialogFragment), per-frame `FrameMetrics` with a stage-by-stage breakdown, grouped per screen, and main-thread
  stalls with the app code line that caused them (plus opt-in StrictMode violations).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png">
  <img alt="Lionscope dashboard profiling the sample app: screens lane, CPU, memory, rendering, frame time and frame breakdown charts on one time axis, with logcat on the right" src="docs/images/dashboard-light.png">
</picture>

<sub>The bundled sample app on an emulator with its deliberate-jank list enabled: screen bands across all
charts, SDK FrameMetrics in the Rendering, Frame time and Frame breakdown lanes, and the app's logcat.</sub>

## What the dashboard shows

The dashboard is a single page: a top bar to pick the device and the app and to start or stop a session, then
stacked timeline charts that share one time axis (last 1, 5 or 10 minutes) and can be paused, and a side
panel on the right with the app's logcat and, with the SDK, a per-screen table.

| Panel                                                 | Source                                                                                   | Interval |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| CPU % + threads                                       | `/proc/<pid>/stat`                                                                       | 1 s      |
| Memory (PSS: Java / Native / Graphics / Code / Other) | `dumpsys meminfo --local <pid>`                                                          | 3 s      |
| Frames (FPS, jank, p50/p90 frame time)                | `dumpsys gfxinfo <pid> framestats reset` (+ `/proc/uptime` for device-side elapsed time) | 0.5 s    |
| Logcat (app PID only)                                 | `logcat -v epoch --pid=<pid>`                                                            | stream   |
| Process start / restart / died markers                | `pidof <pkg>`                                                                            | 1 s      |

With the SDK installed in the app's debug build, the dashboard also shows:

| Panel                                             | Source (in-app SDK)                                         |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Screens lane + tint across all charts             | Activity / Fragment / DialogFragment lifecycle (top screen) |
| Rendering / Frame time (source `SDK`)             | `Window.OnFrameMetricsAvailableListener` (API 24+)          |
| Frame breakdown (input … swap, delay, GPU)        | FrameMetrics stages, aggregated per 500 ms                  |
| Per-screen table (frames, jank %, p90, top stage) | the above, grouped by screen                                |
| Main thread lane (one bar per stall)              | Main-thread watchdog; StrictMode violations as ticks        |
| Stalls tab (offenders, events, stack detail)      | Sampled main-thread stacks; StrictMode violations (opt-in)  |

While SDK frames flow, `gfxinfo` polling pauses (no double observation, no `reset` clash); it resumes 3 s after
they stop. The dashboard shows whether the SDK is connected (and its version), or how to add it.

<img alt="Screens tab: per-screen frames, jank %, typical and worst p90 frame time, and the dominant frame stage, sorted by jank" src="docs/images/dashboard-screens.png">

<sub>The Screens tab ranks screens by jank % and names the dominant frame stage for each one. Names come from the
app's own screen alias when it has one (`home_tab`, `detail_page`, `legacy_page_2`), otherwise from the class.</sub>

<img alt="Stalls tab: offenders ranked by culprit line (SlowWork.kt:16), StrictMode DiskRead events and the Main thread lane" src="docs/images/dashboard-stalls.png">

<sub>The Stalls tab after tapping the sample's "Block main thread" and "Read file on main thread" buttons: the
offenders table names the line that blocked the main thread, StrictMode DiskRead violations are listed with
their stacks, and the Main thread lane marks each stall on the shared time axis.</sub>

### Finding the line that blocks the main thread

With the SDK (0.2.0+ SDK and server), a watchdog thread posts a tick to the main thread every 50 ms. When a
tick is not run within the threshold, it samples the main thread's stack every 50 ms until the block ends, then
reports one stall: when it started, how long it lasted, the screen on top, and the most frequent sampled stack
(a block is cut at 30 s). The dashboard ranks stalls by their culprit line (`Class.method (File.kt:87)`): the
first app frame, skipping generated ViewBinding/DataBinding classes for the code that inflates them; when no app
frame was on the stack, the first library frame outside the Android, Java, Kotlin and AndroidX packages (a
third-party SDK blocking the main thread). It shows the stack with framework frames collapsed, and flags stalls
that happened while a debugger was attached.
The threshold is chosen in the Stalls tab (100, 150, 250, 500 or 1000 ms; default 150 ms). The watchdog runs only
while a dashboard is connected at protocol v2 and an activity is started.

**StrictMode (opt-in, off by default).** The Stalls tab has a toggle for it (Android 9 / API 28+). When on, the
SDK extends the app's current main-thread and process StrictMode policies with disk read/write, network, custom
slow call and leaked-closable detection, and reports each violation with its stack. It restores the app's
policies when you turn it off or the link closes. It refuses to touch a policy that has a death, dialog, flash
or dropbox penalty, or that looks like it has the app's own `penaltyListener`, and it never re-arms a
death-on-network penalty; the Stalls tab then says nothing was added. Violations are coalesced to one per second
per stack, and at most 10 per second overall.

## Requirements

- Node.js ≥ 22.12
- Android SDK platform-tools (`adb`). Lionscope looks for it in `LIONSCOPE_ADB`, `$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, then `PATH`.
- A device or emulator with USB debugging enabled, running Android 7.0 (API 24) or newer (Lionscope relies on
  `pidof`, toybox `date +%s%3N` and a non-PTY `adb shell`).

## Quick start

```bash
npx lionscope
# open http://localhost:8701
```

From source instead (the npm package may lag the latest git tag):
`git clone https://github.com/risyadul/Lionscope.git && cd Lionscope && npm install && npm run lionscope`.

Pick the device, pick the app, press **Start**. Nothing needs to be installed on the device for the ADB-only
mode. `npx lionscope --help` lists the options (`--port`, `--device-port`, `--adb`); the
[`lionscope`](https://www.npmjs.com/package/lionscope) package is a single bundled file plus the built
dashboard, with no runtime dependencies.

## Adding the SDK (optional, debug builds only)

The SDK is published on [JitPack](https://jitpack.io/#risyadul/Lionscope). It is a public artifact: no
credentials or opt-in property are needed.

```groovy
// settings.gradle (dependencyResolutionManagement) or app/build.gradle repositories
maven { url "https://jitpack.io"; content { includeGroup "com.github.risyadul.Lionscope" } }
// app/build.gradle
debugImplementation "com.github.risyadul.Lionscope:lionscope:0.2.0"
```

If the project uses `dependencyResolutionManagement`, the `maven` block goes in `settings.gradle`; otherwise
in the module's `repositories`. The `content { includeGroup … }` filter keeps JitPack from serving anything
except Lionscope.

No code changes are needed: the SDK starts itself through androidx.startup, and only does anything in a
debuggable build and in the app's main process. When a session starts, the server runs
`adb reverse tcp:8700 tcp:<gateway port>` for the selected device itself and removes it when the session stops.
If an app removes androidx.startup's `InitializationProvider`, call `Lionscope.install(context)` from
`Application.onCreate`.

**Screen names.** By default a screen is named after its class (`CheckoutActivity`, `HomeFragment`). If the
Activity or Fragment has a public zero-arg `getScreen()` that returns an object with a non-blank String
`value` (`getScreen()?.value`, e.g. an enum implementing a `ScreenName` interface), that alias is used instead.
The sample app's `ScreenName.kt` is an example of this convention; the SDK reads it through reflection, so no
shared interface is required.

SDK details: minSdk 23 (frame metrics need API 24), Java 8 bytecode, Kotlin metadata 2.0, no runtime
dependencies besides `androidx.startup` (`androidx.fragment` and the Kotlin stdlib come from the host app).
Demo app: [`android-sdk/sample`](android-sdk/sample).

### Keeping it out of release builds

`debugImplementation` means release builds contain nothing from Lionscope: no classes, no
`InitializationProvider` entry, no `INTERNET` permission added by the SDK. As a second guard, the SDK does
nothing unless the app is debuggable (`FLAG_DEBUGGABLE`).

Apps that call the API explicitly (`Lionscope.install()` / `Lionscope.isActive()`) also need it to compile in
release; for them there is a no-op artifact with the same API:

```groovy
releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.2.0"
```

### Cost when no dashboard is connected

- Lifecycle callbacks only record the current top screen; nothing is sent while there is no connection.
- `FrameMetrics` listeners are registered only while the dashboard has accepted the app (an active session for
  that package), so there is no per-frame work otherwise.
- The SDK tries to reach `127.0.0.1:8700` every 1 → 2 → 5 s while the app is in the foreground (a refused
  local connection when nothing listens), slows to every 15 s after 10 minutes of foreground time without a
  dashboard, and stops trying 30 s after the app goes to the background until it comes back.
- The main-thread watchdog thread exists only while a dashboard has accepted the app at protocol v2 and an
  activity is started; StrictMode is off until you enable it, and its reporter thread stays idle (no work)
  after the first enable.
- Its threads run at background priority (except the frame-metrics and watchdog threads, which must not be
  starved while the app is busy); a bounded outbound queue drops the oldest messages instead of growing; SDK errors are contained and
  never reach the app's crash handler.

## Architecture

```
 device                                     laptop (everything listens on 127.0.0.1)

 app (debug) + :lionscope SDK ── TCP :8700 ── adb reverse ──▶ server/ SDK gateway (NDJSON)
 adbd ◀───────────── adb shell: /proc, dumpsys, logcat ─────── server/ collectors
                                                                 │
                                                                 ▼
                                                               session store (10 min)
                                                                 │ HTTP + WebSocket :8701
                                                                 ▼
                                                               dashboard/ in the browser
```

| Directory      | What it is                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/`    | The wire contract shared by server and dashboard: types (`wire.ts`), zod validation (`index.ts`), golden SDK lines (`fixtures/`) |
| `server/`      | Node.js + TypeScript: adb collectors and parsers, session store (10-minute ring buffers), WebSocket gateway, SDK gateway         |
| `dashboard/`   | Vite + React + uPlot single-page app, served by the server                                                                       |
| `android-sdk/` | Gradle build: `:lionscope` (debug SDK), `:lionscope-noop` (release no-op), `:sample` (demo app)                                  |
| `cli/`         | The `lionscope` npm package: the server bundled with esbuild into `dist/lionscope.mjs`, plus the built dashboard                 |

The SDK talks to the server over plain TCP with one JSON object per line rather than WebSocket: apps with
`usesCleartextTraffic=false` (or a network security config without localhost) would block `ws://localhost`,
while plain sockets are not subject to that policy. The Kotlin encoders and the server's validator are both
tested against the same golden file, `protocol/fixtures/device-messages.ndjson`.

The SDK's `hello` carries its protocol version (2 since 0.2.0: stall, StrictMode and `config` messages); the server answers `welcome` with the lower of that and its own
(the negotiated version, accepted from 1 to 1000), and lines of a message type the server does not know are
skipped and counted instead of closing the connection; known types are still validated strictly. From 0.1.1 on,
an SDK and a server from different releases therefore keep working together: a 0.1.1 server or SDK negotiates
protocol 1, and stalls and StrictMode are simply unavailable. The server drops invalid stall or StrictMode
messages instead of closing the link. A 0.1.0 server only accepts
protocol version 1 and closes the connection on unknown message types.

## Security model

- The server listens on `127.0.0.1` only. WebSocket upgrades are accepted only from a loopback Host/Origin
  (blocks cross-site WebSocket hijacking and DNS rebinding). Every dashboard message is validated.
- Device serials and package names are checked against strict patterns and passed to `adb` as argument arrays,
  never through a host shell.
- The SDK gateway (TCP, `127.0.0.1` only) requires a valid `hello` as the first line within 1 s, closes
  HTTP-looking requests (browsers can POST to localhost), rate-limits hellos and lines, caps line size and
  connections, and only accepts data after the hello's PID is verified with `pidof` on the session's device.
- The SDK only sends screen class names / aliases, frame timings and, with stalls enabled, stack frames of the
  main thread (class, method, file, line) and StrictMode messages, and only from debuggable builds. Without
  the `adb reverse` mapping, another app on the device listening on `127.0.0.1:8700` could receive that stream.

## Known limitations

- **Main process only.** Only the process named after the package is profiled. Secondary processes (`:remote`
  services, WebView sandboxed renderers) are not included in CPU, memory or logcat, and the SDK does not start
  in them.
- **`gfxinfo` only sees UI-toolkit frames.** In ADB-only mode, frames come from `dumpsys gfxinfo`, which only
  sees frames drawn by Android's UI toolkit (HWUI). Content rendered into a `SurfaceView` or `TextureView`
  (video, camera, maps, games, Flutter) isn't counted, so 0 FPS can mean "no UI frames were drawn", not that the
  app is frozen.
- **Debuggable builds are slower.** Numbers measured on a debuggable build are slower than release. Use
  Lionscope to find _where_ the problem is; use Macrobenchmark or production monitoring for absolute numbers.
- **500 ms screen attribution.** SDK frames are aggregated into 500 ms buckets, and each bucket is attributed
  to the screen that was on top at its end. Frames from the last moments of a screen transition can be counted
  towards the next screen.
- **Stall detection is sampled.** The watchdog works in about 50 ms steps, so durations are approximate and a
  block only slightly over the threshold can be missed. Time a tick waits in the main queue behind other work
  counts as blocked time.
- **StrictMode shares the app's policy.** Detections Lionscope adds follow the penalties of the app's own base
  policy, so they can add lines to logcat (e.g. `penaltyLog`). Apps with their own `penaltyListener` are detected
  by a heuristic that cannot see every listener. Network violations are reported only when the app's policy
  permits network on the main thread.
- Memory uses `dumpsys meminfo --local`: the same App Summary numbers, without asking the app to dump its
  runtime stats (which would force a GC on every poll). It still costs ~0.3–2 s, so memory is sampled every 3 s.
- Jank follows Android's own definition on API 31+ (frame finished after its deadline); "slow" frames are those
  longer than one vsync interval. Below API 31 the vsync period is inferred from frame timestamps, so 90/120 Hz
  devices are measured correctly. Some OEM builds (e.g. HyperOS on Xiaomi, Android 15) set vendor flag bits on
  normal frames and swap the `FrameInterval` / `FrameStartTime` header labels; the parser handles both.

## Configuration

| Flag                   | Env var                   | Default | Purpose                                              |
| ---------------------- | ------------------------- | ------- | ---------------------------------------------------- |
| `--port <port>`        | `LIONSCOPE_PORT`          | `8701`  | Dashboard HTTP + WebSocket port                      |
| `--device-port <port>` | `LIONSCOPE_DEVICE_PORT`   | `8700`  | SDK gateway (TCP, NDJSON); reached via `adb reverse` |
| `--adb <path>`         | `LIONSCOPE_ADB`           | auto    | Path to the `adb` binary                             |
|                        | `LIONSCOPE_DASHBOARD_DIR` | auto    | Built dashboard to serve                             |

Flags win over environment variables. Without `LIONSCOPE_DASHBOARD_DIR`, the server serves the dashboard that
ships next to it in the npm package, or `dashboard/dist` in a clone. There is no option to listen on anything
but `127.0.0.1`.

## Development

```bash
npm install
npm run dev              # server (tsx watch, --dev allows the Vite origin) + Vite on http://localhost:5173
npm test                 # all unit tests (protocol, server, dashboard)
npm run test:coverage
npm run typecheck
npm run lint
npm run format:check     # or `npm run format` to fix
npm run build            # production dashboard build
npm run build:cli        # the npm package in cli/ (dashboard + bundled server); `cd cli && npm pack` to try it
```

Android SDK (JDK 17 and the Android SDK required):

```bash
cd android-sdk
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug
./gradlew :lionscope:publishToMavenLocal :lionscope-noop:publishToMavenLocal   # same coordinates as JitPack
```

The published version comes from the `lionscopeVersion` Gradle property (default `0.2.0`); on JitPack it is
the git tag. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

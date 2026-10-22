# Lionscope

Lionscope is a lightweight Android profiler with a web dashboard. It shows CPU, memory, frame rendering and
logcat for one app on a connected device, on a single shared time axis, without opening Android Studio.

It works in two modes:

- **ADB-only** (no app changes): everything is collected through `adb shell` (`/proc`, `dumpsys`, `logcat`).
- **With the optional SDK** in the app's **debug** build: adds which screen is on top (Activity, Fragment,
  DialogFragment), per-frame `FrameMetrics` with a stage-by-stage breakdown, grouped per screen, and main-thread
  stalls with the app code line that caused them (plus opt-in StrictMode violations).

You can also see and operate the device's screen right next to the charts: emulators (0.3.0+, which you can
also boot headless from the dashboard) and physical devices over USB (0.3.1+).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png">
  <img alt="Lionscope dashboard profiling the sample app: the emulator's screen in the Device column on the left, the screens lane, CPU, memory and rendering charts on one time axis with logcat below, and the Screens tab on the right" src="docs/images/dashboard-light.png">
</picture>

<sub>The bundled sample app on a headless emulator, operated from the Device column: screen bands across all
charts, SDK FrameMetrics in the Rendering lane, logcat below the timeline, and the Screens tab ranking the
janky list first.</sub>

## What the dashboard shows

The dashboard is a single page: a top bar to pick the device and the app and to start or stop a session; the
emulator's screen on the left; stacked timeline charts in the middle that share one time axis (last 1, 5 or 10
minutes) and can be paused, with the app's logcat in a resizable drawer below them; and, with the SDK, the
Screens, Stalls and Layouts tabs on the right. Below 1280 px the screen opens as a drawer from the top bar.

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
| Layouts tab, Inflate column, gold lane markers    | XML layout inflation timing (Android 10+)                   |
| Views column (count and depth per screen)         | View hierarchy snapshot after a screen's first frame        |

While SDK frames flow, `gfxinfo` polling pauses (no double observation, no `reset` clash); it resumes 3 s after
they stop. The dashboard shows whether the SDK is connected (and its version), or how to add it.

<img width="363" alt="Screens tab: per-screen frames, jank %, stalls and the dominant frame stage, sorted by jank" src="docs/images/dashboard-screens.png">

<sub>The Screens tab ranks screens by jank % and names the dominant frame stage for each one (p90 and slow frames
join in when the panel is wider). Names come from the app's own screen alias when it has one (`home_tab`,
`legacy_page_1`), otherwise from the class.</sub>

<img width="363" alt="Stalls tab: watchdog threshold and StrictMode controls, offenders ranked by culprit line (SlowWork.kt:16), and the stall events" src="docs/images/dashboard-stalls.png">

<sub>The Stalls tab after tapping the sample's "Block main thread" button three times from the Device column: the
offenders table names the line that blocked the main thread and the screen it happened on, and each stall is
listed with its duration; with StrictMode on, disk and network violations join the list with their stacks.</sub>

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

### Layouts: what inflating XML costs

With the SDK (0.4.0+ SDK and server), the **Layouts** tab lists the XML layouts the app inflates on the main
thread through an `AppCompatActivity`'s inflater: how often, total, mean and slowest time, the views created by
the slowest inflation, and the screens it ran on. It is sorted by total time; click a column to sort by it. Layouts that come from the Android framework or
libraries (`abc_`, `mtrl_`, `design_`, …) are hidden until you switch on **Show library layouts**. A layout the
SDK cannot name is shown by its first view and XML line (`Button:12`, in italics). A layout inflated inside
another one (an `<include>`, or a compound view's own layout) gets its own row, marked **nested**, because that
is its own cost; but its time is already part of the layout around it, so the row is not extra time. The
Screens tab's **Inflate** column counts each inflation once, nested ones left out, and the gold lane markers
only show top-level inflations. The Screens tab gets an
**Inflate** column (inflation time on that screen, the slowest layout in the tooltip) and a **Views** column
(views and depth from the screen's latest view tree, the deepest path in the tooltip). Inflations of 16 ms or
more also appear as gold bars on the rail under the Main thread lane's baseline; hover one for the layout, its
time, its views and the screen, click it to open the Layouts tab.

How it is measured: the SDK installs a `LayoutInflater.Factory2` on each Activity before it is created and
times view creation from the first view of a layout to the last, then hands the work on (AppCompat's view
substitution, `MaterialButton` and friends, is untouched). No Gradle plugin and no app changes. Read the figures
as a **lower bound**: parser setup is not included, and a debuggable build is slower than release.
What is **not** measured: inflation through the application context or in a `Service`, on a background thread,
in Activities created while tracking was off, in Activities that already had a `LayoutInflater` factory, and
in screens that are not `AppCompatActivity` (plain `Activity` and `ComponentActivity` screens; their view trees
are still taken). Layout measuring needs
**Android 10 (API 29)+**; below that the tab says so and nothing is installed. Inflation tracking is on by
default and has a switch next to StrictMode in the Stalls tab. Turning it off stops recording, and screens
opened afterwards get no factory at all (also across reconnects, until a session turns it back on); screens
opened while it was on keep theirs.

**If your app sets its own factory.** The SDK only installs its factory when the Activity's inflater has none.
If the app (or a library) later calls `LayoutInflater.setFactory2` on that same inflater, for example in
`onCreate` after `super.onCreate`, Android throws `A factory has already been set on this LayoutInflater`. The
dashboard switch can't help there, because the first Activity is created before the SDK hears from the server.
Turn inflation measuring off for the app in its debug manifest instead (view trees keep working):

```xml
<!-- src/debug/AndroidManifest.xml -->
<application>
    <meta-data android:name="io.github.risyadul.lionscope.inflateTracking" android:value="false" />
</application>
```

And please open an issue with the stack trace.

**View trees.** Once per screen visit, after its first frame and when the main thread is idle, the SDK walks
the window's view hierarchy (iteratively, capped at 20,000 views) and reports the number of views and view
groups, the depth, the path to the deepest view and the most common view classes. This works on every API level
the SDK supports, including those below Android 10.

### Operating the emulator from the dashboard

The device picker lists every AVD, also the ones that are off. **Boot** starts one without a window on the host
GPU (`-no-window -gpu host`), as a **Quick boot** (loads the Quick Boot snapshot and saves it on shutdown) or a
**Cold boot** (`-no-snapshot-load`). Its screen then shows in the Device column, where you use it like the
emulator window: click and drag to touch, Alt+drag to pinch (two fingers mirrored around the centre), scroll
with the wheel, type when the screen has focus (Esc is Back), and use the toolbar for
Back, Home, Recents, Power, rotation, a full-resolution screenshot and the frame size (360, 540 or 720 px along
the short edge). Mirroring works with or without a profiling session, and only streams while the column is
open and the tab is visible.

**Share clipboard** (toolbar, on by default) keeps the clipboards in step: text you copy on your computer is put
on Android's clipboard when you click or focus the screen, so Android's own long-press **Paste** has it, and
text copied inside Android lands on your computer's clipboard ("Copied from the emulator"). Cmd/Ctrl+V on the
screen pastes straight into the focused field. Any Unicode text up to 32 KB works. Reading your clipboard needs
the browser's clipboard permission (Chrome asks once); Firefox-based browsers (Firefox, Zen) and Safari don't offer it,
so there press Cmd/Ctrl+V on the screen to send your clipboard (the screen shows that hint); copying out of
Android works everywhere. Turn the toggle off and nothing is read from or written to either clipboard
(Cmd/Ctrl+V still pastes, as an explicit action).

**Shut down emulator** (in the Device column and next to the device picker) closes any running emulator, after
stopping a profiling session on it. Lionscope asks first when the emulator wasn't booted by Lionscope (for example
Android Studio) or a session is running. Emulators Lionscope booted are also shut down when the server stops; one
you started yourself never is.

Lionscope talks to the emulator's own gRPC endpoint, found through the emulator's discovery file
(`avd/running/pid_<pid>.ini`, which holds its port and access token). Frames are captured by the emulator on
the host side and sent as PNG only when the screen changes, so Android inside the emulator does no extra work
and the app's measurements are not affected. On an M-series Mac at 540 px that is about 58 fps, ~140 KB per
frame and ~55 ms from input to frame.

If an emulator renders in software (SwiftShader, e.g. `-no-window` without `-gpu host`), the dashboard warns:
frame times are then not representative of a device.

### Operating a physical device from the dashboard

Pick a phone connected over USB and its screen shows in the Device column, with the same controls as an
emulator (touch, multi-touch, wheel, keys, Share clipboard, Back / Home / Recents / Power, rotation where the app
allows it, screenshot and frame size). Nothing is installed on the phone: Lionscope pushes the bundled
[scrcpy](https://github.com/Genymobile/scrcpy) server (v5.0.1, Apache-2.0, checked against its published SHA-256)
to `/data/local/tmp`, runs it over adb while the column is open, and it removes itself when mirroring stops. The
phone's screen stays on while it is mirrored (scrcpy's `stay_awake`); the previous setting comes back afterwards.
The phone's hardware encoder sends H.264 video that the browser decodes with WebCodecs (Chrome, Firefox 130+,
Safari 16.4+; the dashboard must be opened on `localhost`).

The phone's hardware encoder does add a little work while it is mirrored, so close the Device column for the
cleanest measurements.

On Xiaomi / HyperOS (and some other OEM builds) the phone refuses injected input until **USB debugging (Security
settings)** is turned on in Developer options; the screen still mirrors and the dashboard tells you what to turn
on.

## Requirements

- Node.js ≥ 22.12
- Android SDK platform-tools (`adb`). Lionscope looks for it in `LIONSCOPE_ADB`, `$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, then `PATH`.
- A device or emulator with USB debugging enabled, running Android 7.0 (API 24) or newer (Lionscope relies on
  `pidof`, toybox `date +%s%3N` and a non-PTY `adb shell`).

## Quick start

```bash
npx lionscope@latest
# open http://localhost:8701
```

`@latest` makes npx check for a new release; a bare `npx lionscope` can keep running a version it cached
earlier.

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
debugImplementation "com.github.risyadul.Lionscope:lionscope:0.3.1"
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
releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.3.1"
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
 emulator ◀─────────── gRPC (EmulatorController, token) ─────── server/ emulator manager + /ws/screen
 phone ◀── adb forward ── scrcpy-server (H.264 + control) ───── server/ scrcpy session + /ws/screen
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
- The dashboard and screen sockets have no password of their own: any process of any user on the same machine
  that can reach `127.0.0.1` can use them, including operating a mirrored emulator. That is no more access than
  the adb server on `127.0.0.1:5037` already gives local processes; do not run Lionscope on a machine you share
  with people you don't trust.
- Emulator access tokens are read from the emulator's discovery file and used only by the server; they are
  never logged or sent to the browser. The screen socket (`/ws/screen`) has the same Host/Origin checks, a
  size cap and an input rate limit. AVD names must match `emulator -list-avds` before anything is spawned, and
  an emulator this server didn't boot is shut down only after the user confirms it in the dashboard, and only through
  its own gRPC endpoint or `adb emu kill` on its serial (never a process signal).
- For physical devices, the scrcpy server jar is checked against its SHA-256 before every push, the command line
  on the phone is built from fixed presets (no dashboard values reach the device shell), and the phone process
  and adb forward are removed on every exit path. Video and device messages from the phone are size-checked.
  While mirroring starts, adb briefly forwards a local port to the phone; it is removed as soon as Lionscope is
  connected. If you run the adb server with `adb -a` (listen on all interfaces), that port is reachable from your
  network for that moment, so keep adb on its default loopback binding.
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
- **Obfuscated SDKs keep their names short.** When a stall's culprit is a third-party SDK shipped with R8 or
  ProGuard, its frames read like `com.vendor.internal.b.a (SourceFile:22)`: the package says which SDK blocked
  the main thread, but the line number does not point at readable source.
- **StrictMode shares the app's policy.** Detections Lionscope adds follow the penalties of the app's own base
  policy, so they can add lines to logcat (e.g. `penaltyLog`). Apps with their own `penaltyListener` are detected
  by a heuristic that cannot see every listener. Network violations are reported only when the app's policy
  permits network on the main thread.
- **Layout times are a lower bound.** Parser setup is not measured, nested `<include>`s are counted in their
  parent and also on their own, and only inflation on the main thread through the Activity's inflater is seen:
  layouts inflated on a background thread, from an application-context inflater or by Compose are not.
- **Screen mirroring.** Emulators need a discovery file with a gRPC port and token (tested with emulator 36.6).
  AVDs have no mouse, so the wheel scrolls with a short touch drag, and typed keys are reliable for printable
  ASCII (the emulator may drop other characters); use paste for anything else. Physical devices need a browser
  with WebCodecs H.264 decoding, and rotating from the dashboard only works where the app allows rotation; the
  mirrored video is the phone's own encoder output, so quality and latency depend on the phone. The discovery locations for Linux and Windows follow Android Studio's and have not
  been tried on those systems yet.
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

The published version comes from the `lionscopeVersion` Gradle property (default `0.3.1`); on JitPack it is
the git tag. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

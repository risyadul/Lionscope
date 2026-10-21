# Lionscope

Lionscope is a lightweight Android profiler with a web dashboard. It shows CPU, memory, frame rendering and
logcat for one app on a connected device, on a single shared time axis, without opening Android Studio.

It works in two modes:

- **ADB-only** (no app changes): everything is collected through `adb shell` (`/proc`, `dumpsys`, `logcat`).
- **With the optional SDK** in the app's **debug** build: adds which screen is on top (Activity, Fragment,
  DialogFragment) and per-frame `FrameMetrics` with a stage-by-stage breakdown, grouped per screen.

## What the dashboard shows

The dashboard is a single page: a top bar to pick the device and the app and to start or stop a session, then
stacked timeline charts that share one time axis (last 1, 5 or 10 minutes) and can be paused, and a logcat
panel below.

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

While SDK frames flow, `gfxinfo` polling pauses (no double observation, no `reset` clash); it resumes 3 s after
they stop. The dashboard shows whether the SDK is connected (and its version), or how to add it.

## Requirements

- Node.js ≥ 22.12
- Android SDK platform-tools (`adb`). Lionscope looks for it in `LIONSCOPE_ADB`, `$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, then `PATH`.
- A device or emulator with USB debugging enabled, running Android 7.0 (API 24) or newer (Lionscope relies on
  `pidof`, toybox `date +%s%3N` and a non-PTY `adb shell`).

## Quick start

```bash
git clone https://github.com/risyadul/Lionscope.git
cd Lionscope
npm install && npm run lionscope   # builds the dashboard, starts the server
# open http://localhost:8701
```

Pick the device, pick the app, press **Start**. Nothing needs to be installed on the device for the ADB-only
mode.

## Adding the SDK (optional, debug builds only)

The SDK is published on [JitPack](https://jitpack.io/#risyadul/Lionscope). It is a public artifact: no
credentials or opt-in property are needed.

```groovy
// settings.gradle (dependencyResolutionManagement) or app/build.gradle repositories
maven { url "https://jitpack.io"; content { includeGroup "com.github.risyadul.Lionscope" } }
// app/build.gradle
debugImplementation "com.github.risyadul.Lionscope:lionscope:0.1.0"
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
releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.1.0"
```

### Cost when no dashboard is connected

- Lifecycle callbacks only record the current top screen; nothing is sent while there is no connection.
- `FrameMetrics` listeners are registered only while the dashboard has accepted the app (an active session for
  that package), so there is no per-frame work otherwise.
- The SDK tries to reach `127.0.0.1:8700` every 1 → 2 → 5 s while the app is in the foreground (a refused
  local connection when nothing listens), slows to every 15 s after 10 minutes of foreground time without a
  dashboard, and stops trying 30 s after the app goes to the background until it comes back.
- Its threads run at background priority (except the frame-metrics thread, which must not be starved during
  jank); a bounded outbound queue drops the oldest messages instead of growing; SDK errors are contained and
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

The SDK talks to the server over plain TCP with one JSON object per line rather than WebSocket: apps with
`usesCleartextTraffic=false` (or a network security config without localhost) would block `ws://localhost`,
while plain sockets are not subject to that policy. The Kotlin encoders and the server's validator are both
tested against the same golden file, `protocol/fixtures/device-messages.ndjson`.

## Security model

- The server listens on `127.0.0.1` only. WebSocket upgrades are accepted only from a loopback Host/Origin
  (blocks cross-site WebSocket hijacking and DNS rebinding). Every dashboard message is validated.
- Device serials and package names are checked against strict patterns and passed to `adb` as argument arrays,
  never through a host shell.
- The SDK gateway (TCP, `127.0.0.1` only) requires a valid `hello` as the first line within 1 s, closes
  HTTP-looking requests (browsers can POST to localhost), rate-limits hellos and lines, caps line size and
  connections, and only accepts data after the hello's PID is verified with `pidof` on the session's device.
- The SDK only sends screen class names / aliases and frame timings, and only from debuggable builds. Without
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
- Memory uses `dumpsys meminfo --local`: the same App Summary numbers, without asking the app to dump its
  runtime stats (which would force a GC on every poll). It still costs ~0.3–2 s, so memory is sampled every 3 s.
- Jank follows Android's own definition on API 31+ (frame finished after its deadline); "slow" frames are those
  longer than one vsync interval. Below API 31 the vsync period is inferred from frame timestamps, so 90/120 Hz
  devices are measured correctly. Some OEM builds (e.g. HyperOS on Xiaomi, Android 15) set vendor flag bits on
  normal frames and swap the `FrameInterval` / `FrameStartTime` header labels; the parser handles both.

## Configuration

| Env var                   | Default          | Purpose                                              |
| ------------------------- | ---------------- | ---------------------------------------------------- |
| `LIONSCOPE_PORT`          | `8701`           | Dashboard HTTP + WebSocket port                      |
| `LIONSCOPE_DEVICE_PORT`   | `8700`           | SDK gateway (TCP, NDJSON); reached via `adb reverse` |
| `LIONSCOPE_ADB`           | auto             | Path to the `adb` binary                             |
| `LIONSCOPE_DASHBOARD_DIR` | `dashboard/dist` | Built dashboard to serve                             |

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
```

Android SDK (JDK 17 and the Android SDK required):

```bash
cd android-sdk
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug
./gradlew :lionscope:publishToMavenLocal :lionscope-noop:publishToMavenLocal   # same coordinates as JitPack
```

The published version comes from the `lionscopeVersion` Gradle property (default `0.1.0`); on JitPack it is
the git tag. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

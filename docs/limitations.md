# Known limitations

- **Main process only.** Only the process named after the package is profiled. Secondary processes (`:remote`
  services, WebView sandboxed renderers) are not included in CPU, memory or logcat, and the SDK does not start
  in them. Their crashes are: `get_crashes` covers the package's process and its `<package>:*` processes.
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
- **Origins have blind spots.** A coroutine's launch site is not known (Android has no coroutine debug probes):
  the origin names the continuation that resumed, and its name only in kotlinx.coroutines debug mode. An Rx
  chain subscribed before the session started, or whose `observeOn` is subscribed on another thread than the one
  that called `subscribe` (an `observeOn` above a `subscribeOn`), has no subscribe site; only `observeOn` chains
  get one. Work run by `Dispatchers.Main.immediate` or a trampoline runs inside whatever message was dispatching
  and is attributed to that.
- **Obfuscated SDKs keep their names short.** When a stall's culprit is a third-party SDK shipped with R8 or
  ProGuard, its frames read like `com.vendor.internal.b.a (SourceFile:22)`: the package says which SDK blocked
  the main thread, but the line number does not point at readable source.
- **StrictMode shares the app's policy.** Detections Lionscope adds follow the penalties of the app's own base
  policy, so they can add lines to logcat (e.g. `penaltyLog`). Apps with their own `penaltyListener` are detected
  by a heuristic that cannot see every listener. Network violations are reported only when the app's policy
  permits network on the main thread.
- **Compose in the Inspector** needs a debug build that is not minified, compiled with Compose source information
  (the default), and composed after the SDK started. Composables are only those called from your code (and from
  libraries other than androidx Compose, Material and Navigation); a composable that lays nothing out (an effect, a
  `Dialog` call, a provider) has no node of its own, and a `Dialog`'s content appears in the dialog's window.
- **Live edits are for Views only.** Composables are read-only (their values come from code on every
  recomposition), and an edit lasts until it is reverted, the app sets the property itself or the view is
  recreated.
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

- **Saved state is measured, not predicted.** The limit is the binder buffer shared by the whole process (1 MB),
  so a failure can come below the measured size when other calls are in flight, and the parcel size in the failure
  is a little larger than the report (the call's own fields). The breakdown lists at most 30 keys of 1 KB or more,
  12 levels deep. Fragment classes come from androidx.fragment's state; a state that another library parcels
  as its own type is listed as one value. The SDK's posted measurement before API 29 was checked on API 23 and 28
  (not 24-27): it runs after the save and before the stop is reported. On API 23 the server's profiling session does
  not reach the app's process yet (it waits for a process ID and reads no logcat), so failures there are neither read
  from logcat nor joined with the SDK's reports, which still arrive.
- **Network capture needs OkHttp.** Only requests made through an `OkHttpClient` with `Lionscope.okHttpInterceptor()`
  are seen (Retrofit, Ktor's OkHttp engine, Coil/Glide's OkHttp integrations); `HttpURLConnection`, Ktor's CIO
  engine, WebView, gRPC's own transports and native code are not. OkHttp 4.x and 5.x are supported (tested with
  4.12 and 5.4), 3.x is not. A request body is captured only when it can safely be written twice (not one-shot or
  duplex, with a known length up to 1 MB); a response the app closes before its end is shown as truncated.
  Bodies are captured up to 64 KB and only for text types; Brotli and zstd bodies are not decoded. A response whose
  body the app never reads to the end or closes stays pending. Mocks are applied by the interceptor itself, so they
  answer only requests that go through it, and never when it was added with `addNetworkInterceptor`.

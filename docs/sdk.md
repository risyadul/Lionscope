**Screen names.** By default a screen is named after its class (`CheckoutActivity`, `HomeFragment`). If the
Activity or Fragment has a public zero-arg `getScreen()` that returns an object with a non-blank String
`value` (`getScreen()?.value`, e.g. an enum implementing a `ScreenName` interface), that alias is used instead.
The sample app's `ScreenName.kt` is an example of this convention; the SDK reads it through reflection, so no
shared interface is required.

**Navigation Compose.** A single-Activity Compose app is one Activity to the SDK. Tell it about your
`NavController` and every destination becomes a screen (the Screens lane, per-screen jank, stalls, the Inspector's
screen and owner):

```kotlin
val navController = rememberNavController()
Lionscope.trackNavigation(navController) // once per controller; repeated calls are free
NavHost(navController, startDestination = "catalog") { /* ... */ }
```

The screen is the destination's **route pattern**, never its arguments: `product/{id}` (query placeholders are
dropped from the name), or for a type-safe route its class name (`ProductDetail`); a `dialog()` destination is a
dialog. It applies while no Fragment of your app is on top, and with nested NavHosts the innermost shown one wins
(track each). `lionscope-noop` has the same call, so it compiles in release builds. In Kotlin Multiplatform
(Compose Multiplatform with `org.jetbrains.androidx.navigation:navigation-compose`), the SDK is an Android
dependency, so call it from `androidMain`, e.g. through an `expect`/`actual` function:

```kotlin
// commonMain
@Composable expect fun TrackNavigation(navController: NavHostController)
// androidMain
@Composable actual fun TrackNavigation(navController: NavHostController) = Lionscope.trackNavigation(navController)
// iosMain (and other targets)
@Composable actual fun TrackNavigation(navController: NavHostController) = Unit
```

Voyager and Navigation 3 are not tracked yet.

SDK details: minSdk 23 (frame metrics need API 24), Java 8 bytecode, Kotlin metadata 2.0, no runtime
dependencies besides `androidx.startup` (`androidx.fragment`, Compose UI, Navigation and the Kotlin stdlib come
from the host app, and are only used when it has them).
Demo app: [`android-sdk/sample`](../android-sdk/sample).

**Network (optional).** The only SDK feature that needs a code change: add `Lionscope.okHttpInterceptor()` to the
app's `OkHttpClient` (Retrofit, or Ktor's OkHttp engine) to get the
[Network tab and mocks](features/network.md). OkHttp 4.x or 5.x comes from the app.

## Keeping it out of release builds

`debugImplementation` means release builds contain nothing from Lionscope: no classes, no
`InitializationProvider` entry, no `INTERNET` permission added by the SDK. As a second guard, the SDK does
nothing unless the app is debuggable (`FLAG_DEBUGGABLE`).

Apps that call the API explicitly (`Lionscope.install()`, `Lionscope.isActive()`, `Lionscope.trackNavigation()`,
`Lionscope.okHttpInterceptor()`) also need it to compile in release; for them there is a no-op artifact with the
same API (its interceptor only passes requests on):

```groovy
releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.12.0"
```

## Cost when no dashboard is connected

- Lifecycle callbacks only record the current top screen; nothing is sent while there is no connection.
- In an app with Compose UI, Compose's tooling data is on from the start (so that the Inspector can read it later):
  composition is a little slower and keeps a little more in memory, as under Android Studio's inspector. Opt out
  with the `io.github.risyadul.lionscope.composeInspection` meta-data (the Inspector then uses uiautomator there).
- `FrameMetrics` listeners are registered only while the dashboard has accepted the app (an active session for
  that package), so there is no per-frame work otherwise.
- The SDK tries to reach `127.0.0.1:8700` every 1 → 2 → 5 s while the app is in the foreground (a refused
  local connection when nothing listens), slows to every 15 s after 10 minutes of foreground time without a
  dashboard, and stops trying 30 s after the app goes to the background until it comes back.
- The main-thread watchdog thread exists only while a dashboard has accepted the app at protocol v2 and an
  activity is started; StrictMode is off until you enable it, and its reporter thread stays idle (no work)
  after the first enable.
- `Lionscope.okHttpInterceptor()` outside a profiling session is one volatile read and `chain.proceed`.
- Saved-state measurement runs only during a profiling session with a 0.12.0+ server (see
  [Saved state](features/saved-state.md)); otherwise a lifecycle callback returns at once.
- The RxJava hooks are installed only during a profiling session (see [RxJava tracking](features/stalls.md));
  a process that never had one has none. The Looper's message logging is not used (a `Printer` would cost about
  3 µs per main-thread message and 17 µs per coroutine dispatch).
- Its threads run at background priority (except the frame-metrics and watchdog threads, which must not be
  starved while the app is busy); a bounded outbound queue drops the oldest messages instead of growing; SDK errors are contained and
  never reach the app's crash handler.

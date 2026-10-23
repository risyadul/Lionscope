package io.github.risyadul.lionscope

import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import android.view.Display

internal const val LOG_TAG = "Lionscope"
internal const val DEFAULT_REFRESH_RATE_HZ = 60.0
private const val INSPECT_ERROR_SIZE_HINT = 64

/** Wires the trackers to the device link; installed at most once per process. */
internal object LionscopeRuntime {

    private var link: DeviceLink? = null

    /** Entry point for the initializer and [Lionscope.install]. Contains every failure, including errors. */
    fun installIfEligible(context: Context, processName: () -> String? = ProcessInfo::currentProcessName) {
        try {
            val app = context.applicationContext as? Application ?: return
            if (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
            if (processName() != app.packageName) return
            install(app)
        } catch (t: Throwable) {
            try {
                Log.w(LOG_TAG, "Lionscope disabled: $t")
            } catch (ignored: Throwable) {
                // Logging itself failed; stay silent.
            }
        }
    }

    @Synchronized
    private fun install(app: Application) {
        if (link != null) return
        // First: a composition can only be inspected if inspection was on when it was first composed.
        ComposeSupport.install(app)
        val processName = ProcessInfo.currentProcessName() ?: app.packageName
        val deviceLink = DeviceLink(helloLine = {
            DeviceMessages.hello(
                packageName = app.packageName,
                processName = processName,
                pid = Process.myPid(),
                apiLevel = Build.VERSION.SDK_INT,
                deviceWallMs = System.currentTimeMillis(),
                refreshRateHz = defaultRefreshRate(app),
            )
        })
        val main = HandlerScheduler(Handler(Looper.getMainLooper()))
        val ownership = AppOwnership(app.packageName)
        lateinit var screens: ScreenTracker
        val frames = if (Build.VERSION.SDK_INT >= 24) {
            FrameTracker(app, deviceLink, main) { screens.requestResolve() }
        } else {
            null
        }
        val origins = ViewOrigins()
        val layouts = try {
            layouts(app, deviceLink, main, ownership, origins) { screens.currentScreenName }
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            Log.w(LOG_TAG, "Lionscope layouts disabled: $t")
            null
        }
        val inspector = try {
            layouts?.let { Inspector(deviceLink, main, ViewScene(it, origins), screenName = { screens.currentScreenName }) }
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            Log.w(LOG_TAG, "Lionscope inspector disabled: $t")
            null
        }
        // Every `inspect` gets an answer, so the server can fall back to uiautomator right away.
        if (inspector == null) {
            deviceLink.addInspectListener { requestId ->
                deviceLink.sendV4(INSPECT_ERROR_SIZE_HINT) { DeviceMessages.inspectError(requestId, InspectError.DISABLED) }
            }
        }
        screens = ScreenTracker(
            deviceLink,
            main,
            dialogWindows = frames,
            layoutEvents = layouts,
            periodicFallback = frames == null,
            ownership = ownership,
        )
        // Built before any registration: a failure here leaves the SDK without diagnostics, never half-registered.
        val diagnostics = try {
            diagnostics(deviceLink, main, screens, ownership)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            Log.w(LOG_TAG, "Lionscope diagnostics disabled: $t")
            null
        }
        app.registerActivityLifecycleCallbacks(screens)
        frames?.let(app::registerActivityLifecycleCallbacks)
        diagnostics?.let(app::registerActivityLifecycleCallbacks)
        layouts?.let(app::registerActivityLifecycleCallbacks)
        link = deviceLink // Set before start(): a failed start must not lead to double registration on retry.
        deviceLink.start()
        Lionscope.installed = true
    }

    /** Main-thread watchdog and (API 28+) StrictMode reporting; both inert until a v2 server says so. */
    private fun diagnostics(
        link: DeviceLink,
        main: MainScheduler,
        screens: ScreenTracker,
        ownership: AppOwnership,
    ): DiagnosticsController {
        val sink = DiagnosticsSink(link, ownership) { screens.topActivityClassName }
        val mainThread by lazy { Looper.getMainLooper().thread }
        val watchdog = MainThreadWatchdog(
            main = main,
            sampleStack = { mainThread.stackTrace },
            screenName = { screens.currentScreenName },
            report = sink::stall,
        )
        val strictMode = if (Build.VERSION.SDK_INT >= 28) {
            StrictModeController.create(main, { screens.currentScreenName }, sink::strictMode)
        } else {
            null
        }
        return DiagnosticsController(link, main, watchdog, strictMode)
    }

    /**
     * View trees on every API level; inflation timing and the views' layout origins for the Inspector (API 29+,
     * where the inflater factory can be set early) unless the app opted out in its manifest.
     */
    private fun layouts(
        app: Application,
        link: DeviceLink,
        main: MainScheduler,
        ownership: AppOwnership,
        origins: ViewOrigins,
        screenName: () -> String?,
    ): LayoutsTracker {
        val reporter = InflateReporter(link, main)
        val tracer = if (Build.VERSION.SDK_INT >= 29 && InflateOptOut.allows(app)) {
            val handler = Handler(Looper.getMainLooper())
            InflateTracer(
                reporter,
                screenName,
                ownership,
                postAtFrontOfQueue = { handler.postAtFrontOfQueue(it) },
                origins = origins,
            )
        } else {
            null
        }
        return LayoutsTracker(link, main, reporter, tracer, ViewTreeSnapshotter(link, screenName))
    }

    private fun defaultRefreshRate(context: Context): Double {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val rate = manager?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate ?: 0f
        return 1000.0 / frameIntervalMs(rate)
    }
}

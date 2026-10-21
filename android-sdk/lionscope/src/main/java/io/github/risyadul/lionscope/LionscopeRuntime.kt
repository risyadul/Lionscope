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
        lateinit var screens: ScreenTracker
        val frames = if (Build.VERSION.SDK_INT >= 24) {
            FrameTracker(app, deviceLink, main) { screens.requestResolve() }
        } else {
            null
        }
        screens = ScreenTracker(deviceLink, main, dialogWindows = frames, periodicFallback = frames == null)
        app.registerActivityLifecycleCallbacks(screens)
        frames?.let(app::registerActivityLifecycleCallbacks)
        link = deviceLink // Set before start(): a failed start must not lead to double registration on retry.
        deviceLink.start()
        Lionscope.installed = true
    }

    private fun defaultRefreshRate(context: Context): Double {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val rate = manager?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate ?: 0f
        return 1000.0 / frameIntervalMs(rate)
    }
}

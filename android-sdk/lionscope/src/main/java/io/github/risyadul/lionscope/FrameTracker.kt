package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.view.Display
import android.view.FrameMetrics
import android.view.Window
import androidx.annotation.RequiresApi
import java.util.concurrent.ConcurrentHashMap

/**
 * Per-frame FrameMetrics of resumed activity windows and shown dialog windows, delivered on the
 * `lionscope-frames` thread and batched every 500 ms. Listeners are only registered during a profiling session
 * (not on an inspect-only link), so there is no observer effect when no dashboard is profiling. While frames flow, it also asks the screen
 * tracker to re-resolve (at most every 500 ms) to catch changes that have no lifecycle event.
 */
@RequiresApi(24)
internal class FrameTracker(
    context: Context,
    private val link: DeviceLink,
    private val main: MainScheduler,
    private val requestResolve: () -> Unit,
) : Application.ActivityLifecycleCallbacks, DialogWindows {
    private val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    private val handler: Handler by lazy {
        val thread = // Default priority on purpose: a background-cgroup thread can be starved under load, and FrameMetrics
        // would then drop frames exactly during jank. The per-frame work is tiny.
        HandlerThread("lionscope-frames", Process.THREAD_PRIORITY_DEFAULT)
        thread.isDaemon = true
        thread.start()
        Handler(thread.looper)
    }
    private val windows = WindowRegistry<Window, Listener>(::attach, ::detach) // main thread only
    /** Frame budget per display id; written on main (attach) and the frames thread (display changes). */
    private val intervalByDisplay = ConcurrentHashMap<Int, Double>()
    private val batcher = FrameBatcher() // frames thread only
    private var flushScheduled = false // frames thread only
    private var lastResolveRequestMs = 0L // frames thread only
    private val flushTick = Runnable { guarded(::flushDue) }
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) = guarded { updateInterval(displayId) }
    }

    /** True while FrameMetrics listeners may be attached (a profiling session is up). */
    val isActive: Boolean
        get() = windows.isActive

    init {
        link.addSessionListener { welcomed -> main.post(Runnable { guarded { onLinkChanged(welcomed) } }) }
    }

    override fun onActivityResumed(activity: Activity) = guarded {
        windows.show(activity, activity.window, activity.javaClass.name)
    }

    override fun onActivityPaused(activity: Activity) = guarded { hide(activity) }

    override fun onDialogShown(key: Any, window: Window, name: String) = guarded { windows.show(key, window, name) }

    override fun onDialogHidden(key: Any) = guarded { hide(key) }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit

    private fun hide(key: Any) {
        val wasActive = windows.isActive
        val name = windows.hide(key) ?: return
        // Inactive: nothing pending (flushed on deactivation), and the frames thread need not exist.
        if (wasActive) handler.post { guarded { batcher.flush(name)?.let(::send) } }
    }

    private fun onLinkChanged(welcomed: Boolean) {
        if (welcomed == windows.isActive) return
        if (welcomed) {
            displayManager?.registerDisplayListener(displayListener, handler)
        } else {
            displayManager?.unregisterDisplayListener(displayListener)
            handler.post { guarded { batcher.flushAll() } } // Link is down: pending frames are discarded.
        }
        windows.setActive(welcomed)
    }

    private fun attach(window: Window, name: String): Listener? = try {
        val displayId = displayOf(window)?.let { display ->
            intervalByDisplay[display.displayId] = frameIntervalMs(display.refreshRate)
            display.displayId
        } ?: Display.DEFAULT_DISPLAY
        val listener = Listener(name, displayId)
        window.addOnFrameMetricsAvailableListener(listener, handler)
        listener
    } catch (e: RuntimeException) {
        null
    }

    private fun detach(window: Window, listener: Listener) {
        try {
            window.removeOnFrameMetricsAvailableListener(listener)
        } catch (e: RuntimeException) {
            // Window already dropped the listener.
        }
    }

    private fun displayOf(window: Window): Display? {
        window.decorView.display?.let { return it }
        @Suppress("DEPRECATION")
        return window.windowManager?.defaultDisplay
    }

    private fun updateInterval(displayId: Int) {
        val display = displayManager?.getDisplay(displayId) ?: return
        intervalByDisplay[displayId] = frameIntervalMs(display.refreshRate)
    }

    private fun onFrame(listener: Listener, metrics: FrameMetrics, droppedFrames: Int) {
        if (!link.isConnected) return
        val intervalMs = intervalByDisplay[listener.displayId] ?: frameIntervalMs(0f)
        val frame = FrameMetricsReader.read(metrics, System.currentTimeMillis(), System.nanoTime())
        batcher.add(listener.window, intervalMs, frame, SystemClock.uptimeMillis(), droppedFrames).forEach(::send)
        scheduleFlush(FrameBatcher.FLUSH_INTERVAL_MS)
    }

    private fun flushDue() {
        flushScheduled = false
        val now = SystemClock.uptimeMillis()
        batcher.flushDue(now).forEach(::send)
        batcher.nextDueInMs(now)?.let(::scheduleFlush)
        if (link.isWelcomed && now - lastResolveRequestMs >= FrameBatcher.FLUSH_INTERVAL_MS) {
            lastResolveRequestMs = now
            requestResolve()
        }
    }

    private fun scheduleFlush(delayMs: Long) {
        if (flushScheduled) return
        flushScheduled = true
        handler.postDelayed(flushTick, delayMs)
    }

    private fun send(batch: FrameBatcher.Batch) {
        link.send(DeviceMessages.frames(batch.window, batch.intervalMs, batch.frames, batch.droppedFrames))
    }

    private inner class Listener(val window: String, val displayId: Int) : Window.OnFrameMetricsAvailableListener {
        override fun onFrameMetricsAvailable(window: Window, frameMetrics: FrameMetrics, dropCountSinceLastInvocation: Int) =
            guarded { onFrame(this, frameMetrics, dropCountSinceLastInvocation) }
    }
}

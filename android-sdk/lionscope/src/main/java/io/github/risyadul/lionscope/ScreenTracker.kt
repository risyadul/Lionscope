package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.Window
import java.util.concurrent.atomic.AtomicBoolean

/** Receives the windows of shown dialog fragments (for frame metrics). */
internal interface DialogWindows {
    fun onDialogShown(key: Any, window: Window, name: String)
    fun onDialogHidden(key: Any)
}

/**
 * Feeds Activity (and, when androidx.fragment is present, Fragment) lifecycle events into [ScreenResolver].
 * Resolution is coalesced into one main-thread post, so a whole transition (pause A → resume B → resume B's
 * fragments) yields a single `screen` message. Changes without lifecycle events (legacy ViewPager swipes,
 * hide/show, dynamic aliases) are caught by [requestResolve], driven by frames or, below API 24, by a 1 s tick.
 */
internal class ScreenTracker(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val dialogWindows: DialogWindows? = null,
    private val periodicFallback: Boolean = false,
    hooksFactory: (ScreenTracker) -> FragmentHooks? = ::createFragmentHooks,
    private val clock: () -> Long = System::currentTimeMillis,
    applicationId: String = "",
) : Application.ActivityLifecycleCallbacks {
    private val resolver = ScreenResolver(applicationId)
    private val fragmentHooks: FragmentHooks? = try {
        hooksFactory(this)
    } catch (e: LinkageError) {
        null // Unexpected androidx.fragment: track activities only.
    } catch (e: Exception) {
        null
    }
    private val isShown: (Any) -> Boolean = { fragmentHooks?.isShown(it) ?: true }
    private val describe: (Any, ScreenKind) -> ScreenRef =
        { target, kind -> ScreenRef(ScreenNames.nameOf(target), target.javaClass.name, kind) }
    private val emitPending = AtomicBoolean(false)
    private val emitRunnable = Runnable { guarded(::emit) }
    private val welcomeChanged = Runnable { guarded(::tick) }
    private val tickTask = Runnable {
        guarded {
            tickScheduled = false
            requestResolve()
            tick()
        }
    }
    private var tickScheduled = false
    private var lastScreen: ScreenRef? = null
    private var wasForeground = false

    init {
        link.addWelcomeListener { main.post(welcomeChanged) }
    }

    val tracksFragments: Boolean
        get() = fragmentHooks != null

    /** Re-resolves the top screen on the main thread soon; safe to call from any thread, coalesced. */
    fun requestResolve() {
        if (emitPending.compareAndSet(false, true)) main.post(emitRunnable)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = guarded {
        fragmentHooks?.register(activity)
    }

    override fun onActivityStarted(activity: Activity) = track { resolver.activityStarted(activity) }

    override fun onActivityResumed(activity: Activity) = track { resolver.activityResumed(activity) }

    override fun onActivityPaused(activity: Activity) = track { resolver.activityPaused(activity) }

    override fun onActivityStopped(activity: Activity) = track { resolver.activityStopped(activity) }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = track { resolver.activityDestroyed(activity) }

    fun onFragmentResumed(fragment: Any, activity: Any, parent: Any?, kind: ScreenKind) =
        track { resolver.fragmentResumed(fragment, activity, parent, kind) }

    fun onFragmentPaused(fragment: Any) = track { resolver.fragmentPaused(fragment) }

    fun onFragmentGone(fragment: Any) = track { resolver.fragmentGone(fragment) }

    fun onDialogShown(fragment: Any, window: Window, name: String) = guarded {
        dialogWindows?.onDialogShown(fragment, window, name)
    }

    fun onDialogHidden(fragment: Any) = guarded { dialogWindows?.onDialogHidden(fragment) }

    private inline fun track(update: () -> Unit) = guarded {
        update()
        val foreground = resolver.hasStartedActivity
        if (foreground != wasForeground) {
            wasForeground = foreground
            link.setForeground(foreground)
        }
        requestResolve()
        tick()
    }

    private fun emit() {
        emitPending.set(false)
        val screen = resolver.resolve(isShown, describe)
        if (screen == lastScreen) return
        lastScreen = screen
        link.onScreen(clock(), screen)
    }

    /** Below API 24 there are no frames to drive re-resolution: poll once a second while it can matter. */
    private fun tick() {
        if (!periodicFallback || tickScheduled) return
        if (!resolver.hasResumedActivity || !link.isWelcomed) return
        tickScheduled = true
        main.postDelayed(tickTask, PERIODIC_RESOLVE_MS)
    }

    private companion object {
        const val PERIODIC_RESOLVE_MS = 1_000L

        fun createFragmentHooks(tracker: ScreenTracker): FragmentHooks? = try {
            Class.forName("androidx.fragment.app.FragmentActivity")
            FragmentHooks(tracker)
        } catch (e: ClassNotFoundException) {
            null
        }
    }
}

/** SDK callbacks must never throw into the app; only a genuine OutOfMemoryError is let through. */
internal inline fun guarded(block: () -> Unit) {
    try {
        block()
    } catch (e: OutOfMemoryError) {
        throw e
    } catch (t: Throwable) {
        // Swallowed on purpose: profiling must not break the app.
    }
}

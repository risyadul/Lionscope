package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.View
import android.view.Window
import java.util.concurrent.atomic.AtomicBoolean

/** Receives the windows of shown dialog fragments (for frame metrics). */
internal interface DialogWindows {
    fun onDialogShown(key: Any, window: Window, name: String)
    fun onDialogHidden(key: Any)
}

/** Fragment, dialog and screen events for layout inflation and view trees (main thread). */
internal interface LayoutEvents {
    fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View)
    fun onFragmentViewDestroyed(fragment: Any)
    fun onDialogShown(fragment: Any, activity: Any?, window: Window, name: String)
    fun onDialogHidden(fragment: Any)

    /** The reported top screen changed; [target] is the Activity / Fragment it was resolved from. */
    fun onScreenChanged(screen: ScreenRef?, target: Any?)
}

/** The current navigation destination shown in an Activity, if any (main thread). */
internal interface DestinationScreens {
    fun screenFor(activity: Any): ScreenRef?
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
    private val layoutEvents: LayoutEvents? = null,
    private val periodicFallback: Boolean = false,
    hooksFactory: (ScreenTracker) -> FragmentHooks? = ::createFragmentHooks,
    private val clock: () -> Long = System::currentTimeMillis,
    ownership: AppOwnership = AppOwnership(),
) : Application.ActivityLifecycleCallbacks {
    private val resolver = ScreenResolver(ownership)
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

    @Volatile
    private var lastScreen: ScreenRef? = null
    private var wasForeground = false

    init {
        link.addWelcomeListener { main.post(welcomeChanged) }
    }

    val tracksFragments: Boolean
        get() = fragmentHooks != null

    /** Name of the last reported top screen (null when none); readable from any thread. */
    val currentScreenName: String?
        get() = lastScreen?.name

    /** Class name of the top started activity as of the last resolve; readable from any thread. */
    @Volatile
    var topActivityClassName: String? = null
        private set

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

    fun onDialogShown(fragment: Any, activity: Any?, window: Window, name: String) = guarded {
        dialogWindows?.onDialogShown(fragment, window, name)
        layoutEvents?.onDialogShown(fragment, activity, window, name)
    }

    fun onDialogHidden(fragment: Any) = guarded {
        dialogWindows?.onDialogHidden(fragment)
        layoutEvents?.onDialogHidden(fragment)
    }

    fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View) = guarded {
        layoutEvents?.onFragmentViewCreated(fragment, activity, view)
    }

    fun onFragmentViewDestroyed(fragment: Any) = guarded { layoutEvents?.onFragmentViewDestroyed(fragment) }

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
        topActivityClassName = resolver.topActivity?.javaClass?.name
        var target: Any? = null
        val screen = resolver.resolve(isShown, describe = { picked, kind ->
            target = picked
            describe(picked, kind)
        })
        if (screen == lastScreen) return
        lastScreen = screen
        link.onScreen(clock(), screen)
        layoutEvents?.onScreenChanged(screen, target)
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

/**
 * The only failure SDK code lets through: a genuine heap OutOfMemoryError. Everything else is contained, including a
 * failed thread start (an OutOfMemoryError from `pthread_create`) and other VirtualMachineErrors.
 */
internal fun isFatal(t: Throwable): Boolean = t is OutOfMemoryError && t.message?.contains("pthread_create") != true

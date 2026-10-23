package io.github.risyadul.lionscope

import android.app.Activity
import androidx.lifecycle.Lifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavDestination
import java.lang.ref.WeakReference

// Links against Navigation (compileOnly): only loaded once the app passed a NavController, or a NavBackStackEntry
// was found in a composition.

internal object NavigationScreens {
    private const val DIALOG_NAVIGATOR = "dialog"

    fun screenOf(destination: NavDestination): ScreenRef? =
        DestinationNames.screen(destination.route, destination.label?.toString(), destination.navigatorName == DIALOG_NAVIGATOR)

    /** The screen name of the destination [entry] (a NavBackStackEntry) is for. */
    fun destinationName(entry: Any): String? = (entry as? NavBackStackEntry)?.destination?.let(::screenOf)?.name
}

/**
 * NavControllers passed to `Lionscope.trackNavigation`, each with the Activity its context belongs to. An Activity's
 * screen is the destination of its newest tracked controller whose current entry is at least started, so a nested
 * NavHost wins while shown and its host's destination comes back once the nested one is gone. Nothing is held
 * strongly but the listener the controller itself holds. Main thread.
 */
internal class NavigationTracker(private val onChange: () -> Unit) : DestinationScreens {
    private class Tracked(controller: NavController, activity: Activity?, val order: Long) {
        val controller = WeakReference(controller)
        val activity = WeakReference(activity)

        @Volatile
        var screen: ScreenRef? = null
    }

    private val tracked = ArrayList<Tracked>()
    private var sequence = 0L

    /** Idempotent per controller; false when it cannot be tracked (too many controllers alive). */
    fun track(controller: NavController): Boolean {
        tracked.removeAll { entry ->
            val activity = entry.activity.get()
            entry.controller.get() == null || activity == null || activity.isDestroyed
        }
        if (tracked.any { it.controller.get() === controller }) return true
        if (tracked.size >= MAX_CONTROLLERS) return false
        val entry = Tracked(controller, activityOf(controller.context), ++sequence)
        tracked += entry
        // Called right away with the current destination, if any, then on every change (main thread).
        controller.addOnDestinationChangedListener { _, destination, _ ->
            guarded {
                entry.screen = NavigationScreens.screenOf(destination)
                onChange()
            }
        }
        return true
    }

    override fun screenFor(activity: Any): ScreenRef? {
        var best: Tracked? = null
        for (entry in tracked) {
            if (entry.activity.get() !== activity || entry.screen == null || !isShown(entry)) continue
            if (best == null || entry.order > best.order) best = entry
        }
        return best?.screen
    }

    private fun isShown(entry: Tracked): Boolean {
        val state = entry.controller.get()?.currentBackStackEntry?.lifecycle?.currentState ?: return false
        return state.isAtLeast(Lifecycle.State.STARTED)
    }

    private companion object {
        const val MAX_CONTROLLERS = 32
    }
}

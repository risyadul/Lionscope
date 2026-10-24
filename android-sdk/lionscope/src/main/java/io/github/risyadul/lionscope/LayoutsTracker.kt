package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.View
import android.view.Window

/**
 * The v3 layout features (main thread only): inflation timing through [InflateTracer] (API 29+, null below) and one
 * view tree snapshot per screen visit. It also knows the windows the Inspector walks below API 29 ([KnownWindows]). Snapshots are only taken on a session link at v3 (never an inspect-only one). Inflation tracking follows
 * the last `inflateTracking` a server sent in this process (on until then): it is not reset when the link drops, so
 * Activities created after it was turned off get no factory until a session turns it on again.
 */
internal class LayoutsTracker(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val reporter: InflateReporter,
    private val tracer: InflateHooks?,
    private val snapshotter: ViewTreeSnapshotter,
) : Application.ActivityLifecycleCallbacks, LayoutEvents, KnownWindows {
    private class Dialog(val window: Window, val name: String)

    private val started = ArrayList<Activity>()
    /** In show order; keys are DialogFragments, whose `equals` is identity (final in Fragment). */
    private val dialogs = LinkedHashMap<Any, Dialog>()
    private var screen: ScreenRef? = null
    private var screenTarget: Any? = null
    private var linkVersion = 0

    init {
        link.addSessionListener { welcomed ->
            val version = if (welcomed) link.negotiatedVersion ?: 0 else 0
            main.post(Runnable { guarded { onLinkChanged(version) } })
        }
        link.addConfigListener { options -> main.post(Runnable { guarded { onConfig(options) } }) }
    }

    override fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?) = guarded {
        tracer?.onActivityPreCreated(activity)
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) = guarded {
        tracer?.onActivityPostCreated(activity)
    }

    override fun onActivityStarted(activity: Activity) = guarded {
        started.remove(activity)
        started += activity
        tracer?.onActivityShown(activity)
    }

    override fun onActivityStopped(activity: Activity) = guarded { started.remove(activity) }

    override fun onActivityDestroyed(activity: Activity) = guarded {
        started.remove(activity)
        if (screenTarget === activity) screenTarget = null
    }

    override val hasStartedActivity: Boolean
        get() = started.isNotEmpty()

    override fun knownRoots(): List<View> {
        val roots = ArrayList<View>(dialogs.size + 1)
        started.lastOrNull()?.window?.peekDecorView()?.let(roots::add)
        for (dialog in dialogs.values) dialog.window.peekDecorView()?.let(roots::add)
        return roots
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = guarded { tracer?.onActivityShown(activity) }
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View) {
        tracer?.onFragmentViewCreated(fragment, activity, view)
    }

    override fun onFragmentViewDestroyed(fragment: Any) {
        tracer?.onFragmentViewDestroyed(fragment)
    }

    override fun onDialogShown(fragment: Any, activity: Any?, window: Window, name: String) {
        dialogs.remove(fragment) // Shown again: now the top-most.
        dialogs[fragment] = Dialog(window, name)
        tracer?.onDialogShown(fragment, activity, window)
    }

    override fun onDialogHidden(fragment: Any) {
        dialogs.remove(fragment)
    }

    override fun onScreenChanged(screen: ScreenRef?, target: Any?) {
        this.screen = screen
        screenTarget = target
        reporter.onScreenChanged()
        requestSnapshot()
    }

    private fun onLinkChanged(version: Int) {
        linkVersion = version
        reporter.setLink(version)
        // A newly connected dashboard has not seen the current screen's tree.
        if (version >= DEVICE_PROTOCOL_V3) requestSnapshot() else snapshotter.cancel()
    }

    /** `config` only arrives on v2+ links; a v2 server never sends `inflateTracking` (parsed as on). */
    private fun onConfig(options: SdkOptions) {
        reporter.setTracking(options.inflateTracking)
    }

    private fun requestSnapshot() {
        if (linkVersion < DEVICE_PROTOCOL_V3 || screen == null) return
        snapshotter.request(::snapshotTarget)
    }

    /** The dialog's window when a dialog screen is on top, else the top started activity's. */
    private fun snapshotTarget(): Pair<View, String>? {
        if (linkVersion < DEVICE_PROTOCOL_V3) return null
        if (screen?.kind == ScreenKind.DIALOG) {
            val dialog = screenTarget?.let { dialogs[it] }
            val decor = dialog?.window?.peekDecorView()
            if (dialog != null && decor != null) return decor to "Dialog · ${dialog.name.substringAfterLast('.')}"
        }
        val activity = started.lastOrNull() ?: return null
        val decor = activity.window?.peekDecorView() ?: return null
        return decor to ViewAccess.simpleName(activity.javaClass)
    }
}

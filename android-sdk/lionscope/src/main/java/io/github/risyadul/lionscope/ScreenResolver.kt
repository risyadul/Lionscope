package io.github.risyadul.lionscope

/**
 * Pure model of what is on top, fed by lifecycle events (keys are Activity / Fragment instances, compared by
 * identity). Top screen = the shown dialog or most recently resumed shown fragment of the top activity
 * (descending into its most recent child), else the top activity itself; null when no activity is started.
 * Names are computed by [resolve]'s `describe` for the final pick only, so dynamic aliases stay current.
 */
internal class ScreenResolver {
    private class ActivityEntry {
        var order = 0L
        var started = false
        var resumed = false
    }

    private class FragmentEntry(val activity: Any, val parent: Any?, val kind: ScreenKind, val order: Long) {
        var resumed = true
    }

    private val activities = HashMap<Any, ActivityEntry>()
    private val fragments = HashMap<Any, FragmentEntry>()
    private var sequence = 0L

    val hasStartedActivity: Boolean
        get() = activities.values.any { it.started }

    val hasResumedActivity: Boolean
        get() = activities.values.any { it.resumed }

    fun activityStarted(activity: Any) {
        val entry = activities.getOrPut(activity) { ActivityEntry() }
        entry.started = true
        entry.order = ++sequence
    }

    fun activityResumed(activity: Any) {
        activityStarted(activity)
        activities[activity]?.resumed = true
    }

    fun activityPaused(activity: Any) {
        activities[activity]?.resumed = false
    }

    fun activityStopped(activity: Any) {
        activities[activity]?.let {
            it.resumed = false
            it.started = false
        }
    }

    fun activityDestroyed(activity: Any) {
        activities.remove(activity)
        fragments.values.removeAll { it.activity === activity }
    }

    fun fragmentResumed(fragment: Any, activity: Any, parent: Any?, kind: ScreenKind) {
        fragments[fragment] = FragmentEntry(activity, parent, kind, ++sequence)
    }

    fun fragmentPaused(fragment: Any) {
        fragments[fragment]?.resumed = false
    }

    /** Fragment stopped, lost its view, was detached or destroyed. */
    fun fragmentGone(fragment: Any) {
        fragments.remove(fragment)
    }

    /**
     * [isShown] reports whether a tracked fragment is currently visible (has a view, not hidden, dialog showing);
     * [describe] names the winner.
     */
    fun resolve(isShown: (Any) -> Boolean, describe: (Any, ScreenKind) -> ScreenRef): ScreenRef? {
        val top = activities.entries.filter { it.value.started }.maxByOrNull { it.value.order } ?: return null
        val activity = top.value
        // While the activity itself is paused (e.g. mid-transition) its paused fragments still count.
        val eligible = fragments.entries.filter { (fragment, entry) ->
            entry.activity === top.key && (entry.resumed || !activity.resumed) && isShown(fragment)
        }
        val dialogs = eligible.filter { it.value.kind == ScreenKind.DIALOG }
        var pick = dialogs.ifEmpty { eligible }.maxByOrNull { it.value.order }
            ?: return describe(top.key, ScreenKind.ACTIVITY)
        for (depth in 0 until MAX_DEPTH) {
            val parent = pick.key
            val child = eligible.filter { it.value.parent === parent && it.key !== parent }.maxByOrNull { it.value.order }
                ?: break
            pick = child
        }
        return describe(pick.key, pick.value.kind)
    }

    private companion object {
        /** Guards against pathological (cyclic) parent links. */
        const val MAX_DEPTH = 32
    }
}

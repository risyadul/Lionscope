package io.github.risyadul.lionscope

/**
 * Pure model of what is on top, fed by lifecycle events (keys are Activity / Fragment instances, compared by
 * identity). A chain starts at a shown dialog, or at a shown fragment of the top activity (with its shown
 * ancestors), and descends into the most recent child. Top screen = the deepest *app-owned* fragment of the first
 * chain that has one, trying dialogs newest first, then the fragments beneath newest first; else the top activity
 * itself; null when no activity is started. Library fragments (maps, NavHostFragment, ...) are descended through
 * but never reported, so a library dialog or a newer top-level library fragment gives way to the app screen beneath.
 * App-owned is decided by [ownership] (top activity's or application id's two-segment package root). Names are
 * computed by [resolve]'s `describe` for the final pick only, so dynamic aliases stay current.
 */
internal class ScreenResolver(private val ownership: AppOwnership = AppOwnership()) {
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

    /** The most recently started activity that is still started, or null. */
    val topActivity: Any?
        get() = activities.entries.filter { it.value.started }.maxByOrNull { it.value.order }?.key

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
     * [describe] names the winner; [classNameOf] gives an instance's class name (decides app ownership).
     */
    fun resolve(
        isShown: (Any) -> Boolean,
        describe: (Any, ScreenKind) -> ScreenRef,
        classNameOf: (Any) -> String = { it.javaClass.name },
    ): ScreenRef? {
        val top = activities.entries.filter { it.value.started }.maxByOrNull { it.value.order } ?: return null
        val activity = top.value
        // While the activity itself is paused (e.g. mid-transition) its paused fragments still count.
        val eligible = fragments.entries.filter { (fragment, entry) ->
            entry.activity === top.key && (entry.resumed || !activity.resumed) && isShown(fragment)
        }
        val activityClass = classNameOf(top.key)
        val deepestAppOwned = { chain: List<Map.Entry<Any, FragmentEntry>> ->
            chain.lastOrNull { ownership.isOwned(classNameOf(it.key), activityClass) }
        }
        val (dialogs, others) = eligible.partition { it.value.kind == ScreenKind.DIALOG }
        for (dialog in dialogs.sortedByDescending { it.value.order }) {
            val pick = deepestAppOwned(descend(listOf(dialog), others)) ?: continue
            return describe(pick.key, pick.value.kind)
        }
        // A dialog's children live in its window: they never stand in for the screen beneath.
        val beneath = others.filter { !isUnderDialog(it.value) }
        // A newer library root (e.g. a top-level map beside the app's NavHost) must not hide an older app chain.
        for (root in beneath.sortedByDescending { it.value.order }) {
            val pick = deepestAppOwned(descend(ancestors(root, beneath), beneath)) ?: continue
            return describe(pick.key, pick.value.kind)
        }
        return describe(top.key, ScreenKind.ACTIVITY)
    }

    /** [entry] and its shown ancestors among [candidates], outermost first. */
    private fun ancestors(
        entry: Map.Entry<Any, FragmentEntry>,
        candidates: List<Map.Entry<Any, FragmentEntry>>,
    ): List<Map.Entry<Any, FragmentEntry>> {
        val chain = arrayListOf(entry)
        while (chain.size < MAX_DEPTH) {
            val parent = chain.last().value.parent ?: break
            val next = candidates.firstOrNull { it.key === parent } ?: break
            if (chain.any { it.key === next.key }) break
            chain += next
        }
        chain.reverse()
        return chain
    }

    /** Extends [chain] with the most recent shown child among [candidates], repeatedly. */
    private fun descend(
        chain: List<Map.Entry<Any, FragmentEntry>>,
        candidates: List<Map.Entry<Any, FragmentEntry>>,
    ): List<Map.Entry<Any, FragmentEntry>> {
        val result = ArrayList(chain)
        while (result.size < MAX_DEPTH) {
            val parent = result.last().key
            var newest: Map.Entry<Any, FragmentEntry>? = null
            for (candidate in candidates) {
                if (candidate.value.parent !== parent || candidate.key === parent) continue
                if (newest == null || candidate.value.order > newest.value.order) newest = candidate
            }
            val child = newest ?: break
            if (result.any { it.key === child.key }) break
            result += child
        }
        return result
    }

    private fun isUnderDialog(entry: FragmentEntry): Boolean {
        var parent = entry.parent
        repeat(MAX_DEPTH) {
            val parentEntry = fragments[parent ?: return false] ?: return false
            if (parentEntry.kind == ScreenKind.DIALOG) return true
            parent = parentEntry.parent
        }
        return false
    }

    private companion object {
        /** Guards against pathological (cyclic) parent links. */
        const val MAX_DEPTH = 32
    }
}

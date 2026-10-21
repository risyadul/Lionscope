package io.github.risyadul.lionscope

/**
 * Pure model of what is on top, fed by lifecycle events (keys are Activity / Fragment instances, compared by
 * identity). A chain starts at a shown dialog, or at a shown fragment of the top activity (with its shown
 * ancestors), and descends into the most recent child. Top screen = the deepest *app-owned* fragment of the first
 * chain that has one, trying dialogs newest first, then the fragments beneath newest first; else the top activity
 * itself; null when no activity is started. Library fragments (maps, NavHostFragment, ...) are descended through
 * but never reported, so a library dialog or a newer top-level library fragment gives way to the app screen beneath.
 * App-owned = shares the first two package segments with the top activity's class or with [applicationId] (see
 * [appPackagePrefix], [packagePrefix]). Names are computed by [resolve]'s `describe` for the final pick only, so
 * dynamic aliases stay current.
 */
internal class ScreenResolver(applicationId: String = "") {
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

    /** Covers modules named after the app id (white-label builds, acquired code); empty when unknown. */
    private val applicationPrefix = packagePrefix(applicationId)
    private var cachedActivityClass: String? = null
    private var cachedActivityPrefix = ""

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
        val activityPrefix = activityPrefix(classNameOf(top.key))
        val deepestAppOwned = { chain: List<Map.Entry<Any, FragmentEntry>> ->
            chain.lastOrNull { isOwned(classNameOf(it.key), activityPrefix) }
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

    private fun isOwned(className: String, activityPrefix: String): Boolean =
        isAppOwned(className, activityPrefix) ||
            (applicationPrefix.isNotEmpty() && isAppOwned(className, applicationPrefix))

    /** Single-entry cache: the top activity rarely changes between resolves. */
    private fun activityPrefix(className: String): String {
        if (className != cachedActivityClass) {
            cachedActivityPrefix = appPackagePrefix(className)
            cachedActivityClass = className
        }
        return cachedActivityPrefix
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

    internal companion object {
        /** Guards against pathological (cyclic) parent links. */
        private const val MAX_DEPTH = 32

        /** First two package segments of [activityClassName] (the whole package when it has fewer). */
        fun appPackagePrefix(activityClassName: String): String =
            packagePrefix(activityClassName.substringBeforeLast('.', ""))

        /** First two segments of [packageName] (all of it when it has fewer). */
        fun packagePrefix(packageName: String): String {
            val first = packageName.indexOf('.')
            if (first < 0) return packageName
            val second = packageName.indexOf('.', first + 1)
            return if (second < 0) packageName else packageName.substring(0, second)
        }

        /** True when [className] lives in [appPrefix] or below; an empty prefix (default package) owns everything. */
        fun isAppOwned(className: String, appPrefix: String): Boolean = appPrefix.isEmpty() ||
            (className.length > appPrefix.length && className.startsWith(appPrefix) && className[appPrefix.length] == '.')
    }
}

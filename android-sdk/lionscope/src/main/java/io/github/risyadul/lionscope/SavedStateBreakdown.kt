package io.github.risyadul.lionscope

/** What a [SavedStateEntry] is: a nested Bundle, a Fragment's saved state, or a plain value (leaf). */
internal enum class SavedStateKind(val wire: String) {
    BUNDLE("bundle"),
    FRAGMENT("fragment"),
    VALUE("value"),
}

/**
 * One key of a saved-state bundle, found at [path] (keys from the Activity's bundle down), and the bytes it takes in a
 * Parcel (key and value, nested content included). [fragment] is the Fragment class whose state holds it (or that it
 * is, for [SavedStateKind.FRAGMENT]); [valueClass] the value's class (`byte[]`, `android.os.Bundle`). Never values.
 */
internal class SavedStateEntry(
    val path: List<String>,
    val bytes: Int,
    val kind: SavedStateKind,
    val fragment: String?,
    val valueClass: String?,
)

/** How [SavedStateBreakdown] reads a saved state; [AndroidStateAccess] on a device, plain maps in unit tests. */
internal interface StateAccess {
    /** The named children of [value] when it is a container (a Bundle, a fragment manager or fragment state), else null. */
    fun children(value: Any): List<Pair<String, Any?>>?

    /** Bytes `key = value` take in a Parcel; -1 when it can't be written (then nothing below it is read). */
    fun entryBytes(key: String, value: Any?): Int

    /** The Fragment class [value] is the saved state of, else null. */
    fun fragmentClass(value: Any): String?

    /**
     * For a [value] that [fragmentClass] names: the key of its child that is that same Fragment's own record (1.5+: a
     * `fragment_<who>` Bundle keeps its FragmentState under `state`), or null when [value] is the record itself. Any
     * other Fragment state below it is another Fragment, whatever its class.
     */
    fun fragmentRecordKey(value: Any): String? = null

    fun valueClass(value: Any?): String?
}

/**
 * Recursive top-N attribution of a saved state: every key of at least [minEntryBytes] (key and value as parceled), down
 * to [maxDepth] levels, descending only into containers that big (small subtrees are never measured), at most
 * [maxVisited] keys measured in all. Read-only: [StateAccess] reads copies, never the bundle the system will send.
 */
internal class SavedStateBreakdown(
    private val access: StateAccess,
    private val minEntryBytes: Int = MIN_ENTRY_BYTES,
    private val maxEntries: Int = MAX_SAVED_STATE_ENTRIES,
    private val maxDepth: Int = MAX_SAVED_STATE_DEPTH,
    private val maxVisited: Int = MAX_VISITED,
) {
    class Result(val entries: List<SavedStateEntry>, val truncated: Boolean)

    fun of(root: Any): Result {
        val walk = Walk()
        walk.container(root, emptyList(), null)
        val sorted = walk.found.sortedWith(compareByDescending<SavedStateEntry> { it.bytes }.thenBy { it.path.size })
        return Result(sorted.take(maxEntries), walk.truncated || sorted.size > maxEntries)
    }

    private inner class Walk {
        val found = ArrayList<SavedStateEntry>()
        var truncated = false
        private var visited = 0

        fun container(value: Any, path: List<String>, owner: String?) {
            childrenOf(value)?.let { walk(it, path, owner, null) }
        }

        /**
         * [ownRecordKey]: the key under which the Fragment boundary these [children] belong to keeps its own record
         * (that child is the same Fragment, not a new one); null when they are not a boundary's children.
         */
        private fun walk(children: List<Pair<String, Any?>>, path: List<String>, owner: String?, ownRecordKey: String?) {
            for ((key, child) in children) {
                if (visited >= maxVisited) {
                    truncated = true
                    return
                }
                visited++
                val bytes = access.entryBytes(key, child)
                if (bytes < minEntryBytes) continue
                val grandchildren = child?.let(::childrenOf)
                val fragment = child?.let(::fragmentOf)
                // A boundary's own record is that Fragment again; any other Fragment state is a new instance, even of
                // the same class (a pager nesting its own kind).
                val ownRecord = ownRecordKey != null && key == ownRecordKey
                val kind = when {
                    fragment != null && !ownRecord -> SavedStateKind.FRAGMENT
                    grandchildren != null || fragment != null -> SavedStateKind.BUNDLE
                    else -> SavedStateKind.VALUE
                }
                val childOwner = if (ownRecord) owner else fragment ?: owner
                val childRecordKey = if (kind == SavedStateKind.FRAGMENT && child != null) recordKeyOf(child) else null
                val childPath = path + key
                found += SavedStateEntry(childPath, bytes, kind, childOwner, access.valueClass(child))
                if (grandchildren == null) continue
                if (childPath.size >= maxDepth) {
                    truncated = true
                } else {
                    walk(grandchildren, childPath, childOwner, childRecordKey)
                }
            }
        }

        private fun childrenOf(value: Any): List<Pair<String, Any?>>? = try {
            access.children(value)
        } catch (e: Exception) {
            null
        }

        private fun fragmentOf(value: Any): String? = try {
            access.fragmentClass(value)
        } catch (e: Exception) {
            null
        }

        private fun recordKeyOf(value: Any): String? = try {
            access.fragmentRecordKey(value)
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        /** Keys smaller than this are neither listed nor descended into. */
        const val MIN_ENTRY_BYTES = 1024
        const val MAX_VISITED = 2000
    }
}

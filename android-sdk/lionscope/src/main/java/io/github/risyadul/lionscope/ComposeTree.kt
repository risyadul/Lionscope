package io.github.risyadul.lionscope

import java.util.IdentityHashMap

/**
 * How much of the compositions one capture reads, shared by every AndroidComposeView in it: at most [maxGroups]
 * groups (a group costs a few µs on a phone) and until [maxMs] of main-thread time have passed, checked every
 * [CHECK_EVERY] groups.
 */
internal class ComposeBudget(
    private val maxGroups: Int = MAX_GROUPS,
    maxMs: Long = MAX_MS,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private val deadline = nanoTime() + maxMs * NANOS_PER_MS
    private var taken = 0
    private var expired = false

    /** False once the budget is spent. */
    fun take(): Boolean {
        if (expired || taken >= maxGroups) return false
        if (++taken % CHECK_EVERY == 0 && nanoTime() >= deadline) expired = true
        return !expired
    }

    internal companion object {
        const val MAX_GROUPS = 100_000
        const val MAX_MS = 200L
        const val CHECK_EVERY = 1_024
        private const val NANOS_PER_MS = 1_000_000L
    }
}

/** One composition's slot table and layout nodes as [ComposeTreeBuilder] reads them, so it can be tested on fakes. */
internal interface SlotTableAccess<G : Any, L : Any> {
    /** Child groups in slot order. */
    fun children(group: G): Iterable<G>
    fun sourceInfo(group: G): String?

    /** The layout node [group] emits, null for every other group. */
    fun layoutNode(group: G): L?

    /** The route of the navigation destination whose content a `LocalOwnersProvider` [group] provides, else null. */
    fun destination(group: G): String?

    /** Null for the owner's root. */
    fun parent(node: L): L?

    /** Placed and attached: laid out on screen. */
    fun isPlaced(node: L): Boolean

    /** Screen pixels, unclipped. */
    fun bounds(node: L): PixelRect
}

/**
 * A composable shown by the Inspector: its [name], call site, [destination] (the navigation route it is drawn for, if
 * any), [layouts] (the layout nodes it emits itself, not through a shown child), [children] (composables in call order,
 * then those of sub-compositions such as lazy list items by position, then any Views added by the caller) and
 * [bounds] (the union of its placed layout nodes and children).
 */
internal class ComposeNode(val name: String, val source: ComposableSource, val destination: String?) {
    val layouts = ArrayList<Any>()
    val children = ArrayList<Any>()
    internal val stitched = ArrayList<ComposeNode>()
    var bounds: PixelRect? = null
        internal set
}

/** What one AndroidComposeView's compositions map to; [truncated] when [ComposeTreeBuilder]'s group budget ran out. */
internal class ComposeTree(
    val roots: List<ComposeNode>,
    val truncated: Boolean,
    /** Whether any group had source information (none: compiled without it, so no composable can be named). */
    val hasSourceInfo: Boolean,
    private val owners: Map<Any, ComposeNode?>,
) {
    /** True when [layout] belongs to a composition that was read; [ownerOf] is then its shown composable, if any. */
    fun contains(layout: Any): Boolean = owners.containsKey(layout)

    fun ownerOf(layout: Any): ComposeNode? = owners[layout]
}

/**
 * Maps the compositions of one AndroidComposeView (its root composition and sub-compositions: lazy items, subcompose
 * layouts) onto [ComposeNode]s. A call's line comes from its parent group's call locations, its file from the nearest
 * group with one, and whether it is shown from [ComposableFilter]. Sub-compositions are hung under the composable
 * owning the layout node their nodes are placed in; a composition whose nodes belong to another owner (a dialog's
 * content, recorded in its parent's table too) is left out, as are composables with nothing placed. At most
 * what [budget] allows is read ([truncated] beyond). Iterative: no recursion on deep slot tables.
 */
internal class ComposeTreeBuilder<G : Any, L : Any>(
    private val access: SlotTableAccess<G, L>,
    private val budget: ComposeBudget = ComposeBudget(),
    private val filter: ComposableFilter = ComposableFilter(),
) {
    /** A group being walked: what its children inherit, how many calls they made so far, and the rest of them. */
    private class Frame<G>(
        val info: SourceInfo?,
        val file: String?,
        val packageHash: String?,
        val owner: ComposeNode?,
        val insideLayout: Boolean,
        val destination: String?,
        val children: Iterator<G>,
    ) {
        var calls = 0
    }

    private class Walked<L>(val top: List<ComposeNode>, val topLayouts: List<L>)

    private val parsed = HashMap<String, SourceInfo?>()
    private val owners = IdentityHashMap<Any, ComposeNode?>()
    private val compositionOf = IdentityHashMap<Any, Int>()
    private var truncated = false
    private var hasSourceInfo = false

    /** [compositions] are each one's top-level groups; [root] is the owner's root layout node. */
    fun build(compositions: List<Iterable<G>>, root: L): ComposeTree {
        val walked = compositions.mapIndexed { index, groups -> walk(index, groups) }
        val accepted = BooleanArray(walked.size)
        val roots = ArrayList<ComposeNode>()
        val stitchedRoots = ArrayList<ComposeNode>()
        for ((index, composition) in walked.withIndex()) {
            if (composition.topLayouts.firstOrNull()?.let(access::parent) !== root) continue
            accepted[index] = true
            roots += composition.top
        }
        // Each pass accepts the compositions placed in an accepted one; a cycle or a foreign owner never gets in.
        var changed = true
        while (changed) {
            changed = false
            for ((index, composition) in walked.withIndex()) {
                if (accepted[index]) continue
                val parent = composition.topLayouts.firstOrNull()?.let(access::parent) ?: continue
                val parentComposition = compositionOf[parent] ?: continue
                if (!accepted[parentComposition]) continue
                accepted[index] = true
                changed = true
                val host = owners[parent]
                if (host == null) stitchedRoots += composition.top else host.stitched += composition.top
            }
        }
        val acceptedOwners = IdentityHashMap<Any, ComposeNode?>()
        for ((layout, owner) in owners) if (accepted[compositionOf.getValue(layout)]) acceptedOwners[layout] = owner
        val placed = (roots + stitchedRoots).filter { measure(it) }
        val shown = placed.filter { it in roots } + placed.filter { it !in roots }.sortedWith(BY_POSITION)
        return ComposeTree(shown, truncated, hasSourceInfo, acceptedOwners)
    }

    /** Pre-order over the slot table, each frame iterating its group's children (no child lists are built). */
    private fun walk(index: Int, groups: Iterable<G>): Walked<L> {
        val top = ArrayList<ComposeNode>()
        val topLayouts = ArrayList<L>()
        val stack = arrayListOf(Frame(null, null, null, null, insideLayout = false, destination = null, groups.iterator()))
        while (stack.isNotEmpty()) {
            val parent = stack[stack.size - 1]
            if (!parent.children.hasNext()) {
                stack.removeAt(stack.size - 1)
                continue
            }
            if (!budget.take()) {
                truncated = true
                break
            }
            val group = parent.children.next()
            val info = access.sourceInfo(group)?.let { parsed.getOrPut(it) { SourceInfo.parse(it) } }
            if (info != null) hasSourceInfo = true
            var owner = parent.owner
            var destination = parent.destination
            if (info?.isCall == true) {
                val call = parent.calls++
                filter.learn(info, parent.packageHash)
                if (filter.isShown(info.name, parent.packageHash)) {
                    val node = ComposeNode(info.name!!, ComposableSource(parent.file, parent.info?.lineOfCall(call)), destination)
                    if (owner == null) top += node else owner.children += node
                    owner = node
                }
                if (info.name == NAVIGATION_OWNERS_PROVIDER) access.destination(group)?.let { destination = it }
            }
            var insideLayout = parent.insideLayout
            access.layoutNode(group)?.let { layout ->
                owners[layout] = owner
                compositionOf[layout] = index
                owner?.layouts?.add(layout)
                if (!insideLayout) topLayouts += layout
                insideLayout = true
            }
            stack += Frame(
                info = info,
                file = info?.file ?: parent.file,
                packageHash = if (info?.file != null) info.packageHash else parent.packageHash,
                owner = owner,
                insideLayout = insideLayout,
                destination = destination,
                children = access.children(group).iterator(),
            )
        }
        return Walked(top, topLayouts)
    }

    /**
     * Post-order: [ComposeNode.bounds] of [root] and its subtree, children without anything placed removed, the
     * stitched ones appended by position. False when nothing of [root] is placed.
     */
    private fun measure(root: ComposeNode): Boolean {
        val order = ArrayList<ComposeNode>()
        val stack = arrayListOf(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeAt(stack.size - 1)
            order += node
            for (child in node.children) if (child is ComposeNode) stack += child
            stack += node.stitched
        }
        for (node in order.asReversed()) {
            var bounds: PixelRect? = null
            for (layout in node.layouts) {
                @Suppress("UNCHECKED_CAST")
                val typed = layout as L
                if (access.isPlaced(typed)) bounds = union(bounds, access.bounds(typed))
            }
            node.children.removeAll { it is ComposeNode && it.bounds == null }
            node.stitched.removeAll { it.bounds == null }
            node.stitched.sortWith(BY_POSITION)
            node.children.addAll(node.stitched)
            node.stitched.clear()
            for (child in node.children) if (child is ComposeNode) bounds = union(bounds, child.bounds)
            node.bounds = bounds
        }
        return root.bounds != null
    }

    internal companion object {
        const val NAVIGATION_OWNERS_PROVIDER = "LocalOwnersProvider"

        private val BY_POSITION = compareBy<ComposeNode>({ it.bounds?.top }, { it.bounds?.left })

        fun union(a: PixelRect?, b: PixelRect?): PixelRect? = when {
            a == null -> b
            b == null -> a
            else -> PixelRect(minOf(a.left, b.left), minOf(a.top, b.top), maxOf(a.right, b.right), maxOf(a.bottom, b.bottom))
        }
    }
}

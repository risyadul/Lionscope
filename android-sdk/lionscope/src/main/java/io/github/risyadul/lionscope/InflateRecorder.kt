package io.github.risyadul.lionscope

import java.util.IdentityHashMap

/**
 * Turns the factory's per-view callbacks of one main-thread message into layout inflations. Pure (views, parsers
 * and parents are compared by identity only); main thread only. [finish] runs when the message ends: a
 * `LayoutInflater.inflate` call never spans two messages.
 *
 * Every parser (the `AttributeSet` handed to the factory) is one layout, measured from its first view's creation to
 * the end of its last one. A layout is nested in another (an `<include>`, or a layout a custom view's constructor
 * inflates into itself) when its first view's parent was created by that layout (or, for an included `<merge>`
 * level, shares a `<merge>` layout's parent) and that layout was provably still being parsed: its parser stood at
 * a start tag when the nested layout began ([Opening.parentParsing]: an `<include>` or a view being constructed),
 * or it created a view after the nested one's last (a compound view is recorded when its constructor returns).
 * Anything else is a layout of its own: a later, separate inflate into a finished layout (a fragment's view into the
 * activity's container) or into a layout's still detached root (items added to a list's root before it is
 * attached, a ViewHolder's own inflate into its itemView): their parser has reached its end tag. An `<include>` that
 * is the first child of a `<merge>` (no view of the merge layout yet) is reported as a separate layout: the
 * including layout's numbers are then a lower bound, never an over-count. A nested layout's views and time count
 * into its parent too; it is also reported under its own name. Layouts are recorded when their first view's
 * constructor returns, so a nested layout can be recorded before its parent (a compound view as a layout's root):
 * every pass therefore goes along the parent chain, never by recording order.
 *
 * Screens, in order: one assigned afterwards ([assignView], e.g. a fragment's root view, over [assignRoots], e.g. a
 * dialog's window: the more specific wins whatever the order); a nested
 * layout's parent's; for a root, the screen of a layout it was inflated during (e.g. by a custom view's
 * constructor); what [finish]'s `screenOf` finds for the view it was inflated into (the fragment holding a
 * RecyclerView); the creation scope it was recorded in (the Activity being created); [finish]'s fallback.
 */
internal class InflateRecorder<S : Any>(
    private val maxLayouts: Int = MAX_LAYOUTS,
    private val maxViews: Int = MAX_TRACKED_VIEWS,
) {
    /** What the factory knows about a layout when its first view has been created. */
    class Opening<S>(
        val source: S,
        /** The first view sits at depth 2 of its parser: the layout's root tag is `<merge>`. */
        val merge: Boolean,
        /** The parser of [parserAround]'s layout stood at a start tag when this layout's first view was created. */
        val parentParsing: Boolean,
        /** The creation scope (Activity being created) the first view was recorded in, if any. */
        val scope: String?,
    )

    class Inflation<S>(
        val source: S,
        val startNanos: Long,
        val durationNanos: Long,
        /** Own views plus those of the layouts nested in it. */
        val views: Int,
        val screen: String?,
        /** Nested in another layout through its views (an `<include>`, a compound view's own layout). */
        val isInclude: Boolean,
        /**
         * Inflated within another layout's inflation, so its time is already part of that one's: an include, or a
         * separate layout inflated meanwhile (e.g. by a widget's constructor into a view it built itself).
         */
        val isNested: Boolean,
    )

    private class Layout<S>(
        val source: S,
        val firstView: Any,
        val firstParent: Any?,
        val merge: Boolean,
        val parentParsing: Boolean,
        val startNanos: Long,
        val scope: String?,
    ) {
        var parser: Any? = null
        var assigned: String? = null
        /** [assigned] came from [assignView]: [assignRoots] leaves it alone. */
        var assignedByView = false
        var ownEndNanos = startNanos
        var ownViews = 1
        var parent: Layout<S>? = null
        var depth = 0
        var endNanos = 0L
        var views = 0
        var resolving = false
        var resolved = false
        var screen: String? = null

        /** The view this layout's views end up in when it is a root inflation. */
        val rootView: Any?
            get() = if (merge) firstParent else firstView
    }

    private val byParser = IdentityHashMap<Any, Layout<S>>()
    private val layouts = ArrayList<Layout<S>>()
    private val viewOwners = IdentityHashMap<Any, Layout<S>>()

    /** Views of layouts beyond [maxLayouts] in one message, ignored. */
    var droppedViews = 0
        private set

    val isEmpty: Boolean
        get() = layouts.isEmpty()

    /** One view of [parser], created between [startNanos] and [endNanos]; [open] runs for a parser's first view. */
    fun onView(parser: Any, view: Any, parent: Any?, startNanos: Long, endNanos: Long, open: () -> Opening<S>) {
        var layout = byParser[parser]
        if (layout == null) {
            if (layouts.size >= maxLayouts) {
                droppedViews++
                return
            }
            val opening = open()
            layout = Layout(opening.source, view, parent, opening.merge, opening.parentParsing, startNanos, opening.scope)
            layout.parser = parser
            byParser[parser] = layout
            layouts += layout
        } else {
            layout.ownViews++
        }
        layout.ownEndNanos = endNanos
        if (viewOwners.size < maxViews) viewOwners[view] = layout
    }

    /**
     * The parser of the layout a new layout inflated into [parent] could be nested in: the one that created
     * [parent], else the latest `<merge>` layout whose views go into [parent]. Asked before that layout's first view.
     */
    fun parserAround(parent: Any?): Any? {
        if (parent == null) return null
        viewOwners[parent]?.let { return it.parser }
        var best: Layout<S>? = null
        for (candidate in layouts) {
            if (!candidate.merge || candidate.firstParent !== parent) continue
            if (best == null || candidate.startNanos > best.startNanos) best = candidate
        }
        return best?.parser
    }

    /** Gives [screen] to the layout that created [view] (a fragment's root view). */
    fun assignView(view: Any, screen: String) {
        val layout = viewOwners[view] ?: return
        layout.assigned = screen
        layout.assignedByView = true
    }

    /**
     * Gives [screen] to every layout whose root view [matches] (e.g. lies in a dialog's window), except those
     * [assignView] already gave one (a child fragment hosted in a dialog keeps its own).
     */
    fun assignRoots(screen: String, matches: (rootView: Any) -> Boolean) {
        for (layout in layouts) {
            if (layout.assignedByView) continue
            val root = layout.rootView ?: continue
            if (matches(root)) layout.assigned = screen
        }
    }

    /**
     * Ends the message: returns every layout of it, roots and nested ones, in order of recording; then resets.
     * [screenOf] names the screen holding the view a root layout was inflated into (null: unknown); [fallback] is
     * the screen of a root nothing else attributes.
     */
    fun finish(fallback: String? = null, screenOf: (parent: Any?) -> String? = { null }): List<Inflation<S>> {
        if (layouts.isEmpty()) return emptyList()
        for (layout in layouts) {
            layout.parent = parentOf(layout)
            layout.endNanos = layout.ownEndNanos
            layout.views = layout.ownViews
        }
        for (layout in layouts) layout.depth = depthOf(layout)
        // Deepest first: a layout's subtree is complete before it is folded into its parent.
        for (layout in layouts.sortedByDescending { it.depth }) {
            val parent = layout.parent ?: continue
            parent.views += layout.views
            if (layout.endNanos > parent.endNanos) parent.endNanos = layout.endNanos
        }
        val result = ArrayList<Inflation<S>>(layouts.size)
        for (layout in layouts) {
            result += Inflation(
                source = layout.source,
                startNanos = layout.startNanos,
                durationNanos = layout.endNanos - layout.startNanos,
                views = layout.views,
                screen = resolve(layout, fallback, screenOf),
                isInclude = layout.parent != null,
                isNested = layout.parent != null || enclosing(layout) != null,
            )
        }
        clear()
        return result
    }

    fun clear() {
        byParser.clear()
        layouts.clear()
        viewOwners.clear()
        droppedViews = 0
    }

    private fun parentOf(layout: Layout<S>): Layout<S>? {
        val parentView = layout.firstParent ?: return null
        val owner = viewOwners[parentView]
        if (owner != null && owner !== layout) {
            val stillParsing = layout.parentParsing || owner.ownEndNanos > layout.ownEndNanos
            return if (stillParsing && owner.startNanos <= layout.startNanos) owner else null
        }
        // Latest-starting `<merge>` layout around the same parent that was still parsing.
        var best: Layout<S>? = null
        for (candidate in layouts) {
            if (candidate === layout || !candidate.merge || candidate.firstParent !== parentView) continue
            if (candidate.startNanos > layout.startNanos) continue
            if (!layout.parentParsing && candidate.ownEndNanos <= layout.ownEndNanos) continue
            if (best == null || candidate.startNanos > best.startNanos) best = candidate
        }
        return best
    }

    /** Distance to the root; a (pathological) cycle is cut at [MAX_NESTING]. */
    private fun depthOf(layout: Layout<S>): Int {
        var depth = 0
        var current = layout.parent
        while (current != null && depth < MAX_NESTING) {
            depth++
            current = current.parent
        }
        if (current != null) layout.parent = null
        return if (current != null) 0 else depth
    }

    private fun resolve(layout: Layout<S>, fallback: String?, screenOf: (Any?) -> String?): String? {
        if (layout.resolved) return layout.screen
        if (layout.resolving) return null // Cycle through `enclosing`: give up on this branch.
        layout.resolving = true
        val parent = layout.parent
        val screen = layout.assigned
            ?: parent?.let { resolve(it, fallback, screenOf) }
            ?: if (parent != null) {
                null
            } else {
                enclosing(layout)?.let { resolve(it, fallback, screenOf) }
                    ?: screenOf(layout.firstParent)
                    ?: layout.scope
                    ?: fallback
            }
        layout.resolving = false
        layout.resolved = true
        layout.screen = screen
        return screen
    }

    /** The innermost other layout whose time span contains [layout]'s. */
    private fun enclosing(layout: Layout<S>): Layout<S>? {
        var best: Layout<S>? = null
        for (candidate in layouts) {
            if (candidate === layout) continue
            if (candidate.startNanos > layout.startNanos || candidate.endNanos < layout.endNanos) continue
            if (best == null || candidate.startNanos > best.startNanos ||
                (candidate.startNanos == best.startNanos && candidate.endNanos < best.endNanos)
            ) {
                best = candidate
            }
        }
        return best
    }

    internal companion object {
        const val MAX_LAYOUTS = 256
        const val MAX_TRACKED_VIEWS = 8_192
        private const val MAX_NESTING = 64
    }
}

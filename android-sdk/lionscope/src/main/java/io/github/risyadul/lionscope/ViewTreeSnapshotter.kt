package io.github.risyadul.lionscope

import android.content.res.Resources
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup

/** A view hierarchy as [ViewTreeWalker] sees it, so the walk can be tested on a fake tree. */
internal interface TreeAccess<T : Any> {
    fun childCount(node: T): Int
    fun childAt(node: T, index: Int): T?
    fun parentOf(node: T): T?
    fun isGroup(node: T): Boolean
    fun className(node: T): String

    /** Only asked for the nodes of the deepest path. */
    fun idName(node: T): String?
}

internal class ViewTreeStats(
    val views: Int,
    val viewGroups: Int,
    val maxDepth: Int,
    val deepestPath: List<ViewPathNode>,
    val topClasses: List<ClassCount>,
)

/** Iterative (no recursion) walk of a hierarchy, at most [MAX_VIEWS] nodes; the root has depth 1. */
internal object ViewTreeWalker {
    const val MAX_VIEWS = 20_000

    fun <T : Any> walk(root: T, access: TreeAccess<T>, maxViews: Int = MAX_VIEWS): ViewTreeStats {
        val nodes = ArrayList<T>()
        val depths = ArrayList<Int>()
        val classes = HashMap<String, Int>()
        nodes += root
        depths += 1
        var views = 0
        var viewGroups = 0
        var maxDepth = 0
        var deepest = root
        while (nodes.isNotEmpty() && views < maxViews) {
            val node = nodes.removeAt(nodes.size - 1)
            val depth = depths.removeAt(depths.size - 1)
            views++
            val name = access.className(node)
            classes[name] = (classes[name] ?: 0) + 1
            if (depth > maxDepth) {
                maxDepth = depth
                deepest = node
            }
            if (!access.isGroup(node)) continue
            viewGroups++
            // Reversed, so children are visited first to last (the first deepest view wins a tie).
            for (index in access.childCount(node) - 1 downTo 0) {
                val child = access.childAt(node, index) ?: continue
                nodes += child
                depths += depth + 1
            }
        }
        return ViewTreeStats(views, viewGroups, maxDepth, pathTo(root, deepest, access), topClasses(classes))
    }

    /** Root first, at most [MAX_VIEW_PATH_NODES] nodes: the deepest ones are kept. */
    private fun <T : Any> pathTo(root: T, deepest: T, access: TreeAccess<T>): List<ViewPathNode> {
        val path = ArrayList<ViewPathNode>()
        var node: T? = deepest
        while (node != null && path.size < MAX_VIEW_PATH_NODES) {
            path += ViewPathNode(access.className(node), access.idName(node))
            if (node === root) break
            node = access.parentOf(node)
        }
        path.reverse()
        return path
    }

    private fun topClasses(classes: Map<String, Int>): List<ClassCount> = classes.entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        .take(MAX_VIEW_TREE_CLASSES)
        .map { ClassCount(it.key, it.value) }
}

/** [TreeAccess] over real views; class names are cached per walk. */
internal class ViewAccess : TreeAccess<View> {
    private val names = HashMap<Class<*>, String>()

    override fun childCount(node: View): Int = (node as? ViewGroup)?.childCount ?: 0
    override fun childAt(node: View, index: Int): View? = (node as ViewGroup).getChildAt(index)
    override fun parentOf(node: View): View? = node.parent as? View
    override fun isGroup(node: View): Boolean = node is ViewGroup

    override fun className(node: View): String = names.getOrPut(node.javaClass) { simpleName(node.javaClass) }

    override fun idName(node: View): String? {
        val id = node.id
        // Generated ids (View.generateViewId) have no package byte and no resource name.
        if (id == View.NO_ID || id ushr 24 == 0) return null
        return try {
            node.resources?.getResourceEntryName(id)
        } catch (e: Resources.NotFoundException) {
            null
        }
    }

    companion object {
        /** Anonymous / local classes have no simple name: their binary name after the package. */
        fun simpleName(type: Class<*>): String = type.simpleName.ifEmpty { type.name.substringAfterLast('.') }
    }
}

/**
 * Takes one view tree snapshot per [request]: after the next frame, on the following main-thread idle, so the new
 * screen has been laid out and the walk does not delay its first frame. A newer request (or [cancel]) replaces a
 * pending one. Main thread only; [target] is evaluated when the snapshot is taken (null = nothing to walk).
 */
internal class ViewTreeSnapshotter(
    private val link: LinkPort,
    private val screenName: () -> String?,
    private val afterFrameAndIdle: (Runnable) -> Unit = ::afterNextFrameAndIdle,
    private val wallMs: () -> Long = System::currentTimeMillis,
) {
    private var generation = 0

    fun request(target: () -> Pair<View, String>?) {
        val requested = ++generation
        afterFrameAndIdle(Runnable { guarded { if (requested == generation) snapshot(target) } })
    }

    fun cancel() {
        generation++
    }

    private fun snapshot(target: () -> Pair<View, String>?) {
        val (root, window) = target() ?: return
        val stats = ViewTreeWalker.walk(root, ViewAccess())
        val ts = wallMs()
        val screen = screenName()
        link.sendV3(SIZE_HINT) {
            DeviceMessages.viewTree(
                ts = ts,
                screen = screen,
                window = window,
                views = stats.views,
                viewGroups = stats.viewGroups,
                maxDepth = stats.maxDepth,
                deepestPath = stats.deepestPath,
                topClasses = stats.topClasses,
            )
        }
    }

    private companion object {
        const val SIZE_HINT = 4 * 1024

        /** Main thread: the frame callback runs before that frame's traversal, so post once more, then wait for idle. */
        fun afterNextFrameAndIdle(task: Runnable) {
            val handler = Handler(Looper.getMainLooper())
            Choreographer.getInstance().postFrameCallback {
                handler.post {
                    Looper.myQueue().addIdleHandler {
                        task.run()
                        false
                    }
                }
            }
        }
    }
}

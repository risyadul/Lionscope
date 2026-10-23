package io.github.risyadul.lionscope

/** One window to walk: its root, `WindowManager.LayoutParams.type`, screen bounds and owning Activity's class. */
internal class WindowRoot<T : Any>(val root: T, val type: Int?, val bounds: PixelRect, val activity: String?)

/** What [InspectorWalker] reads of one node: everything but its place in the tree, owners and visible bounds. */
internal class NodeAttributes(
    val className: String,
    val resourceId: String?,
    val text: String?,
    val contentDescription: String?,
    val bounds: PixelRect,
    val visibility: ViewVisibility,
    val alpha: Double,
    val enabled: Boolean,
    val clickable: Boolean,
    val focused: Boolean,
    val selected: Boolean,
    val checked: Boolean?,
    val padding: PixelRect,
    val margin: PixelRect?,
    val layoutWidth: String?,
    val layoutHeight: String?,
    val source: ViewSource?,
)

/** A view hierarchy as [InspectorWalker] sees it, so the capture can be tested on a fake tree. */
internal interface InspectorTreeAccess<T : Any> {
    /** In drawing order: a later child draws over an earlier one. */
    fun children(node: T): List<T>
    fun className(node: T): String

    /** Only asked for the nodes that are kept. */
    fun read(node: T): NodeAttributes

    /** The Fragment whose view (or dialog window) [node] is the root of, else null: its subtree inherits it. */
    fun fragmentRootOf(node: T): String?
}

internal class InspectorCapture(
    val windows: List<InspectorWindow>,
    val nodes: List<InspectorNode>,
    val truncated: Boolean,
    val compose: Boolean,
)

/**
 * Walks windows into Inspector nodes, emitted bottom-most window first: ids are pre-order indexes over all windows, a
 * window's root has no parent, and siblings are in drawing order, so of two overlapping nodes the later one is on top.
 * Budgets go to the top-most windows first (what the user sees: a dialog, a popup), each window below keeping room for
 * at least its root: at most [maxWalk] nodes are walked and [maxNodes] kept, a window over its share dropping its
 * deepest nodes first (at the cut depth, the last ones in pre-order), so every kept node keeps its parent. Only the
 * top-most [MAX_INSPECTOR_WINDOWS] windows are walked. Any of these cuts marks the capture truncated. Visible bounds
 * are the bounds clipped to the parent's visible bounds (the window's and the screen's for a root), null for a view
 * that is not visible or has nothing on screen. Iterative: no recursion on deep trees.
 */
internal object InspectorWalker {
    const val MAX_WALK = 50_000
    const val COMPOSE_VIEW = "androidx.compose.ui.platform.AndroidComposeView"

    private class Entry<T>(val node: T, val depth: Int, val parent: Int, val window: Int)

    private class Walked<T>(val entries: List<Entry<T>>, val complete: Boolean, val compose: Boolean)

    fun <T : Any> capture(
        windows: List<WindowRoot<T>>,
        screen: PixelRect,
        access: InspectorTreeAccess<T>,
        maxNodes: Int = MAX_INSPECTOR_NODES,
        maxWalk: Int = MAX_WALK,
    ): InspectorCapture {
        val shown = windows.takeLast(MAX_INSPECTOR_WINDOWS)
        val walked = arrayOfNulls<Walked<T>>(shown.size)
        val kept = arrayOfNulls<BooleanArray>(shown.size)
        var walkLeft = maxWalk
        var nodesLeft = maxNodes
        for (window in shown.indices.reversed()) {
            // `window` windows lie below this one: each keeps room for its root.
            val walk = walk(shown[window].root, window, access, (walkLeft - window).coerceAtLeast(1))
            val keep = keep(walk.entries, (nodesLeft - window).coerceAtLeast(1))
            walked[window] = walk
            kept[window] = keep
            walkLeft -= walk.entries.size
            nodesLeft -= keep.count { it }
        }
        val entries = ArrayList<Entry<T>>()
        val keptAll = ArrayList<Boolean>()
        for (window in shown.indices) {
            val offset = entries.size
            for (entry in walked[window]!!.entries) {
                entries += Entry(entry.node, entry.depth, if (entry.parent < 0) -1 else entry.parent + offset, window)
            }
            kept[window]!!.forEach { keptAll += it }
        }
        val keptArray = keptAll.toBooleanArray()
        return InspectorCapture(
            windows = shown.mapIndexed { id, root -> InspectorWindow(id, root.type, root.bounds) },
            nodes = nodes(entries, keptArray, shown, screen, access),
            truncated = shown.size < windows.size || walked.any { !it!!.complete } || keptArray.any { !it },
            compose = walked.any { it!!.compose },
        )
    }

    /** Pre-order walk of one window, at most [limit] nodes; parents are indexes in this window's list. */
    private fun <T : Any> walk(root: T, window: Int, access: InspectorTreeAccess<T>, limit: Int): Walked<T> {
        val entries = ArrayList<Entry<T>>()
        val stack = ArrayList<Entry<T>>()
        var compose = false
        stack += Entry(root, 0, -1, window)
        while (stack.isNotEmpty()) {
            if (entries.size >= limit) return Walked(entries, complete = false, compose = compose)
            val popped = stack.removeAt(stack.size - 1)
            val index = entries.size
            entries += popped
            if (!compose && access.className(popped.node) == COMPOSE_VIEW) compose = true
            // Reversed, so children are visited first to last (pre-order).
            val children = access.children(popped.node)
            for (child in children.indices.reversed()) stack += Entry(children[child], popped.depth + 1, index, window)
        }
        return Walked(entries, complete = true, compose = compose)
    }

    /** Which entries stay: every depth that fits whole, then the first ones (pre-order) of the next depth. */
    private fun <T> keep(entries: List<Entry<T>>, maxNodes: Int): BooleanArray {
        val kept = BooleanArray(entries.size) { true }
        if (entries.size <= maxNodes) return kept
        val perDepth = IntArray((entries.maxOfOrNull { it.depth } ?: 0) + 1)
        for (entry in entries) perDepth[entry.depth]++
        var fullDepth = -1
        var total = 0
        while (fullDepth + 1 < perDepth.size && total + perDepth[fullDepth + 1] <= maxNodes) {
            fullDepth++
            total += perDepth[fullDepth]
        }
        var partial = maxNodes - total
        for ((index, entry) in entries.withIndex()) {
            kept[index] = entry.depth <= fullDepth || (entry.depth == fullDepth + 1 && partial-- > 0)
        }
        return kept
    }

    private fun <T : Any> nodes(
        entries: List<Entry<T>>,
        kept: BooleanArray,
        windows: List<WindowRoot<T>>,
        screen: PixelRect,
        access: InspectorTreeAccess<T>,
    ): List<InspectorNode> {
        val ids = IntArray(entries.size) { -1 }
        val owners = arrayOfNulls<String>(entries.size)
        val visible = arrayOfNulls<PixelRect>(entries.size)
        val windowClips = windows.map { intersect(it.bounds, screen) }
        val nodes = ArrayList<InspectorNode>(kept.count { it })
        for ((index, entry) in entries.withIndex()) {
            if (!kept[index]) continue
            val attributes = access.read(entry.node)
            val parent = entry.parent
            val clip = if (parent < 0) windowClips[entry.window] else visible[parent]
            owners[index] = access.fragmentRootOf(entry.node) ?: if (parent < 0) null else owners[parent]
            visible[index] = if (attributes.visibility != ViewVisibility.VISIBLE || clip == null) {
                null
            } else {
                intersect(attributes.bounds, clip)
            }
            ids[index] = nodes.size
            nodes += InspectorNode(
                id = nodes.size,
                parent = if (parent < 0) null else ids[parent],
                window = entry.window,
                className = attributes.className,
                resourceId = attributes.resourceId,
                text = attributes.text,
                contentDescription = attributes.contentDescription,
                bounds = attributes.bounds,
                visibleBounds = visible[index],
                visibility = attributes.visibility,
                alpha = attributes.alpha,
                enabled = attributes.enabled,
                clickable = attributes.clickable,
                focused = attributes.focused,
                selected = attributes.selected,
                checked = attributes.checked,
                padding = attributes.padding,
                margin = attributes.margin,
                layoutWidth = attributes.layoutWidth,
                layoutHeight = attributes.layoutHeight,
                source = attributes.source,
                fragment = owners[index],
                activity = windows[entry.window].activity,
            )
        }
        return nodes
    }

    /** Null when nothing is left (an empty or zero-size intersection). */
    fun intersect(a: PixelRect, b: PixelRect?): PixelRect? {
        if (b == null) return null
        val left = maxOf(a.left, b.left)
        val top = maxOf(a.top, b.top)
        val right = minOf(a.right, b.right)
        val bottom = minOf(a.bottom, b.bottom)
        return if (right > left && bottom > top) PixelRect(left, top, right, bottom) else null
    }
}

/** The app's windows as the Inspector captures them (main thread). */
internal interface InspectorScene<T : Any> {
    /** False while no Activity of the app is started (the app is in the background). */
    val isForeground: Boolean

    /** The visible windows, bottom-most first, and how to read them; null when there is none. */
    fun prepare(): PreparedScene<T>?
}

internal class PreparedScene<T : Any>(
    val windows: List<WindowRoot<T>>,
    val display: InspectorDisplay,
    val access: InspectorTreeAccess<T>,
)

/** A capture ready to be sent: everything was read on the main thread. */
internal class InspectSnapshot(
    val requestId: Int,
    val ts: Long,
    val screen: String?,
    val display: InspectorDisplay,
    val capture: InspectorCapture,
    val captureMs: Double,
)

/**
 * Answers the server's `inspect` requests (v4 links): the scene is captured on the main thread, then encoded and
 * sent off it by [sender]. One snapshot is sent at a time: a newer request abandons the one still being sent (the
 * server has given up on it), and its lines stop before the new snapshot's begin.
 */
internal class Inspector<T : Any>(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val scene: InspectorScene<T>,
    private val screenName: () -> String?,
    private val sender: InspectSender = InspectSender(link),
    private val inBackground: (Runnable) -> Unit = ::startSenderThread,
    private val nanoTime: () -> Long = System::nanoTime,
    private val wallMs: () -> Long = System::currentTimeMillis,
) {
    init {
        link.addInspectListener { requestId -> main.post(Runnable { guarded { inspect(requestId) } }) }
    }

    /** Main thread. */
    fun inspect(requestId: Int) {
        if (!DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V4)) return
        sender.abandon()
        if (!scene.isForeground) return reply(requestId, InspectError.BACKGROUND)
        val ts = wallMs()
        val start = nanoTime()
        val prepared: PreparedScene<T>
        val capture: InspectorCapture
        try {
            prepared = scene.prepare()?.takeIf { it.windows.isNotEmpty() } ?: return reply(requestId, InspectError.NO_WINDOW)
            val display = prepared.display
            capture = InspectorWalker.capture(prepared.windows, PixelRect(0, 0, display.width, display.height), prepared.access)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            return reply(requestId, InspectError.FAILED)
        }
        val captureMs = (nanoTime() - start) / NANOS_PER_MS
        val snapshot = InspectSnapshot(requestId, ts, screenName(), prepared.display, capture, captureMs)
        val send = sender.prepare(snapshot)
        try {
            inBackground(send)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            reply(requestId, InspectError.FAILED)
        }
    }

    private fun reply(requestId: Int, reason: InspectError) {
        link.sendV4(ERROR_SIZE_HINT) { DeviceMessages.inspectError(requestId, reason) }
    }

    private companion object {
        const val NANOS_PER_MS = 1_000_000.0
        const val ERROR_SIZE_HINT = 64

        fun startSenderThread(task: Runnable) {
            val thread = Thread({
                try {
                    lowerThreadPriority()
                    task.run()
                } catch (t: Throwable) {
                    // Never let SDK failures reach the app's uncaught-exception handler.
                }
            }, "lionscope-inspect")
            thread.isDaemon = true
            thread.start()
        }
    }
}

/**
 * Encodes a snapshot into `inspectBegin` and `inspectNodes` lines (chunks of at most [maxChunkBytes]) and queues them
 * at most one per [lineIntervalMs] (≤ 40 lines/s, across snapshots too), stopping when the link no longer speaks v4
 * or the snapshot was [abandon]ed. If encoding fails or the answer would exceed [maxAnswerBytes] (newline included),
 * nothing but an `inspectError` (`failed`) is sent. [prepare] is called on
 * the main thread; the task it returns runs on a background thread.
 */
internal class InspectSender(
    private val link: LinkPort,
    private val sleepMs: (Long) -> Unit = Thread::sleep,
    private val nanoTime: () -> Long = System::nanoTime,
    private val maxChunkBytes: Int = MAX_INSPECT_CHUNK_BYTES,
    private val lineIntervalMs: Long = LINE_INTERVAL_MS,
    private val maxAnswerBytes: Int = MAX_INSPECT_ANSWER_BYTES,
) {
    private val lock = Any()
    /** Bumped by [abandon] and [prepare]: a task only sends while it is the current one. */
    private var generation = 0L
    private var lastLineNanos: Long? = null

    /** Stops the snapshot being sent, if any, before its next line. */
    fun abandon() {
        synchronized(lock) { generation++ }
    }

    fun prepare(snapshot: InspectSnapshot): Runnable {
        val mine = synchronized(lock) { ++generation }
        return Runnable { send(snapshot, mine) }
    }

    private fun send(snapshot: InspectSnapshot, mine: Long) {
        val lines = try {
            // The server would reject a larger answer after it was streamed: fail it right away instead.
            encode(snapshot).takeIf { lines -> lines.sumOf { StackFrames.utf8Length(it) + 1 } <= maxAnswerBytes }
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            null
        } ?: listOf(DeviceMessages.inspectError(snapshot.requestId, InspectError.FAILED))
        for (line in lines) {
            pace()
            synchronized(lock) {
                if (generation != mine || !DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V4)) return
                link.sendV4(line.length) { line }
                lastLineNanos = nanoTime()
            }
        }
    }

    /** Waits until [lineIntervalMs] after the last line queued by any snapshot. */
    private fun pace() {
        val last = synchronized(lock) { lastLineNanos } ?: return
        val waitMs = lineIntervalMs - (nanoTime() - last) / NANOS_PER_MS
        if (waitMs > 0) sleepMs(waitMs)
    }

    private fun encode(snapshot: InspectSnapshot): List<String> {
        val capture = snapshot.capture
        val lines = ArrayList<String>()
        lines += DeviceMessages.inspectBegin(
            requestId = snapshot.requestId,
            ts = snapshot.ts,
            screen = snapshot.screen,
            display = snapshot.display,
            windows = capture.windows,
            nodeCount = capture.nodes.size,
            truncated = capture.truncated,
            captureMs = snapshot.captureMs,
            compose = capture.compose,
        )
        lines += DeviceMessages.inspectChunks(snapshot.requestId, capture.nodes, maxChunkBytes)
        return lines
    }

    internal companion object {
        /** 40 lines per second. */
        const val LINE_INTERVAL_MS = 25L
        private const val NANOS_PER_MS = 1_000_000L
    }
}

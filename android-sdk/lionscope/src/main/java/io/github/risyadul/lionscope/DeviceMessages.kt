package io.github.risyadul.lionscope

import android.view.ViewGroup

/**
 * Encoders for SDK → server lines (no trailing newline). Field order matches the golden fixtures. They also enforce
 * the server's bounds (see protocol/src/wire.ts): SDK-produced text via [WireText], numbers clamped, at most
 * [MAX_STACK_FRAMES] frames, so no field can get a message rejected or the link closed. `hello`'s package and
 * process names come from the system and are sent as they are.
 */
internal object DeviceMessages {
    private const val MAX_NAME_LENGTH = 256
    private const val MAX_SCREEN_NAME_LENGTH = 256
    private const val MAX_WINDOW_LENGTH = 256
    private const val VIOLATION_FALLBACK = "Violation"
    private const val MAX_FILE_LENGTH = 128
    private const val MAX_VIOLATION_LENGTH = 128
    private const val MAX_MESSAGE_LENGTH = 256
    private const val MAX_SCREEN_LENGTH = 256
    private const val MAX_STALL_MS = 60_000.0
    private const val MAX_SAMPLES = 10_000
    private const val MAX_COUNT = 1_000_000
    private const val NATIVE_LINE = -2
    /** v3 text fields (layout, label, screen, window, class names, ids). */
    private const val MAX_V3_TEXT_LENGTH = 200
    private const val MAX_INFLATE_MS = 60_000.0
    /** View tree path class / id names: shorter than other v3 text, so 64 nodes stay far below the line limit. */
    private const val MAX_PATH_TEXT_LENGTH = 80
    /** v4 Inspector text (TextView text, content descriptions); names (classes, ids, layouts) use [MAX_V3_TEXT_LENGTH]. */
    private const val MAX_INSPECTOR_TEXT_LENGTH = 500
    private const val MAX_INSPECTOR_PIXELS = 100_000
    private const val MAX_INSPECTOR_DISPLAY_PX = 20_000
    private const val MAX_WINDOW_TYPE = 10_000
    private const val MAX_CAPTURE_MS = 60_000.0
    /** `<n>px` layout sizes: at most 6 digits on the wire. */
    private const val MAX_LAYOUT_PX = 999_999
    private const val MATCH_PARENT = "match_parent"
    private const val WRAP_CONTENT = "wrap_content"
    private val LAYOUT_PX = Regex("-?\\d{1,6}px")

    fun hello(
        packageName: String,
        processName: String,
        pid: Int,
        apiLevel: Int,
        deviceWallMs: Long,
        refreshRateHz: Double,
        protocolVersion: Int = DEVICE_PROTOCOL_VERSION,
        sdkVersion: String = Lionscope.VERSION,
        nonce: String? = null,
    ): String {
        val json = JsonWriter().beginObject()
            .name("type").value("hello")
            .name("protocolVersion").value(protocolVersion)
            .name("sdkVersion").value(sdkVersion)
            .name("packageName").value(packageName)
            .name("processName").value(processName)
            .name("pid").value(pid)
            .name("apiLevel").value(apiLevel)
            .name("deviceWallMs").value(deviceWallMs)
            .name("refreshRateHz").value(refreshRateHz)
        // v7: the link proof's challenge (a fresh one per connection, see LinkProof).
        if (nonce != null && protocolVersion >= DEVICE_PROTOCOL_V7) json.name("nonce").value(nonce)
        return json.endObject().toString()
    }

    /** A [ScreenKind.DESTINATION] is sent as `fragment` unless [negotiatedVersion] is v6 or later. */
    fun screen(ts: Long, screen: ScreenRef?, negotiatedVersion: Int? = DEVICE_PROTOCOL_VERSION): String {
        val json = JsonWriter().beginObject()
            .name("type").value("screen")
            .name("ts").value(ts)
            .name("screen")
        if (screen == null) {
            json.nullValue()
        } else {
            json.beginObject()
                .name("name").value(screenName(screen))
                .name("className").value(WireText.required(screen.className, MAX_NAME_LENGTH))
                .name("kind").value(screenKind(screen.kind, negotiatedVersion))
                .endObject()
        }
        return json.endObject().toString()
    }

    /** `droppedFrames` is omitted when 0 (the wire default). */
    fun frames(window: String, intervalMs: Double, frames: List<SdkFrame>, droppedFrames: Int = 0): String {
        val json = JsonWriter().beginObject()
            .name("type").value("frames")
            .name("window").value(WireText.required(window, MAX_WINDOW_LENGTH))
            .name("intervalMs").value(intervalMs)
            .name("frames").beginArray()
        for (frame in frames) writeFrame(json, frame)
        json.endArray()
        if (droppedFrames > 0) json.name("droppedFrames").value(droppedFrames)
        return json.endObject().toString()
    }

    fun heartbeat(ts: Long, droppedMessages: Int): String = JsonWriter().beginObject()
        .name("type").value("heartbeat")
        .name("ts").value(ts)
        .name("droppedMessages").value(droppedMessages)
        .endObject().toString()

    /** v2. */
    fun stall(
        ts: Long,
        durationMs: Double,
        frames: List<StackFrame>,
        samples: Int,
        truncated: Boolean,
        screen: String?,
        debugger: Boolean,
    ): String {
        val json = JsonWriter().beginObject()
            .name("type").value("stall")
            .name("ts").value(ts)
            .name("durationMs").value(if (durationMs.isNaN()) 0.0 else durationMs.coerceIn(0.0, MAX_STALL_MS))
        writeStack(json, frames)
        return json.name("samples").value(samples.coerceIn(1, MAX_SAMPLES))
            .name("truncated").value(truncated || frames.size > MAX_STACK_FRAMES)
            .name("screen").value(WireText.clean(screen, MAX_SCREEN_LENGTH))
            .name("debugger").value(debugger)
            .endObject().toString()
    }

    /** v2. */
    fun strictMode(
        ts: Long,
        policy: StrictModePolicy,
        violation: String,
        message: String?,
        frames: List<StackFrame>,
        count: Int,
        screen: String?,
    ): String {
        val json = JsonWriter().beginObject()
            .name("type").value("strictmode")
            .name("ts").value(ts)
            .name("policy").value(policy.wire)
            .name("violation").value(WireText.required(violation, MAX_VIOLATION_LENGTH, VIOLATION_FALLBACK))
            .name("message").value(WireText.clean(message, MAX_MESSAGE_LENGTH))
        writeStack(json, frames)
        return json.name("count").value(count.coerceIn(1, MAX_COUNT))
            .name("screen").value(WireText.clean(screen, MAX_SCREEN_LENGTH))
            .endObject().toString()
    }

    /** v3. [label] is only sent when [layout] is null (then it is required). */
    fun inflate(
        ts: Long,
        layout: String?,
        label: String?,
        library: Boolean,
        nested: Boolean,
        screen: String?,
        count: Int,
        totalMs: Double,
        maxMs: Double,
        views: Int,
    ): String {
        val layoutName = WireText.clean(layout, MAX_V3_TEXT_LENGTH)
        return JsonWriter().beginObject()
            .name("type").value("inflate")
            .name("ts").value(ts)
            .name("layout").value(layoutName)
            .name("label").value(if (layoutName == null) WireText.required(label, MAX_V3_TEXT_LENGTH) else null)
            .name("library").value(library)
            .name("nested").value(nested)
            .name("screen").value(WireText.clean(screen, MAX_V3_TEXT_LENGTH))
            .name("count").value(count.coerceIn(1, MAX_COUNT))
            .name("totalMs").value(clampMs(totalMs, MAX_INFLATE_MS))
            .name("maxMs").value(clampMs(maxMs, MAX_INFLATE_MS))
            .name("views").value(views.coerceIn(0, MAX_COUNT))
            .endObject().toString()
    }

    /**
     * v3. At most [MAX_VIEW_PATH_NODES] path nodes (the deepest ones) and [MAX_VIEW_TREE_CLASSES] classes. While the
     * line is longer than [maxLineBytes] the root-end half of the path is dropped, keeping the deepest nodes. With
     * path names capped at [MAX_PATH_TEXT_LENGTH] a line stays under [MAX_DEVICE_LINE_BYTES] (~55 KB worst case),
     * so this only guards against future fields.
     */
    fun viewTree(
        ts: Long,
        screen: String?,
        window: String,
        views: Int,
        viewGroups: Int,
        maxDepth: Int,
        deepestPath: List<ViewPathNode>,
        topClasses: List<ClassCount>,
        maxLineBytes: Int = MAX_DEVICE_LINE_BYTES,
    ): String {
        var path = deepestPath.takeLast(MAX_VIEW_PATH_NODES)
        while (true) {
            val line = viewTreeLine(ts, screen, window, views, viewGroups, maxDepth, path, topClasses)
            if (path.isEmpty() || StackFrames.utf8Length(line) <= maxLineBytes) return line
            path = path.takeLast(path.size / 2)
        }
    }

    private fun viewTreeLine(
        ts: Long,
        screen: String?,
        window: String,
        views: Int,
        viewGroups: Int,
        maxDepth: Int,
        deepestPath: List<ViewPathNode>,
        topClasses: List<ClassCount>,
    ): String {
        val json = JsonWriter().beginObject()
            .name("type").value("viewtree")
            .name("ts").value(ts)
            .name("screen").value(WireText.clean(screen, MAX_V3_TEXT_LENGTH))
            .name("window").value(WireText.required(window, MAX_V3_TEXT_LENGTH))
            .name("views").value(views.coerceIn(0, MAX_COUNT))
            .name("viewGroups").value(viewGroups.coerceIn(0, MAX_COUNT))
            .name("maxDepth").value(maxDepth.coerceIn(0, MAX_COUNT))
            .name("deepestPath").beginArray()
        for (node in deepestPath) {
            json.beginObject()
                .name("className").value(WireText.required(node.className, MAX_PATH_TEXT_LENGTH))
                .name("id").value(WireText.clean(node.id, MAX_PATH_TEXT_LENGTH))
                .endObject()
        }
        json.endArray().name("topClasses").beginArray()
        for (entry in topClasses.take(MAX_VIEW_TREE_CLASSES)) {
            json.beginObject()
                .name("className").value(WireText.required(entry.className, MAX_V3_TEXT_LENGTH))
                .name("count").value(entry.count.coerceIn(1, MAX_COUNT))
                .endObject()
        }
        return json.endArray().endObject().toString()
    }

    /**
     * v4. Start of the answer to `inspect` [requestId]; windows beyond [MAX_INSPECTOR_WINDOWS] are not sent (the
     * snapshot never has more). [display] sizes are clamped to 1..20 000 px, its rotation to a multiple of 90.
     */
    fun inspectBegin(
        requestId: Int,
        ts: Long,
        screen: String?,
        display: InspectorDisplay,
        windows: List<InspectorWindow>,
        nodeCount: Int,
        truncated: Boolean,
        captureMs: Double,
        compose: Boolean,
    ): String {
        val json = JsonWriter().beginObject()
            .name("type").value("inspectBegin")
            .name("requestId").value(requestId.coerceAtLeast(0))
            .name("ts").value(ts)
            .name("screen").value(WireText.clean(screen, MAX_V3_TEXT_LENGTH))
            .name("display").beginObject()
            .name("width").value(display.width.coerceIn(1, MAX_INSPECTOR_DISPLAY_PX))
            .name("height").value(display.height.coerceIn(1, MAX_INSPECTOR_DISPLAY_PX))
            .name("rotation").value(rotation(display.rotation))
            .endObject()
            .name("windows").beginArray()
        for (window in windows.take(MAX_INSPECTOR_WINDOWS)) {
            json.beginObject()
                .name("id").value(window.id)
                .name("type")
            val type = window.type?.takeIf { it in 0..MAX_WINDOW_TYPE }
            if (type == null) json.nullValue() else json.value(type)
            json.name("bounds")
            writeRect(json, window.bounds)
            json.endObject()
        }
        return json.endArray()
            .name("nodeCount").value(nodeCount.coerceIn(0, MAX_INSPECTOR_NODES))
            .name("truncated").value(truncated)
            .name("captureMs").value(clampMs(captureMs, MAX_CAPTURE_MS))
            .name("compose").value(compose)
            .endObject().toString()
    }

    /**
     * v4. The [nodes] of `inspect` [requestId] as `inspectNodes` lines of at most [maxLineBytes] UTF-8 bytes each,
     * filled node by node (by size, not count); the last one has `last: true`. One node is at most a few KB (text is
     * capped), so it always fits a chunk; no nodes still give one (empty) last chunk.
     */
    fun inspectChunks(requestId: Int, nodes: List<InspectorNode>, maxLineBytes: Int = MAX_INSPECT_CHUNK_BYTES): List<String> {
        val chunks = ArrayList<List<String>>()
        var current = ArrayList<String>()
        var bytes = 0
        for (node in nodes) {
            val encoded = inspectNode(node)
            val size = StackFrames.utf8Length(encoded)
            if (current.isEmpty()) bytes = envelopeBytes(requestId, chunks.size)
            val added = size + if (current.isEmpty()) 0 else 1
            if (current.isNotEmpty() && bytes + added > maxLineBytes) {
                chunks += current
                current = ArrayList()
                bytes = envelopeBytes(requestId, chunks.size) + size
            } else {
                bytes += added
            }
            current += encoded
        }
        chunks += current
        return chunks.mapIndexed { seq, encoded -> inspectNodes(requestId, seq, seq == chunks.size - 1, encoded) }
    }

    /** v4. One `inspectNodes` line of already-encoded [nodes] ([inspectNode]). */
    fun inspectNodes(requestId: Int, seq: Int, last: Boolean, nodes: List<String>): String {
        val json = JsonWriter().beginObject()
            .name("type").value("inspectNodes")
            .name("requestId").value(requestId.coerceAtLeast(0))
            .name("seq").value(seq)
            .name("last").value(last)
            .name("nodes").beginArray()
        for (node in nodes) json.rawValue(node)
        return json.endArray().endObject().toString()
    }

    /** v4. One `InspectorNode` object, text cleaned and capped, numbers clamped to the server's bounds. */
    fun inspectNode(node: InspectorNode): String {
        val json = JsonWriter().beginObject()
            .name("id").value(node.id)
            .name("parent")
        if (node.parent == null) json.nullValue() else json.value(node.parent)
        json.name("window").value(node.window)
            .name("className").value(WireText.required(node.className, MAX_V3_TEXT_LENGTH))
            .name("resourceId").value(WireText.clean(node.resourceId, MAX_V3_TEXT_LENGTH))
            .name("text").value(WireText.clean(node.text, MAX_INSPECTOR_TEXT_LENGTH))
            .name("contentDescription").value(WireText.clean(node.contentDescription, MAX_INSPECTOR_TEXT_LENGTH))
            .name("bounds")
        writeRect(json, node.bounds)
        json.name("visibleBounds")
        writeRect(json, node.visibleBounds)
        json.name("visibility").value(node.visibility.wire)
            .name("alpha")
        if (node.alpha == null) json.nullValue() else json.value(if (node.alpha.isNaN()) 0.0 else node.alpha.coerceIn(0.0, 1.0))
        json
            .name("enabled").value(node.enabled)
            .name("clickable").value(node.clickable)
            .name("focused").value(node.focused)
            .name("selected").value(node.selected)
            .name("checked")
        if (node.checked == null) json.nullValue() else json.value(node.checked)
        json.name("padding")
        writeRect(json, node.padding)
        json.name("margin")
        writeRect(json, node.margin)
        json.name("layoutWidth").value(layoutSize(node.layoutWidth))
            .name("layoutHeight").value(layoutSize(node.layoutHeight))
            .name("source")
        val layout = node.source?.let { WireText.clean(it.layout, MAX_V3_TEXT_LENGTH) }
        if (node.source == null || layout == null || node.source.line < 1) {
            json.nullValue()
        } else {
            json.beginObject()
                .name("layout").value(layout)
                .name("line").value(node.source.line)
                .endObject()
        }
        json.name("fragment").value(WireText.clean(node.fragment, MAX_V3_TEXT_LENGTH))
            .name("activity").value(WireText.clean(node.activity, MAX_V3_TEXT_LENGTH))
        writeCompose(json, node)
        return json.endObject().toString()
    }

    /** v6 fields, only written when set (a v4 snapshot has none, byte for byte as before). */
    private fun writeCompose(json: JsonWriter, node: InspectorNode) {
        node.composable?.let { source ->
            json.name("composable").beginObject()
                .name("file").value(WireText.clean(source.file, MAX_V3_TEXT_LENGTH))
                .name("line")
            val line = source.line?.takeIf { it >= 1 }
            if (line == null) json.nullValue() else json.value(line)
            source.draws?.let { json.name("draws").value(it) }
            json.endObject()
        }
        node.composition?.let { json.name("composition").value(it.wire) }
        WireText.clean(node.destination, MAX_V3_TEXT_LENGTH)?.let { json.name("destination").value(it) }
    }

    private fun screenKind(kind: ScreenKind, negotiatedVersion: Int?): String =
        if (kind == ScreenKind.DESTINATION && !DeviceLink.speaks(negotiatedVersion, DEVICE_PROTOCOL_V6)) {
            ScreenKind.FRAGMENT.wire
        } else {
            kind.wire
        }

    /** v4. */
    fun inspectError(requestId: Int, reason: InspectError): String = JsonWriter().beginObject()
        .name("type").value("inspectError")
        .name("requestId").value(requestId.coerceAtLeast(0))
        .name("reason").value(reason.wire)
        .endObject().toString()

    /** A `LayoutParams` width or height as sent: `match_parent`, `wrap_content` or `<n>px` (n clamped to 6 digits). */
    fun layoutDimension(size: Int): String = when (size) {
        ViewGroup.LayoutParams.MATCH_PARENT -> MATCH_PARENT
        ViewGroup.LayoutParams.WRAP_CONTENT -> WRAP_CONTENT
        else -> "${size.coerceIn(-MAX_LAYOUT_PX, MAX_LAYOUT_PX)}px"
    }

    /** Anything but a [layoutDimension] is sent as null. */
    private fun layoutSize(value: String?): String? =
        value?.takeIf { it == MATCH_PARENT || it == WRAP_CONTENT || LAYOUT_PX.matches(it) }

    /** The size of an `inspectNodes` line without nodes, with `last: false` (longer than `true`). */
    private fun envelopeBytes(requestId: Int, seq: Int): Int = inspectNodes(requestId, seq, false, emptyList()).length

    private fun rotation(degrees: Int): Int = (((degrees / 90) % 4 + 4) % 4) * 90

    private fun writeRect(json: JsonWriter, rect: PixelRect?) {
        if (rect == null) {
            json.nullValue()
            return
        }
        json.beginArray()
            .value(pixel(rect.left))
            .value(pixel(rect.top))
            .value(pixel(rect.right))
            .value(pixel(rect.bottom))
            .endArray()
    }

    private fun pixel(value: Int): Int = value.coerceIn(-MAX_INSPECTOR_PIXELS, MAX_INSPECTOR_PIXELS)

    private fun clampMs(value: Double, max: Double): Double = if (value.isNaN()) 0.0 else value.coerceIn(0.0, max)

    /** An alias that cleans to nothing falls back to the simple class name. */
    private fun screenName(screen: ScreenRef): String = WireText.clean(screen.name, MAX_SCREEN_NAME_LENGTH)
        ?: WireText.required(screen.className.substringAfterLast('.'), MAX_SCREEN_NAME_LENGTH)

    private fun writeStack(json: JsonWriter, frames: List<StackFrame>) {
        json.name("frames").beginArray()
        for (frame in frames.take(MAX_STACK_FRAMES)) {
            json.beginObject()
                .name("className").value(WireText.required(frame.className, MAX_NAME_LENGTH))
                .name("method").value(WireText.required(frame.method, MAX_NAME_LENGTH))
                .name("file").value(WireText.clean(frame.file, MAX_FILE_LENGTH))
                .name("line")
            val line = frame.line?.takeIf { it >= 0 || it == NATIVE_LINE }
            if (line == null) json.nullValue() else json.value(line)
            json.name("inApp").value(frame.inApp).endObject()
        }
        json.endArray()
    }

    private fun writeFrame(json: JsonWriter, frame: SdkFrame) {
        json.beginObject()
            .name("ts").value(frame.ts)
            .name("totalMs").value(frame.totalMs)
            .name("inputMs").value(frame.inputMs)
            .name("animationMs").value(frame.animationMs)
            .name("layoutMs").value(frame.layoutMs)
            .name("drawMs").value(frame.drawMs)
            .name("syncMs").value(frame.syncMs)
            .name("commandMs").value(frame.commandMs)
            .name("swapMs").value(frame.swapMs)
            .name("delayMs").value(frame.delayMs)
            .name("gpuMs").nullableValue(frame.gpuMs)
            .name("deadlineMs").nullableValue(frame.deadlineMs)
            .name("firstDraw").value(frame.firstDraw)
            .endObject()
    }

    private fun JsonWriter.nullableValue(value: Double?): JsonWriter =
        if (value == null) nullValue() else value(value)
}

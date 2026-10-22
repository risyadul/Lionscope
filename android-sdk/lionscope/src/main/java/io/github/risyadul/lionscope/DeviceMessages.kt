package io.github.risyadul.lionscope

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

    fun hello(
        packageName: String,
        processName: String,
        pid: Int,
        apiLevel: Int,
        deviceWallMs: Long,
        refreshRateHz: Double,
        protocolVersion: Int = DEVICE_PROTOCOL_VERSION,
        sdkVersion: String = Lionscope.VERSION,
    ): String = JsonWriter().beginObject()
        .name("type").value("hello")
        .name("protocolVersion").value(protocolVersion)
        .name("sdkVersion").value(sdkVersion)
        .name("packageName").value(packageName)
        .name("processName").value(processName)
        .name("pid").value(pid)
        .name("apiLevel").value(apiLevel)
        .name("deviceWallMs").value(deviceWallMs)
        .name("refreshRateHz").value(refreshRateHz)
        .endObject().toString()

    fun screen(ts: Long, screen: ScreenRef?): String {
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
                .name("kind").value(screen.kind.wire)
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

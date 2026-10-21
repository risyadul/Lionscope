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

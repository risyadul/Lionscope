package io.github.risyadul.lionscope

/** Encoders for SDK → server lines (no trailing newline). Field order matches the golden fixtures. */
internal object DeviceMessages {

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
                .name("name").value(screen.name)
                .name("className").value(screen.className)
                .name("kind").value(screen.kind.wire)
                .endObject()
        }
        return json.endObject().toString()
    }

    /** `droppedFrames` is omitted when 0 (the wire default). */
    fun frames(window: String, intervalMs: Double, frames: List<SdkFrame>, droppedFrames: Int = 0): String {
        val json = JsonWriter().beginObject()
            .name("type").value("frames")
            .name("window").value(window)
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

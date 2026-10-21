package io.github.risyadul.lionscope

// Mirrors protocol/src/wire.ts, section "In-app SDK ↔ server (device gateway)".

internal const val DEVICE_PROTOCOL_VERSION = 1
internal const val DEVICE_LINK_PORT = 8700
internal const val MAX_SDK_FRAMES_PER_BATCH = 256

internal enum class ScreenKind(val wire: String) {
    ACTIVITY("activity"),
    FRAGMENT("fragment"),
    DIALOG("dialog"),
}

internal data class ScreenRef(val name: String, val className: String, val kind: ScreenKind)

/** One FrameMetrics frame, durations in ms. */
internal class SdkFrame(
    val ts: Long,
    val totalMs: Double,
    val inputMs: Double,
    val animationMs: Double,
    val layoutMs: Double,
    val drawMs: Double,
    val syncMs: Double,
    val commandMs: Double,
    val swapMs: Double,
    val delayMs: Double,
    val gpuMs: Double?,
    val deadlineMs: Double?,
    val firstDraw: Boolean,
)

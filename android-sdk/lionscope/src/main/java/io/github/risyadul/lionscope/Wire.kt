package io.github.risyadul.lionscope

// Mirrors protocol/src/wire.ts, section "In-app SDK ↔ server (device gateway)".

/** Highest device protocol version this SDK speaks, sent in `hello`; the server answers min(sdk, server). */
internal const val DEVICE_PROTOCOL_VERSION = 2
internal const val MIN_DEVICE_PROTOCOL_VERSION = 1
/** First version with `stall` / `strictmode` (SDK → server) and `config` (server → SDK). */
internal const val DEVICE_PROTOCOL_V2 = 2
internal const val DEVICE_LINK_PORT = 8700
internal const val MAX_DEVICE_LINE_BYTES = 64 * 1024
internal const val MAX_SDK_FRAMES_PER_BATCH = 256
/** Max frames per captured stack (innermost first); longer stacks are cut and flagged `truncated`. */
internal const val MAX_STACK_FRAMES = 64

/** Allowed watchdog thresholds; `config` values outside this set snap to the nearest one. */
internal val STALL_THRESHOLDS_MS = longArrayOf(100, 150, 250, 500, 1000)

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

/** Per-session options pushed by the server in `config`; [DEFAULT] until the first one arrives. */
internal data class SdkOptions(val stallThresholdMs: Long, val strictMode: Boolean) {
    companion object {
        val DEFAULT = SdkOptions(stallThresholdMs = 150, strictMode = false)
    }
}

internal enum class StrictModePolicy(val wire: String) {
    THREAD("thread"),
    VM("vm"),
}

/** One `StackTraceElement` as sent: [line] is null when unknown, -2 for native methods. */
internal data class StackFrame(
    val className: String,
    val method: String,
    val file: String?,
    val line: Int?,
    val inApp: Boolean,
)

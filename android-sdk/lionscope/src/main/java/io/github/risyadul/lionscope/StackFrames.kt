package io.github.risyadul.lionscope

/**
 * `StackTraceElement`s → wire [StackFrame]s (innermost first; text is cleaned and capped by the encoders, see
 * [WireText]). Each run of the SDK's own frames collapses into one [SDK_FRAME], so a block caused by the SDK stays
 * visible without its internals; at most [MAX_STACK_FRAMES] are kept. Only classes directly in the SDK package count
 * as the SDK's own, so an app that lives below it (like the sample, `io.github.risyadul.lionscope.sample`) keeps its
 * frames.
 */
internal object StackFrames {
    /** [consumed]: how many of the stack's elements [frames] stand for (the rest were cut). */
    class Mapped(val frames: List<StackFrame>, val truncated: Boolean, val consumed: Int = frames.size)

    private const val SDK_PACKAGE_PREFIX = "io.github.risyadul.lionscope."
    /** `StackTraceElement.lineNumber` of a native method; other negative values mean unknown. */
    private const val NATIVE_LINE = -2

    /** Stands in for a run of SDK frames. */
    val SDK_FRAME = StackFrame("io.github.risyadul.lionscope.Lionscope", "(sdk)", file = null, line = null, inApp = false)

    /**
     * Elements kept per sampled stack: enough for [MAX_STACK_FRAMES] after collapsing a few SDK runs. The innermost
     * frames are the ones that matter, so a sampler keeps these and records that there were more.
     */
    const val MAX_SAMPLED_ELEMENTS = MAX_STACK_FRAMES + 8

    /** [isInApp] receives the full class name of each kept frame; [longer] = the stack was already cut by the caller. */
    fun map(stack: Array<StackTraceElement>, longer: Boolean = false, isInApp: (String) -> Boolean): Mapped {
        val frames = ArrayList<StackFrame>(minOf(stack.size, MAX_STACK_FRAMES))
        var inSdkRun = false
        for ((index, element) in stack.withIndex()) {
            val sdk = isSdkClass(element.className)
            if (sdk && inSdkRun) continue
            inSdkRun = sdk
            if (frames.size == MAX_STACK_FRAMES) return Mapped(frames, truncated = true, consumed = index)
            frames += if (sdk) SDK_FRAME else frame(element, isInApp)
        }
        return Mapped(frames, truncated = longer, consumed = stack.size)
    }

    fun isSdkClass(className: String): Boolean =
        className.startsWith(SDK_PACKAGE_PREFIX) && className.indexOf('.', SDK_PACKAGE_PREFIX.length) < 0

    /**
     * Encodes the line with [encode]; while it is longer than [MAX_DEVICE_LINE_BYTES] (only possible with very long
     * non-ASCII names), drops the outer half of the frames and flags the stack truncated. Null if it never fits.
     */
    fun fitLine(mapped: Mapped, encode: (frames: List<StackFrame>, truncated: Boolean) -> String): String? {
        var frames = mapped.frames
        var truncated = mapped.truncated
        while (true) {
            val line = encode(frames, truncated)
            if (utf8Length(line) <= MAX_DEVICE_LINE_BYTES) return line
            if (frames.isEmpty()) return null
            frames = frames.subList(0, frames.size / 2)
            truncated = true
        }
    }

    private fun frame(element: StackTraceElement, isInApp: (String) -> Boolean): StackFrame {
        val line = element.lineNumber
        return StackFrame(
            className = element.className,
            method = element.methodName,
            file = element.fileName,
            line = if (line >= 0 || line == NATIVE_LINE) line else null,
            inApp = isInApp(element.className),
        )
    }

    fun utf8Length(value: String): Int {
        var bytes = 0
        var i = 0
        while (i < value.length) {
            val c = value[i]
            bytes += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                Character.isHighSurrogate(c) && i + 1 < value.length && Character.isLowSurrogate(value[i + 1]) -> {
                    i++
                    4
                }
                else -> 3
            }
            i++
        }
        return bytes
    }
}

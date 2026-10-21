package io.github.risyadul.lionscope

/**
 * Groups frames per window into `frames` batches. A batch is due [flushIntervalMs] after its first frame, or
 * immediately at [maxFrames]. Not thread-safe: used only on the frames thread. Times are monotonic ms.
 */
internal class FrameBatcher(
    private val flushIntervalMs: Long = FLUSH_INTERVAL_MS,
    private val maxFrames: Int = MAX_SDK_FRAMES_PER_BATCH,
) {
    class Batch(val window: String, val intervalMs: Double, val frames: List<SdkFrame>, val droppedFrames: Int)

    private class Pending(val intervalMs: Double, val startedAtMs: Long) {
        val frames = ArrayList<SdkFrame>()
        var droppedFrames = 0
    }

    private val pending = LinkedHashMap<String, Pending>()

    /**
     * Adds [frame] (and the [droppedFrames] FrameMetrics skipped before it); returns the batches that must be
     * sent right away (full batch, or refresh-rate change).
     */
    fun add(window: String, intervalMs: Double, frame: SdkFrame, nowMs: Long, droppedFrames: Int = 0): List<Batch> {
        val ready = ArrayList<Batch>(1)
        var current = pending[window]
        if (current != null && current.intervalMs != intervalMs) {
            flush(window)?.let(ready::add)
            current = null
        }
        if (current == null) {
            current = Pending(intervalMs, nowMs)
            pending[window] = current
        }
        current.frames.add(frame)
        current.droppedFrames += droppedFrames.coerceAtLeast(0)
        if (current.frames.size >= maxFrames) flush(window)?.let(ready::add)
        return ready
    }

    fun flushDue(nowMs: Long): List<Batch> {
        val due = pending.filterValues { nowMs - it.startedAtMs >= flushIntervalMs }.keys.toList()
        return due.mapNotNull(::flush)
    }

    fun flush(window: String): Batch? {
        val entry = pending.remove(window) ?: return null
        return Batch(window, entry.intervalMs, entry.frames, entry.droppedFrames)
    }

    fun flushAll(): List<Batch> = pending.keys.toList().mapNotNull(::flush)

    /** Milliseconds until the next batch is due, or null when nothing is pending. */
    fun nextDueInMs(nowMs: Long): Long? =
        pending.values.minOfOrNull { it.startedAtMs + flushIntervalMs - nowMs }?.coerceAtLeast(0)

    companion object {
        const val FLUSH_INTERVAL_MS = 500L
    }
}

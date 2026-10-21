package io.github.risyadul.lionscope

/**
 * Rate-limits StrictMode reports: the first occurrence of a key is emitted at once, later ones within
 * [perKeyIntervalMs] are counted and emitted together when the interval has passed (as one sample carrying the
 * first coalesced occurrence and the count). At most [globalPerSecond] emissions per second in total; pending
 * counts wait for budget. Keeps at most [maxKeys] keys (least recently seen evicted, with any pending count).
 * Not thread-safe; times are monotonic ms.
 */
internal class ViolationCoalescer<P>(
    private val perKeyIntervalMs: Long = 1_000,
    private val globalPerSecond: Int = 10,
    private val maxKeys: Int = 256,
) {
    class Emission<P>(val payload: P, val count: Int)

    private class Entry<P> {
        var lastEmitMs: Long? = null
        var pending: P? = null
        var pendingCount = 0
    }

    private val entries = object : LinkedHashMap<Any, Entry<P>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Any, Entry<P>>?): Boolean = size > maxKeys
    }

    /** Emission times within the last second, oldest first. */
    private val recent = ArrayDeque<Long>()

    val size: Int
        get() = entries.size

    /** Records one occurrence of [key]; [payload] is only built for the first one of a coalesced batch. */
    fun offer(key: Any, nowMs: Long, payload: () -> P): List<Emission<P>> {
        val entry = entries.getOrPut(key) { Entry() }
        if (entry.pending == null) entry.pending = payload()
        entry.pendingCount++
        return flush(nowMs)
    }

    /** Emits every pending batch whose key interval has passed, within the global budget. */
    fun flush(nowMs: Long): List<Emission<P>> {
        while (recent.isNotEmpty() && nowMs - recent.first() >= WINDOW_MS) recent.removeFirst()
        var out: ArrayList<Emission<P>>? = null
        for (entry in entries.values) {
            val payload = entry.pending ?: continue
            if (!intervalPassed(entry, nowMs)) continue
            if (recent.size >= globalPerSecond) break
            if (out == null) out = ArrayList(2)
            out += Emission(payload, entry.pendingCount)
            entry.pending = null
            entry.pendingCount = 0
            entry.lastEmitMs = nowMs
            recent.addLast(nowMs)
        }
        return out ?: emptyList()
    }

    /** Ms until [flush] can emit something, or null when nothing is pending. */
    fun nextFlushInMs(nowMs: Long): Long? {
        val budgetAt = if (recent.size >= globalPerSecond) recent.first() + WINDOW_MS else nowMs
        var next: Long? = null
        for (entry in entries.values) {
            if (entry.pending == null) continue
            val due = maxOf(entry.lastEmitMs?.let { it + perKeyIntervalMs } ?: nowMs, budgetAt)
            if (next == null || due < next) next = due
        }
        return next?.let { (it - nowMs).coerceAtLeast(1) }
    }

    private fun intervalPassed(entry: Entry<P>, nowMs: Long): Boolean {
        val last = entry.lastEmitMs ?: return true
        return nowMs - last >= perKeyIntervalMs
    }

    private companion object {
        const val WINDOW_MS = 1_000L
    }
}

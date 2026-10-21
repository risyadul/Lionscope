package io.github.risyadul.lionscope

/** Reconnect delays: 1 s → 2 s → 5 s, then 5 s forever until [reset]. */
internal class Backoff(private val delaysMs: LongArray = longArrayOf(1_000, 2_000, 5_000)) {
    private var attempt = 0

    @Synchronized
    fun next(): Long {
        val delay = delaysMs[minOf(attempt, delaysMs.size - 1)]
        if (attempt < delaysMs.size) attempt++
        return delay
    }

    @Synchronized
    fun reset() {
        attempt = 0
    }
}

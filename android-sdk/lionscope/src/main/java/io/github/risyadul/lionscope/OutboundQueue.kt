package io.github.risyadul.lionscope

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Bounded queue: never blocks producers. When either the item cap or the size budget ([sizeOf] units, ≈ bytes)
 * would be exceeded, the oldest items are dropped and counted.
 */
internal class OutboundQueue<T : Any>(
    private val capacity: Int = DEFAULT_CAPACITY,
    private val maxSize: Long = DEFAULT_MAX_BYTES,
    private val sizeOf: (T) -> Int,
) {
    private class Item<T>(val value: T, val size: Int)

    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private val items = ArrayDeque<Item<T>>()
    private var totalSize = 0L
    private var dropped = 0
    private var woken = false

    fun offer(value: T) = lock.withLock {
        val item = Item(value, sizeOf(value).coerceAtLeast(0))
        while (items.isNotEmpty() && (items.size >= capacity || totalSize + item.size > maxSize)) {
            totalSize -= items.pollFirst()!!.size
            dropped++
        }
        items.addLast(item)
        totalSize += item.size
        notEmpty.signal()
    }

    /**
     * Moves up to [max] items into [sink], waiting up to [timeoutMs] while the queue is empty.
     * Returns early (possibly with nothing) after [wake].
     */
    fun drainTo(sink: MutableList<T>, max: Int, timeoutMs: Long): Int = lock.withLock {
        var remainingNs = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (items.isEmpty() && !woken && remainingNs > 0) {
            remainingNs = notEmpty.awaitNanos(remainingNs)
        }
        woken = false
        var moved = 0
        while (moved < max) {
            val item = items.pollFirst() ?: break
            totalSize -= item.size
            sink.add(item.value)
            moved++
        }
        moved
    }

    /** Returns the number of dropped items since the previous call. */
    fun takeDropped(): Int = lock.withLock {
        val count = dropped
        dropped = 0
        count
    }

    fun clear() = lock.withLock {
        items.clear()
        totalSize = 0
        dropped = 0
    }

    fun wake() = lock.withLock {
        woken = true
        notEmpty.signal()
    }

    val size: Int
        get() = lock.withLock { items.size }

    companion object {
        const val DEFAULT_CAPACITY = 512
        const val DEFAULT_MAX_BYTES = 2L * 1024 * 1024
    }
}

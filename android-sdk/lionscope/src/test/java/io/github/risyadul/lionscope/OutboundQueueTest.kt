package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundQueueTest {

    private fun queue(capacity: Int = OutboundQueue.DEFAULT_CAPACITY, maxSize: Long = OutboundQueue.DEFAULT_MAX_BYTES) =
        OutboundQueue<String>(capacity, maxSize) { it.length }

    private fun OutboundQueue<String>.drainAll(): List<String> = ArrayList<String>().also { drainTo(it, Int.MAX_VALUE, 0) }

    @Test
    fun dropsOldestWhenFullAndCountsDrops() {
        val queue = queue(capacity = 3)
        (1..5).forEach { queue.offer("l$it") }
        assertEquals(listOf("l3", "l4", "l5"), queue.drainAll())
        assertEquals(2, queue.takeDropped())
    }

    @Test
    fun takeDroppedResetsTheCounter() {
        val queue = queue(capacity = 1)
        queue.offer("a")
        queue.offer("b")
        assertEquals(1, queue.takeDropped())
        assertEquals(0, queue.takeDropped())
    }

    @Test
    fun drainRespectsMaxAndKeepsOrder() {
        val queue = queue()
        (1..5).forEach { queue.offer("l$it") }
        val sink = ArrayList<String>()
        assertEquals(2, queue.drainTo(sink, 2, 0))
        assertEquals(listOf("l1", "l2"), sink)
        assertEquals(3, queue.size)
    }

    @Test
    fun drainOnEmptyQueueWaitsForTimeout() {
        val queue = queue()
        val start = System.nanoTime()
        assertEquals(0, queue.drainTo(ArrayList(), 10, 50))
        assertTrue((System.nanoTime() - start) / 1_000_000 >= 45)
    }

    @Test
    fun offerFromAnotherThreadWakesTheDrain() {
        val queue = queue()
        Thread {
            Thread.sleep(20)
            queue.offer("late")
        }.start()
        val sink = ArrayList<String>()
        queue.drainTo(sink, 10, 5_000)
        assertEquals(listOf("late"), sink)
    }

    @Test
    fun wakeReturnsEarlyWithoutLines() {
        val queue = queue()
        Thread {
            Thread.sleep(20)
            queue.wake()
        }.start()
        val start = System.nanoTime()
        assertEquals(0, queue.drainTo(ArrayList(), 10, 5_000))
        assertTrue((System.nanoTime() - start) / 1_000_000 < 4_000)
    }

    @Test
    fun clearDropsLinesWithoutCountingThem() {
        val queue = queue(capacity = 2)
        (1..3).forEach { queue.offer("l$it") }
        queue.clear()
        assertEquals(0, queue.size)
        assertEquals(0, queue.takeDropped())
    }

    @Test
    fun sizeBudgetDropsOldestUntilTheNewItemFits() {
        val queue = queue(maxSize = 10)
        queue.offer("aaaa") // 4
        queue.offer("bbbb") // 8
        queue.offer("cccc") // 12 > 10: drops "aaaa"
        assertEquals(1, queue.takeDropped())
        queue.offer("dddddddd") // 16 > 10: drops "bbbb" and "cccc"
        assertEquals(2, queue.takeDropped())
        assertEquals(listOf("dddddddd"), queue.drainAll())
    }

    @Test
    fun oversizedSingleItemIsStillAccepted() {
        val queue = queue(maxSize = 4)
        queue.offer("a")
        queue.offer("too long for the budget")
        assertEquals(listOf("too long for the budget"), queue.drainAll())
        assertEquals(1, queue.takeDropped())
    }

    @Test
    fun drainingReleasesBudget() {
        val queue = queue(maxSize = 8)
        queue.offer("aaaa")
        queue.offer("bbbb")
        queue.drainAll()
        queue.offer("cccc")
        queue.offer("dddd")
        assertEquals(0, queue.takeDropped())
    }
}

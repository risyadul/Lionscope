package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ViolationCoalescerTest {

    private val coalescer = ViolationCoalescer<String>()

    private fun List<ViolationCoalescer.Emission<String>>.described() = map { "${it.payload}×${it.count}" }

    @Test
    fun firstOccurrenceIsEmittedAtOnceAndRepeatsAreCountedForASecond() {
        assertEquals(listOf("a@0×1"), coalescer.offer("a", 0) { "a@0" }.described())
        var built = 0
        for (t in listOf(100L, 200, 900)) {
            assertTrue(coalescer.offer("a", t) { built++; "a@$t" }.isEmpty())
        }
        assertEquals(1, built) // Payload of the batch = its first occurrence.
        assertEquals(900L, coalescer.nextFlushInMs(100))
        assertTrue(coalescer.flush(999).isEmpty())
        assertEquals(listOf("a@100×3"), coalescer.flush(1_000).described())
        assertNull(coalescer.nextFlushInMs(1_000))

        // Next batch: at most one per second after the previous emission.
        assertTrue(coalescer.offer("a", 1_500) { "a@1500" }.isEmpty())
        assertEquals(listOf("a@1500×2"), coalescer.offer("a", 2_000) { "unused" }.described())
    }

    @Test
    fun differentKeysAreIndependent() {
        assertEquals(1, coalescer.offer("a", 0) { "a" }.size)
        assertEquals(1, coalescer.offer("b", 10) { "b" }.size)
        assertTrue(coalescer.offer("a", 20) { "a2" }.isEmpty())
    }

    @Test
    fun globalCapIsTenPerSecondAndHeldBackCountsWaitForBudget() {
        for (i in 0 until 10) assertEquals(1, coalescer.offer("k$i", i.toLong()) { "k$i" }.size)
        assertTrue(coalescer.offer("k10", 50) { "k10" }.isEmpty()) // Over budget: held back.
        assertTrue(coalescer.offer("k10", 60) { "unused" }.isEmpty())
        assertEquals(950L, coalescer.nextFlushInMs(50)) // When the first emission leaves the window.
        assertTrue(coalescer.flush(999).isEmpty())
        assertEquals(listOf("k10×2"), coalescer.flush(1_000).described())
    }

    @Test
    fun keysAreBoundedLeastRecentlySeenFirst() {
        val small = ViolationCoalescer<String>(globalPerSecond = 1_000, maxKeys = 3)
        for (key in listOf("a", "b", "c")) small.offer(key, 0) { key }
        small.offer("a", 10) { "a" } // Seen again: most recent.
        small.offer("d", 20) { "d" } // Evicts b.
        assertEquals(3, small.size)
        // b is new again: emitted at once; a is still inside its interval.
        assertEquals(listOf("b×1"), small.offer("b", 30) { "b" }.described())
        assertTrue(small.offer("a", 40) { "a" }.isEmpty())
    }
}

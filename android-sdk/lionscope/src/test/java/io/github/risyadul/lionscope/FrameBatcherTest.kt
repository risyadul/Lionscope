package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameBatcherTest {

    private fun frame(ts: Long) = SdkFrame(ts, 8.0, 0.1, 0.2, 1.0, 2.0, 0.3, 1.1, 0.4, 1.5, null, null, false)

    @Test
    fun batchIsDueFiveHundredMillisecondsAfterItsFirstFrame() {
        val batcher = FrameBatcher()
        assertTrue(batcher.add("Main", 16.667, frame(1), nowMs = 1_000).isEmpty())
        assertTrue(batcher.add("Main", 16.667, frame(2), nowMs = 1_300).isEmpty())
        assertEquals(200L, batcher.nextDueInMs(1_300))
        assertTrue(batcher.flushDue(1_499).isEmpty())

        val batches = batcher.flushDue(1_500)
        assertEquals(1, batches.size)
        assertEquals("Main", batches[0].window)
        assertEquals(16.667, batches[0].intervalMs, 0.0)
        assertEquals(listOf(1L, 2L), batches[0].frames.map { it.ts })
        assertNull(batcher.nextDueInMs(1_500))
    }

    @Test
    fun fullBatchIsReturnedImmediately() {
        val batcher = FrameBatcher()
        repeat(MAX_SDK_FRAMES_PER_BATCH - 1) {
            assertTrue(batcher.add("Main", 8.333, frame(it.toLong()), nowMs = 0).isEmpty())
        }
        val full = batcher.add("Main", 8.333, frame(999), nowMs = 0)
        assertEquals(1, full.size)
        assertEquals(MAX_SDK_FRAMES_PER_BATCH, full[0].frames.size)
        assertNull(batcher.nextDueInMs(0))
    }

    @Test
    fun windowsAreBatchedSeparately() {
        val batcher = FrameBatcher()
        batcher.add("Main", 16.667, frame(1), nowMs = 0)
        batcher.add("Detail", 16.667, frame(2), nowMs = 200)
        batcher.add("Main", 16.667, frame(3), nowMs = 300)

        val first = batcher.flushDue(500)
        assertEquals(listOf("Main"), first.map { it.window })
        assertEquals(listOf(1L, 3L), first[0].frames.map { it.ts })
        assertEquals(200L, batcher.nextDueInMs(500))

        val second = batcher.flushDue(700)
        assertEquals(listOf("Detail"), second.map { it.window })
        assertEquals(listOf(2L), second[0].frames.map { it.ts })
    }

    @Test
    fun refreshRateChangeFlushesThePendingBatch() {
        val batcher = FrameBatcher()
        batcher.add("Main", 16.667, frame(1), nowMs = 0)
        val flushed = batcher.add("Main", 8.333, frame(2), nowMs = 10)
        assertEquals(1, flushed.size)
        assertEquals(16.667, flushed[0].intervalMs, 0.0)
        assertEquals(listOf(1L), flushed[0].frames.map { it.ts })

        val next = batcher.flushDue(510)
        assertEquals(8.333, next.single().intervalMs, 0.0)
        assertEquals(listOf(2L), next.single().frames.map { it.ts })
    }

    @Test
    fun explicitFlushOfOneWindow() {
        val batcher = FrameBatcher()
        batcher.add("Main", 16.667, frame(1), nowMs = 0)
        batcher.add("Detail", 16.667, frame(2), nowMs = 0)
        assertEquals(listOf(1L), batcher.flush("Main")!!.frames.map { it.ts })
        assertNull(batcher.flush("Main"))
        assertEquals(listOf("Detail"), batcher.flushDue(500).map { it.window })
    }

    @Test
    fun droppedFramesAccumulatePerWindowIntoTheNextBatch() {
        val batcher = FrameBatcher()
        batcher.add("Main", 16.667, frame(1), nowMs = 0, droppedFrames = 2)
        batcher.add("Main", 16.667, frame(2), nowMs = 10, droppedFrames = 3)
        batcher.add("Dialog", 16.667, frame(3), nowMs = 10, droppedFrames = 1)
        val batches = batcher.flushDue(510).associateBy { it.window }
        assertEquals(5, batches.getValue("Main").droppedFrames)
        assertEquals(1, batches.getValue("Dialog").droppedFrames)

        batcher.add("Main", 16.667, frame(4), nowMs = 600)
        assertEquals(0, batcher.flush("Main")!!.droppedFrames)
    }

    @Test
    fun flushAllEmptiesEveryWindow() {
        val batcher = FrameBatcher()
        batcher.add("Main", 16.667, frame(1), nowMs = 0)
        batcher.add("Dialog", 16.667, frame(2), nowMs = 0)
        assertEquals(setOf("Main", "Dialog"), batcher.flushAll().map { it.window }.toSet())
        assertNull(batcher.nextDueInMs(0))
    }
}

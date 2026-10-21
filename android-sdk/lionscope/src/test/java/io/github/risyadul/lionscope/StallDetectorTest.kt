package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class FakeWatchdogClock(private val wallStartMs: Long = 1_792_516_378_000) : WatchdogClock {
    var nanos = 0L

    override fun nanoTime(): Long = nanos
    override fun wallMs(): Long = wallStartMs + nanos / 1_000_000

    fun advanceMs(ms: Long) {
        nanos += ms * 1_000_000
    }
}

internal fun stackOf(vararg frames: String): Array<StackTraceElement> = frames.mapIndexed { i, frame ->
    StackTraceElement(frame.substringBeforeLast('.'), frame.substringAfterLast('.'), "F.kt", i + 1)
}.toTypedArray()

class StallDetectorTest {

    private val clock = FakeWatchdogClock()
    private val main = FakeScheduler()
    private val stalls = ArrayList<StallDetector.Stall>()
    private var threshold = 150L
    private var screen: String? = "homepage"
    private val blockStack = stackOf("app.Work.block", "app.Work.run", "android.os.Looper.loop")
    private var sampler: () -> Array<StackTraceElement> = { blockStack }
    private var sampled = 0

    private var reportedUnderLock = false
    private var maxSamples = StallDetector.MAX_SAMPLES

    private val detector by lazy {
        lateinit var self: StallDetector
        self = StallDetector(
            clock = clock,
            post = main::post,
            sampleStack = {
                sampled++
                sampler()
            },
            thresholdMs = { threshold },
            screenName = { screen },
            debuggerAttached = { false },
            report = {
                reportedUnderLock = reportedUnderLock || Thread.holdsLock(self)
                stalls += it
            },
            maxSamples = maxSamples,
        )
        self
    }

    /** Watchdog rounds while the main thread is idle: every tick runs as soon as it is posted. */
    private fun idle(rounds: Int) = repeat(rounds) {
        detector.step()
        main.runPosted()
        clock.advanceMs(StallDetector.INTERVAL_MS)
    }

    /** Watchdog rounds while the main thread is busy; then the main thread gets to the tick. */
    private fun block(rounds: Int, beforeEachRound: (Int) -> Unit = {}) {
        repeat(rounds) {
            beforeEachRound(it)
            detector.step()
            clock.advanceMs(StallDetector.INTERVAL_MS)
        }
        main.runPosted()
        detector.step()
    }

    @Test
    fun anIdleMainThreadIsNeverSampled() {
        idle(100)
        assertEquals(0, sampled)
        assertTrue(stalls.isEmpty())
    }

    @Test
    fun blocksShorterThanTheThresholdAreNotReported() {
        idle(2)
        block(2) // The tick runs 100 ms late: no sample yet, no stall.
        assertEquals(0, sampled)

        // Sampled once from threshold - interval (100 ms late), but over before the threshold.
        repeat(3) {
            detector.step()
            clock.advanceMs(StallDetector.INTERVAL_MS)
        }
        clock.advanceMs(-30)
        main.runPosted() // 120 ms late.
        detector.step()
        assertEquals(1, sampled)
        assertTrue(stalls.isEmpty())
    }

    @Test
    fun aBlockJustOverTheThresholdStillHasAStack() {
        idle(2)
        block(3) // Sampled once at 100 ms late; the tick runs at 150 ms, before any later round.
        assertEquals(1, stalls.single().samples)
        assertEquals(150.0, stalls.single().durationMs, 0.0)
    }

    @Test
    fun oneStallPerBlockWithItsStartDurationSamplesAndScreen() {
        idle(2)
        val postedWall = clock.wallMs()
        block(8) // Tick posted at 100 ms; samples at 250..450 ms; the tick runs at 500 ms.
        idle(10)

        assertEquals(1, stalls.size)
        val stall = stalls.single()
        assertEquals(postedWall, stall.ts)
        assertEquals(400.0, stall.durationMs, 0.0)
        assertEquals(6, stall.samples) // At 100..350 ms late.
        assertSame(blockStack, stall.stack)
        assertFalse(stall.stackCut)
        assertFalse(reportedUnderLock)
        assertEquals("homepage", stall.screen)
        assertFalse(stall.debugger)

        block(8)
        assertEquals(2, stalls.size)
    }

    @Test
    fun theScreenIsTakenWhenTheBlockIsFirstSampled() {
        idle(2)
        block(8) { round -> if (round == 5) screen = "later" }
        assertEquals("homepage", stalls.single().screen)
    }

    @Test
    fun theMostFrequentStackWinsKeyedByItsTopEightFrames() {
        val top = (1..8).map { "app.Deep.f$it" }.toTypedArray()
        val shallow = stackOf("app.Parse.json", "app.Work.run")
        val deepA = stackOf(*top, "app.Caller.a")
        val deepB = stackOf(*top, "app.Caller.b") // Same top 8 frames: same key as deepA.
        val order = listOf(shallow, shallow, deepA, deepB, shallow, deepB)
        var next = 0
        sampler = { order[next++] }
        idle(2)
        block(8) // Six samples: shallow ×3, deep ×3; a tie keeps the first seen of the most frequent.
        assertEquals(6, stalls.single().samples)
        assertSame(shallow, stalls.single().stack)

        next = 0
        sampler = { listOf(shallow, deepA, deepB, deepA, shallow, deepB)[next++] }
        block(8)
        assertSame(deepA, stalls[1].stack) // deep ×4 vs shallow ×2; represented by its first sample.
    }

    @Test
    fun aSampleRacingTheEndOfTheBlockIsDiscarded() {
        idle(2)
        var count = 0
        sampler = {
            if (++count == 3) main.runPosted() // The main thread finishes while its stack is being taken.
            blockStack
        }
        block(5) // Samples at 100, 150 and (racing) 200 ms late.
        assertEquals(2, stalls.single().samples)
        assertEquals(200.0, stalls.single().durationMs, 0.0)
    }

    @Test
    fun blocksLongerThanThirtySecondsAreReportedOnceWhenCut() {
        idle(2)
        val rounds = (StallDetector.MAX_BLOCK_MS / StallDetector.INTERVAL_MS).toInt() + 40
        block(rounds) { if (it == rounds - 1) assertEquals(1, stalls.size) }
        assertEquals(1, stalls.size) // Not reported again when the tick finally runs.
        val cut = stalls.single()
        assertEquals(StallDetector.MAX_BLOCK_MS.toDouble(), cut.durationMs, 0.0)
        assertTrue(cut.samples in 1..StallDetector.MAX_SAMPLES)
        val samplesAtCut = sampled
        assertEquals(cut.samples, samplesAtCut) // Sampling stops once reported.

        block(8)
        assertEquals(2, stalls.size)
        assertEquals(400.0, stalls[1].durationMs, 0.0)
    }

    @Test
    fun aBlockIsCutAtMaxSamples() {
        maxSamples = 4
        idle(2)
        block(10) { if (it == 9) assertEquals(1, stalls.size) }
        val cut = stalls.single()
        assertEquals(4, cut.samples)
        assertEquals(250.0, cut.durationMs, 0.0) // Fourth sample at 250 ms late.
        assertEquals(4, sampled)
    }

    @Test
    fun deepStacksAreStoredCutWithAFlag() {
        val deep = (0 until 200).map { StackTraceElement("app.C$it", "m", "C.kt", it) }.toTypedArray()
        sampler = { deep }
        idle(2)
        block(8)
        val stall = stalls.single()
        assertEquals(StackFrames.MAX_SAMPLED_ELEMENTS, stall.stack.size)
        assertEquals("app.C0", stall.stack.first().className) // Innermost kept.
        assertTrue(stall.stackCut)
    }

    @Test
    fun aRaisedThresholdAppliesLive() {
        idle(2)
        threshold = 500
        block(8)
        assertTrue(stalls.isEmpty())
        threshold = 100
        block(8)
        assertEquals(1, stalls.size)
    }

    @Test
    fun closeReportsTheBlockInProgressAndStopsPosting() {
        idle(2)
        repeat(8) {
            detector.step()
            clock.advanceMs(StallDetector.INTERVAL_MS)
        }
        detector.close() // Called on the main thread: the block is over.
        assertEquals(400.0, stalls.single().durationMs, 0.0)
        assertTrue(detector.isClosed)

        main.runPosted()
        detector.step()
        assertEquals(0, main.pendingCount)
        assertEquals(1, stalls.size)
    }

    @Test
    fun closeWhileIdleReportsNothing() {
        idle(5)
        detector.close()
        assertTrue(stalls.isEmpty())
    }
}

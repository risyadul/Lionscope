package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeSerialExecutor : SerialExecutor {
    var prestartResult = true
    val tasks = ArrayList<Pair<Long, Runnable>>()

    override fun prestart(): Boolean = prestartResult

    override fun execute(delayMs: Long, task: Runnable) {
        tasks += delayMs to task
    }

    fun runNext(): Long {
        val (delay, task) = tasks.removeAt(0)
        task.run()
        return delay
    }
}

private class LeakedClosableViolation : Throwable()

class ViolationReporterTest {

    private val executor = FakeSerialExecutor()
    private var now = 0L
    private val emitted = ArrayList<Pair<ViolationEvent, Int>>()
    private val reporter = ViolationReporter(executor, { "homepage" }, { event, count -> emitted += event to count }, { now }, { 1_000 + now })
    private val violation = LeakedClosableViolation()

    @Test
    fun violationsWhileStoppedAreDropped() {
        reporter.onViolation(StrictModePolicy.VM, violation)
        assertTrue(emitted.isEmpty())
        reporter.start()
        reporter.stop()
        reporter.onViolation(StrictModePolicy.VM, violation)
        assertTrue(emitted.isEmpty())
    }

    @Test
    fun repeatsAreFlushedWithTheirCountOnTheReporterThread() {
        assertTrue(reporter.start())
        reporter.onViolation(StrictModePolicy.VM, violation)
        assertEquals(1, emitted.single().second)
        assertEquals("homepage", emitted.single().first.screen)
        assertEquals(1_000L, emitted.single().first.wallMs)

        now = 100
        reporter.onViolation(StrictModePolicy.VM, violation)
        now = 200
        reporter.onViolation(StrictModePolicy.VM, violation)
        assertEquals(1, emitted.size)
        assertEquals(1, executor.tasks.size) // One flush scheduled, not one per violation.
        now = 1_000
        assertEquals(900L, executor.runNext())
        assertEquals(2, emitted.last().second)
        assertEquals(1_100L, emitted.last().first.wallMs) // The batch's first occurrence.
    }

    @Test
    fun aFlushFromAnEarlierSessionIsDropped() {
        reporter.start()
        reporter.onViolation(StrictModePolicy.THREAD, violation)
        now = 10
        reporter.onViolation(StrictModePolicy.THREAD, violation) // Pending; flush scheduled.
        reporter.stop()
        reporter.start() // New session, fresh coalescer.
        now = 20
        reporter.onViolation(StrictModePolicy.THREAD, violation)
        assertEquals(2, emitted.size) // Emitted at once: the old session's window does not apply.
        now = 2_000
        executor.runNext() // The old session's flush.
        assertEquals(2, emitted.size)
    }

    @Test
    fun startFailsWhenTheThreadCannotStart() {
        executor.prestartResult = false
        assertFalse(reporter.start())
        reporter.onViolation(StrictModePolicy.VM, violation)
        assertTrue(emitted.isEmpty())
    }
}

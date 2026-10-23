package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InflateReporterTest {

    private val link = FakeLink()
    private val main = FakeScheduler()
    private var now = 0L
    private val reporter = InflateReporter(link, main) { now }
    private val home = LayoutName("fragment_home", null, false)
    private val row = LayoutName("item_row", null, false)

    private fun sent() = link.v3Lines.map { TestJson.parse(it) as Map<*, *> }

    /** Welcome at v3 and the config that follows it. */
    private fun welcome() {
        reporter.setLink(3)
        reporter.setTracking(true)
    }

    @Test
    fun coalescesPerLayoutAndScreenAndKeepsTheSlowestsStartAndViews() {
        welcome()
        reporter.add(row, "list", tsMs = 100, durationMs = 1.0, views = 5)
        reporter.add(row, "list", tsMs = 200, durationMs = 3.5, views = 6)
        reporter.add(row, "list", tsMs = 300, durationMs = 2.0, views = 7)
        reporter.add(row, "homepage", tsMs = 400, durationMs = 1.0, views = 5)
        reporter.add(LayoutName(null, "LinearLayout:7", false), "list", tsMs = 500, durationMs = 1.0, views = 1)
        assertTrue(link.v3Lines.isEmpty())
        assertEquals(listOf(InflateReporter.FLUSH_INTERVAL_MS), main.delayed.map { it.second }) // One timer.

        now = 1_000
        main.runDelayed()
        val lines = sent()
        assertEquals(3, lines.size)
        val first = lines[0]
        assertEquals(listOf("item_row", "list", 3.0, 6.5, 3.5, 200.0, 6.0),
            listOf("layout", "screen", "count", "totalMs", "maxMs", "ts", "views").map { first[it] })
        assertEquals("homepage", lines[1]["screen"])
        assertEquals("LinearLayout:7", lines[2]["label"])
    }

    @Test
    fun sendsAtMostOncePerSecondButRightAwayOnAScreenChange() {
        welcome()
        reporter.add(home, "homepage", 1, 18.4, 42)
        now = 400
        main.runDelayed() // Too early: rescheduled for the rest of the window.
        assertTrue(link.v3Lines.isEmpty())
        assertEquals(600L, main.delayed.single().second)

        reporter.onScreenChanged()
        assertEquals(1, link.v3Lines.size)
        now = 1_000
        main.runDelayed()
        assertEquals(1, link.v3Lines.size) // Nothing new.
    }

    @Test
    fun aColdStartIsHeldUntilAV3WelcomeAndItsConfigAndDroppedAfterTheHoldTime() {
        reporter.add(home, "homepage", 1, 18.4, 42) // Link not welcomed yet: recorded.
        now = 1_000
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty())
        reporter.setLink(3)
        now = 2_000
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty()) // Welcomed, but the config that follows may still turn tracking off.
        reporter.setTracking(true)
        now = 2_300
        main.runDelayed()
        assertEquals("fragment_home", sent().single()["layout"])

        reporter.setLink(0)
        reporter.add(home, "homepage", 1, 18.4, 42)
        now = 2_300 + InflateReporter.HOLD_MS
        main.runDelayed()
        welcome()
        now += 2_000
        main.runDelayed()
        assertEquals(1, link.v3Lines.size) // The held window had expired.
    }

    @Test
    fun aConfigTurningTrackingOffDropsTheHeldColdStart() {
        reporter.add(home, "homepage", 1, 18.4, 42)
        reporter.setLink(3)
        main.runDelayed() // However early a timer fires, nothing goes out before the config.
        now = 1_500
        main.runDelayed()
        reporter.setTracking(false)
        now = 10_000
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty())
    }

    @Test
    fun aServerThatSendsNoConfigGetsTheHeldDataAfterTheWait() {
        reporter.add(home, "homepage", 1, 18.4, 42)
        reporter.setLink(3)
        now = InflateReporter.CONFIG_WAIT_MS - 1
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty())
        now = InflateReporter.CONFIG_WAIT_MS
        main.runDelayed()
        assertEquals(1, link.v3Lines.size)
    }

    @Test
    fun nestedInflationsAreKeptApartFromRootsOfTheSameLayout() {
        welcome()
        reporter.add(row, "list", 1, 1.0, 7, nested = false)
        reporter.add(row, "list", 2, 2.0, 7, nested = true)
        now = 1_000
        main.runDelayed()
        assertEquals(listOf(false, true), sent().map { it["nested"] })
    }

    @Test
    fun anOlderLinkOrTrackingOffStopsRecordingAndDropsWhatIsPending() {
        reporter.add(home, "homepage", 1, 18.4, 42)
        reporter.setLink(2)
        assertFalse(reporter.isRecording)
        reporter.add(home, "homepage", 1, 18.4, 42)
        reporter.setLink(3)
        now = 5_000
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty())

        reporter.add(home, "homepage", 1, 18.4, 42)
        reporter.setTracking(false)
        assertFalse(reporter.isRecording)
        reporter.add(home, "homepage", 1, 18.4, 42)
        now = 10_000
        main.runDelayed()
        reporter.onScreenChanged()
        assertTrue(link.v3Lines.isEmpty())
        reporter.setTracking(true)
        assertTrue(reporter.isRecording)
    }

    /** Runs delayed tasks when their time comes, unlike [FakeScheduler]. */
    private class TimedScheduler(private val clock: () -> Long) : MainScheduler {
        private val tasks = ArrayList<Pair<Long, Runnable>>()

        override fun post(task: Runnable) = postDelayed(task, 0)

        override fun postDelayed(task: Runnable, delayMs: Long) {
            tasks += clock() + delayMs to task
        }

        fun runDue() {
            while (true) {
                val next = tasks.filter { it.first <= clock() }.minByOrNull { it.first } ?: return
                tasks.remove(next)
                next.second.run()
            }
        }
    }

    @Test
    fun aFullWindowAColdStartReleaseAndScreenChurnStayUnderTheServersLineRate() {
        val timed = TimedScheduler { now }
        val paced = InflateReporter(link, timed) { now }
        val sentAt = ArrayList<Long>()
        fun stamp() = repeat(link.v3Lines.size - sentAt.size) { sentAt += now }
        fun step(toMs: Long) {
            while (now < toMs) {
                now += 10
                timed.runDue()
                stamp()
            }
        }
        // Cold start: far more distinct layouts than one window holds, before the link is up.
        repeat(InflateCoalescer.MAX_KEYS + 40) { paced.add(LayoutName("cold_$it", null, false), "home", it.toLong(), 1.0, 1) }
        assertEquals(40, paced.pendingOverflow)
        step(500)
        paced.setLink(3)
        paced.setTracking(true)
        // Then a screen change every 50 ms, each with a full set of new layouts.
        for (round in 0 until 60) {
            repeat(InflateCoalescer.MAX_KEYS) { paced.add(LayoutName("l${round}_$it", null, false), "s$round", 1, 1.0, 1) }
            paced.onScreenChanged()
            stamp()
            step(now + 50)
        }
        step(now + 3_000)

        assertTrue(sentAt.size > 3 * InflateCoalescer.MAX_KEYS) // It keeps sending...
        val worstSecond = sentAt.indices.maxOf { i -> sentAt.count { it >= sentAt[i] && it < sentAt[i] + 1_000 } }
        assertTrue("worst second: $worstSecond lines", worstSecond <= InflateReporter.MAX_LINES_PER_SECOND) // ...paced.
        val sendTimes = sentAt.distinct()
        assertTrue(sendTimes.zipWithNext().all { (a, b) -> b - a >= InflateReporter.MIN_FLUSH_GAP_MS })
    }

    @Test
    fun keysPerWindowAreBounded() {
        val coalescer = InflateCoalescer(maxKeys = 2)
        for (i in 0 until 4) coalescer.add(LayoutName("l$i", null, false), null, 1, 1.0, 1, nowMs = 0)
        coalescer.add(LayoutName("l0", null, false), null, 1, 1.0, 1, nowMs = 0) // Existing keys still count.
        assertEquals(2, coalescer.overflow)
        assertEquals(listOf(2, 1), coalescer.drain().map { it.count })
        assertEquals(0, coalescer.overflow)
        assertEquals(null, coalescer.windowStartMs)
    }

    @Test
    fun anInspectOnlyLinkReportsNothingUntilASessionWelcome() {
        LayoutsTracker(link, main, reporter, tracer = null, snapshotter = ViewTreeSnapshotter(link, { "homepage" }, afterFrameAndIdle = {}))
        link.welcome(true, DEVICE_PROTOCOL_V5, inspectOnly = true)
        main.runPosted()
        reporter.add(home, "homepage", 1, 18.4, 42) // Origins recording is unchanged: still recorded...
        now = 5_000
        main.runDelayed()
        assertTrue(link.v3Lines.isEmpty()) // ...but never sent.

        link.welcome(false)
        main.runPosted()
        link.welcome(true, DEVICE_PROTOCOL_V5)
        main.runPosted()
        link.config(SdkOptions(150, false, inflateTracking = true))
        main.runPosted()
        reporter.add(home, "homepage", 2, 10.0, 42)
        now = 10_000
        main.runDelayed()
        assertEquals(1, link.v3Lines.size)
    }
}

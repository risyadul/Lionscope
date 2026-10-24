package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class FakeWatchdog : Watchdog {
    override var thresholdMs = 0L
    var isRunning = false
        private set
    var starts = 0
        private set

    override fun start() {
        if (!isRunning) starts++
        isRunning = true
    }

    override fun stop() {
        isRunning = false
    }
}

internal class FakeStrictMode : StrictModeSwitch {
    @Volatile
    var enabled = false
        private set
    val changes = ArrayList<Boolean>()
    var resumes = 0
        private set

    override fun setEnabled(enabled: Boolean) {
        if (enabled != this.enabled) changes += enabled
        this.enabled = enabled
    }

    override fun onActivityResumed() {
        resumes++
    }
}

internal class FakeRxTracking : RxTracking {
    var enabled = false
        private set
    val changes = ArrayList<Boolean>()

    override fun setEnabled(enabled: Boolean) {
        if (enabled != this.enabled) changes += enabled
        this.enabled = enabled
    }

    override var currentTask: Any? = null

    override fun describe(task: Any, frames: (Array<StackTraceElement>) -> List<StackFrame>): RxOrigin? =
        RxOrigin(task.javaClass.name, null, emptyList())
}

class DiagnosticsControllerTest {

    private val link = FakeLink()
    private val main = FakeScheduler()
    private val watchdog = FakeWatchdog()
    private val strictMode = FakeStrictMode()
    private val controller = DiagnosticsController(link, main, watchdog, strictMode)
    private val activity = PlainTestActivity()

    private fun welcome(version: Int) {
        link.welcome(true, version)
        main.runPosted()
    }

    private fun config(thresholdMs: Long, strict: Boolean) {
        link.config(SdkOptions(thresholdMs, strict))
        main.runPosted()
    }

    @Test
    fun watchdogRunsOnlyWhileWelcomedAtV2WithAStartedActivity() {
        controller.onActivityStarted(activity)
        assertFalse(watchdog.isRunning) // Not welcomed.
        welcome(2)
        assertTrue(watchdog.isRunning)

        controller.onActivityStopped(activity) // Backgrounded.
        assertFalse(watchdog.isRunning)
        controller.onActivityStarted(activity)
        assertTrue(watchdog.isRunning)

        link.welcome(false)
        main.runPosted()
        assertFalse(watchdog.isRunning)
    }

    @Test
    fun aV1LinkNeverStartsTheWatchdogNorStrictMode() {
        controller.onActivityStarted(activity)
        welcome(1)
        config(250, strict = true) // A v1 DeviceLink drops config; even if one got through it is ignored.
        assertFalse(watchdog.isRunning)
        assertEquals(0, watchdog.starts)
        assertFalse(strictMode.enabled)
    }

    @Test
    fun configAppliesLiveAndResetsToDefaultsOnEveryLinkChange() {
        controller.onActivityStarted(activity)
        welcome(2)
        assertEquals(SdkOptions.DEFAULT, controller.options)
        assertEquals(150L, watchdog.thresholdMs)
        assertFalse(strictMode.enabled)

        config(500, strict = true)
        assertEquals(500L, watchdog.thresholdMs)
        assertTrue(strictMode.enabled)
        config(100, strict = false)
        assertEquals(100L, watchdog.thresholdMs)
        assertFalse(strictMode.enabled)
        config(250, strict = true)

        link.welcome(false) // Link closed: StrictMode policies restored, defaults until the next config.
        main.runPosted()
        assertFalse(strictMode.enabled)
        assertEquals(SdkOptions.DEFAULT, controller.options)
        welcome(2)
        assertEquals(150L, watchdog.thresholdMs)
        assertFalse(strictMode.enabled)
        assertEquals(listOf(true, false, true, false), strictMode.changes)
    }

    @Test
    fun strictModeDoesNotNeedAForegroundActivityButIsReappliedOnResume() {
        welcome(2)
        config(150, strict = true)
        assertTrue(strictMode.enabled)
        assertFalse(watchdog.isRunning)
        controller.onActivityResumed(activity)
        assertEquals(1, strictMode.resumes)
    }

    @Test
    fun destroyingAStartedActivityCountsAsStopped() {
        welcome(2)
        controller.onActivityStarted(activity)
        controller.onActivityDestroyed(activity)
        assertFalse(watchdog.isRunning)
    }

    @Test
    fun belowApi28ThereIsNoStrictModeAndTheWatchdogStillWorks() {
        val link = FakeLink()
        val watchdog = FakeWatchdog()
        val controller = DiagnosticsController(link, main, watchdog, strictMode = null)
        controller.onActivityStarted(activity)
        link.welcome(true, 2)
        link.config(SdkOptions(250, true))
        main.runPosted()
        controller.onActivityResumed(activity)
        assertTrue(watchdog.isRunning)
        assertEquals(250L, watchdog.thresholdMs)
    }

    @Test
    fun anInspectOnlyLinkLeavesTheWatchdogAndStrictModeOff() {
        link.welcome(true, DEVICE_PROTOCOL_V5, inspectOnly = true)
        main.runPosted()
        controller.onActivityStarted(activity)
        link.config(SdkOptions(1000, true))
        main.runPosted()
        assertFalse(watchdog.isRunning)
        assertEquals(0, watchdog.starts)
        assertTrue(strictMode.changes.isEmpty())

        link.welcome(false)
        main.runPosted()
        welcome(DEVICE_PROTOCOL_V5) // The same app later joins a session.
        assertTrue(watchdog.isRunning)
    }

    @Test
    fun rxTrackingRunsOnlyInAV9SessionWithTheOptionOn() {
        val rx = FakeRxTracking()
        val link = FakeLink()
        DiagnosticsController(link, main, FakeWatchdog(), strictMode = null, rx = rx)
        link.welcome(true, DEVICE_PROTOCOL_V8)
        main.runPosted()
        assertFalse(rx.enabled) // An older server can't receive what it finds.

        link.welcome(false)
        main.runPosted()
        link.welcome(true, DEVICE_PROTOCOL_V9)
        main.runPosted()
        assertFalse(rx.enabled) // Waits for the session's config.
        link.config(SdkOptions(150, strictMode = false))
        main.runPosted()
        assertTrue(rx.enabled) // On by default, in the background too.

        link.config(SdkOptions(150, strictMode = false, rxTracking = false))
        main.runPosted()
        assertFalse(rx.enabled)
        link.config(SdkOptions(150, strictMode = false))
        main.runPosted()
        assertTrue(rx.enabled)

        link.welcome(false) // Disconnected.
        main.runPosted()
        assertFalse(rx.enabled)
        assertEquals(listOf(true, false, true, false), rx.changes)
    }

    @Test
    fun anInspectOnlyLinkNeverTurnsRxTrackingOn() {
        val rx = FakeRxTracking()
        val link = FakeLink()
        DiagnosticsController(link, main, FakeWatchdog(), strictMode = null, rx = rx)
        link.welcome(true, DEVICE_PROTOCOL_V9, inspectOnly = true)
        main.runPosted()
        assertTrue(rx.changes.isEmpty())
    }
}

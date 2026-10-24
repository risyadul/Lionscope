package io.github.risyadul.lionscope

import android.view.View
import android.view.Window
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LayoutsTrackerTest {

    private val link = FakeLink()
    private val main = FakeScheduler()
    private val reporter = InflateReporter(link, main) { 0L }
    private val snapshots = ArrayList<Runnable>()
    private val snapshotter = ViewTreeSnapshotter(link, { "homepage" }, afterFrameAndIdle = { snapshots += it })
    private val tracker = LayoutsTracker(link, main, reporter, tracer = null, snapshotter = snapshotter)
    private val home = ScreenRef("homepage", "com.example.shop.HomeFragment", ScreenKind.FRAGMENT)

    private fun welcome(version: Int) {
        link.welcome(true, version)
        main.runPosted()
    }

    @Test
    fun viewTreesAreOnlyRequestedOnAV3Link() {
        tracker.onScreenChanged(home, Any())
        welcome(2)
        tracker.onScreenChanged(home.copy(name = "other"), Any())
        assertTrue(snapshots.isEmpty())

        link.welcome(false)
        main.runPosted()
        welcome(3) // A new dashboard gets the current screen's tree...
        assertEquals(1, snapshots.size)
        tracker.onScreenChanged(home, Any()) // ...and one per screen change.
        assertEquals(2, snapshots.size)
        tracker.onScreenChanged(null, null) // Background: nothing to walk.
        assertEquals(2, snapshots.size)
    }

    @Test
    fun aSupersededOrUnresolvableSnapshotSendsNothing() {
        welcome(3)
        tracker.onScreenChanged(home, Any())
        tracker.onScreenChanged(home.copy(name = "next"), Any())
        snapshots.forEach(Runnable::run) // No started activity in this test: no window to walk.
        assertTrue(link.v3Lines.isEmpty())
    }

    @Test
    fun inflationTrackingFollowsTheLastConfigEvenAcrossLinkDrops() {
        assertTrue(reporter.isRecording) // Cold start: recorded until a server says otherwise.
        welcome(3)
        link.config(SdkOptions(150, false, inflateTracking = false))
        main.runPosted()
        assertFalse(reporter.isRecording)

        link.welcome(false)
        main.runPosted()
        assertFalse(reporter.isRecording) // Still off: new Activities get no factory.
        welcome(3)
        link.config(SdkOptions(150, false, inflateTracking = true))
        main.runPosted()
        assertTrue(reporter.isRecording)

        link.welcome(false)
        main.runPosted()
        welcome(2) // An older server: no v3 messages.
        assertFalse(reporter.isRecording)
    }

    @Test
    fun screenTrackerReportsTheResolvedTarget() {
        val events = ArrayList<Pair<ScreenRef?, Any?>>()
        val recorder = object : LayoutEvents {
            override fun onFragmentViewCreated(fragment: Any, activity: Any?, view: View) = Unit
            override fun onFragmentViewDestroyed(fragment: Any) = Unit
            override fun onDialogShown(fragment: Any, activity: Any?, window: Window, name: String) = Unit
            override fun onDialogHidden(fragment: Any) = Unit
            override fun onScreenChanged(screen: ScreenRef?, target: Any?) {
                events += screen to target
            }
        }
        val screens = ScreenTracker(link, main, layoutEvents = recorder, hooksFactory = { null }, clock = { 1L })
        val activity = PlainTestActivity()
        screens.onActivityStarted(activity)
        screens.onActivityResumed(activity)
        main.runPosted()
        screens.requestResolve()
        main.runPosted() // Unchanged: no event.
        screens.onActivityStopped(activity)
        main.runPosted()

        assertEquals(2, events.size)
        assertEquals("PlainTestActivity", events[0].first?.name)
        assertSame(activity, events[0].second)
        assertEquals(null to null, events[1])
    }

    @Test
    fun anInspectOnlyLinkTakesNoViewTreeSnapshots() {
        link.welcome(true, DEVICE_PROTOCOL_V5, inspectOnly = true)
        main.runPosted()
        tracker.onScreenChanged(home, Any())
        assertTrue(snapshots.isEmpty())

        link.welcome(false)
        main.runPosted()
        welcome(DEVICE_PROTOCOL_V5) // A later session welcome starts them as before.
        assertEquals(1, snapshots.size)
    }
}

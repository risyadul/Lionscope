package io.github.risyadul.lionscope

import android.app.Activity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlainTestActivity : Activity()

class AliasTestActivity : Activity(), FakeScreenName {
    var current: FakeScreen? = FakeScreen.HOME
    override fun getScreen(): FakeScreen? = current
}

class ScreenTrackerTest {

    private val link = FakeLink()
    private val main = FakeScheduler()

    private fun tracker(periodicFallback: Boolean = false, hooks: (ScreenTracker) -> FragmentHooks? = { null }) =
        ScreenTracker(link, main, periodicFallback = periodicFallback, hooksFactory = hooks, clock = { 1L })

    private fun ScreenTracker.launch(activity: Activity) {
        onActivityCreated(activity, null)
        onActivityStarted(activity)
        onActivityResumed(activity)
    }

    private fun activityRef(activity: Activity, name: String) =
        ScreenRef(name, activity.javaClass.name, ScreenKind.ACTIVITY)

    @Test
    fun aWholeTransitionIsOneMainThreadPostAndOneScreen() {
        val tracker = tracker()
        val first = PlainTestActivity()
        tracker.launch(first)
        val second = AliasTestActivity()
        tracker.onActivityPaused(first)
        tracker.launch(second)
        tracker.onActivityStopped(first)
        assertEquals(1, main.pendingCount)
        main.runPosted()
        assertEquals(listOf(activityRef(second, "homepage")), link.screens)
    }

    @Test
    fun requestResolvePicksUpADynamicAliasAndDedupsUnchangedScreens() {
        val tracker = tracker()
        val activity = AliasTestActivity()
        tracker.launch(activity)
        main.runPosted()

        tracker.requestResolve()
        tracker.requestResolve()
        assertEquals(1, main.pendingCount) // Coalesced.
        main.runPosted()
        assertEquals(1, link.screens.size) // Unchanged: nothing on the wire.

        activity.current = FakeScreen.WITH_BODY
        tracker.requestResolve()
        main.runPosted()
        assertEquals(activityRef(activity, "with_body"), link.screens.last())

        activity.current = null
        tracker.requestResolve()
        main.runPosted()
        assertEquals(activityRef(activity, "AliasTestActivity"), link.screens.last())
    }

    @Test
    fun aShownDestinationIsTheScreenOfItsActivity() {
        val tracker = tracker()
        val activity = PlainTestActivity()
        val destinations = object : DestinationScreens {
            var current: ScreenRef? = null
            override fun screenFor(activity: Any): ScreenRef? = current
        }
        tracker.destinations = destinations
        tracker.launch(activity)
        main.runPosted()
        assertEquals(activityRef(activity, "PlainTestActivity"), link.screens.last()) // No destination yet.

        val product = ScreenRef("product/{id}", "product/{id}", ScreenKind.DESTINATION)
        destinations.current = product
        tracker.requestResolve()
        main.runPosted()
        assertEquals(product, link.screens.last())
        assertEquals("product/{id}", tracker.currentScreenName)
    }

    @Test
    fun backgroundEmitsNullAndReportsForegroundChanges() {
        val tracker = tracker()
        val activity = PlainTestActivity()
        tracker.launch(activity)
        tracker.onActivityPaused(activity)
        tracker.onActivityStopped(activity)
        tracker.onActivityStarted(activity)
        main.runPosted()
        assertEquals(listOf(true, false, true), link.foreground)
        assertEquals(listOf(activityRef(activity, "PlainTestActivity")), link.screens)

        tracker.onActivityStopped(activity)
        main.runPosted()
        assertEquals(null, link.screens.last())
    }

    @Test
    fun periodicFallbackTicksOnlyWhileWelcomedWithAResumedActivity() {
        val tracker = tracker(periodicFallback = true)
        val activity = AliasTestActivity()
        tracker.launch(activity)
        main.runPosted()
        assertTrue(main.delayed.isEmpty()) // Not welcomed yet.

        link.welcome(true)
        main.runPosted()
        assertEquals(listOf(1_000L), main.delayed.map { it.second })

        activity.current = FakeScreen.WITH_BODY
        main.runDelayed()
        assertEquals(activityRef(activity, "with_body"), link.screens.last())
        assertEquals(1, main.delayed.size) // Rescheduled.

        link.welcome(false)
        main.runDelayed()
        assertTrue(main.delayed.isEmpty()) // Stops once the link is down.
    }

    @Test
    fun noPeriodicTicksWhenFramesDriveResolution() {
        val tracker = tracker(periodicFallback = false)
        tracker.launch(PlainTestActivity())
        link.welcome(true)
        main.runPosted()
        assertTrue(main.delayed.isEmpty())
    }

    @Test
    fun fragmentHooksThatFailToLoadFallBackToActivityTracking() {
        val tracker = tracker(hooks = { throw NoClassDefFoundError("androidx/fragment/app/FragmentManager") })
        assertFalse(tracker.tracksFragments)
        val activity = PlainTestActivity()
        tracker.launch(activity)
        main.runPosted()
        assertEquals(listOf(activityRef(activity, "PlainTestActivity")), link.screens)
    }

    @Test
    fun realFragmentHooksLoadWhenAndroidxFragmentIsPresent() {
        assertTrue(ScreenTracker(link, main).tracksFragments)
    }

    @Test
    fun callbacksContainLinkFailuresIncludingErrors() {
        val tracker = tracker()
        link.failure = StackOverflowError("boom")
        tracker.launch(PlainTestActivity())
        main.runPosted() // Must not throw.
        link.failure = IllegalStateException("boom")
        tracker.onActivityResumed(AliasTestActivity())
        main.runPosted()
        assertTrue(link.screens.isEmpty())
    }
}

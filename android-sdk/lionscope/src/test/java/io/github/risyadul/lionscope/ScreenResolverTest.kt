package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenResolverTest {

    /** A tracked Activity / Fragment; [label] plays the role of its (possibly dynamic) screen name. */
    private class Instance(var label: String) {
        override fun toString() = label
    }

    private val resolver = ScreenResolver()
    private val hidden = HashSet<Any>()
    private val described = ArrayList<Any>()
    private fun top() = resolver.resolve({ it !in hidden }) { target, kind ->
        described += target
        val label = (target as Instance).label
        ScreenRef(label, "app.$label", kind)
    }

    private fun activityRef(name: String) = ScreenRef(name, "app.$name", ScreenKind.ACTIVITY)
    private fun fragmentRef(name: String) = ScreenRef(name, "app.$name", ScreenKind.FRAGMENT)
    private fun dialogRef(name: String) = ScreenRef(name, "app.$name", ScreenKind.DIALOG)

    private fun launch(activity: Instance, name: String) {
        activity.label = name
        resolver.activityStarted(activity)
        resolver.activityResumed(activity)
    }

    private fun resumeFragment(fragment: Instance, activity: Any, ref: ScreenRef, parent: Any? = null) {
        fragment.label = ref.name
        resolver.fragmentResumed(fragment, activity, parent, ref.kind)
    }

    @Test
    fun nothingStartedMeansNoScreen() {
        assertNull(top())
    }

    @Test
    fun activityWithoutFragmentsIsTheScreen() {
        launch(Instance("main"), "MainActivity")
        assertEquals(activityRef("MainActivity"), top())
    }

    @Test
    fun fragmentOverActivity() {
        val main = Instance("main")
        launch(main, "MainActivity")
        resumeFragment(Instance("home"), main, fragmentRef("homepage"))
        assertEquals(fragmentRef("homepage"), top())
    }

    @Test
    fun replacedFragmentGivesWayToTheNewOne() {
        val main = Instance("main")
        val home = Instance("home")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        resolver.fragmentPaused(home)
        resolver.fragmentGone(home)
        resumeFragment(Instance("list"), main, fragmentRef("ListFragment"))
        assertEquals(fragmentRef("ListFragment"), top())
    }

    @Test
    fun nestedChildFragmentWinsEvenThoughParentResumesLast() {
        val main = Instance("main")
        val container = Instance("container")
        val child = Instance("child")
        val grandChild = Instance("grandChild")
        launch(main, "MainActivity")
        // FragmentManager reports children as resumed before their parent.
        resumeFragment(grandChild, main, fragmentRef("GrandChild"), parent = child)
        resumeFragment(child, main, fragmentRef("Child"), parent = container)
        resumeFragment(container, main, fragmentRef("Container"))
        assertEquals(fragmentRef("GrandChild"), top())
    }

    @Test
    fun childReplacedInsideContainer() {
        val main = Instance("main")
        val container = Instance("container")
        val first = Instance("first")
        launch(main, "MainActivity")
        resumeFragment(first, main, fragmentRef("First"), parent = container)
        resumeFragment(container, main, fragmentRef("Container"))
        resolver.fragmentPaused(first)
        resolver.fragmentGone(first)
        assertEquals(fragmentRef("Container"), top())
        resumeFragment(Instance("second"), main, fragmentRef("Second"), parent = container)
        assertEquals(fragmentRef("Second"), top())
    }

    @Test
    fun dialogOnTopThenDismissed() {
        val main = Instance("main")
        val home = Instance("home")
        val dialog = Instance("dialog")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        resumeFragment(dialog, main, dialogRef("Promo"), parent = home)
        assertEquals(dialogRef("Promo"), top())

        // The underlying fragment re-resuming does not cover a showing dialog.
        resolver.fragmentPaused(home)
        resumeFragment(home, main, fragmentRef("homepage"))
        assertEquals(dialogRef("Promo"), top())

        resolver.fragmentPaused(dialog)
        resolver.fragmentGone(dialog)
        assertEquals(fragmentRef("homepage"), top())
    }

    @Test
    fun dialogThatIsNotShowingIsIgnored() {
        val main = Instance("main")
        val dialog = Instance("dialog")
        launch(main, "MainActivity")
        resumeFragment(Instance("home"), main, fragmentRef("homepage"))
        resumeFragment(dialog, main, dialogRef("Promo"))
        hidden += dialog
        assertEquals(fragmentRef("homepage"), top())
    }

    @Test
    fun backToActivityWhenItsLastFragmentIsGone() {
        val main = Instance("main")
        val home = Instance("home")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        resolver.fragmentPaused(home)
        resolver.fragmentGone(home)
        assertEquals(activityRef("MainActivity"), top())
    }

    @Test
    fun hiddenFragmentFallsBackToVisibleSibling() {
        val main = Instance("main")
        val a = Instance("a")
        val b = Instance("b")
        launch(main, "MainActivity")
        resumeFragment(a, main, fragmentRef("A"))
        resumeFragment(b, main, fragmentRef("B"))
        hidden += b
        assertEquals(fragmentRef("A"), top())
        hidden += a
        assertEquals(activityRef("MainActivity"), top())
    }

    @Test
    fun pausedFragmentInResumedActivityIsNotOnTop() {
        // ViewPager2 / BEHAVIOR_RESUME_ONLY_CURRENT_FRAGMENT caps off-screen pages at STARTED.
        val main = Instance("main")
        val page1 = Instance("page1")
        val page2 = Instance("page2")
        launch(main, "MainActivity")
        resumeFragment(page1, main, fragmentRef("Page1"))
        resumeFragment(page2, main, fragmentRef("Page2"))
        resolver.fragmentPaused(page2)
        resumeFragment(page1, main, fragmentRef("Page1"))
        assertEquals(fragmentRef("Page1"), top())
    }

    @Test
    fun secondActivityThenBack() {
        val main = Instance("main")
        val home = Instance("home")
        val detail = Instance("detail")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))

        // Mid-transition: the paused activity keeps its (paused) fragment on top.
        resolver.activityPaused(main)
        resolver.fragmentPaused(home)
        assertEquals(fragmentRef("homepage"), top())

        launch(detail, "detail_page")
        assertEquals(activityRef("detail_page"), top())
        resolver.fragmentGone(home)
        resolver.activityStopped(main)
        assertEquals(activityRef("detail_page"), top())

        // Back: detail pauses, main restarts with its fragment.
        resolver.activityPaused(detail)
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        resolver.activityStopped(detail)
        resolver.activityDestroyed(detail)
        assertEquals(fragmentRef("homepage"), top())
    }

    @Test
    fun fragmentsOfAnActivityBelowAreIgnored() {
        val main = Instance("main")
        val detail = Instance("detail")
        launch(main, "MainActivity")
        launch(detail, "DetailActivity")
        resumeFragment(Instance("late"), main, fragmentRef("Late"))
        assertEquals(activityRef("DetailActivity"), top())
    }

    @Test
    fun backgroundMeansNullAndForegroundRestores() {
        val main = Instance("main")
        val home = Instance("home")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        resolver.activityPaused(main)
        resolver.fragmentPaused(home)
        resolver.fragmentGone(home)
        resolver.activityStopped(main)
        assertNull(top())

        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("homepage"))
        assertEquals(fragmentRef("homepage"), top())
    }

    @Test
    fun rotationRecreateResolvesToTheSameScreen() {
        val old = Instance("old")
        val oldHome = Instance("oldHome")
        launch(old, "MainActivity")
        resumeFragment(oldHome, old, fragmentRef("homepage"))
        val before = top()

        resolver.activityPaused(old)
        resolver.fragmentPaused(oldHome)
        resolver.fragmentGone(oldHome)
        resolver.activityStopped(old)
        resolver.activityDestroyed(old)
        val recreated = Instance("new")
        launch(recreated, "MainActivity")
        resumeFragment(Instance("newHome"), recreated, fragmentRef("homepage"))

        assertEquals(before, top())
    }

    @Test
    fun destroyedActivityForgetsItsFragments() {
        val main = Instance("main")
        val detail = Instance("detail")
        launch(main, "MainActivity")
        launch(detail, "DetailActivity")
        resumeFragment(Instance("detailFragment"), detail, fragmentRef("DetailFragment"))
        resolver.activityPaused(detail)
        resolver.activityStopped(detail)
        resolver.activityDestroyed(detail)
        assertEquals(activityRef("MainActivity"), top())
    }

    @Test
    fun aliasIsReadAtResolveTimeForTheFinalPickOnly() {
        val main = Instance("main")
        val pager = Instance("pager")
        launch(main, "MainActivity")
        resumeFragment(pager, main, fragmentRef("orders_active"))
        assertEquals(fragmentRef("orders_active"), top())

        // e.g. a pager fragment whose getScreen() follows viewPager.currentItem without any lifecycle event.
        pager.label = "orders_history"
        described.clear()
        assertEquals(fragmentRef("orders_history"), top())
        assertEquals(listOf<Any>(pager), described)
    }

    @Test
    fun descentStopsOnSelfParentAndCycles() {
        val main = Instance("main")
        val a = Instance("a")
        val b = Instance("b")
        launch(main, "MainActivity")
        resumeFragment(a, main, fragmentRef("A"), parent = b)
        resumeFragment(b, main, fragmentRef("B"), parent = a)
        // Terminates (bounded descent) and returns one of the cycle members.
        assertTrue(top()!!.name in setOf("A", "B"))

        val self = Instance("self")
        resumeFragment(self, main, fragmentRef("Self"), parent = self)
        assertEquals(fragmentRef("Self"), top())
    }
}

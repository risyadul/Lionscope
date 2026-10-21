package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenResolverTest {

    /**
     * A tracked Activity / Fragment; [label] plays the role of its (possibly dynamic) screen name and [className]
     * of its class (app-owned by default).
     */
    private class Instance(var label: String, val className: String = "com.example.shop.ui.Screen") {
        override fun toString() = label
    }

    private var resolver = ScreenResolver()
    private val hidden = HashSet<Any>()
    private val described = ArrayList<Any>()
    private fun top() = resolver.resolve(
        isShown = { it !in hidden },
        describe = { target, kind ->
            described += target
            val label = (target as Instance).label
            ScreenRef(label, "app.$label", kind)
        },
        classNameOf = { (it as Instance).className },
    )

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

    @Test
    fun libraryChildInsideAnAppFragmentReportsTheAppFragment() {
        val main = Instance("main", MAIN_ACTIVITY)
        val address = Instance("address", "com.example.shop.checkout.AddressFragment")
        val map = Instance("map", MAP_FRAGMENT)
        launch(main, "MainActivity")
        resumeFragment(map, main, fragmentRef("SupportMapFragment"), parent = address)
        resumeFragment(address, main, fragmentRef("Address"))
        assertEquals(fragmentRef("Address"), top())

        // Added to the child FragmentManager after the parent resumed: the shown parent still wins.
        resolver.fragmentPaused(map)
        resolver.fragmentGone(map)
        resumeFragment(map, main, fragmentRef("SupportMapFragment"), parent = address)
        assertEquals(fragmentRef("Address"), top())
    }

    @Test
    fun libraryContainerIsDescendedThroughToTheAppChild() {
        val main = Instance("main", MAIN_ACTIVITY)
        val navHost = Instance("navHost", NAV_HOST)
        val cart = Instance("cart", "com.example.shop.cart.CartFragment")
        val map = Instance("map", MAP_FRAGMENT)
        launch(main, "MainActivity")
        resumeFragment(map, main, fragmentRef("SupportMapFragment"), parent = cart)
        resumeFragment(cart, main, fragmentRef("Cart"), parent = navHost)
        resumeFragment(navHost, main, fragmentRef("NavHostFragment"))
        assertEquals(fragmentRef("Cart"), top())
    }

    @Test
    fun libraryDialogFallsBackToTheScreenBeneath() {
        val main = Instance("main", MAIN_ACTIVITY)
        val home = Instance("home", "com.example.shop.home.HomeFragment")
        val consent = Instance("consent", "com.vendor.consent.ConsentDialog")
        val consentPage = Instance("consentPage", "com.vendor.consent.ConsentPageFragment")
        launch(main, "MainActivity")
        resumeFragment(home, main, fragmentRef("Home"))
        resumeFragment(consentPage, main, fragmentRef("ConsentPage"), parent = consent)
        resumeFragment(consent, main, dialogRef("Consent"), parent = home)
        // Neither the library dialog nor its (library) content is the screen; the dialog's subtree is skipped.
        assertEquals(fragmentRef("Home"), top())

        // An app dialog below the library one is the screen beneath.
        val promo = Instance("promo", "com.example.shop.home.PromoDialog")
        resolver.fragmentGone(consent)
        resolver.fragmentGone(consentPage)
        resumeFragment(promo, main, dialogRef("Promo"), parent = home)
        resumeFragment(consentPage, main, fragmentRef("ConsentPage"), parent = consent)
        resumeFragment(consent, main, dialogRef("Consent"), parent = home)
        assertEquals(dialogRef("Promo"), top())
    }

    @Test
    fun libraryDialogHostingAnAppFragmentReportsThatFragment() {
        val main = Instance("main", MAIN_ACTIVITY)
        val sheet = Instance("sheet", "com.vendor.sheets.HostSheetDialog")
        val filters = Instance("filters", "com.example.shop.search.FiltersFragment")
        launch(main, "MainActivity")
        resumeFragment(Instance("home", "com.example.shop.home.HomeFragment"), main, fragmentRef("Home"))
        resumeFragment(filters, main, fragmentRef("Filters"), parent = sheet)
        resumeFragment(sheet, main, dialogRef("HostSheet"))
        assertEquals(fragmentRef("Filters"), top())
    }

    @Test
    fun allLibraryChainFallsBackToTheActivity() {
        val main = Instance("main", MAIN_ACTIVITY)
        val navHost = Instance("navHost", NAV_HOST)
        launch(main, "MainActivity")
        resumeFragment(Instance("map", MAP_FRAGMENT), main, fragmentRef("SupportMapFragment"), parent = navHost)
        resumeFragment(navHost, main, fragmentRef("NavHostFragment"))
        assertEquals(activityRef("MainActivity"), top())
    }

    @Test
    fun singleSegmentActivityPackageUsesTheWholePackage() {
        val main = Instance("main", "shop.MainActivity")
        val home = Instance("home", "shop.HomeFragment")
        launch(main, "MainActivity")
        resumeFragment(Instance("lookalike", "shopping.PromoFragment"), main, fragmentRef("Lookalike"), parent = home)
        resumeFragment(home, main, fragmentRef("Home"))
        assertEquals(fragmentRef("Home"), top())
    }

    @Test
    fun appPackagePrefixTakesTheFirstTwoSegments() {
        assertEquals("com.example", ScreenResolver.appPackagePrefix("com.example.shop.ui.MainActivity"))
        assertEquals("com.example", ScreenResolver.appPackagePrefix("com.example.MainActivity\$Inner"))
        assertEquals("shop", ScreenResolver.appPackagePrefix("shop.MainActivity"))
        assertEquals("", ScreenResolver.appPackagePrefix("MainActivity"))
    }

    @Test
    fun appOwnershipMatchesWholeSegments() {
        assertTrue(ScreenResolver.isAppOwned("com.example.shop.HomeFragment", "com.example"))
        assertTrue(ScreenResolver.isAppOwned("com.example.HomeFragment", "com.example"))
        assertFalse(ScreenResolver.isAppOwned("com.examples.HomeFragment", "com.example"))
        assertFalse(ScreenResolver.isAppOwned(NAV_HOST, "com.example"))
        assertFalse(ScreenResolver.isAppOwned("HomeFragment", "com.example"))
        assertTrue(ScreenResolver.isAppOwned("anything.Goes", ""))
    }

    @Test
    fun newerTopLevelLibraryFragmentDoesNotHideTheAppChain() {
        val main = Instance("main", MAIN_ACTIVITY)
        val navHost = Instance("navHost", NAV_HOST)
        launch(main, "MainActivity")
        resumeFragment(Instance("cart", "com.example.shop.cart.CartFragment"), main, fragmentRef("Cart"), parent = navHost)
        resumeFragment(navHost, main, fragmentRef("NavHostFragment"))
        // A top-level map beside the NavHost, resumed last.
        resumeFragment(Instance("map", MAP_FRAGMENT), main, fragmentRef("SupportMapFragment"))
        assertEquals(fragmentRef("Cart"), top())

        // Same with an app top-level sheet container next to it.
        val other = Instance("other", MAIN_ACTIVITY)
        launch(other, "OtherActivity")
        resumeFragment(Instance("sheet", "com.example.shop.sheet.SheetContainerFragment"), other, fragmentRef("Sheet"))
        resumeFragment(Instance("map2", MAP_FRAGMENT), other, fragmentRef("SupportMapFragment"))
        assertEquals(fragmentRef("Sheet"), top())
    }

    @Test
    fun applicationIdRootAlsoCountsAsAppOwned() {
        val main = Instance("main", "com.acme.platform.ui.MainActivity")
        val offers = Instance("offers", "com.example.shop.offers.OffersFragment")
        launch(main, "MainActivity")
        resumeFragment(offers, main, fragmentRef("Offers"))
        assertEquals(activityRef("MainActivity"), top())

        resolver = ScreenResolver(applicationId = "com.example.shop.debug")
        launch(main, "MainActivity")
        resumeFragment(offers, main, fragmentRef("Offers"))
        resumeFragment(Instance("map", MAP_FRAGMENT), main, fragmentRef("SupportMapFragment"), parent = offers)
        assertEquals(fragmentRef("Offers"), top())
        // The activity's own root still counts.
        resumeFragment(Instance("home", "com.acme.platform.home.HomeFragment"), main, fragmentRef("Home"))
        assertEquals(fragmentRef("Home"), top())
    }

    @Test
    fun ownershipFollowsTheCurrentTopActivity() {
        val main = Instance("main", MAIN_ACTIVITY)
        val partner = Instance("partner", "org.partner.pay.CheckoutActivity")
        launch(main, "MainActivity")
        resumeFragment(Instance("home", "com.example.shop.home.HomeFragment"), main, fragmentRef("Home"))
        assertEquals(fragmentRef("Home"), top())

        launch(partner, "CheckoutActivity")
        resumeFragment(Instance("pay", "org.partner.pay.PayFragment"), partner, fragmentRef("Pay"))
        assertEquals(fragmentRef("Pay"), top())

        resolver.activityPaused(partner)
        resolver.activityStopped(partner)
        resolver.activityDestroyed(partner)
        launch(main, "MainActivity")
        assertEquals(fragmentRef("Home"), top())
    }

    @Test
    fun ancestorWalkStopsOnATwoNodeCycle() {
        val main = Instance("main", MAIN_ACTIVITY)
        val app = Instance("app", "com.example.shop.home.HomeFragment")
        val library = Instance("library", MAP_FRAGMENT)
        launch(main, "MainActivity")
        resumeFragment(app, main, fragmentRef("Home"), parent = library)
        // Newest root is the library node, so the cycle is walked upwards first.
        resumeFragment(library, main, fragmentRef("SupportMapFragment"), parent = app)
        assertEquals(fragmentRef("Home"), top())
    }

    @Test
    fun dialogNestedInsideADialog() {
        val main = Instance("main", MAIN_ACTIVITY)
        val outer = Instance("outer", "com.example.shop.cart.CartDialog")
        launch(main, "MainActivity")
        resumeFragment(Instance("home", "com.example.shop.home.HomeFragment"), main, fragmentRef("Home"))
        resumeFragment(outer, main, dialogRef("Cart"))
        val inner = Instance("inner", "com.example.shop.cart.ConfirmDialog")
        resumeFragment(inner, main, dialogRef("Confirm"), parent = outer)
        assertEquals(dialogRef("Confirm"), top())

        resolver.fragmentGone(inner)
        resumeFragment(Instance("rating", "com.vendor.rating.RatingDialog"), main, dialogRef("Rating"), parent = outer)
        assertEquals(dialogRef("Cart"), top())
    }

    @Test
    fun appDialogWithANewerLibraryChildIsReported() {
        val main = Instance("main", MAIN_ACTIVITY)
        val picker = Instance("picker", "com.example.shop.address.PickerDialog")
        launch(main, "MainActivity")
        resumeFragment(Instance("home", "com.example.shop.home.HomeFragment"), main, fragmentRef("Home"))
        resumeFragment(picker, main, dialogRef("Picker"))
        resumeFragment(Instance("map", MAP_FRAGMENT), main, fragmentRef("SupportMapFragment"), parent = picker)
        assertEquals(dialogRef("Picker"), top())
    }

    @Test
    fun hiddenDialogsChildrenDoNotStandInForTheScreenBeneath() {
        val main = Instance("main", MAIN_ACTIVITY)
        val dialog = Instance("dialog", "com.example.shop.home.PromoDialog")
        launch(main, "MainActivity")
        resumeFragment(Instance("home", "com.example.shop.home.HomeFragment"), main, fragmentRef("Home"))
        resumeFragment(Instance("content", "com.example.shop.home.PromoContent"), main, fragmentRef("PromoContent"), parent = dialog)
        resumeFragment(dialog, main, dialogRef("Promo"))
        hidden += dialog // Dismissed (not showing) while the child still reports a view.
        assertEquals(fragmentRef("Home"), top())
    }

    @Test
    fun packagePrefixTakesTheFirstTwoSegmentsOfAPackage() {
        assertEquals("com.example", ScreenResolver.packagePrefix("com.example.shop.debug"))
        assertEquals("com.example", ScreenResolver.packagePrefix("com.example"))
        assertEquals("shop", ScreenResolver.packagePrefix("shop"))
        assertEquals("", ScreenResolver.packagePrefix(""))
    }

    private companion object {
        const val MAIN_ACTIVITY = "com.example.shop.ui.MainActivity"
        const val MAP_FRAGMENT = "com.google.android.gms.maps.SupportMapFragment"
        const val NAV_HOST = "androidx.navigation.fragment.NavHostFragment"
    }
}

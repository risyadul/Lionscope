package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class InflateRecorderTest {

    private val recorder = InflateRecorder<String>()
    private var clock = 0L

    /** A parser of layout [name]; views are plain objects compared by identity, like the real ones. */
    private inner class Parser(val name: String, val merge: Boolean = false, val screen: String? = null) {
        /** Creates one view taking [costNanos], then leaves a 100 ns gap (parsing, addView). */
        /** [parentParsing]: the parser of the layout around [parent] stood at a start tag (an `<include>`). */
        fun view(parent: Any?, costNanos: Long = 1_000, parentParsing: Boolean = false): Any {
            val view = Any()
            val start = clock
            clock += costNanos
            recorder.onView(this, view, parent, start, clock) {
                InflateRecorder.Opening(name, merge, parentParsing, screen)
            }
            clock += 100
            return view
        }
    }

    private fun finish(fallback: String? = "top", screenOf: (Any?) -> String? = { null }) =
        recorder.finish(fallback, screenOf).associateBy { it.source }

    @Test
    fun anIncludeInTheMiddleCountsIntoItsParentAndIsReportedOnItsOwn() {
        val outer = Parser("fragment_home")
        val root = outer.view(parent = Any()) // Inflated into an attached container.
        outer.view(root)
        val include = Parser("view_header")
        val includeRoot = include.view(root)
        include.view(includeRoot)
        outer.view(root)

        val result = finish()
        val home = result.getValue("fragment_home")
        val header = result.getValue("view_header")
        assertFalse(home.isInclude)
        assertTrue(header.isInclude)
        assertEquals(5, home.views)
        assertEquals(2, header.views)
        assertEquals(5 * 1_000L + 4 * 100, home.durationNanos)
        assertEquals(2 * 1_000L + 100, header.durationNanos)
    }

    @Test
    fun aTrailingIncludeIsNestedWhileTheIncludingParserStandsAtTheIncludeTag() {
        val outer = Parser("activity_detail")
        val root = outer.view(parent = null)
        val include = Parser("view_footer")
        include.view(root, costNanos = 5_000, parentParsing = true) // The last thing activity_detail parses.

        val result = finish()
        assertTrue(result.getValue("view_footer").isInclude)
        assertEquals(2, result.getValue("activity_detail").views)
        assertEquals(1_000L + 100 + 5_000, result.getValue("activity_detail").durationNanos)
    }

    @Test
    fun withoutTheParserSignalATrailingIncludeIsASeparateLayoutALowerBound() {
        val outer = Parser("activity_detail")
        val root = outer.view(parent = null)
        Parser("view_footer").view(root, costNanos = 5_000) // e.g. an AttributeSet that is not an XmlPullParser.

        val result = finish()
        assertFalse(result.getValue("view_footer").isInclude)
        assertEquals(1, result.getValue("activity_detail").views)
    }

    @Test
    fun aTrailingIncludeAtMergeLevelIsNestedThroughTheMergeParser() {
        val host = Any()
        val merge = Parser("view_card", merge = true)
        merge.view(host)
        assertSame(merge, recorder.parserAround(host))
        Parser("view_actions").view(host, parentParsing = true)

        val result = finish()
        assertTrue(result.getValue("view_actions").isInclude)
        assertEquals(2, result.getValue("view_card").views)
    }

    @Test
    fun itemsInflatedIntoAListsDetachedRootAreSeparateLayouts() {
        // val root = inflate(R.layout.list, container, false); items.forEach { inflate(R.layout.item, root, true) }
        val list = Parser("list")
        val root = list.view(Any())
        list.view(root)
        assertSame(list, recorder.parserAround(root)) // The tracer asks it; a finished parser is at its end tag.
        repeat(3) { Parser("item_$it").view(root) }

        val result = finish("top")
        val listLayout = result.getValue("list")
        assertEquals(2, listLayout.views)
        assertEquals(2 * 1_000L + 100, listLayout.durationNanos) // Not stretched over the items.
        for (i in 0 until 3) {
            val item = result.getValue("item_$i")
            assertFalse(item.isInclude)
            assertFalse(item.isNested)
            assertEquals("top", item.screen) // Not swallowed by the list's span either.
        }
    }

    @Test
    fun aViewHolderInflatingIntoItsDetachedItemViewIsASeparateLayout() {
        val recyclerView = Any()
        val row = Parser("item_row")
        val itemView = row.view(recyclerView) // onCreateViewHolder
        row.view(itemView)
        Parser("view_badge").view(itemView) // onBind, before RecyclerView attaches the itemView.

        val result = finish()
        assertFalse(result.getValue("view_badge").isInclude)
        assertEquals(2, result.getValue("item_row").views)
    }

    @Test
    fun aLaterInflateIntoAFinishedLayoutIsASeparateLayout() {
        // Activity launch: setContentView, then the fragment's view lands in the activity's container (same message).
        val activity = Parser("activity_main")
        val content = Any()
        val root = activity.view(content)
        val container = activity.view(root)
        activity.view(root)
        clock += 50_000 // onCreate continues, onStart executes the fragment transaction.
        val fragment = Parser("fragment_home")
        val fragmentRoot = fragment.view(container)
        fragment.view(fragmentRoot)

        val result = finish()
        val main = result.getValue("activity_main")
        assertFalse(result.getValue("fragment_home").isInclude)
        assertEquals(3, main.views)
        assertEquals(3 * 1_000L + 2 * 100, main.durationNanos) // Not stretched to the fragment's end.
    }

    @Test
    fun recyclerViewRowsInOneMessageAreSeparateInflations() {
        val list = Any()
        repeat(3) {
            val row = Parser("item_row")
            val rowRoot = row.view(list)
            row.view(rowRoot)
        }
        val inflations = recorder.finish("top") { if (it === list) "list" else null } // The list's own screen.
        assertEquals(3, inflations.size)
        assertTrue(inflations.none { it.isInclude })
        assertTrue(inflations.all { it.views == 2 && it.screen == "list" })
    }

    @Test
    fun aMergeLevelIncludeBelongsToTheMergeLayoutWhileItIsStillParsing() {
        val host = Any() // A custom view inflating a <merge> layout into itself.
        val merge = Parser("view_card", merge = true)
        merge.view(host)
        val include = Parser("view_badge")
        include.view(host)
        merge.view(host)
        val trailing = Parser("view_trailing")
        trailing.view(host) // After the merge layout's last view: indistinguishable from a separate inflate.

        val result = finish()
        assertTrue(result.getValue("view_badge").isInclude)
        assertFalse(result.getValue("view_trailing").isInclude)
        assertEquals(3, result.getValue("view_card").views)
    }

    @Test
    fun aSeparateLayoutInflatedDuringAnotherOneTakesItsScreenButNotItsViews() {
        val outer = Parser("fragment_profile", screen = "profile")
        val root = outer.view(null)
        // A compound view's constructor inflates its own layout into itself: its views come before its own record.
        val compoundStart = clock
        clock += 200
        val inner = Parser("view_avatar")
        val holder = Any()
        inner.view(holder)
        inner.view(holder)
        val compound = Any()
        recorder.onView(outer, compound, root, compoundStart, clock) { error("not a new parser") }
        clock += 100
        val separate = Parser("view_status")
        separate.view(Any()) // Separate root, inside the outer span (outer creates one more view below).
        outer.view(root)

        val result = finish()
        assertFalse(result.getValue("view_avatar").isInclude) // `holder` is not one of the outer layout's views...
        assertTrue(result.getValue("view_avatar").isNested) // ...but its time is inside fragment_profile's.
        assertFalse(result.getValue("fragment_profile").isNested)
        assertEquals(3, result.getValue("fragment_profile").views)
        assertEquals("profile", result.getValue("view_avatar").screen) // Inflated during the profile layout.
        assertEquals("profile", result.getValue("view_status").screen)
    }

    @Test
    fun aCompoundViewAtALayoutsRootCountsTheLayoutItInflatesIntoItself() {
        val list = Any()
        // item_product's root <ProductCard> inflates the <merge> card_content into itself in its constructor:
        // card_content is recorded first, item_product only when ProductCard's constructor returns.
        val cardStart = clock
        clock += 100
        val productCard = Any()
        val content = Parser("card_content", merge = true)
        content.view(productCard)
        content.view(productCard)
        val item = Parser("item_product")
        recorder.onView(item, productCard, list, cardStart, clock) { InflateRecorder.Opening("item_product", false, false, null) }

        val result = finish(fallback = "top") { if (it === list) "shop" else null }
        val product = result.getValue("item_product")
        assertFalse(product.isInclude)
        assertTrue(result.getValue("card_content").isInclude)
        assertEquals(3, product.views)
        assertEquals(clock - cardStart, product.durationNanos)
        assertEquals("shop", product.screen)
        assertEquals("shop", result.getValue("card_content").screen) // Resolved through its parent, recorded later.
    }

    @Test
    fun threeNestedCompoundLevelsRecordedInsideOutAreFoldedAndAttributed() {
        val list = Any()
        val cardStart = clock
        clock += 100
        val badgeStart = clock
        clock += 100
        // card_content's first view is a <BadgeView> that inflates the <merge> badge_content into itself.
        val badgeView = Any()
        Parser("badge_content", merge = true).view(badgeView)
        val productCard = Any()
        val content = Parser("card_content", merge = true)
        recorder.onView(content, badgeView, productCard, badgeStart, clock) {
            InflateRecorder.Opening("card_content", true, false, null)
        }
        clock += 100
        content.view(productCard)
        val item = Parser("item_product")
        recorder.onView(item, productCard, list, cardStart, clock) { InflateRecorder.Opening("item_product", false, false, null) }

        val result = finish(fallback = "top") { if (it === list) "shop" else null }
        assertEquals(listOf(1, 3, 4), listOf("badge_content", "card_content", "item_product").map { result.getValue(it).views })
        assertEquals(listOf(true, true, false), listOf("badge_content", "card_content", "item_product").map { result.getValue(it).isInclude })
        assertTrue(result.values.all { it.screen == "shop" })
    }

    @Test
    fun anAssignedScreenWinsEvenForANestedLayout() {
        // A FragmentContainerView in activity_main creates its fragment during setContentView: the fragment's layout
        // is nested in activity_main's inflation, yet belongs to the fragment.
        val activity = Parser("activity_main", screen = "MainActivity")
        val root = activity.view(Any())
        val fcvStart = clock
        clock += 100
        val container = Any()
        val fragment = Parser("fragment_home", screen = "MainActivity")
        val fragmentRoot = fragment.view(container)
        Parser("view_header", screen = "MainActivity").view(fragmentRoot)
        fragment.view(fragmentRoot)
        recorder.assignView(fragmentRoot, "homepage")
        recorder.onView(activity, container, root, fcvStart, clock) { error("known parser") }
        clock += 100
        activity.view(root)

        val result = finish()
        assertEquals("MainActivity", result.getValue("activity_main").screen)
        assertEquals("homepage", result.getValue("fragment_home").screen)
        assertEquals("homepage", result.getValue("view_header").screen) // Its include follows it.
        assertEquals(6, result.getValue("activity_main").views)
    }

    @Test
    fun screensComeFromScopesAssignmentsAndIncludesTakeTheirRoots() {
        val scoped = Parser("activity_main", screen = "MainActivity")
        val scopedRoot = scoped.view(null)
        Parser("view_toolbar", screen = "other").view(scopedRoot)
        scoped.view(scopedRoot)
        clock += 10_000
        val fragment = Parser("fragment_home")
        val fragmentRoot = fragment.view(Any())
        recorder.assignView(fragmentRoot, "homepage")
        clock += 10_000
        val dialogRoot = Parser("dialog_promo").view(Any())
        recorder.assignRoots("promo") { it === dialogRoot } // The tracer checks `rootView === dialog decor`.
        clock += 10_000
        Parser("item_row").view(Any())

        val result = finish(fallback = "top")
        assertEquals("MainActivity", result.getValue("activity_main").screen)
        assertEquals("MainActivity", result.getValue("view_toolbar").screen)
        assertEquals("homepage", result.getValue("fragment_home").screen)
        assertEquals("promo", result.getValue("dialog_promo").screen)
        assertEquals("top", result.getValue("item_row").screen)
    }

    @Test
    fun aChildFragmentInADialogKeepsItsOwnScreenWhateverTheOrder() {
        val dialog = Parser("dialog_sheet")
        val sheetRoot = dialog.view(Any())
        dialog.view(sheetRoot)
        val early = Parser("fragment_options").view(Any())
        recorder.assignView(early, "options")
        recorder.assignRoots("sheet") { true } // Dialog started: everything in its window...
        val late = Parser("fragment_summary").view(Any())
        recorder.assignRoots("sheet") { true }
        recorder.assignView(late, "summary") // ...but a child fragment's own root is more specific.

        val result = finish()
        assertEquals("sheet", result.getValue("dialog_sheet").screen)
        assertEquals("options", result.getValue("fragment_options").screen)
        assertEquals("summary", result.getValue("fragment_summary").screen)
    }

    @Test
    fun finishResetsAndTheNumberOfLayoutsPerMessageIsBounded() {
        val bounded = InflateRecorder<String>(maxLayouts = 2)
        for (i in 0 until 3) {
            bounded.onView(Any(), Any(), null, 0, 1) { InflateRecorder.Opening("l$i", false, false, null) }
        }
        assertEquals(1, bounded.droppedViews)
        assertEquals(listOf("l0", "l1"), bounded.finish().map { it.source })
        assertTrue(bounded.isEmpty)
        assertTrue(bounded.finish().isEmpty())
    }
}

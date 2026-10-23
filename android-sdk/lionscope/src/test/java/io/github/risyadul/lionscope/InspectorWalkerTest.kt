package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.IdentityHashMap

class InspectorWalkerTest {

    private val screen = PixelRect(0, 0, 1080, 2424)

    private fun capture(vararg windows: WindowRoot<FakeView>, access: FakeTreeAccess = FakeTreeAccess(), maxNodes: Int = 5000, maxWalk: Int = 50_000) =
        InspectorWalker.capture(windows.toList(), screen, access, maxNodes, maxWalk)

    @Test
    fun nodesArePreOrderOverAllWindowsBottomMostFirst() {
        val activity = FakeView("decor", screen, children = listOf(
            FakeView("content", children = listOf(FakeView("title"), FakeView("list", children = listOf(FakeView("row"))))),
            FakeView("nav"),
        ))
        val dialog = FakeView("dialog_decor", PixelRect(100, 800, 980, 1600), children = listOf(FakeView("message")))
        val result = capture(fakeWindow(activity), fakeWindow(dialog, type = 2))

        assertEquals(listOf("decor", "content", "title", "list", "row", "nav", "dialog_decor", "message"), result.nodes.map { it.resourceId })
        assertEquals((0..7).toList(), result.nodes.map { it.id })
        assertEquals(listOf(null, 0, 1, 1, 3, 0, null, 6), result.nodes.map { it.parent })
        assertEquals(listOf(0, 0, 0, 0, 0, 0, 1, 1), result.nodes.map { it.window })
        assertEquals(listOf(InspectorWindow(0, 1, screen), InspectorWindow(1, 2, PixelRect(100, 800, 980, 1600))), result.windows)
        assertTrue(result.nodes.all { it.activity == "com.example.shop.ui.MainActivity" })
        assertFalse(result.truncated)
        assertFalse(result.compose)
    }

    @Test
    fun visibleBoundsAreClippedToAncestorsAndTheScreenAndNullWhenNotShown() {
        val root = FakeView("root", PixelRect(0, 0, 1080, 3000), children = listOf(
            FakeView("scroller", PixelRect(0, 200, 1080, 1200), children = listOf(
                FakeView("partly", PixelRect(0, 1000, 1080, 1400)),
                FakeView("below", PixelRect(0, 1300, 1080, 1500)),
                FakeView("hidden", PixelRect(0, 300, 1080, 400), ViewVisibility.INVISIBLE, children = listOf(FakeView("inner", PixelRect(0, 300, 10, 310)))),
                FakeView("empty", PixelRect(5, 300, 5, 400)),
            )),
            FakeView("gone", PixelRect(0, 0, 0, 0), ViewVisibility.GONE),
        ))
        val nodes = capture(fakeWindow(root)).nodes.associateBy { it.resourceId }

        assertEquals(PixelRect(0, 0, 1080, 2424), nodes.getValue("root").visibleBounds) // Window and screen.
        assertEquals(PixelRect(0, 1000, 1080, 1200), nodes.getValue("partly").visibleBounds)
        assertEquals(PixelRect(0, 1000, 1080, 1400), nodes.getValue("partly").bounds) // Bounds stay unclipped.
        assertNull(nodes.getValue("below").visibleBounds)
        assertNull(nodes.getValue("hidden").visibleBounds)
        assertNull(nodes.getValue("inner").visibleBounds) // Under an invisible parent.
        assertNull(nodes.getValue("empty").visibleBounds)
        assertNull(nodes.getValue("gone").visibleBounds)
        assertEquals(ViewVisibility.GONE, nodes.getValue("gone").visibility)
    }

    @Test
    fun fragmentsOwnTheirSubtreesNestedOnesTheirsAndADialogFragmentItsWindow() {
        val childRoot = FakeView("child_root", children = listOf(FakeView("child_text")))
        val homeRoot = FakeView("home_root", children = listOf(FakeView("title"), childRoot))
        val navHost = FakeView("nav_host", children = listOf(homeRoot))
        val decor = FakeView("decor", screen, children = listOf(FakeView("toolbar"), navHost))
        val dialogDecor = FakeView("dialog_decor", children = listOf(FakeView("dialog_message")))

        // Fragment tree: NavHost > Home > Child; a dialog built in onCreateDialog (no view, only its window).
        class Frag(val name: String, val view: FakeView?, val decor: FakeView? = null, val children: List<Frag> = emptyList())
        val tree = listOf(
            Frag("androidx.navigation.fragment.NavHostFragment", navHost, children = listOf(
                Frag("com.example.shop.ui.home.HomeFragment", homeRoot, children = listOf(Frag("com.example.shop.ui.home.ChildFragment", childRoot))),
            )),
            Frag("com.example.shop.ui.PromoDialogFragment", null, dialogDecor),
            Frag("com.example.shop.ui.HeadlessFragment", null),
        )
        val roots = IdentityHashMap<Any, String>()
        FragmentOwnership.collect(tree, { it.children }, { listOf(it.view, it.decor) }, { it.name }, roots)
        @Suppress("UNCHECKED_CAST")
        val access = FakeTreeAccess(roots as Map<FakeView, String>)
        val owners = capture(fakeWindow(decor), fakeWindow(dialogDecor, type = 2), access = access).nodes.associate { it.resourceId to it.fragment }

        assertNull(owners["decor"])
        assertNull(owners["toolbar"])
        assertEquals("androidx.navigation.fragment.NavHostFragment", owners["nav_host"])
        assertEquals("com.example.shop.ui.home.HomeFragment", owners["home_root"])
        assertEquals("com.example.shop.ui.home.HomeFragment", owners["title"])
        assertEquals("com.example.shop.ui.home.ChildFragment", owners["child_root"])
        assertEquals("com.example.shop.ui.home.ChildFragment", owners["child_text"])
        assertEquals("com.example.shop.ui.PromoDialogFragment", owners["dialog_decor"])
        assertEquals("com.example.shop.ui.PromoDialogFragment", owners["dialog_message"])
    }

    @Test
    fun aDeepFragmentTreeIsCutAtTheFragmentCap() {
        class Frag(val depth: Int)
        val roots = HashMap<Any, String>()
        FragmentOwnership.collect(listOf(Frag(0)), { if (it.depth < 10_000) listOf(Frag(it.depth + 1)) else emptyList() }, { listOf(it) }, { "f${it.depth}" }, roots)
        assertEquals(FragmentOwnership.MAX_FRAGMENTS, roots.size)
    }

    /** A chain of [depth] groups, each with [leaves] leaf children. */
    private fun comb(depth: Int, leaves: Int, level: Int = 0): FakeView {
        val children = List(leaves) { FakeView("leaf$level.$it") } + if (level + 1 < depth) listOf(comb(depth, leaves, level + 1)) else emptyList()
        return FakeView("group$level", children = children)
    }

    @Test
    fun aboveTheNodeCapTheDeepestNodesAreDroppedFirstAndParentsAreKept() {
        // Depth d holds 1 group (and, below the root, its leaves): 1, 4, 4, 4, ... nodes per depth.
        val access = FakeTreeAccess()
        val result = capture(fakeWindow(comb(depth = 10, leaves = 3)), access = access, maxNodes = 15)

        assertTrue(result.truncated)
        assertEquals(15, result.nodes.size)
        assertEquals(15, access.reads) // Dropped nodes are never read.
        val byName = result.nodes.associateBy { it.resourceId }
        // Depths 0..3 hold 1 + 4 + 4 + 4 = 13 nodes; 2 more of depth 4 (group3's children), the first in pre-order.
        assertTrue(listOf("group0", "group3", "leaf2.0", "leaf2.2", "leaf3.0", "leaf3.1").all { it in byName })
        assertFalse("leaf3.2" in byName)
        assertFalse("group4" in byName)
        assertEquals(result.nodes.indices.toList(), result.nodes.map { it.id })
        for (node in result.nodes) {
            val parent = node.parent ?: continue
            assertTrue(parent < node.id)
            assertTrue(result.nodes[parent].resourceId!!.startsWith("group"))
        }
    }

    @Test
    fun theWalkStopsAtItsLimitAndOnlyTheTopMostWindowsAreKept() {
        val wide = FakeView("root", children = List(100) { FakeView("c$it") })
        val limited = capture(fakeWindow(wide), maxWalk = 10)
        assertTrue(limited.truncated)
        assertEquals(10, limited.nodes.size)

        val many = List(40) { fakeWindow(FakeView("w$it"), type = 2) }
        val windows = InspectorWalker.capture(many, screen, FakeTreeAccess())
        assertTrue(windows.truncated)
        assertEquals(MAX_INSPECTOR_WINDOWS, windows.windows.size)
        assertEquals("w8", windows.nodes.first().resourceId)
        assertEquals((0 until MAX_INSPECTOR_WINDOWS).toList(), windows.nodes.map { it.window })
    }

    @Test
    fun theTopMostWindowsGetTheBudgetsFirstAndEveryWindowKeepsItsRoot() {
        val activity = comb(depth = 50, leaves = 9) // 1 + 49 * 10 = 491 nodes, many shallow.
        val dialog = FakeView("dialog", children = List(30) { FakeView("d$it", children = listOf(FakeView("d$it.inner"))) })
        val popup = FakeView("popup", children = listOf(FakeView("menu_item")))
        val capped = capture(fakeWindow(activity), fakeWindow(dialog, type = 2), fakeWindow(popup, type = 1000), maxNodes = 100)

        assertTrue(capped.truncated)
        assertEquals(100, capped.nodes.size)
        val perWindow = capped.nodes.groupingBy { it.window }.eachCount()
        assertEquals(mapOf(0 to 37, 1 to 61, 2 to 2), perWindow) // Popup and dialog whole, the activity gets the rest.
        assertEquals(listOf(0, 1, 2), capped.nodes.map { it.window }.distinct()) // Still emitted bottom-most first.

        val walkCapped = capture(fakeWindow(activity), fakeWindow(dialog, type = 2), fakeWindow(popup, type = 1000), maxWalk = 64)
        assertEquals(mapOf(0 to 1, 1 to 61, 2 to 2), walkCapped.nodes.groupingBy { it.window }.eachCount())
        assertNull(walkCapped.nodes.first().parent)
        assertEquals("group0", walkCapped.nodes.first().resourceId) // The activity keeps its root.
    }

    @Test
    fun aComposeViewMarksTheCapture() {
        val root = FakeView("decor", children = listOf(FakeView("compose", className = InspectorWalker.COMPOSE_VIEW)))
        assertTrue(capture(fakeWindow(root)).compose)
    }

    @Test
    fun intersectionsWithNothingLeftAreNull() {
        assertEquals(PixelRect(5, 5, 10, 10), InspectorWalker.intersect(PixelRect(0, 0, 10, 10), PixelRect(5, 5, 20, 20)))
        assertNull(InspectorWalker.intersect(PixelRect(0, 0, 10, 10), PixelRect(10, 0, 20, 10)))
        assertNull(InspectorWalker.intersect(PixelRect(0, 0, 10, 10), null))
    }
}

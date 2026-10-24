package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A fake slot table group: its source information, the layout node it emits, its children. */
internal class FakeGroup(
    val info: String? = null,
    val layout: FakeLayout? = null,
    val destination: String? = null,
    val children: List<FakeGroup> = emptyList(),
)

internal class FakeLayout(
    val name: String,
    var parent: FakeLayout? = null,
    val bounds: PixelRect = PixelRect(0, 0, 100, 100),
    val placed: Boolean = true,
)

internal object FakeSlots : SlotTableAccess<FakeGroup, FakeLayout> {
    var reads = 0
    override fun children(group: FakeGroup): Iterable<FakeGroup> = group.children.also { reads++ }
    override fun sourceInfo(group: FakeGroup): String? = group.info
    override fun layoutNode(group: FakeGroup): FakeLayout? = group.layout
    override fun destination(group: FakeGroup): String? = group.destination
    override fun parent(node: FakeLayout): FakeLayout? = node.parent
    override fun isPlaced(node: FakeLayout): Boolean = node.placed
    override fun bounds(node: FakeLayout): PixelRect = node.bounds
}

class ComposeTreeTest {
    private val app = SourceInfo.packageHash("com.example.shop")
    private val material3 = SourceInfo.packageHash("androidx.compose.material3")
    private val foundationLayout = SourceInfo.packageHash("androidx.compose.foundation.layout")
    private val ui = SourceInfo.packageHash("androidx.compose.ui")
    private val root = FakeLayout("root")

    /** A function body group: `C(name)` with the 1-based [lines] of the calls it makes, in [file]. */
    private fun function(name: String, file: String, hash: String, vararg lines: Int, children: List<FakeGroup> = emptyList()) =
        FakeGroup("C($name)${locations(lines)}:$file#$hash", children = children)

    /** A composable lambda (no name) in [file], making calls on [lines]. */
    private fun lambda(file: String, hash: String, vararg lines: Int, children: List<FakeGroup> = emptyList()) =
        FakeGroup("C${locations(lines)}:$file#$hash", children = children)

    private fun locations(lines: IntArray) = lines.joinToString(",") { "${it - 1}@0L1" }

    /** What a material Text is in the slot table: a call into material3 that ends in one layout node. */
    private fun text(layout: FakeLayout) = function(
        "Text", "Text.kt", material3, 10,
        children = listOf(function("BasicText", "BasicText.kt", ui, 20, children = listOf(FakeGroup(layout = layout)))),
    )

    private fun build(vararg compositions: List<FakeGroup>, budget: ComposeBudget = ComposeBudget()) =
        ComposeTreeBuilder(FakeSlots, budget).build(compositions.toList(), root)

    private fun names(node: ComposeNode): String =
        node.name + node.children.filterIsInstance<ComposeNode>().takeIf { it.isNotEmpty() }
            ?.joinToString(",", "(", ")") { names(it) }.orEmpty()

    @Test
    fun appCallsAreShownWithTheirCallSiteAndLibraryInternalsAreNot() {
        val title = FakeLayout("title", root, PixelRect(10, 20, 110, 60))
        val screen = lambda(
            "MainActivity.kt", app, 28,
            children = listOf(function("HomeScreen", "Home.kt", app, 41, children = listOf(text(title)))),
        )
        val tree = build(listOf(screen))

        val home = tree.roots.single()
        assertEquals("HomeScreen(Text)", names(home))
        assertEquals(ComposableSource("MainActivity.kt", 28), home.source)
        val text = home.children.single() as ComposeNode
        assertEquals(ComposableSource("Home.kt", 41), text.source)
        assertEquals(listOf<Any>(title), text.layouts) // BasicText's node belongs to the shown Text.
        assertEquals(PixelRect(10, 20, 110, 60), text.bounds)
        assertEquals(PixelRect(10, 20, 110, 60), home.bounds)
        assertTrue(tree.hasSourceInfo)
        assertSame(text, tree.ownerOf(title))
    }

    @Test
    fun appLambdasPassedIntoLibraryCodeAreShownUnderTheirCaller() {
        val label = FakeLayout("label", null, PixelRect(20, 20, 60, 40))
        val surface = FakeLayout("surface", root, PixelRect(0, 0, 200, 80))
        label.parent = surface
        // Button (app call) → Surface (material3, hidden) → its layout → the app's content lambda → Text.
        val button = function(
            "Button", "Button.kt", material3, 30,
            children = listOf(
                function(
                    "Surface", "Surface.kt", material3, 40,
                    children = listOf(
                        FakeGroup(
                            layout = surface,
                            children = listOf(lambda("Home.kt", app, 13, children = listOf(text(label)))),
                        ),
                    ),
                ),
            ),
        )
        val tree = build(listOf(lambda("Home.kt", app, 12, children = listOf(button))))

        val shown = tree.roots.single()
        assertEquals("Button(Text)", names(shown))
        assertEquals(listOf<Any>(surface), shown.layouts)
        assertEquals(ComposableSource("Home.kt", 13), (shown.children.single() as ComposeNode).source)
    }

    @Test
    fun functionsCalledFromLibraryCodeAreLibraryCodeWhateverTheirPackage() {
        val box = FakeLayout("box", root)
        val unlisted = SourceInfo.packageHash("androidx.compose.material3.notlisted")
        val card = function(
            "Card", "Card.kt", material3, 5,
            children = listOf(
                function(
                    "CardDecoration", "Decoration.kt", unlisted, 7,
                    children = listOf(function("Box", "Box.kt", foundationLayout, 1, children = listOf(FakeGroup(layout = box)))),
                ),
            ),
        )
        val tree = build(listOf(lambda("Home.kt", app, 3, children = listOf(card))))
        assertEquals("Card", names(tree.roots.single())) // Neither CardDecoration nor the Box it calls.
    }

    @Test
    fun subCompositionsHangUnderTheComposableOwningTheirHostByPosition() {
        val list = FakeLayout("list", root, PixelRect(0, 0, 1080, 2000))
        val itemLayouts = listOf(
            FakeLayout("second", list, PixelRect(0, 300, 1080, 500)),
            FakeLayout("first", list, PixelRect(0, 100, 1080, 300)),
        )
        val lazyColumn = function(
            "LazyColumn", "LazyDsl.kt", SourceInfo.packageHash("androidx.compose.foundation.lazy"), 1,
            children = listOf(FakeGroup(layout = list)),
        )
        val main = listOf(lambda("Catalog.kt", app, 44, children = listOf(lazyColumn)))
        // Item compositions come in no particular order (Compose keeps them in a weak set).
        val items = itemLayouts.map { layout ->
            listOf(lambda("Catalog.kt", app, 54, children = listOf(function("ProductCard", "Card.kt", app, children = listOf(FakeGroup(layout = layout))))))
        }
        val tree = build(main, *items.toTypedArray())

        val column = tree.roots.single()
        assertEquals("LazyColumn(ProductCard,ProductCard)", names(column))
        val cards = column.children.map { (it as ComposeNode).layouts.single() as FakeLayout }
        assertEquals(listOf("first", "second"), cards.map { it.name })
        assertEquals(ComposableSource("Catalog.kt", 54), (column.children.first() as ComposeNode).source)
        assertTrue(tree.contains(itemLayouts[0]))
    }

    @Test
    fun compositionsOfAnotherOwnerAndUnplacedComposablesAreLeftOut() {
        val dialogRoot = FakeLayout("dialog root")
        val foreign = FakeLayout("dialog content", dialogRoot)
        val hidden = FakeLayout("prefetched", root, placed = false)
        val shown = FakeLayout("shown", root, PixelRect(0, 0, 50, 50))
        val main = listOf(
            lambda(
                "Home.kt", app, 1, 2, 3,
                children = listOf(
                    function("Visible", "Home.kt", app, children = listOf(FakeGroup(layout = shown))),
                    function("Prefetched", "Home.kt", app, children = listOf(FakeGroup(layout = hidden))),
                    function("Effect", "Home.kt", app), // Emits nothing.
                ),
            ),
        )
        val dialog = listOf(lambda("Home.kt", app, 9, children = listOf(function("Promo", "Home.kt", app, children = listOf(FakeGroup(layout = foreign))))))
        val tree = build(main, dialog)
        assertEquals(listOf("Visible"), tree.roots.map { it.name })
        assertFalse(tree.contains(foreign))
    }

    @Test
    fun aDestinationIsInheritedByEverythingDrawnForIt() {
        val layout = FakeLayout("content", root)
        val provider = FakeGroup(
            "C(LocalOwnersProvider)P(1)46@1896L240:NavBackStackEntryProvider.kt#${SourceInfo.packageHash("androidx.navigation.compose")}",
            destination = "product/{id}",
            children = listOf(lambda("Shop.kt", app, 39, children = listOf(function("ProductScreen", "Product.kt", app, 5, children = listOf(text(layout)))))),
        )
        val tree = build(listOf(lambda("Shop.kt", app, 30, children = listOf(provider))))
        val screen = tree.roots.single()
        assertEquals("ProductScreen(Text)", names(screen))
        assertEquals("product/{id}", screen.destination)
        assertEquals("product/{id}", (screen.children.single() as ComposeNode).destination)
    }

    @Test
    fun theGroupBudgetCutsTheReadShort() {
        val layouts = List(10) { FakeLayout("l$it", root) }
        val many = lambda("Home.kt", app, *IntArray(10) { it + 1 }, children = layouts.map { function("Item", "Home.kt", app, children = listOf(FakeGroup(layout = it))) })
        val full = build(listOf(many))
        assertEquals(10, full.roots.size)
        assertFalse(full.truncated)
        val cut = build(listOf(many), budget = ComposeBudget(maxGroups = 7))
        assertTrue(cut.truncated)
        assertTrue(cut.roots.size in 1..3)
    }

    @Test
    fun theTimeBudgetCutsTheReadShortToo() {
        var nanos = 0L
        val budget = ComposeBudget(maxMs = 200, nanoTime = { nanos })
        repeat(ComposeBudget.CHECK_EVERY - 1) { assertTrue(budget.take()) }
        nanos = 199_000_000
        assertTrue(budget.take()) // Checked: not yet.
        nanos = 201_000_000
        repeat(ComposeBudget.CHECK_EVERY - 1) { assertTrue(budget.take()) }
        assertFalse(budget.take()) // Checked again: past the deadline, and spent from now on.
        assertFalse(budget.take())
    }

    @Test
    fun withoutSourceInformationNothingIsNamed() {
        val tree = build(listOf(FakeGroup(children = listOf(FakeGroup(layout = FakeLayout("x", root))))))
        assertFalse(tree.hasSourceInfo)
        assertTrue(tree.roots.isEmpty())
    }

    @Test
    fun anEmptyChildDoesNotStretchItsParentToTheCorner() {
        // A bottom-bar item: its own layout at the bottom right, an icon that is zero-size at the origin.
        val item = FakeLayout("item", root, PixelRect(805, 2544, 1220, 2664))
        val icon = FakeLayout("icon", item, PixelRect(0, 0, 0, 0))
        val tree = build(
            listOf(
                function(
                    "Item", "Home.kt", app, 12,
                    children = listOf(FakeGroup(layout = item, children = listOf(function("Icon", "Home.kt", app, children = listOf(FakeGroup(layout = icon)))))),
                ),
            ),
        )
        val node = tree.roots.single()
        assertEquals(PixelRect(805, 2544, 1220, 2664), node.bounds)
        // The empty one keeps its own (empty) box; it just doesn't count for the parent.
        assertEquals(PixelRect(0, 0, 0, 0), (node.children.single() as ComposeNode).bounds)
        assertEquals(PixelRect(0, 0, 0, 0), ComposeTreeBuilder.union(null, PixelRect(0, 0, 0, 0)))
        assertEquals(PixelRect(1, 2, 3, 4), ComposeTreeBuilder.union(PixelRect(0, 0, 0, 0), PixelRect(1, 2, 3, 4)))
    }

    @Test
    fun aCallWhoseParentRecordedNoLocationHasNoLine() {
        val tree = build(listOf(FakeGroup(children = listOf(function("Orphan", "Home.kt", app, children = listOf(FakeGroup(layout = FakeLayout("o", root))))))))
        val orphan = tree.roots.single()
        assertNull(orphan.source.file)
        assertNull(orphan.source.line)
    }
}

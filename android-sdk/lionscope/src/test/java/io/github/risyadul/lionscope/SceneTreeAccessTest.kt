package io.github.risyadul.lionscope

import android.content.Context
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.IdentityHashMap

class SceneTreeAccessTest {
    private val views = FakeViews()
    private val decor = views.view("com.android.internal.policy.DecorView")
    private val composeView = views.view(InspectorWalker.COMPOSE_VIEW)
    private val handler = views.view("androidx.compose.ui.platform.AndroidViewsHandler")
    private val layers = views.view("androidx.compose.ui.platform.ViewLayerContainer")
    private val holder = views.view("androidx.compose.ui.viewinterop.ViewFactoryHolder")
    private val stray = views.view("androidx.compose.ui.viewinterop.ViewFactoryHolder")
    private val rating = views.view("android.widget.RatingBar")

    init {
        views.children[decor] = listOf(composeView)
        views.children[composeView] = listOf(handler, layers)
        views.children[handler] = listOf(holder)
        views.children[holder] = listOf(rating)
    }

    /** Views by identity: real (stub) View objects, their classes and children faked. */
    private class FakeViews : InspectorTreeAccess<View> {
        val classes = IdentityHashMap<View, String>()
        val children = IdentityHashMap<View, List<View>>()

        fun view(className: String): View = View(null as Context?).also { classes[it] = className }

        override fun children(node: View): List<View> = children[node].orEmpty()
        override fun className(node: View): String = classes.getValue(node)
        override fun fragmentRootOf(node: View): String? = null
        override fun read(node: View): NodeAttributes = NodeAttributes(
            className = className(node),
            resourceId = null,
            text = null,
            contentDescription = null,
            bounds = PixelRect(0, 0, 100, 100),
            visibility = ViewVisibility.VISIBLE,
            alpha = 1.0,
            enabled = true,
            clickable = false,
            focused = false,
            selected = false,
            checked = null,
            padding = PixelRect(0, 0, 0, 0),
            margin = null,
            layoutWidth = null,
            layoutHeight = null,
            source = null,
        )
    }

    private class FakeReading(val answer: (View) -> ComposeRead) : ComposeReading {
        var captures = 0
        val reads = ArrayList<View>()
        override fun beginCapture() {
            captures++
        }

        override fun read(view: View): ComposeRead = answer(view).also { reads += view }
    }

    private fun composable(name: String, vararg children: Any) =
        ComposeNode(name, ComposableSource("Shop.kt", 12), "catalog").apply {
            bounds = PixelRect(0, 0, 50, 50)
            this.children.addAll(children)
        }

    @Test
    fun withoutComposeReadingTheTreeIsTheViewTree() {
        val access = SceneTreeAccess(views, null)
        assertEquals(listOf(handler, layers), access.children(composeView))
        assertNull(access.read(composeView).composition)
        assertFalse(access.truncated)
    }

    @Test
    fun aReadCompositionShowsComposablesAndClaimedAndroidViewsUnderThem() {
        val androidView = composable("AndroidView", holder)
        val button = composable("Button")
        val screen = composable("CatalogScreen", button, androidView)
        val semantics = ComposeSemantics("Buy", "Buy now", "buy", true, true, false, false, null, secret = false)
        val reading = FakeReading { ComposeRead(CompositionStatus.READ, listOf(screen), mapOf(button to semantics), setOf(holder), truncated = true) }
        val access = SceneTreeAccess(views, reading)

        // The layers container is internal; the handler holds no unclaimed AndroidView, so it is left out too.
        assertEquals(listOf<Any>(screen), access.children(composeView))
        assertEquals(listOf<Any>(button, androidView), access.children(screen))
        assertEquals(listOf<Any>(holder), access.children(androidView))
        assertEquals(listOf<Any>(rating), access.children(holder))
        assertEquals(CompositionStatus.READ, access.read(composeView).composition)
        assertTrue(access.truncated)

        val attributes = access.read(button)
        assertEquals("Button", attributes.className)
        assertEquals("buy", attributes.resourceId)
        assertEquals("Buy", attributes.text)
        assertEquals("Buy now", attributes.contentDescription)
        assertTrue(attributes.clickable)
        assertNull(attributes.alpha)
        assertNull(attributes.padding)
        assertEquals(ComposableSource("Shop.kt", 12), attributes.composable)
        assertEquals("catalog", attributes.destination)
        assertEquals("Button", access.className(button))
        assertNull(access.fragmentRootOf(button))
        assertEquals(listOf(composeView), reading.reads) // Read once.
    }

    @Test
    fun theWalkerInheritsDestinationsAndReportsACutRead() {
        val androidView = composable("AndroidView", holder)
        val screen = ComposeNode("CatalogScreen", ComposableSource("Shop.kt", 32), "catalog").apply {
            bounds = PixelRect(0, 0, 100, 100)
            children += androidView
        }
        val access = SceneTreeAccess(views, FakeReading { ComposeRead(CompositionStatus.READ, listOf(screen), claimed = setOf(holder), truncated = true) })
        val capture = InspectorWalker.capture(
            listOf(WindowRoot<Any>(decor, 1, PixelRect(0, 0, 100, 100), "com.example.shop.ui.MainActivity")),
            PixelRect(0, 0, 100, 100),
            access,
        )
        assertEquals(
            listOf("com.android.internal.policy.DecorView", InspectorWalker.COMPOSE_VIEW, "CatalogScreen", "AndroidView", "androidx.compose.ui.viewinterop.ViewFactoryHolder", "android.widget.RatingBar"),
            capture.nodes.map { it.className },
        )
        assertEquals(listOf(null, null, "catalog", "catalog", "catalog", "catalog"), capture.nodes.map { it.destination })
        assertEquals(CompositionStatus.READ, capture.nodes[1].composition)
        assertEquals(ComposableSource("Shop.kt", 32), capture.nodes[2].composable)
        assertTrue(capture.compose)
        assertTrue(capture.truncated)
    }

    @Test
    fun anUnclaimedAndroidViewKeepsTheHandler() {
        views.children[handler] = listOf(holder, stray)
        val access = SceneTreeAccess(views, FakeReading { ComposeRead(CompositionStatus.READ, emptyList(), claimed = setOf(holder)) })
        assertEquals(listOf(handler), access.children(composeView))
        assertEquals(listOf(stray), access.children(handler))
    }

    @Test
    fun aPasswordComposableSendsNoText() {
        val field = composable("OutlinedTextField")
        val secret = ComposeSemantics("hunter2", "hunter2", null, true, true, false, false, null, secret = true)
        val access = SceneTreeAccess(views, FakeReading { ComposeRead(CompositionStatus.READ, listOf(field), mapOf(field to secret)) })
        access.children(composeView)
        assertNull(access.read(field).text)
        assertNull(access.read(field).contentDescription)
    }

    @Test
    fun anUnreadCompositionKeepsTheViewsAndSaysWhy() {
        val access = SceneTreeAccess(views, FakeReading { ComposeRead(CompositionStatus.DISABLED) })
        assertEquals(listOf(handler, layers), access.children(composeView))
        assertEquals(CompositionStatus.DISABLED, access.read(composeView).composition)
        assertNull(access.read(decor).composition) // Only AndroidComposeViews are read.
    }

    @Test
    fun aViewSceneOnlyReadsCompositionsWhenAsked() {
        val reading = FakeReading { ComposeRead(CompositionStatus.READ) }
        assertEquals(0, reading.captures)
        val access = SceneTreeAccess(views, reading.also { it.beginCapture() })
        access.children(decor)
        assertTrue(reading.reads.isEmpty())
        access.children(composeView)
        assertEquals(1, reading.reads.size)
    }
}

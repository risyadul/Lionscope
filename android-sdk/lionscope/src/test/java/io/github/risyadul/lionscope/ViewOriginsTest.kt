package io.github.risyadul.lionscope

import android.content.Context
import android.util.AttributeSet
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.xmlpull.v1.XmlPullParser
import java.lang.reflect.Proxy

/** Origins as [TracingFactory] notes them through [InflateTracer.noteOrigin], one parser per inflated layout. */
class ViewOriginsTest {

    private val origins = ViewOrigins()
    private val resIds = HashMap<AttributeSet, Int>()
    private val link = FakeLink()
    private val reporter = InflateReporter(link, FakeScheduler()) { 0L }.apply { setTracking(false) }
    private val tracer = InflateTracer(
        reporter = reporter,
        topScreen = { null },
        ownership = AppOwnership("com.example.shop"),
        postAtFrontOfQueue = {},
        origins = origins,
        sourceResId = { resIds[it] ?: 0 },
    )

    /** A layout's parser standing at [line] (where the current start tag ends). */
    private class Layout(val resId: Int) {
        var line = 0
    }

    private fun parser(layout: Layout): AttributeSet {
        lateinit var proxy: AttributeSet
        proxy = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(AttributeSet::class.java, XmlPullParser::class.java)) { _, method, args ->
            when (method.name) {
                "getLineNumber" -> layout.line
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.get(0)
                else -> null
            }
        } as AttributeSet
        resIds[proxy] = layout.resId
        return proxy
    }

    private fun view(parser: AttributeSet, layout: Layout, line: Int): View {
        layout.line = line
        return View(null as Context?).also { tracer.noteOrigin(parser, it) }
    }

    @Test
    fun anIncludedLayoutsViewsGetItsOwnLinesNotTheIncludingOnes() {
        val home = Layout(0x7f0b0001)
        val homeParser = parser(home)
        val root = view(homeParser, home, 9)
        // <include layout="@layout/view_dashboard_card"/>: a parser of its own.
        val card = Layout(0x7f0b0002)
        val cardRoot = view(parser(card), card, 6)
        val title = view(homeParser, home, 33)

        assertEquals(listOf(0x7f0b0001, 9), origins[root]!!.let { listOf(it.resId, it.line) })
        assertEquals(listOf(0x7f0b0002, 6), origins[cardRoot]!!.let { listOf(it.resId, it.line) })
        assertEquals(33, origins[title]!!.line)
    }

    @Test
    fun mergeChildrenAreRecordedWithTheMergeLayout() {
        val actions = Layout(0x7f0b0003)
        val parser = parser(actions)
        val details = view(parser, actions, 9)
        val share = view(parser, actions, 15)
        assertEquals(0x7f0b0003, origins[details]!!.resId)
        assertEquals(15, origins[share]!!.line)
    }

    @Test
    fun recyclerRowsShareOneOriginPerTagAndEachRowIsKept() {
        val row = Layout(0x7f0b0004)
        val rows = List(50) { view(parser(row), row, 12) }
        assertEquals(50, origins.size)
        val first = origins[rows.first()]
        rows.forEach { assertSame(first, origins[it]) }
    }

    @Test
    fun viewsWithoutAResourceOrLineAreNotRecorded() {
        val unknown = Layout(0)
        val code = view(parser(unknown), unknown, 4)
        val named = Layout(0x7f0b0005)
        val noLine = view(parser(named), named, 0)
        val plain = AttributeSetOnly()
        val view = View(null as Context?).also { tracer.noteOrigin(plain.set, it) }
        assertNull(origins[code])
        assertNull(origins[noLine])
        assertNull(origins[view])
        assertEquals(0, origins.size)
    }

    private class AttributeSetOnly {
        val set = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(AttributeSet::class.java)) { _, _, _ -> null } as AttributeSet
    }

    @Test
    fun viewsAreKeyedByIdentityNotEquality() {
        class Same(val key: Int) {
            override fun equals(other: Any?) = other is Same && other.key == key
            override fun hashCode() = key
        }
        val first = Same(1)
        val second = Same(1)
        origins.record(first, 0x7f0b0006, 3)
        origins.record(second, 0x7f0b0006, 4)
        assertEquals(3, origins[first]!!.line)
        assertEquals(4, origins[second]!!.line)
        assertNotSame(origins[first], origins[second])
    }
}

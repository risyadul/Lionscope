package io.github.risyadul.lionscope

import android.content.Context
import android.util.AttributeSet
import android.view.InflateException
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import org.xmlpull.v1.XmlPullParser

class HomeTestFragment

class FakeDelegate {
    @Suppress("UNUSED_PARAMETER")
    fun createView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? = null
}

class FakeAppCompatActivity : android.app.Activity() {
    private val delegate = FakeDelegate()
    fun getDelegate(): FakeDelegate = delegate
}

/**
 * [InflateTracer] attribution through its real callbacks (android.jar stubs: views have no parents, attribute sets
 * no resource ids, so layouts are reported under their first tag's label).
 */
class InflateTracerTest {

    private val link = FakeLink().apply { welcome(true, 3) }
    private val main = FakeScheduler()
    private var now = 0L
    private val reporter = InflateReporter(link, main) { now }.apply {
        setLink(3)
        setTracking(true) // The config that follows welcome.
    }
    private val endOfMessage = ArrayList<Runnable>()
    private var nanos = 0L
    private val tracer = InflateTracer(
        reporter = reporter,
        topScreen = { "top" },
        ownership = AppOwnership("io.github.risyadul.lionscope"),
        postAtFrontOfQueue = { endOfMessage += it },
        nanoTime = { nanos },
        wallMs = { 1_000_000L },
    )
    private val activity = PlainTestActivity()
    private val fragment = HomeTestFragment()

    private fun parser(): AttributeSet =
        Proxy.newProxyInstance(javaClass.classLoader, arrayOf(AttributeSet::class.java)) { _, _, _ -> null } as AttributeSet

    /** An XML parser whose event type the test sets: START_TAG while it is inside a tag (an `<include>`). */
    private class XmlParser(var eventType: Int)

    private fun xmlParser(state: XmlParser): AttributeSet = Proxy.newProxyInstance(
        javaClass.classLoader,
        arrayOf(AttributeSet::class.java, XmlPullParser::class.java),
    ) { _, method, _ ->
        when (method.name) {
            "getEventType" -> state.eventType
            "getDepth", "getLineNumber", "getAttributeCount" -> 0
            else -> null
        }
    } as AttributeSet

    /** One view of [parser] tagged [tag] (its label), taking 1 µs. */
    private fun view(parser: AttributeSet, tag: String, parent: View?): View {
        val view = View(null as Context?)
        val start = nanos
        nanos += 1_000
        tracer.record(parser, view, parent, activity, tag, start, nanos)
        nanos += 100
        return view
    }

    /** Ends the message and returns each reported layout's screen, by label. */
    private fun endAndSend(): Map<String, String?> {
        endOfMessage.toList().forEach(Runnable::run)
        endOfMessage.clear()
        now += 2_000
        main.runDelayed()
        return link.v3Lines.map { TestJson.parse(it) as Map<*, *> }.associate { it["label"] as String to it["screen"] as String? }
    }

    @Test
    fun aRestoredFragmentDoesNotClaimTheActivitysOwnContentView() {
        // super.onCreate restores the fragment (created now, view only in onStart), then setContentView.
        tracer.onActivityPreCreated(activity)
        val main = parser()
        val content = View(null as Context?)
        val root = view(main, "ActivityMain", content)
        val container = view(main, "Container", root)
        tracer.onActivityPostCreated(activity)
        // onStart: the restored fragment's view.
        val home = parser()
        val homeRoot = view(home, "FragmentHome", container)
        view(home, "Title", homeRoot)
        tracer.onFragmentViewCreated(fragment, activity, homeRoot)

        val screens = endAndSend()
        assertEquals("PlainTestActivity", screens["ActivityMain"])
        assertEquals("HomeTestFragment", screens["FragmentHome"])
    }

    @Test
    fun aFragmentContainerViewFragmentAndALaterInflateInOnCreateKeepTheirOwners() {
        tracer.onActivityPreCreated(activity)
        val main = parser()
        val root = view(main, "ActivityMain", View(null as Context?))
        // The FragmentContainerView's constructor creates the fragment and its view during setContentView.
        val home = parser()
        val homeRoot = view(home, "FragmentHome", null)
        tracer.onFragmentViewCreated(fragment, activity, homeRoot)
        view(main, "FragmentContainerView", root)
        val navigation = view(main, "NavigationView", root)
        // Later in onCreate: the navigation header, inflated into the activity's own view.
        view(parser(), "NavHeader", navigation)
        tracer.onActivityPostCreated(activity)

        val screens = endAndSend()
        assertEquals("PlainTestActivity", screens["ActivityMain"])
        assertEquals("HomeTestFragment", screens["FragmentHome"])
        assertEquals("PlainTestActivity", screens["NavHeader"])
    }

    @Test
    fun outsideAnyScopeAFragmentsHierarchyOrElseTheTopScreenIsUsed() {
        val home = parser()
        val homeRoot = view(home, "FragmentHome", null)
        tracer.onFragmentViewCreated(fragment, activity, homeRoot)
        endAndSend()
        link.v3Lines.clear()
        view(parser(), "Row", null) // A row of some list: no scope, no known hierarchy (stub views have no parents).
        assertEquals("top", endAndSend()["Row"])
    }

    @Test
    fun inflationsLaterInTheLaunchMessageGoToTheActivityNotTheStaleTopScreen() {
        tracer.onActivityPreCreated(activity)
        view(parser(), "ActivityMain", null)
        tracer.onActivityPostCreated(activity)
        tracer.onActivityShown(activity) // onStart / onPostCreate (AppCompat's lazy subDecor) / onResume.
        view(parser(), "AbcScreenSimple", null)
        val first = endAndSend()
        assertEquals("PlainTestActivity", first["ActivityMain"])
        assertEquals("PlainTestActivity", first["AbcScreenSimple"])

        link.v3Lines.clear()
        view(parser(), "Later", null) // A later message: the fallback was cleared with the first one.
        assertEquals("top", endAndSend()["Later"])
    }

    @Test
    fun theIncludingParsersEventTypeTellsAnIncludeFromALaterInflateIntoADetachedRoot() {
        val listState = XmlParser(XmlPullParser.START_TAG)
        val list = xmlParser(listState)
        val listRoot = view(list, "ListRoot", null)
        view(xmlParser(XmlParser(XmlPullParser.START_TAG)), "Footer", listRoot) // <include> while list is at its tag.
        listState.eventType = XmlPullParser.END_TAG // inflate(R.layout.list, container, false) has returned.
        view(xmlParser(XmlParser(XmlPullParser.START_TAG)), "Item", listRoot) // inflate(R.layout.item, root, true)

        endOfMessage.toList().forEach(Runnable::run)
        now += 2_000
        main.runDelayed()
        val nested = link.v3Lines.map { TestJson.parse(it) as Map<*, *> }.associate { it["label"] to it["nested"] }
        assertEquals(mapOf("ListRoot" to false, "Footer" to true, "Item" to false), nested)
    }

    @Test
    fun onlyAppCompatActivitiesGetTheFactory() {
        val bridge = AppCompatBridge.forClasses(FakeAppCompatActivity::class.java, FakeDelegate::class.java)
        assertTrue(InflateTracer.installDelegate(bridge, FakeAppCompatActivity()) is FakeDelegate)
        assertNull(InflateTracer.installDelegate(bridge, PlainTestActivity())) // May install AppCompat's itself.
        assertNull(InflateTracer.installDelegate(null, PlainTestActivity())) // No AppCompat at all.
        val unusable = AppCompatBridge.forClasses(FakeAppCompatActivity::class.java, Any::class.java) // No createView.
        assertNull(InflateTracer.installDelegate(unusable, FakeAppCompatActivity()))
    }

    @Test
    fun appCompatFailuresSurfaceAsAppCompatsOwnFactoryWouldThrowThem() {
        var broken: Throwable? = null
        val themeError = IllegalArgumentException("This component requires a Theme.MaterialComponents theme")
        try {
            AppCompatBridge.invokeCreateView({ throw InvocationTargetException(themeError) }) { broken = it }
            fail("swallowed")
        } catch (e: IllegalArgumentException) {
            assertSame(themeError, e) // Not turned into a plain framework Button.
        }
        val stackOverflow = StackOverflowError()
        try {
            AppCompatBridge.invokeCreateView({ throw InvocationTargetException(stackOverflow) }) { broken = it }
            fail("swallowed")
        } catch (e: StackOverflowError) {
            assertSame(stackOverflow, e)
        }
        assertTrue(AppCompatBridge.surfaced(InvocationTargetException(IOException("checked"))) is InflateException)
        assertNull(broken)

        // Only the reflection itself failing disables delegation.
        for (failure in listOf(IllegalAccessException(), IllegalArgumentException("argument type mismatch"), NoSuchMethodError())) {
            broken = null
            assertNull(AppCompatBridge.invokeCreateView({ throw failure }) { broken = it })
            assertSame(failure, broken)
        }
    }

    @Test
    fun theInstallWarningNamesTheOptOut() {
        assertTrue(InflateTracer.INSTALL_WARNING.contains("android:name=\"io.github.risyadul.lionscope.inflateTracking\""))
        assertTrue(InflateTracer.INSTALL_WARNING.contains("android:value=\"false\""))
        assertTrue(InflateTracer.INSTALL_WARNING.contains("A factory has already been set"))
    }
}

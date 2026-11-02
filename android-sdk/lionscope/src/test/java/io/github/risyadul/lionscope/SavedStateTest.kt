package io.github.risyadul.lionscope

import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A saved state as nested maps: a [Leaf] is a value of so many bytes, a [FragmentRecord] a fragment's record. */
private class Leaf(val bytes: Int)
private class FragmentRecord(val className: String, val state: Map<String, Any?>)

/** Sizes add up like a Parcel: a key costs [KEY_BYTES], a container the sum of its children. */
private class MapAccess : StateAccess {
    val read = ArrayList<Any>()

    override fun children(value: Any): List<Pair<String, Any?>>? = when (value) {
        is Map<*, *> -> value.entries.map { (key, child) -> key as String to child }.also { read += value }
        is FragmentRecord -> listOf("savedFragmentState" to value.state)
        else -> null
    }

    override fun entryBytes(key: String, value: Any?): Int = KEY_BYTES + sizeOf(value)

    override fun fragmentClass(value: Any): String? = when (value) {
        is FragmentRecord -> value.className
        is Map<*, *> -> (value["state"] as? FragmentRecord)?.className
        else -> null
    }

    override fun fragmentRecordKey(value: Any): String? = if (value is Map<*, *>) "state" else null

    override fun valueClass(value: Any?): String? = when (value) {
        is Leaf -> "byte[]"
        is Map<*, *> -> "android.os.Bundle"
        null -> null
        else -> value.javaClass.simpleName
    }

    private fun sizeOf(value: Any?): Int = when (value) {
        is Leaf -> value.bytes
        is FragmentRecord -> KEY_BYTES + sizeOf(value.state)
        is Map<*, *> -> value.entries.sumOf { (_, child) -> KEY_BYTES + sizeOf(child) }
        else -> 4
    }

    companion object {
        const val KEY_BYTES = 16
    }
}

private const val KB = 1024

class SavedStateBreakdownTest {

    /** The pattern behind most oversized states: a pager fragment whose nested child keeps a big list. */
    private val state: Map<String, Any?> = linkedMapOf(
        "androidx.lifecycle.BundlableSavedStateRegistry.key" to linkedMapOf(
            "android:support:fragments" to linkedMapOf(
                "state" to Leaf(200),
                "fragment_a1" to linkedMapOf(
                    "state" to FragmentRecord("com.example.PagerFragment", emptyMap()),
                    "childFragmentManager" to linkedMapOf(
                        "fragment_b2" to linkedMapOf(
                            "state" to FragmentRecord("com.example.ListFragment", emptyMap()),
                            "savedInstanceState" to linkedMapOf("cached_items" to Leaf(300 * KB), "small" to Leaf(10)),
                        ),
                    ),
                ),
            ),
        ),
        "android:viewHierarchyState" to linkedMapOf("views" to Leaf(500)),
        "late_payload" to Leaf(120 * KB),
    )

    @Test
    fun attributesTheBytesToTheNestedFragmentAndItsKey() {
        val result = SavedStateBreakdown(MapAccess()).of(state)
        val byPath = result.entries.associateBy { it.path.joinToString("/") }
        val leaf = byPath.getValue(
            "androidx.lifecycle.BundlableSavedStateRegistry.key/android:support:fragments/fragment_a1/" +
                "childFragmentManager/fragment_b2/savedInstanceState/cached_items",
        )
        assertEquals(SavedStateKind.VALUE, leaf.kind)
        assertEquals("com.example.ListFragment", leaf.fragment)
        assertEquals("byte[]", leaf.valueClass)
        val child = byPath.getValue(
            "androidx.lifecycle.BundlableSavedStateRegistry.key/android:support:fragments/fragment_a1/childFragmentManager/fragment_b2",
        )
        assertEquals(SavedStateKind.FRAGMENT, child.kind)
        assertEquals("com.example.ListFragment", child.fragment)
        val pager = byPath.getValue("androidx.lifecycle.BundlableSavedStateRegistry.key/android:support:fragments/fragment_a1")
        assertEquals(SavedStateKind.FRAGMENT, pager.kind)
        assertEquals("com.example.PagerFragment", pager.fragment)
        // A key added after super.onSaveInstanceState() is a root key like any other.
        assertEquals(SavedStateKind.VALUE, byPath.getValue("late_payload").kind)
        assertNull(byPath.getValue("late_payload").fragment)
        // Largest first; nothing under MIN_ENTRY_BYTES.
        assertEquals(result.entries.sortedByDescending { it.bytes }.map { it.bytes }, result.entries.map { it.bytes })
        assertTrue(result.entries.none { it.bytes < SavedStateBreakdown.MIN_ENTRY_BYTES })
        assertFalse(byPath.keys.any { it.startsWith("android:viewHierarchyState") })
        assertFalse(result.truncated)
    }

    @Test
    fun opensAFragmentRecordWithoutRepeatingItAsANewFragment() {
        val record = FragmentRecord("com.example.OldFragment", linkedMapOf("cache" to Leaf(50 * KB)))
        val result = SavedStateBreakdown(MapAccess()).of(linkedMapOf("android:support:fragments" to linkedMapOf("fragment_x" to record)))
        val kinds = result.entries.associate { it.path.last() to it.kind }
        assertEquals(SavedStateKind.FRAGMENT, kinds["fragment_x"])
        assertEquals(SavedStateKind.BUNDLE, kinds["savedFragmentState"])
        assertEquals(SavedStateKind.VALUE, kinds["cache"])
        assertEquals("com.example.OldFragment", result.entries.single { it.path.last() == "cache" }.fragment)
    }

    /** fragment 1.6+ layout: `fragment_<who>` { state: record, savedInstanceState, childFragmentManager { fragment_… } }. */
    private fun fragment(className: String, vararg state: Pair<String, Any?>, children: Map<String, Any?> = emptyMap()) =
        linkedMapOf<String, Any?>(
            "state" to FragmentRecord(className, emptyMap()),
            "savedInstanceState" to linkedMapOf(*state),
            "childFragmentManager" to LinkedHashMap(children),
        )

    @Test
    fun aNestedFragmentOfTheParentsClassIsItsOwnInstance() {
        val recursive = "com.example.RecursiveFragment"
        val root = linkedMapOf<String, Any?>(
            "android:support:fragments" to linkedMapOf(
                "fragment_p" to fragment(
                    recursive,
                    "header" to Leaf(4 * KB),
                    children = linkedMapOf(
                        "fragment_c" to fragment(recursive, "payload" to Leaf(80 * KB)),
                        "fragment_s" to fragment("com.example.SiblingFragment", "items" to Leaf(20 * KB)),
                    ),
                ),
            ),
        )
        val byPath = SavedStateBreakdown(MapAccess()).of(root).entries.associateBy { it.path.joinToString("/") }
        val parent = byPath.getValue("android:support:fragments/fragment_p")
        val child = byPath.getValue("android:support:fragments/fragment_p/childFragmentManager/fragment_c")
        val sibling = byPath.getValue("android:support:fragments/fragment_p/childFragmentManager/fragment_s")
        assertEquals(SavedStateKind.FRAGMENT, parent.kind)
        assertEquals(SavedStateKind.FRAGMENT, child.kind)
        assertEquals(recursive, child.fragment)
        assertEquals(SavedStateKind.FRAGMENT, sibling.kind)
        assertEquals("com.example.SiblingFragment", sibling.fragment)
        // Each instance once: its own record (`state`) is not another Fragment.
        val fragments = byPath.values.filter { it.kind == SavedStateKind.FRAGMENT }.map { it.path.last() }
        assertEquals(listOf("fragment_c", "fragment_p", "fragment_s"), fragments.sorted())
        // The payload is the child's, under the child's path.
        val payload = byPath.getValue(
            "android:support:fragments/fragment_p/childFragmentManager/fragment_c/savedInstanceState/payload",
        )
        assertEquals(recursive, payload.fragment)
        assertEquals(SavedStateKind.VALUE, payload.kind)
        assertTrue(payload.bytes < child.bytes && child.bytes < parent.bytes)
        val items = byPath.getValue(
            "android:support:fragments/fragment_p/childFragmentManager/fragment_s/savedInstanceState/items",
        )
        assertEquals("com.example.SiblingFragment", items.fragment)
    }

    @Test
    fun aRecordNestingItsOwnClassIsStillTwoInstances() {
        // fragment 1.4 records open straight into their state; a same-class record below is a new instance.
        val leaf = FragmentRecord("com.example.RecursiveFragment", linkedMapOf("payload" to Leaf(80 * KB)))
        val parent = FragmentRecord(
            "com.example.RecursiveFragment",
            linkedMapOf("android:support:fragments" to linkedMapOf("fragment_c" to leaf)),
        )
        val entries = SavedStateBreakdown(MapAccess()).of(linkedMapOf("fragment_p" to parent)).entries
        assertEquals(
            listOf("fragment_p", "fragment_c"),
            entries.filter { it.kind == SavedStateKind.FRAGMENT }.map { it.path.last() },
        )
    }

    @Test
    fun smallSubtreesAreNeverOpened() {
        val small = linkedMapOf<String, Any?>("tiny" to Leaf(10))
        val access = MapAccess()
        SavedStateBreakdown(access).of(linkedMapOf("big" to Leaf(80 * KB), "small" to small))
        assertFalse(access.read.any { it === small })
    }

    @Test
    fun capsEntriesDepthAndVisitedKeys() {
        val wide = (1..50).associate { "k$it" to Leaf((it + 1) * KB) }
        val listed = SavedStateBreakdown(MapAccess(), maxEntries = 30).of(wide)
        assertEquals(30, listed.entries.size)
        assertTrue(listed.truncated)
        assertEquals("k50", listed.entries.first().path.single())

        var deep: Any? = Leaf(10 * KB)
        repeat(12) { deep = linkedMapOf("level$it" to deep) }
        val shallow = SavedStateBreakdown(MapAccess(), maxDepth = 8).of(deep!!)
        assertTrue(shallow.entries.all { it.path.size <= 8 })
        assertTrue(shallow.truncated)

        val visited = SavedStateBreakdown(MapAccess(), maxVisited = 5).of(wide)
        assertTrue(visited.truncated)
        assertTrue(visited.entries.size <= 5)
    }

    @Test
    fun aFailingContainerIsALeaf() {
        val access = object : StateAccess by MapAccess() {
            override fun children(value: Any): List<Pair<String, Any?>>? =
                if (value is Map<*, *> && value.containsKey("boom")) throw IllegalStateException("unparcel") else MapAccess().children(value)
        }
        val result = SavedStateBreakdown(access).of(linkedMapOf("bad" to linkedMapOf("boom" to Leaf(5 * KB))))
        assertEquals(listOf("bad"), result.entries.map { it.path.single() })
        assertEquals(SavedStateKind.VALUE, result.entries.single().kind)
    }
}

class SavedStateProfilerTest {
    private val link = FakeLink()
    private val main = FakeScheduler()
    private val activity = PlainTestActivity()
    private val measured = ArrayList<Int>()

    private fun profiler(apiLevel: Int, totalBytes: Int = 600 * KB) = SavedStateProfiler(
        link = link,
        main = main,
        measure = { _, minBytes, _ ->
            measured += minBytes
            val breakdown = if (totalBytes >= minBytes) {
                SavedStateBreakdown.Result(
                    listOf(SavedStateEntry(listOf("late_payload"), 120 * KB, SavedStateKind.VALUE, null, "byte[]")),
                    truncated = false,
                )
            } else {
                null
            }
            SavedStateMeasurement(totalBytes, 0.5, breakdown?.let { 2.0 }, breakdown)
        },
        screenNameOf = { "orders" },
        apiLevel = apiLevel,
        clock = { 1_792_516_385_000L },
    )

    private fun session(version: Int = DEVICE_PROTOCOL_VERSION) {
        link.welcome(true, version)
        main.runPosted()
    }

    /** The `savedState` lines (each welcome also sends a `liveActivities` list). */
    private val reports: List<String>
        get() = link.v10Lines.filter { it.startsWith("{\"type\":\"savedState\"") }

    @Test
    fun api29UsesThePostSaveHookAndNotTheSaveHook() {
        val profiler = profiler(apiLevel = 29)
        session()
        profiler.onActivitySaveInstanceState(activity, Bundle())
        main.runPosted()
        assertTrue(reports.isEmpty())
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        val line = TestJson.parse(reports.single()) as Map<*, *>
        assertEquals("savedState", line["type"])
        assertEquals("post_save", line["hook"])
        assertEquals((600 * KB).toDouble(), line["totalBytes"])
        assertEquals("orders", line["screen"])
        assertEquals(PlainTestActivity::class.java.name, line["activity"])
        assertEquals(1.0, line["instanceId"])
        assertEquals(listOf("late_payload"), ((line["entries"] as List<*>).single() as Map<*, *>)["path"])
    }

    @Test
    fun beforeApi29TheMeasurementIsPostedUntilTheSaveIsComplete() {
        val profiler = profiler(apiLevel = 28)
        session()
        profiler.onActivitySaveInstanceState(activity, Bundle())
        // Nothing measured inside super.onSaveInstanceState(): the app may still add keys.
        assertTrue(measured.isEmpty())
        main.runPosted()
        assertEquals("posted", (TestJson.parse(reports.single()) as Map<*, *>)["hook"])
    }

    @Test
    fun belowTheThresholdOnlyTheTotalIsSent() {
        val profiler = profiler(apiLevel = 31, totalBytes = 20 * KB)
        session()
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        val line = TestJson.parse(reports.single()) as Map<*, *>
        assertEquals((20 * KB).toDouble(), line["totalBytes"])
        assertNull(line["breakdownMs"])
        assertEquals(emptyList<Any>(), line["entries"])
        assertEquals(listOf(SavedStateProfiler.BREAKDOWN_MIN_BYTES), measured)
    }

    @Test
    fun idleWithoutAV10SessionOrWithTheOptionOff() {
        val profiler = profiler(apiLevel = 31)
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        session(DEVICE_PROTOCOL_V9)
        assertFalse(profiler.isEnabled)
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        assertTrue(measured.isEmpty())

        session(DEVICE_PROTOCOL_V10)
        assertTrue(profiler.isEnabled)
        link.config(SdkOptions(150, strictMode = false, savedStateTracking = false))
        main.runPosted()
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        assertTrue(measured.isEmpty())

        link.config(SdkOptions(150, strictMode = false))
        main.runPosted()
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        assertEquals(1, reports.size)

        link.welcome(false)
        main.runPosted()
        assertFalse(profiler.isEnabled)
    }

    @Test
    fun aFailingMeasurementNeverReachesTheApp() {
        val profiler = SavedStateProfiler(link, main, measure = { _, _, _ -> throw IllegalStateException("boom") }, apiLevel = 31)
        session()
        profiler.onActivityPostSaveInstanceState(activity, Bundle())
        assertTrue(reports.isEmpty())
    }
}

class SavedStateMessageTest {
    private fun entry(bytes: Int, key: String) =
        SavedStateEntry(List(MAX_SAVED_STATE_DEPTH) { key }, bytes, SavedStateKind.VALUE, null, "byte[]")

    @Test
    fun keepsTheLargestEntriesWithinTheLineCap() {
        val entries = (40 downTo 1).map { entry(it * KB, "k".repeat(200) + it) }
        val line = DeviceMessages.savedState(
            ts = 1L, activity = "a.B", instanceId = 1, screen = null, hook = SavedStateHook.POSTED, totalBytes = 900 * KB,
            measureMs = 1.0, breakdownMs = 2.0, entries = entries, truncated = false, maxLineBytes = 20_000,
        )
        assertTrue(StackFrames.utf8Length(line) <= 20_000)
        val parsed = TestJson.parse(line) as Map<*, *>
        val sent = parsed["entries"] as List<*>
        assertTrue(sent.size in 1 until MAX_SAVED_STATE_ENTRIES)
        assertEquals((40 * KB).toDouble(), (sent.first() as Map<*, *>)["bytes"])
        assertEquals(true, parsed["truncated"])
        // Keys are capped at 120 characters, paths at MAX_SAVED_STATE_DEPTH.
        val path = (sent.first() as Map<*, *>)["path"] as List<*>
        assertEquals(MAX_SAVED_STATE_DEPTH, path.size)
        assertTrue(path.all { (it as String).length <= 120 })
        // Worst case at the real cap: 30 entries of 12 keys of 120 characters still fit.
        val full = DeviceMessages.savedState(
            ts = 1L, activity = "a.B", instanceId = 1, screen = null, hook = SavedStateHook.POSTED, totalBytes = 900 * KB,
            measureMs = 1.0, breakdownMs = 2.0, entries = entries.take(30), truncated = false,
        )
        assertEquals(30, ((TestJson.parse(full) as Map<*, *>)["entries"] as List<*>).size)
        assertTrue(StackFrames.utf8Length(full) <= MAX_DEVICE_LINE_BYTES)
    }

    @Test
    fun redactsCredentialLookingKeysBeforeCuttingThemAndKeepsPlainNames() {
        val secret = "synthetic-secret-" + "x".repeat(150)
        val path = listOf(
            "https://api.example.test/v1/items?page=2&token=$secret",
            "cache auth_token=synthetic-secret-2",
            "token",
            "password",
            "fragment_a1",
        )
        val line = DeviceMessages.savedState(
            ts = 1L, activity = "a.B", instanceId = 1, screen = null, hook = SavedStateHook.POST_SAVE, totalBytes = 80 * KB,
            measureMs = 0.1, breakdownMs = 0.2,
            entries = listOf(SavedStateEntry(path, 80 * KB, SavedStateKind.VALUE, null, "byte[]")),
            truncated = false,
        )
        assertFalse(line.contains("synthetic-secret"))
        val sent = (((TestJson.parse(line) as Map<*, *>)["entries"] as List<*>).single() as Map<*, *>)["path"]
        assertEquals(
            listOf(
                "https://api.example.test/v1/items?page=2&token=$HTTP_REDACTED",
                "cache auth_token=$HTTP_REDACTED",
                "token",
                "password",
                "fragment_a1",
            ),
            sent,
        )
    }
}

class SavedStateConfigTest {
    private fun config(line: String): SdkOptions = (GatewayMessage.parse(line) as GatewayMessage.Config).options

    @Test
    fun savedStateTrackingIsOffOnlyForALiteralFalse() {
        assertEquals(false, config("{\"type\":\"config\",\"stallThresholdMs\":150,\"strictMode\":false,\"inflateTracking\":true,\"rxTracking\":true,\"savedStateTracking\":false}").savedStateTracking)
        assertEquals(true, config("{\"type\":\"config\",\"stallThresholdMs\":150,\"strictMode\":false,\"inflateTracking\":true,\"rxTracking\":true}").savedStateTracking)
        assertEquals(true, config("{\"type\":\"config\",\"stallThresholdMs\":150,\"savedStateTracking\":\"false\"}").savedStateTracking)
        assertTrue(SdkOptions.DEFAULT.savedStateTracking)
    }
}

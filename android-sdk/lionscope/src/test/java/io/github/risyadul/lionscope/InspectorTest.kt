package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InspectorTest {

    private val link = FakeLink().apply { welcome(true, 4) }
    private val main = FakeScheduler()
    private val sleeps = ArrayList<Long>()
    private val background = ArrayList<Runnable>()
    private var nanos = 0L
    /** The sender's clock: sleeping advances it. */
    private var senderNanos = 0L
    private var onSleep: () -> Unit = {}

    private fun sender() = InspectSender(link, sleepMs = {
        sleeps += it
        senderNanos += it * 1_000_000
        onSleep()
    }, nanoTime = { senderNanos })

    private class Scene(var root: FakeView?, var foreground: Boolean = true) : InspectorScene<FakeView> {
        var failure: RuntimeException? = null
        /** Commits counted by the scene's `captured` hook, which a v8 capture calls once its walk worked. */
        var commits = 0
        val readCompose = ArrayList<Boolean>()
        val viewState = ArrayList<Boolean>()
        override val isForeground: Boolean
            get() = foreground

        override fun prepare(readCompose: Boolean, viewState: Boolean): PreparedScene<FakeView>? {
            this.readCompose += readCompose
            this.viewState += viewState
            failure?.let { throw it }
            val root = root ?: return null
            val captured = if (viewState) { { ++commits } } else null
            return PreparedScene(listOf(fakeWindow(root)), InspectorDisplay(1080, 2424, 0), FakeTreeAccess(), captured)
        }
    }

    private val scene = Scene(FakeView("decor", PixelRect(0, 0, 1080, 2424), children = listOf(FakeView("title", text = "Hello"))))
    private val inspector = Inspector(
        link = link,
        main = main,
        scene = scene,
        screenName = { "homepage" },
        sender = sender(),
        inBackground = { background += it },
        nanoTime = { nanos.also { nanos += 2_400_000 } },
        wallMs = { 1_792_516_376_500L },
    )

    private fun request(id: Int) {
        link.inspect(id)
        main.runPosted()
    }

    private fun sent(): List<Map<*, *>> = link.v4Lines.map { TestJson.parse(it) as Map<*, *> }

    @Test
    fun aRequestIsCapturedOnTheMainThreadThenSentPacedFromTheBackground() {
        request(7)
        assertTrue(link.v4Lines.isEmpty()) // Nothing is encoded on the main thread.
        background.single().run()

        val (begin, nodes) = sent()
        assertEquals("inspectBegin", begin["type"])
        assertEquals(7.0, begin["requestId"])
        assertEquals("homepage", begin["screen"])
        assertEquals(1_792_516_376_500.0, begin["ts"])
        assertEquals(2.4, begin["captureMs"])
        assertEquals(2.0, begin["nodeCount"])
        assertEquals(false, begin["truncated"])
        assertEquals(mapOf("width" to 1080.0, "height" to 2424.0, "rotation" to 0.0), begin["display"])
        assertEquals("inspectNodes", nodes["type"])
        assertEquals(true, nodes["last"])
        assertEquals(listOf("decor", "title"), (nodes["nodes"] as List<*>).map { (it as Map<*, *>)["resourceId"] })
        assertEquals(listOf(InspectSender.LINE_INTERVAL_MS), sleeps) // One pause between the two lines: ≤ 40 lines/s.
    }

    @Test
    fun aNewerRequestAbandonsTheSnapshotStillBeingSentAndPacingSpansBoth() {
        request(1)
        request(2) // Before snapshot 1 sent anything.
        background.removeAt(0).run()
        assertTrue(link.v4Lines.isEmpty())
        background.removeAt(0).run()
        assertEquals(listOf(2.0, 2.0), sent().map { it["requestId"] })

        // Mid-send: request 3 comes while snapshot 3 waits before its nodes line.
        link.v4Lines.clear()
        sleeps.clear()
        senderNanos += 1_000_000_000
        onSleep = {
            onSleep = {}
            request(4)
        }
        request(3)
        background.removeAt(0).run()
        assertEquals(listOf("inspectBegin"), sent().map { it["type"] }) // Its nodes were never sent.
        onSleep = {}
        background.removeAt(0).run()
        assertEquals(listOf(3.0, 4.0, 4.0), sent().map { it["requestId"] })
        // One paced stream: 25 ms before 3's (abandoned) nodes line, which already spaces 4's begin, then 25 ms more.
        assertEquals(listOf(25L, 25L), sleeps)
    }

    @Test
    fun backgroundNoWindowAndFailuresAreReported() {
        scene.foreground = false
        request(1)
        scene.foreground = true
        scene.root = null
        request(2)
        scene.root = FakeView("decor")
        scene.failure = IllegalStateException("view tree changed")
        request(3)
        assertEquals(listOf("background", "no_window", "failed"), sent().map { it["reason"] })
        assertEquals(listOf(1.0, 2.0, 3.0), sent().map { it["requestId"] })
        assertTrue(background.isEmpty())
        scene.failure = null
        request(4)
        assertEquals(1, background.size) // A failed capture leaves nothing busy.
    }

    @Test
    fun compositionsAreOnlyReadOnAV6Link() {
        request(1)
        link.welcome(false)
        link.welcome(true, 6)
        request(2)
        assertEquals(listOf(false, true), scene.readCompose)
    }

    @Test
    fun viewStateAndLiveEditsAreOnlyOnAV8Link() {
        request(1)
        background.removeAt(0).run()
        assertFalse(sent().single { it["type"] == "inspectBegin" }.containsKey("liveEdits"))
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V8)
        link.v4Lines.clear()
        request(2)
        background.removeAt(0).run()
        assertEquals(listOf(false, true), scene.viewState)
        assertEquals(1, scene.commits)
        assertEquals(1.0, sent().single { it["type"] == "inspectBegin" }["liveEdits"])
    }

    @Test
    fun aFailedCaptureIsNotTheOneEditsName() {
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V8)
        scene.failure = IllegalStateException("view tree changed")
        request(1)
        assertEquals(0, scene.commits)
    }

    @Test
    fun requestsAreIgnoredBelowV4() {
        link.welcome(false)
        link.welcome(true, 3)
        request(1)
        assertTrue(background.isEmpty())
        assertTrue(link.v4Lines.isEmpty())
    }

    @Test
    fun theSenderStopsWhenTheLinkDrops() {
        val nodes = List(400) { InspectorFixtures.plainNode(it, if (it == 0) null else 0, text = "x".repeat(400)) }
        val snapshot = InspectSnapshot(9, 1, null, InspectorDisplay(1080, 2424, 0), InspectorCapture(emptyList(), nodes, false, false), 1.0)
        var lines = 0
        onSleep = { if (++lines == 3) link.welcome(false) }
        sender().prepare(snapshot).run()
        assertEquals(3, link.v4Lines.size) // Begin and two chunks, then the link went away.
    }

    @Test
    fun anAnswerOverTheServersSizeLimitIsFailedInsteadOfStreamed() {
        val nodes = List(20) { InspectorFixtures.plainNode(it, if (it == 0) null else 0, text = "x".repeat(400)) } // ~16 KB.
        val snapshot = InspectSnapshot(5, 1, null, InspectorDisplay(1080, 2424, 0), InspectorCapture(emptyList(), nodes, false, false), 1.0)
        InspectSender(link, sleepMs = {}, maxAnswerBytes = 8 * 1024).prepare(snapshot).run()
        assertEquals(listOf(mapOf("type" to "inspectError", "requestId" to 5.0, "reason" to "failed")), sent())
        link.v4Lines.clear()
        InspectSender(link, sleepMs = {}, maxAnswerBytes = 64 * 1024).prepare(snapshot).run()
        assertEquals(listOf("inspectBegin", "inspectNodes"), sent().map { it["type"] })
    }

    @Test
    fun nodesAreChunkedByBytesAndReassembleInOrder() {
        // CJK text: 3 UTF-8 bytes per char, so a count-based split would overflow.
        val nodes = List(MAX_INSPECTOR_NODES) { InspectorFixtures.plainNode(it, if (it == 0) null else it - 1, text = "视图".repeat(if (it % 7 == 0) 250 else 10)) }
        val chunks = DeviceMessages.inspectChunks(11, nodes)

        assertTrue(chunks.size > 1)
        val parsed = chunks.map { TestJson.parse(it) as Map<*, *> }
        for ((seq, chunk) in chunks.withIndex()) {
            assertTrue("chunk $seq", chunk.toByteArray(Charsets.UTF_8).size <= MAX_INSPECT_CHUNK_BYTES)
            assertEquals(seq.toDouble(), parsed[seq]["seq"])
            assertEquals(seq == chunks.lastIndex, parsed[seq]["last"])
            assertEquals(11.0, parsed[seq]["requestId"])
        }
        // Each chunk is filled: the next node would not have fit.
        for (seq in 0 until chunks.lastIndex) {
            val next = DeviceMessages.inspectNode(InspectorFixtures.node((parsed[seq + 1]["nodes"] as List<*>).first() as Map<*, *>))
            assertTrue(chunks[seq].toByteArray(Charsets.UTF_8).size + 1 + next.toByteArray(Charsets.UTF_8).size > MAX_INSPECT_CHUNK_BYTES)
        }
        val reassembled = parsed.flatMap { it["nodes"] as List<*> }.map { InspectorFixtures.node(it as Map<*, *>) }
        assertEquals(nodes, reassembled)
    }

    @Test
    fun noNodesStillEndWithALastChunk() {
        val chunk = TestJson.parse(DeviceMessages.inspectChunks(1, emptyList()).single()) as Map<*, *>
        assertEquals(true, chunk["last"])
        assertEquals(emptyList<Any>(), chunk["nodes"])
    }
}

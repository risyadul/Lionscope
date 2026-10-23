package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewEditRequestsTest {
    private val link = FakeLink().apply { welcome(true, DEVICE_PROTOCOL_V8) }
    private val main = FakeScheduler()
    private val access = FakeEditAccess()
    private val editor = ViewEditor(access, firstKey = 1)

    private fun answers(): List<Map<*, *>> = link.v8Lines.map { TestJson.parse(it) as Map<*, *> }

    private fun key(view: FakeEditView): Int = editor.beginCapture().let { capture -> capture.keyOf(view).also { capture.commit() } }

    @Test
    fun editsAreAppliedOnTheMainThreadAndAnswered() {
        ViewEditRequests(link, main, editor)
        val view = FakeEditView()
        val key = key(view)
        link.viewEdit(GatewayMessage.SetViewProperty(5, key, ViewProperty.PADDING_LEFT, 24.0))
        assertTrue(access.writes.isEmpty()) // Only handed off on the link thread.
        main.runPosted()
        link.viewEdit(GatewayMessage.SetViewProperty(6, 999, ViewProperty.ALPHA, 0.5))
        link.viewEdit(GatewayMessage.RevertViewProperties(7, null, null))
        main.runPosted()
        assertEquals(
            listOf(
                "{\"type\":\"viewPropertyResult\",\"requestId\":5,\"ok\":true,\"liveEdits\":1}",
                "{\"type\":\"viewPropertyResult\",\"requestId\":6,\"ok\":false,\"error\":\"stale\",\"liveEdits\":1}",
                "{\"type\":\"viewPropertyResult\",\"requestId\":7,\"ok\":true,\"liveEdits\":0}",
            ),
            link.v8Lines,
        )
        assertEquals(8, view.values[ViewProperty.PADDING_LEFT])
    }

    @Test
    fun withoutAnEditorEveryRequestIsAnsweredDisabled() {
        ViewEditRequests<FakeEditView>(link, main, null)
        link.viewEdit(GatewayMessage.SetViewProperty(1, 2, ViewProperty.ALPHA, 0.5))
        main.runPosted()
        assertEquals("disabled", answers().single()["error"])
    }

    @Test
    fun anEditThatThrowsIsAnsweredFailed() {
        val throwing = object : ViewEditAccess<FakeEditView> by access {
            override fun supports(view: FakeEditView, property: ViewProperty): Boolean = throw IllegalStateException()
        }
        val broken = ViewEditor(throwing)
        ViewEditRequests(link, main, broken)
        val key = broken.beginCapture().let { capture -> capture.keyOf(FakeEditView()).also { capture.commit() } }
        link.viewEdit(GatewayMessage.SetViewProperty(2, key, ViewProperty.ALPHA, 0.5))
        main.runPosted()
        assertEquals("failed", answers().single()["error"])
    }

    @Test
    fun aRequestFromAConnectionThatEndedIsDroppedUnapplied() {
        ViewEditRequests(link, main, editor)
        val view = FakeEditView()
        val key = key(view)
        link.viewEdit(GatewayMessage.SetViewProperty(1, key, ViewProperty.ALPHA, 0.5))
        link.welcome(false)
        link.welcome(true, DEVICE_PROTOCOL_V8) // The next connection may reuse request id 1.
        main.runPosted()
        assertTrue(link.v8Lines.isEmpty())
        assertTrue(access.writes.isEmpty())
        link.viewEdit(GatewayMessage.SetViewProperty(1, key, ViewProperty.ALPHA, 0.5))
        main.runPosted()
        assertEquals(1, link.v8Lines.size)
    }

    @Test
    fun aFloodIsAnsweredBusyBeyondTheQueueWithoutWaitingForTheMainThread() {
        ViewEditRequests(link, main, editor, maxQueued = 3)
        repeat(6) { link.viewEdit(GatewayMessage.RevertViewProperties(it, null, null)) }
        assertEquals(3, main.pendingCount)
        assertEquals(List(3) { "busy" }, answers().map { it["error"] })
        assertEquals(listOf(3.0, 4.0, 5.0), answers().map { it["requestId"] })
        main.runPosted()
        assertEquals(6, link.v8Lines.size)
        link.viewEdit(GatewayMessage.RevertViewProperties(11, null, null))
        assertEquals(1, main.pendingCount)
    }

    @Test
    fun pastItsRateTheSdkAnswersBusyUntilTheBucketRefills() {
        var nanos = 0L
        ViewEditRequests(link, main, editor, burst = 2, perSecond = 1.0, nanoTime = { nanos })
        repeat(3) { link.viewEdit(GatewayMessage.RevertViewProperties(it, null, null)) }
        main.runPosted()
        assertEquals(listOf(null, null, "busy"), answers().sortedBy { it["requestId"] as Double }.map { it["error"] })
        nanos += 1_000_000_000L
        link.viewEdit(GatewayMessage.RevertViewProperties(9, null, null))
        main.runPosted()
        assertEquals(null, answers().last()["error"])
    }

    @Test
    fun nothingIsAnsweredBelowV8() {
        val old = FakeLink().apply { welcome(true, DEVICE_PROTOCOL_V6) }
        ViewEditRequests(old, main, editor)
        old.viewEdit(GatewayMessage.SetViewProperty(1, 2, ViewProperty.ALPHA, 0.5))
        main.runPosted()
        assertTrue(old.v8Lines.isEmpty())
        assertTrue(access.writes.isEmpty())
    }
}

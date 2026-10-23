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
    fun nothingIsAnsweredBelowV8() {
        val old = FakeLink().apply { welcome(true, DEVICE_PROTOCOL_V6) }
        ViewEditRequests(old, main, editor)
        old.viewEdit(GatewayMessage.SetViewProperty(1, 2, ViewProperty.ALPHA, 0.5))
        main.runPosted()
        assertTrue(old.v8Lines.isEmpty())
        assertTrue(access.writes.isEmpty())
    }
}

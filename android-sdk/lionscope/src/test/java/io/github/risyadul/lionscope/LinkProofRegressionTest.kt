package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Non-network messages of v8 or later on a link without the link proof (no key reached the app): 0.11.0 dropped them
 * all, so an edit refused `unauthenticated` was never answered and the server waited for it to time out. Only API that
 * predates the fix is used here, so this file also runs against the code before it.
 */
class LinkProofRegressionTest {
    private val viewPropertyResult = "{\"type\":\"viewPropertyResult\",\"requestId\":3,\"ok\":false,\"error\":\"unauthenticated\",\"liveEdits\":0}"

    private fun v8(line: String) = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V8) { line }

    @Test
    fun anEditAnswerIsWrittenOnAV8LinkWithoutTheProof() {
        assertEquals(viewPropertyResult, DeviceLink.encode(v8(viewPropertyResult), negotiatedVersion = 8, networkAuthenticated = false))
        assertEquals(viewPropertyResult, DeviceLink.encode(v8(viewPropertyResult), negotiatedVersion = 9, networkAuthenticated = true))
        // The version gate is unchanged: no v8 line on a v7 link, proof or not.
        assertNull(DeviceLink.encode(v8(viewPropertyResult), negotiatedVersion = 7, networkAuthenticated = true))
        assertNull(DeviceLink.encode(v8(viewPropertyResult), negotiatedVersion = 7))
    }

    @Test
    fun anUnauthenticatedEditIsAnsweredToTheServerInsteadOfTimingOut() {
        val link = FakeLink().apply { welcome(true, DEVICE_PROTOCOL_V8, proven = false) }
        val main = FakeScheduler()
        val access = FakeEditAccess()
        ViewEditRequests(link, main, ViewEditor(access, firstKey = 1))
        link.viewEdit(GatewayMessage.SetViewProperty(3, 1, ViewProperty.ALPHA, 0.5))
        link.viewEdit(GatewayMessage.RevertViewProperties(4, null, null))
        main.runPosted()
        val written = link.v8Items.map { DeviceLink.encode(it, negotiatedVersion = 8, networkAuthenticated = false) }
        val answers = written.map { TestJson.parse(checkNotNull(it)) as Map<*, *> }
        assertEquals(listOf(3.0, 4.0), answers.map { it["requestId"] })
        assertEquals(listOf(false, false), answers.map { it["ok"] })
        assertEquals(listOf("unauthenticated", "unauthenticated"), answers.map { it["error"] })
        assertTrue(access.writes.isEmpty()) // Refused before any view is touched.
    }
}

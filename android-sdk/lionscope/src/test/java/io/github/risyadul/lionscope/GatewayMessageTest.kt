package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayMessageTest {

    @Test
    fun parsesWelcome() {
        assertSame(GatewayMessage.Welcome, GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\":1}"))
    }

    @Test
    fun parsesByeWithReason() {
        val bye = GatewayMessage.parse("{ \"type\" : \"bye\", \"reason\": \"package_mismatch\" }")
        assertTrue(bye is GatewayMessage.Bye)
        assertEquals("package_mismatch", (bye as GatewayMessage.Bye).reason)
    }

    @Test
    fun byeWithoutReasonIsUnknown() {
        assertEquals("unknown", (GatewayMessage.parse("{\"type\":\"bye\"}") as GatewayMessage.Bye).reason)
    }

    @Test
    fun ignoresUnknownAndMalformedLines() {
        assertNull(GatewayMessage.parse("{\"type\":\"ping\"}"))
        assertNull(GatewayMessage.parse("HTTP/1.1 400 Bad Request"))
        assertNull(GatewayMessage.parse(""))
    }
}

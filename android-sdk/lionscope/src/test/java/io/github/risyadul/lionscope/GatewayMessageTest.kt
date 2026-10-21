package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayMessageTest {

    @Test
    fun parsesWelcomeWithItsNegotiatedVersion() {
        val welcome = GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\":1}")
        assertEquals(1, (welcome as GatewayMessage.Welcome).protocolVersion)
        val newer = GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\" : 3}")
        assertEquals(3, (newer as GatewayMessage.Welcome).protocolVersion)
    }

    @Test
    fun welcomeToleratesUnknownFields() {
        val welcome = GatewayMessage.parse(
            "{\"type\":\"welcome\",\"features\":{\"x\":true},\"protocolVersion\":2,\"serverVersion\":\"9.9.9\"}",
        )
        assertEquals(2, (welcome as GatewayMessage.Welcome).protocolVersion)
    }

    @Test
    fun welcomeVersionMustBeAJsonInteger() {
        fun versionOf(raw: String) =
            (GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\":$raw}") as GatewayMessage.Welcome).protocolVersion
        // Integers are passed on as sent (DeviceLink clamps them); anything else means version 1.
        assertEquals(0, versionOf("0"))
        assertEquals(-3, versionOf("-3"))
        assertEquals(1, versionOf("\"2\""))
        assertEquals(1, versionOf("2.5"))
        assertEquals(1, versionOf("2e1"))
        assertEquals(1, versionOf("true"))
    }

    @Test
    fun welcomeWithoutAUsableVersionAssumesVersionOne() {
        for (line in listOf(
            "{\"type\":\"welcome\"}",
            "{\"type\":\"welcome\",\"protocolVersion\":null}",
            "{\"type\":\"welcome\",\"protocolVersion\":99999999999}",
        )) {
            assertEquals(line, 1, (GatewayMessage.parse(line) as GatewayMessage.Welcome).protocolVersion)
        }
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
        assertNull(GatewayMessage.parse("{\"type\":\"configure\",\"protocolVersion\":2,\"sampleRate\":10}"))
        assertNull(GatewayMessage.parse("HTTP/1.1 400 Bad Request"))
        assertNull(GatewayMessage.parse(""))
    }
}

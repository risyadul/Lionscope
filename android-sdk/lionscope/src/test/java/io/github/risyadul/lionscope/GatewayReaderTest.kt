package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class GatewayReaderTest {

    private fun read(input: InputStream): Pair<List<GatewayMessage>, Int> {
        val messages = ArrayList<GatewayMessage>()
        var closed = 0
        GatewayReader(input, onMessage = { messages += it }, onClosed = { closed++ }).readLoop()
        return messages to closed
    }

    @Test
    fun parsesLinesUntilEof() {
        val (messages, closed) = read(
            ByteArrayInputStream("{\"type\":\"welcome\",\"protocolVersion\":1}\n{\"type\":\"bye\",\"reason\":\"x\"}\n".toByteArray())
        )
        assertEquals(2, messages.size)
        assertTrue(messages[0] is GatewayMessage.Welcome)
        assertEquals(1, closed)
    }

    @Test
    fun skipsOversizedLinesAndKeepsReading() {
        val huge = "{\"type\":\"welcome\",\"pad\":\"" + "x".repeat(GatewayReader.MAX_LINE_BYTES * 2) + "\"}\n"
        val (messages, closed) = read(ByteArrayInputStream((huge + "{\"type\":\"bye\",\"reason\":\"after\"}\n").toByteArray()))
        assertEquals(1, messages.size)
        assertEquals("after", (messages.single() as GatewayMessage.Bye).reason)
        assertEquals(1, closed)
    }

    @Test
    fun containsErrorsThrownByTheStream() {
        val failing = object : InputStream() {
            override fun read(): Int = throw StackOverflowError("boom")
        }
        val (messages, closed) = read(failing)
        assertTrue(messages.isEmpty())
        assertEquals(1, closed)
    }

    @Test
    fun containsErrorsThrownByCallbacks() {
        val input = ByteArrayInputStream("{\"type\":\"welcome\",\"protocolVersion\":1}\n".toByteArray())
        GatewayReader(input, onMessage = { throw LinkageError("bad") }, onClosed = { throw IllegalStateException() })
            .readLoop()
    }
}

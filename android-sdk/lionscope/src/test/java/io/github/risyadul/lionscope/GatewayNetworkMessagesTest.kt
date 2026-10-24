package io.github.risyadul.lionscope

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** protocol/fixtures/gateway-messages.ndjson: the server reproduces these lines byte for byte; the SDK reads them. */
class GatewayNetworkMessagesTest {

    private val goldenLines: List<String> by lazy {
        val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
        File(dir, "gateway-messages.ndjson").readLines(Charsets.UTF_8).filter { it.isNotBlank() }
    }

    @Test
    fun parsesEveryGoldenLine() {
        assertEquals(5, goldenLines.size)
        val all = goldenLines.map { checkNotNull(GatewayMessage.parse(it)) { "not parsed: $it" } }

        val welcome = all[0] as GatewayMessage.Welcome
        assertEquals(GOLDEN_WELCOME, goldenLines[0])
        assertEquals(7, welcome.protocolVersion)
        assertFalse(welcome.inspectOnly)
        assertEquals("f2d88543b6cc93f29e7d04d3c7239f4bbcbd8b40566ba077664e2729f885a0e4", welcome.proof)
        assertEquals(welcome.proof, LinkProof.proof(TEST_LINK_KEY, GOLDEN_NONCE, 7, "session"))

        val messages = all.drop(1)
        val set = messages[0] as GatewayMessage.Mocks
        assertEquals(3, set.rev)
        assertEquals(2, set.count)

        val first = messages[1] as GatewayMessage.Mock
        assertEquals(3, first.rev)
        assertEquals(0, first.index)
        val respond = first.rule
        assertEquals("m2", respond.id)
        assertEquals("GET", respond.method)
        assertEquals(MockMatch.EXACT, respond.match)
        assertEquals("https://api.example.com/v1/items/42", respond.url)
        assertEquals(MockAction.RESPOND, respond.action)
        assertEquals(200, respond.status)
        // `\n` separates the headers; `\"` and the non-ASCII ✓ come through unchanged.
        assertEquals(listOf("Content-Type" to "application/json", "X-Note" to "\"quoted\" ✓"), respond.headers)
        assertEquals("{\"id\":42,\"name\":\"Mocked ✓\"}", String(respond.body, Charsets.UTF_8))
        assertEquals(1500, respond.delayMs)

        val second = messages[2] as GatewayMessage.Mock
        assertEquals(3, second.rev)
        assertEquals(1, second.index)
        val timeout = second.rule
        assertEquals("m1", timeout.id)
        assertNull(timeout.method) // `*`: any method.
        assertEquals(MockMatch.GLOB, timeout.match)
        assertEquals("https://*.example.com/v1/*", timeout.url)
        assertEquals(MockAction.TIMEOUT, timeout.action)
        assertEquals(0, timeout.status)
        assertTrue(timeout.headers.isEmpty())
        assertEquals(0, timeout.body.size)
        assertEquals(0, timeout.delayMs)

        val cleared = messages[3] as GatewayMessage.Mocks
        assertEquals(4, cleared.rev)
        assertEquals(0, cleared.count)
    }

    @Test
    fun goldenLinesReachTheLinkThroughTheReader() {
        val bytes = goldenLines.joinToString("\n", postfix = "\n").toByteArray(Charsets.UTF_8)
        val messages = ArrayList<GatewayMessage>()
        GatewayReader(java.io.ByteArrayInputStream(bytes), onMessage = { messages += it }, onClosed = {}).readLoop()
        assertEquals(listOf("Welcome", "Mocks", "Mock", "Mock", "Mocks"), messages.map { it.javaClass.simpleName })
    }

    private fun mockLine(vararg changes: Pair<String, String>): String {
        val fields = linkedMapOf(
            "type" to "\"mock\"", "rev" to "1", "index" to "0", "id" to "\"m1\"", "method" to "\"POST\"",
            "match" to "\"prefix\"", "url" to "\"https://api.example.com/v1\"", "action" to "\"respond\"",
            "status" to "201", "headers" to "\"\"", "bodyBase64" to "\"YQ\"", "delayMs" to "0",
        )
        for ((key, value) in changes) if (value.isEmpty()) fields.remove(key) else fields[key] = value
        return fields.entries.joinToString(",", "{", "}") { (key, value) -> "\"$key\":$value" }
    }

    @Test
    fun aMockLineNeedsEveryFieldWithItsType() {
        val rule = (GatewayMessage.parse(mockLine()) as GatewayMessage.Mock).rule
        assertEquals("POST", rule.method)
        assertArrayEquals("a".toByteArray(), rule.body) // Padding is optional.
        assertEquals(30_000, (GatewayMessage.parse(mockLine("delayMs" to "99999")) as GatewayMessage.Mock).rule.delayMs)
        for (change in listOf(
            "rev" to "-1", "rev" to "1.5", "index" to "\"0\"", "id" to "\"\"", "method" to "null", "match" to "\"regex\"",
            "action" to "\"drop\"", "status" to "99", "status" to "600", "headers" to "1", "bodyBase64" to "\"*\"",
            "bodyBase64" to "\"Y\"", "delayMs" to "1e3", "url" to "", "url" to "{\"nested\":1}",
        )) {
            assertNull(change.toString(), GatewayMessage.parse(mockLine(change)))
        }
        // Failure actions carry status 0.
        assertEquals(
            MockAction.CONNECTION_ERROR,
            (GatewayMessage.parse(mockLine("action" to "\"connection_error\"", "status" to "0")) as GatewayMessage.Mock).rule.action,
        )
    }

    @Test
    fun mockHeadersThatCouldInjectAreDropped() {
        assertEquals(
            listOf("X-Ok" to "a\tb ✓"),
            MockWire.headers("X-Ok: a\tb ✓\nBad Name: x\nX-Cr: a\rSet-Cookie: x\nX-Nul: a\u0000b\nX-Del: \u007f\n: empty"),
        )
    }

    @Test
    fun aMocksLineNeedsIntegerRevAndCount() {
        assertEquals(40, (GatewayMessage.parse("{\"type\":\"mocks\",\"rev\":7,\"count\":40}") as GatewayMessage.Mocks).count)
        assertNull(GatewayMessage.parse("{\"type\":\"mocks\",\"rev\":7}"))
        assertNull(GatewayMessage.parse("{\"type\":\"mocks\",\"rev\":\"7\",\"count\":1}"))
        assertNull(GatewayMessage.parse("{\"type\":\"mocks\",\"rev\":7,\"count\":1,\"x\":[1]}"))
    }

    @Test
    fun base64DecodesStandardAlphabet() {
        assertArrayEquals(byteArrayOf(), MockWire.base64(""))
        assertArrayEquals("[]".toByteArray(), MockWire.base64("W10="))
        assertArrayEquals(byteArrayOf(-5, -1), MockWire.base64("+/8="))
        assertNull(MockWire.base64("W10=="))
        assertNull(MockWire.base64("W1 0"))
    }
}

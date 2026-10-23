package io.github.risyadul.lionscope

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException

/** Mock rules answer matching calls without a network call; only during a v7 session. */
class OkHttpMocksTest {
    private val net = NetworkHarness()

    @After
    fun tearDown() = net.close()

    private fun get(path: String, method: String = "GET"): Pair<Int, String> {
        val request = Request.Builder().url(net.url(path))
        if (method != "GET") request.method(method, if (method == "DELETE") null else "{}".toRequestBody())
        return net.client().newCall(request.build()).execute().use { it.code to it.body!!.string() }
    }

    @Test
    fun aMatchingRuleAnswersWithoutTheNetwork() {
        net.session()
        net.mocks(
            1,
            mockRule(
                url = "${net.base}v1/items",
                status = 201,
                headers = listOf("Content-Type" to "application/json; charset=utf-8", "X-Note" to "\"quoted\" ✓"),
                body = "{\"id\":42,\"name\":\"Mocked ✓\"}",
            ),
        )
        net.client().newCall(Request.Builder().url(net.url("/v1/items/42?token=abc")).build()).execute().use { response ->
            assertEquals(201, response.code)
            assertEquals("Created", response.message)
            assertEquals(Protocol.HTTP_1_1, response.protocol)
            assertEquals("\"quoted\" ✓", response.header("X-Note"))
            assertEquals("application/json; charset=utf-8", response.body!!.contentType().toString())
            assertEquals("{\"id\":42,\"name\":\"Mocked ✓\"}", response.body!!.string())
        }
        assertEquals(0, net.server.requestCount)
        assertEquals(listOf("Mocked GET ${net.base}v1/items/42?token=$HTTP_REDACTED (rule m1): 201"), net.logs)

        val request = net.request()
        assertEquals("m1", request["mockId"])
        val response = net.response()
        assertEquals(201.0, response["status"])
        assertNull(response["protocol"])
        assertEquals("{\"id\":42,\"name\":\"Mocked ✓\"}", (response["body"] as Map<*, *>)["text"])
        assertEquals(listOf("mocksApplied"), net.messages("mocksApplied").map { it["type"] })
        assertEquals(1.0, net.messages("mocksApplied").single()["count"])
    }

    @Test
    fun exactPrefixGlobQueryAndAnyMethod() {
        net.session()
        net.mocks(
            1,
            mockRule(id = "m1", match = MockMatch.EXACT, url = "${net.base}exact", body = "exact"),
            mockRule(id = "m2", match = MockMatch.PREFIX, url = "${net.base}prefix/", body = "prefix"),
            mockRule(id = "m3", method = null, match = MockMatch.GLOB, url = "*://*/glob/*/end", body = "glob"),
            mockRule(id = "m4", match = MockMatch.EXACT, url = "${net.base}q?page=2", body = "query"),
        )
        assertEquals(200 to "exact", get("/exact?x=1#f"))
        assertEquals(200 to "prefix", get("/prefix/a/b"))
        assertEquals(200 to "glob", get("/glob/a/b/end", method = "DELETE"))
        assertEquals(200 to "query", get("/q?page=2"))
        repeat(4) { net.server.enqueue(MockResponse().setBody("real")) }
        assertEquals(200 to "real", get("/exact/more")) // Exact means exact.
        assertEquals(200 to "real", get("/prefix")) // Shorter than the prefix.
        assertEquals(200 to "real", get("/q?page=3"))
        assertEquals(200 to "real", get("/exact", method = "POST")) // m1 is GET only.
        assertEquals(4, net.server.requestCount)
        assertEquals(listOf("m1", "m2", "m3", "m4", null, null, null, null), net.messages("httpRequest").map { it["mockId"] })
    }

    @Test
    fun theFirstRuleInTheServersOrderWins() {
        net.session()
        net.mocks(
            1,
            mockRule(id = "m2", match = MockMatch.EXACT, url = "${net.base}v1/items", body = "first"),
            mockRule(id = "m1", method = null, match = MockMatch.PREFIX, url = "${net.base}v1/", body = "second"),
        )
        assertEquals("first", get("/v1/items").second)
        assertEquals("second", get("/v1/other").second)
    }

    @Test
    fun aDelayedAnswerWaitsAndACancelEndsTheWait() {
        net.session()
        net.mocks(1, mockRule(url = "${net.base}slow", delayMs = 300), mockRule(id = "m2", url = "${net.base}never", delayMs = 30_000))
        val started = System.nanoTime()
        assertEquals("{\"mocked\":true}", get("/slow").second)
        assertTrue((System.nanoTime() - started) / 1_000_000 >= 300)
        assertTrue((net.response()["headersMs"] as Double) >= 300.0)

        val call = net.client().newCall(Request.Builder().url(net.url("/never")).build())
        Thread {
            Thread.sleep(150)
            call.cancel()
        }.start()
        val cancelStarted = System.nanoTime()
        try {
            call.execute()
            fail("expected the call to be canceled")
        } catch (e: IOException) {
            assertEquals("Canceled", e.message)
        }
        assertTrue((System.nanoTime() - cancelStarted) / 1_000_000 < 5_000)
        val canceled = net.messages("httpResponse").last()
        assertEquals("canceled", (canceled["error"] as Map<*, *>)["kind"])
        assertEquals("m2", net.messages("httpRequest").last()["mockId"])
        assertEquals(0, net.server.requestCount)
    }

    @Test
    fun failureRulesThrowTheMatchingIOExceptions() {
        net.session()
        net.mocks(
            1,
            mockRule(id = "m1", url = "${net.base}timeout", action = MockAction.TIMEOUT, status = 0),
            mockRule(id = "m2", url = "${net.base}refused", action = MockAction.CONNECTION_ERROR, status = 0),
        )
        try {
            get("/timeout")
            fail("expected a timeout")
        } catch (e: SocketTimeoutException) {
            // Retrofit's and Ktor's timeout paths run.
        }
        try {
            get("/refused")
            fail("expected a connection error")
        } catch (e: ConnectException) {
            // Expected.
        }
        assertEquals(0, net.server.requestCount)
        val errors = net.messages("httpResponse").map { it["error"] as Map<*, *> }
        assertEquals(listOf("timeout", "connection"), errors.map { it["kind"] })
        assertEquals(listOf("m1", "m2"), net.messages("httpRequest").map { it["mockId"] })
        assertEquals("Mocked GET ${net.base}timeout (rule m1): timeout", net.logs[0])
    }

    @Test
    fun aNetworkInterceptorNeverMocks() {
        net.session()
        net.mocks(1, mockRule(url = net.base))
        net.server.enqueue(MockResponse().setBody("real"))
        net.server.enqueue(MockResponse().setBody("real"))
        val client = net.client(network = true)
        repeat(2) { client.newCall(Request.Builder().url(net.url("/x")).build()).execute().use { assertEquals("real", it.body!!.string()) } }
        assertEquals(2, net.server.requestCount)
        assertNull(net.messages("httpRequest").first()["mockId"])
        assertEquals(1, net.logs.count { it.contains("addNetworkInterceptor") })
    }

    @Test
    fun aMockTheSdkCannotBuildFallsBackToTheNetwork() {
        net.session()
        // OkHttp refuses this header name: building the answer fails, so the real server answers.
        net.mocks(1, mockRule(url = net.base, headers = listOf("Bad\u0001Name" to "x")))
        net.server.enqueue(MockResponse().setBody("real"))
        assertEquals("real", get("/x").second)
        assertEquals(1, net.server.requestCount)
        assertNull(net.request()["mockId"])
        assertTrue(net.logs.none { it.startsWith("Mocked") })
    }

    @Test
    fun ruleSetsApplyWhenCompleteAndClearWithTheSession() {
        net.session()
        val rule = mockRule(url = net.base, body = "mocked")
        fun answer(): String {
            net.server.enqueue(MockResponse().setBody("real"))
            return get("/x").second
        }
        // Half-received: not applied, not confirmed.
        net.link.gateway(GatewayMessage.Mocks(1, 2))
        net.link.gateway(GatewayMessage.Mock(1, 0, rule))
        assertEquals("real", answer())
        assertTrue(net.messages("mocksApplied").isEmpty())
        // A mock of another rev is ignored; the rest of rev 1 completes it.
        net.link.gateway(GatewayMessage.Mock(2, 1, rule))
        assertEquals("real", answer())
        net.link.gateway(GatewayMessage.Mock(1, 1, rule))
        assertEquals("mocked", answer())
        assertEquals(listOf(1.0 to 2.0), net.messages("mocksApplied").map { it["rev"] to it["count"] })

        // A new set discards one still arriving; the active set stays until the new one is complete.
        net.link.gateway(GatewayMessage.Mocks(2, 1))
        assertEquals("mocked", answer())
        net.link.gateway(GatewayMessage.Mocks(3, 0))
        assertEquals("real", answer())
        assertEquals(3.0, net.messages("mocksApplied").last()["rev"])

        // Over 32 rules: the active set is cleared, nothing is confirmed.
        net.mocks(4, rule)
        assertEquals("mocked", answer())
        net.link.gateway(GatewayMessage.Mocks(5, MAX_NETWORK_MOCKS + 1))
        assertEquals("real", answer())
        assertEquals(4.0, net.messages("mocksApplied").last()["rev"])

        // The session ends: rules are gone, and none apply until a new session sets them.
        net.mocks(6, rule)
        assertEquals("mocked", answer())
        net.endSession()
        assertTrue(net.capture.mocks.isEmpty())
        net.session()
        assertEquals("real", answer())
    }

    @Test
    fun noMocksOutsideAV7Session() {
        val rule = mockRule(url = net.base, body = "mocked")
        net.session(inspectOnly = true)
        net.mocks(1, rule)
        net.server.enqueue(MockResponse().setBody("real"))
        assertEquals("real", get("/x").second)
        net.endSession()
        net.session(version = DEVICE_PROTOCOL_V5)
        net.mocks(1, rule)
        net.server.enqueue(MockResponse().setBody("real"))
        assertEquals("real", get("/x").second)
        assertTrue(net.link.v7Lines.isEmpty())
        assertFalse(net.capture.isActive)
    }

    @Test
    fun overTheRateCapMocksStillApply() {
        var now = 0L
        NetworkHarness(nanoTime = { now }).use { capped ->
            capped.session()
            capped.mocks(1, mockRule(url = capped.base, body = "mocked"))
            val client = capped.client()
            repeat(HTTP_EXCHANGE_BURST + 5) {
                client.newCall(Request.Builder().url(capped.url("/x")).build()).execute().use { assertEquals("mocked", it.body!!.string()) }
            }
            assertEquals(HTTP_EXCHANGE_BURST, capped.messages("httpRequest").size)
            assertEquals(0, capped.server.requestCount)
            assertEquals(HTTP_EXCHANGE_BURST + 5, capped.logs.count { it.startsWith("Mocked") })
        }
    }
}

package io.github.risyadul.lionscope

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** The real [DeviceLink] over a socket: network capture and mocks only on welcomed, proven v7 session links. */
class NetworkLinkTest {
    private val loopback = InetAddress.getByName("127.0.0.1")
    private val hello = "{\"type\":\"hello\",\"protocolVersion\":7}"

    private fun Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

    private fun BufferedReader.next(type: String): Map<*, *> {
        while (true) {
            val message = TestJson.parse(readLine() ?: error("stream closed")) as Map<*, *>
            if (message["type"] == type) return message
        }
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(10)
        }
    }

    private fun mockLines(rev: Int, url: String) = listOf(
        "{\"type\":\"mocks\",\"rev\":$rev,\"count\":1}",
        "{\"type\":\"mock\",\"rev\":$rev,\"index\":0,\"id\":\"m1\",\"method\":\"*\",\"match\":\"prefix\",\"url\":\"$url\"," +
            "\"action\":\"respond\",\"status\":200,\"headers\":\"Content-Type: text/plain\",\"bodyBase64\":\"bW9ja2Vk\",\"delayMs\":0}",
    )

    @Test(timeout = 30_000)
    fun aV7SessionCapturesAndMocksAndTheLinkEndClearsTheRules() {
        val web = MockWebServer().apply { start(loopback, 0) }
        val gateway = ServerSocket(0, 4, loopback).apply { soTimeout = 10_000 }
        try {
            val link = DeviceLink(
                helloLine = { hello },
                port = gateway.localPort,
                policy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(50))),
                heartbeatIntervalMs = 200,
                linkKey = { TEST_LINK_KEY },
                newNonce = { GOLDEN_NONCE },
            )
            val capture = NetworkCapture(log = { _, _ -> })
            capture.attach(link)
            val client = OkHttpClient.Builder().addInterceptor(LionscopeOkHttpInterceptor(capture)).build()
            val base = web.url("/").toString()
            fun get(): String {
                web.enqueue(MockResponse().setBody("real").setHeader("Content-Type", "text/plain"))
                return client.newCall(Request.Builder().url(web.url("/v1/items")).build()).execute().use { it.body!!.string() }
            }
            link.start()

            // An inspect-only link: no capture, mocks ignored and never confirmed.
            gateway.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                socket.reply("{\"type\":\"welcome\",\"protocolVersion\":7,\"mode\":\"inspect\"}")
                waitFor { link.isWelcomed }
                mockLines(1, base).forEach { socket.reply(it) }
                link.send("{\"type\":\"marker\"}")
                input.next("marker")
                assertFalse(capture.isActive)
                assertTrue(capture.mocks.isEmpty())
                assertEquals("real", get())
                link.send("{\"type\":\"marker\"}")
                input.next("marker") // Nothing network-related was written before it.
            }
            waitFor { !link.isConnected }

            // A v5 session: no network messages either.
            gateway.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                socket.reply("{\"type\":\"welcome\",\"protocolVersion\":5}")
                waitFor { link.isSession }
                mockLines(1, base).forEach { socket.reply(it) }
                assertEquals("real", get())
                assertFalse(capture.isActive)
            }
            waitFor { !link.isConnected }

            // A proven v7 session: rules apply once complete, exchanges are written, the link end clears everything.
            gateway.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                socket.reply(GOLDEN_WELCOME)
                waitFor { capture.isActive }
                assertEquals("real", get())
                assertEquals("httpRequest", input.next("httpRequest")["type"])
                assertEquals("real", (input.next("httpResponse")["body"] as Map<*, *>)["text"])

                socket.reply("{\"type\":\"mocks\",\"rev\":2,\"count\":2}") // Half-received, then replaced.
                mockLines(3, base).forEach { socket.reply(it) }
                val applied = input.next("mocksApplied")
                assertEquals(3.0, applied["rev"])
                assertEquals(1.0, applied["count"])
                assertEquals("mocked", get())
                assertEquals("m1", input.next("httpRequest")["mockId"])
            }
            waitFor { !capture.isActive }
            assertTrue(capture.mocks.isEmpty())
            assertEquals("real", get())
            assertEquals(4, web.requestCount) // Every call but the mocked one.
        } finally {
            gateway.close()
            web.shutdown()
        }
    }

    @Test
    fun aV7ItemIsEncodedOnlyOnAProvenV7Connection() {
        val item = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V7) { "{\"type\":\"mocksApplied\"}" }
        assertEquals(null, DeviceLink.encode(item, negotiatedVersion = 5, networkAuthenticated = true))
        assertEquals("{\"type\":\"mocksApplied\"}", DeviceLink.encode(item, negotiatedVersion = 7, networkAuthenticated = true))
        // Queued for a proven connection, written on one that is not: dropped.
        assertEquals(null, DeviceLink.encode(item, negotiatedVersion = 7))
    }
}

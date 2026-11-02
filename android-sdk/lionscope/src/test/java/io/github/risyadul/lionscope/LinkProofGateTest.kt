package io.github.risyadul.lionscope

import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The link proof gate ([DeviceLink.encode]): without the proof, an item of v7 or later goes out only if its line is of
 * an [UnprovenType]; network messages and every type nobody classified are held back, and counted.
 */
class LinkProofGateTest {
    private fun v8(line: String) = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V8) { line }

    @Test
    fun unclassifiedTypesOfV8OrLaterAreHeldBackWithoutTheProof() {
        val held = intArrayOf(0)
        for (line in listOf(
            "{\"type\":\"httpRequest\",\"id\":1}", // A network message on the wrong send call.
            "{\"type\":\"futureMessage\"}", // A type added later and not classified.
            "{\"requestId\":3,\"type\":\"viewPropertyResult\"}", // Not `type` first: not classified.
            "{\"type\":\"viewPropertyResult2\"}",
            "{\"type\":\"view\\\"PropertyResult\"}",
            "{\"type\":\"viewPropertyResult",
            "",
        )) {
            assertNull(line, DeviceLink.encode(v8(line), negotiatedVersion = 8, networkAuthenticated = false) { held[0]++ })
            assertEquals(line, DeviceLink.encode(v8(line), negotiatedVersion = 8, networkAuthenticated = true) { held[0] += 100 })
        }
        assertEquals(7, held[0])
        // A later version's item without the proof follows the same list.
        val v9 = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V9) { "{\"type\":\"stallOrigin\"}" }
        assertNull(DeviceLink.encode(v9, negotiatedVersion = 9))
        // Nothing to send is not a message held back.
        assertNull(DeviceLink.encode(DeviceLink.V2Item(16, DEVICE_PROTOCOL_V8) { null }, negotiatedVersion = 8) { held[0]++ })
        assertEquals(7, held[0])
    }

    @Test
    fun aV7NetworkItemIsHeldBackUnencodedUntilAProvenConnection() {
        var encoded = 0
        var held = 0
        val item = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V7) { encoded++; "{\"type\":\"viewPropertyResult\"}" }
        // Even a line of an allowed type: v7 is the network version, none of it goes out unproven.
        assertNull(DeviceLink.encode(item, negotiatedVersion = 8, networkAuthenticated = false) { held++ })
        assertEquals(0, encoded)
        assertEquals(1, held)
        assertEquals("{\"type\":\"viewPropertyResult\"}", DeviceLink.encode(item, negotiatedVersion = 8, networkAuthenticated = true))
        assertEquals(1, encoded)
    }

    @Test
    fun theAllowListHoldsExactlyTheClassifiedTypes() {
        // Adding a type here lets it out on links without the proof: it must carry no app data (see UnprovenType).
        assertEquals(setOf("viewPropertyResult"), UnprovenType.values().map { it.wire }.toSet())
        for (network in listOf("httpRequest", "httpResponse", "mocksApplied")) {
            assertFalse(network, UnprovenType.allows("{\"type\":\"$network\"}"))
        }
    }

    @Test
    fun networkMessagesOnlyGoThroughTheProofPath() {
        NetworkHarness().use { net ->
            net.session()
            net.mocks(1, mockRule(url = net.base + "mocked", body = "mocked"))
            net.server.enqueue(MockResponse().setBody("real"))
            val client = net.client()
            for (path in listOf("/real", "/mocked")) {
                client.newCall(Request.Builder().url(net.url(path)).build()).execute().use { it.body!!.string() }
            }
            val types = net.link.v7Lines.map { (TestJson.parse(it) as Map<*, *>)["type"] }.toSet()
            assertEquals(setOf("httpRequest", "httpResponse", "mocksApplied"), types)
            for (lines in listOf(net.link.v2Lines, net.link.v3Lines, net.link.v4Lines, net.link.v8Lines)) {
                assertTrue(lines.toString(), lines.isEmpty())
            }
        }
    }

    @Test
    fun heldBackMessagesAreLoggedTwicePerConnectionAtMostWithoutPayload() {
        val logs = ArrayList<String>()
        val withheld = WithheldMessages { logs += it }
        withheld.startConnection()
        repeat(500) { withheld.add(connection = 4) }
        withheld.endConnection(4)
        withheld.startConnection()
        withheld.endConnection(5) // Nothing held back: nothing said.
        withheld.startConnection()
        withheld.add(6)
        withheld.endConnection(6)
        assertEquals(501L, withheld.count)
        assertEquals(
            listOf(
                "Link 4 has no link proof: holding back messages that need it (1 so far)",
                "Link 4 held back 500 messages without the link proof (500 in all)",
                "Link 6 has no link proof: holding back messages that need it (501 so far)",
                "Link 6 held back 1 messages without the link proof (501 in all)",
            ),
            logs,
        )
    }

    /** The real [DeviceLink] over a socket, welcomed at v8 without a proof. */
    @Test(timeout = 30_000)
    fun aLinkWithoutTheProofAnswersEditsAndHoldsBackTheRest() {
        val loopback = InetAddress.getByName("127.0.0.1")
        val hello = "{\"type\":\"hello\",\"protocolVersion\":9}"
        val gateway = ServerSocket(0, 4, loopback).apply { soTimeout = 10_000 }
        val logs = CopyOnWriteArrayList<String>()
        val withheld = WithheldMessages { logs += it }
        val posted = LinkedBlockingQueue<Runnable>()
        val main = object : MainScheduler {
            override fun post(task: Runnable) {
                posted.add(task)
            }

            override fun postDelayed(task: Runnable, delayMs: Long) = Unit
        }
        try {
            val link = DeviceLink(
                helloLine = { hello },
                port = gateway.localPort,
                policy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(60_000))),
                heartbeatIntervalMs = 200,
                linkKey = { TEST_LINK_KEY },
                newNonce = { GOLDEN_NONCE },
                withheld = withheld,
            )
            val access = FakeEditAccess()
            ViewEditRequests(link, main, ViewEditor(access, firstKey = 1))
            link.start()
            gateway.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                socket.reply("{\"type\":\"welcome\",\"protocolVersion\":8,\"mode\":\"session\"}")
                waitFor { link.isSession }
                assertFalse(link.isServerVerified)

                link.sendV7(16) { "{\"type\":\"mocksApplied\",\"rev\":1,\"count\":0}" }
                link.sendV8(16) { "{\"type\":\"httpRequest\",\"id\":1}" }
                socket.reply("{\"type\":\"setViewProperty\",\"requestId\":3,\"viewKey\":1,\"property\":\"alpha\",\"value\":0.5}")
                checkNotNull(posted.poll(5, TimeUnit.SECONDS)).run()
                link.send("{\"type\":\"marker\"}")

                val written = input.until("marker")
                assertEquals(listOf("viewPropertyResult"), written.map { it["type"] })
                assertEquals(false, written.single()["ok"])
                assertEquals("unauthenticated", written.single()["error"])
            }
            waitFor { !link.isConnected }
            waitFor { logs.size == 2 }
            assertEquals(2L, withheld.count)
            assertEquals("Link 1 held back 2 messages without the link proof (2 in all)", logs[1])
            assertTrue(access.writes.isEmpty())
        } finally {
            gateway.close()
        }
    }

    private fun Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

    /** The messages read before the first of [type], heartbeats left out. */
    private fun BufferedReader.until(type: String): List<Map<*, *>> {
        val seen = ArrayList<Map<*, *>>()
        while (true) {
            val message = TestJson.parse(readLine() ?: error("stream closed")) as Map<*, *>
            if (message["type"] == type) return seen
            if (message["type"] != "heartbeat") seen += message
        }
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(10)
        }
    }
}

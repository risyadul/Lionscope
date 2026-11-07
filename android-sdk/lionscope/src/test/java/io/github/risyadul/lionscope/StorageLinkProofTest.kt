package io.github.risyadul.lionscope

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

/**
 * The link proof gate for the v11 storage answers: none of the three result
 * types is an [UnprovenType], so on a link without the proof the real encoder ([DeviceLink.encode]) holds each back,
 * whichever connection state an item meets when it is written; every storage line goes through the gated `sendV11`
 * (never a raw `send` or a version below v7, which the gate does not cover); and over a real socket a request on a link
 * without the proof touches no prefs and gets no payload out, while a proven link does get its answer.
 */
class StorageLinkProofTest {
    private val resultLines = listOf(
        StorageInspector.codeLine(1, "storageListResult", "ok"),
        StorageInspector.codeLine(2, "storageReadResult", "ok"),
        StorageInspector.writeRefusal(3, "op3", "ok"),
    )

    @Test
    fun theThreeStorageResultsAreHeldBackOnALinkWithoutTheProof() {
        assertEquals(listOf("storageListResult", "storageReadResult", "storageWriteResult"), resultLines.map { (TestJson.parse(it) as Map<*, *>)["type"] })
        val held = intArrayOf(0)
        for (line in resultLines) {
            val item = DeviceLink.V2Item(line.length, DEVICE_PROTOCOL_V11) { line }
            assertNull(line, DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V11, networkAuthenticated = false) { held[0]++ })
            assertEquals(line, DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V11, networkAuthenticated = true) { held[0] += 100 })
            // A connection negotiated below v11 drops it before the proof is even looked at.
            assertNull(DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V10, networkAuthenticated = true) { held[0] += 100 })
            assertFalse(line, UnprovenType.allows(line))
        }
        assertEquals(3, held[0])
        // Fail-closed: the allowlist is exactly the three classified types (no storage type, read or write).
        assertEquals(setOf("viewPropertyResult", "savedState", "liveActivities"), UnprovenType.values().map { it.wire }.toSet())
        assertTrue(UnprovenType.values().none { it.wire.startsWith("storage") })
    }

    @Test
    fun anItemQueuedOnAProvenLinkIsCheckedAgainWhenWritten() {
        // Queued while proven; by the time the link thread writes it the connection is another one, without the proof.
        var encoded = 0
        val item = DeviceLink.V2Item(64, DEVICE_PROTOCOL_V11) { encoded++; resultLines[2] }
        var held = 0
        assertNull(DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V11, networkAuthenticated = false) { held++ })
        assertEquals(1, held)
        // Or one negotiated lower: not even encoded.
        val before = encoded
        assertNull(DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V8, networkAuthenticated = true))
        assertEquals(before, encoded)
    }

    @Test
    fun everyStorageAnswerGoesThroughTheGatedV11SendAndNoOther() {
        // FakeLink records every send call (LinkPort has no raw send: the real link's send(String) is not reachable).
        val link = FakeLink()
        val file = FakePrefs(mapOf("dark" to true, "count" to 3))
        val prefs = FakePrefsAccess(linkedMapOf("app" to file))
        val commits = ManualCommits()
        val tasks = ArrayList<Runnable>()
        StorageRequests(link, StorageInspector(prefs, DatabaseRegistry(), commits.runner), { tasks += it })
        link.welcome(true, DEVICE_PROTOCOL_V11)
        link.config(SdkOptions.DEFAULT.copy(storageConsent = StorageConsent.READ_WRITE))
        fun run() { while (tasks.isNotEmpty()) tasks.removeAt(0).run() }
        link.storage(GatewayMessage.StorageList(1))
        link.storage(GatewayMessage.StorageRead(2, "prefs", "app", null, null, null))
        link.storage(GatewayMessage.StorageWrite(3, "op3", "prefs", "app", "update", "count", null, null, null, """{"t":"int","v":"3"}""", """{"t":"int","v":"4"}""", null))
        run()
        // A provisional answer and its final one from the commit thread.
        commits.hold = true
        link.storage(GatewayMessage.StorageWrite(4, "op4", "prefs", "app", "update", "dark", null, null, null, """{"t":"bool","v":true}""", """{"t":"bool","v":false}""", null))
        run()
        commits.release()
        // A refusal (consent) is a storage answer too.
        link.config(SdkOptions.DEFAULT.copy(storageConsent = StorageConsent.READ))
        link.storage(GatewayMessage.StorageWrite(5, "op5", "prefs", "app", "update", "count", null, null, null, """{"t":"int","v":"4"}""", """{"t":"int","v":"5"}""", null))
        run()
        val types = link.v11Lines.map { (TestJson.parse(it) as Map<*, *>)["type"] }
        assertEquals(
            listOf("storageListResult", "storageReadResult", "storageWriteResult", "storageWriteResult", "storageWriteResult", "storageWriteResult"),
            types,
        )
        for (lines in listOf(link.v2Lines, link.v3Lines, link.v4Lines, link.v7Lines, link.v8Lines, link.v10Lines)) {
            assertTrue(lines.toString(), lines.isEmpty())
        }
        // The very items queued, written on a connection without the proof: every one held back, none encoded out.
        var held = 0
        assertEquals(6, link.v11Items.size)
        for (item in link.v11Items) {
            assertEquals(DEVICE_PROTOCOL_V11, item.minVersion)
            assertNull(DeviceLink.encode(item, negotiatedVersion = DEVICE_PROTOCOL_V11, networkAuthenticated = false) { held++ })
        }
        assertEquals(6, held)
    }

    // --- the real DeviceLink over a socket -----------------------------------------------------------------------

    private class Gateway(proven: Boolean) : AutoCloseable {
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 10_000 }
        val logs = CopyOnWriteArrayList<String>()
        val withheld = WithheldMessages { logs += it }
        val file = FakePrefs(mapOf("count" to 3))
        val prefs = FakePrefsAccess(linkedMapOf("app" to file))
        val link = DeviceLink(
            helloLine = { "{\"type\":\"hello\",\"protocolVersion\":11}" },
            port = server.localPort,
            policy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(60_000))),
            heartbeatIntervalMs = 200,
            linkKey = { TEST_LINK_KEY },
            newNonce = { GOLDEN_NONCE },
            withheld = withheld,
        )
        val welcome = "{\"type\":\"welcome\",\"protocolVersion\":11,\"mode\":\"session\"" +
            (if (proven) ",\"proof\":\"${LinkProof.proof(TEST_LINK_KEY, GOLDEN_NONCE, 11, "session")}\"" else "") + "}"

        init {
            StorageRequests(link, StorageInspector(prefs, DatabaseRegistry(), ManualCommits().runner))
            link.start()
        }

        override fun close() = server.close()
    }

    private fun Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

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

    private val requests = listOf(
        """{"type":"storageList","requestId":1}""",
        """{"type":"storageRead","requestId":2,"store":"prefs","name":"app"}""",
        """{"type":"storageWrite","requestId":3,"opId":"op3","store":"prefs","name":"app","op":"update","key":"count","expected":"{\"t\":\"int\",\"v\":\"3\"}","value":"{\"t\":\"int\",\"v\":\"4\"}"}""",
    )

    @Test(timeout = 30_000)
    fun aLinkWithoutTheProofTouchesNoPrefsAndWritesNoStorageLine() {
        Gateway(proven = false).use { gateway ->
            gateway.server.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                input.readLine() // hello
                socket.reply(gateway.welcome)
                waitFor { gateway.link.isSession }
                assertFalse(gateway.link.isServerVerified)
                // Even with storage consent on: the proof comes first.
                socket.reply("""{"type":"config","storageConsent":"read_write"}""")
                for (request in requests) socket.reply(request)
                // The three refusals are queued (sendV11) and held back when written; the marker goes after them.
                waitFor { gateway.withheld.count == 3L }
                gateway.link.send("{\"type\":\"marker\"}")
                val written = input.until("marker")
                assertTrue(written.toString(), written.none { (it["type"] as String).startsWith("storage") })
            }
            assertTrue(gateway.prefs.opened.isEmpty())
            assertEquals(3, gateway.file.values["count"])
            assertEquals(0, gateway.file.commits)
        }
    }

    @Test(timeout = 30_000)
    fun aProvenLinkGetsItsStorageAnswers() {
        Gateway(proven = true).use { gateway ->
            gateway.server.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                input.readLine() // hello
                socket.reply(gateway.welcome)
                waitFor { gateway.link.isServerVerified }
                socket.reply("""{"type":"config","storageConsent":"read_write"}""")
                // The config is applied on the link thread before the next line is read.
                for (request in requests) socket.reply(request)
                val answers = ArrayList<Map<*, *>>()
                while (answers.size < 3) {
                    val message = TestJson.parse(input.readLine() ?: error("stream closed")) as Map<*, *>
                    if ((message["type"] as String).startsWith("storage")) answers += message
                }
                assertEquals(listOf("storageListResult", "storageReadResult", "storageWriteResult"), answers.map { it["type"] })
                assertEquals(listOf("ok", "ok", "ok"), answers.map { it["code"] })
            }
            assertEquals(4, gateway.file.values["count"])
            assertEquals(0L, gateway.withheld.count)
        }
    }
}

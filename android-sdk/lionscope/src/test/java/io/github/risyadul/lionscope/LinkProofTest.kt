package io.github.risyadul.lionscope

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.BufferedReader
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.xml.parsers.DocumentBuilderFactory

/** The v7 link proof: network capture and mocks only once the server proved it holds the key adb handed over. */
class LinkProofTest {
    private val loopback = InetAddress.getByName("127.0.0.1")
    private val goldenProof = "f2d88543b6cc93f29e7d04d3c7239f4bbcbd8b40566ba077664e2729f885a0e4"

    @Test
    fun theGoldenProofIsTheHmacOfTheGoldenNonce() {
        assertEquals(goldenProof, LinkProof.proof(TEST_LINK_KEY, GOLDEN_NONCE, 7, "session"))
        assertTrue(LinkProof.verifySession(TEST_LINK_KEY, GOLDEN_NONCE, 7, goldenProof))
        assertFalse(LinkProof.verifySession(TEST_LINK_KEY, GOLDEN_NONCE, 8, goldenProof)) // Over the version as sent.
        assertFalse(LinkProof.verifySession(TEST_LINK_KEY, "0".repeat(32), 7, goldenProof))
        assertFalse(LinkProof.verifySession(ByteArray(LINK_KEY_BYTES), GOLDEN_NONCE, 7, goldenProof))
        assertFalse(LinkProof.verifySession(null, GOLDEN_NONCE, 7, goldenProof))
        assertFalse(LinkProof.verifySession(TEST_LINK_KEY, GOLDEN_NONCE, 7, null))
    }

    @Test
    fun noncesAreFreshLowerCaseHex() {
        val nonces = List(8) { LinkProof.newNonce() }
        assertTrue(nonces.all { Regex("[0-9a-f]{32}").matches(it) })
        assertEquals(nonces.size, nonces.toSet().size)
    }

    @Test
    fun theWelcomeProofMustBeSixtyFourLowerCaseHexDigits() {
        fun proof(value: String) = (GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\":7,\"proof\":$value}") as GatewayMessage.Welcome).proof
        assertEquals(goldenProof, proof("\"$goldenProof\""))
        assertNull(proof("\"${goldenProof.uppercase()}\""))
        assertNull(proof("\"${goldenProof.dropLast(1)}\""))
        assertNull(proof("\"${goldenProof}0\""))
        assertNull(proof("1"))
        assertNull((GatewayMessage.parse("{\"type\":\"welcome\",\"protocolVersion\":7}") as GatewayMessage.Welcome).proof)
    }

    @Test
    fun theReceiverKeepsAValidKeyForThisProcessOnly() {
        val hex = LinkProof.hex(TEST_LINK_KEY)
        assertEquals("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", hex)
        assertTrue(LinkKey.accept(hex, pid = 4242, myPid = 4242))
        assertArrayEquals(TEST_LINK_KEY, LinkKey.current)
        // Another process's key, malformed keys: ignored, the held key stays.
        val other = "ff".repeat(LINK_KEY_BYTES)
        assertFalse(LinkKey.accept(other, pid = 4243, myPid = 4242))
        for (bad in listOf(null, "", hex.dropLast(2), hex + "00", hex.uppercase(), "g" + hex.drop(1), "٠" + hex.drop(1))) {
            assertFalse(bad.toString(), LinkKey.accept(bad, pid = 4242, myPid = 4242))
        }
        assertArrayEquals(TEST_LINK_KEY, LinkKey.current)
        // The latest valid one wins.
        assertTrue(LinkKey.accept(other, pid = 4242, myPid = 4242))
        assertArrayEquals(ByteArray(LINK_KEY_BYTES) { -1 }, LinkKey.current)
    }

    @Test
    fun theReceiverIsDeclaredExportedBehindTheDumpPermission() {
        val receivers = receivers(manifest("lionscope.manifest"))
        assertEquals(1, receivers.size)
        val receiver = receivers.single()
        assertEquals(LinkKeyReceiver::class.java.name, receiver.getAttribute("android:name"))
        assertEquals("true", receiver.getAttribute("android:exported"))
        assertEquals("android.permission.DUMP", receiver.getAttribute("android:permission"))
        assertTrue(receivers(manifest("lionscope.noopManifest")).isEmpty())
    }

    private fun manifest(property: String): File = File(checkNotNull(System.getProperty(property)) { "run via Gradle" })

    private fun receivers(manifest: File): List<Element> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(manifest)
        val nodes = document.getElementsByTagName("receiver")
        return List(nodes.length) { nodes.item(it) as Element }
    }

    @Test(timeout = 60_000)
    fun networkCaptureNeedsAProofOverThisConnectionsNonceWithTheHeldKey() {
        val gateway = ServerSocket(0, 4, loopback).apply { soTimeout = 10_000 }
        val key = AtomicReference<ByteArray?>(null)
        val nonce = AtomicReference(GOLDEN_NONCE)
        val configs = AtomicInteger()
        try {
            val link = DeviceLink(
                helloLine = { it },
                port = gateway.localPort,
                policy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(50))),
                heartbeatIntervalMs = 200,
                linkKey = { key.get() },
                newNonce = { nonce.get() },
            )
            val capture = NetworkCapture(log = { _, _ -> })
            capture.attach(link)
            link.addConfigListener { configs.incrementAndGet() }
            link.start()

            /** One connection answered with [welcome]: whether network capture went on and mocks were applied. */
            fun connect(welcome: String): Boolean = gateway.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(nonce.get(), input.readLine()) // The hello carries this connection's nonce.
                socket.reply(welcome)
                waitFor { link.isWelcomed }
                val seen = configs.get()
                socket.reply("{\"type\":\"mocks\",\"rev\":1,\"count\":0}")
                // Lines are handled in order: once the config arrived, the mocks line was handled too.
                socket.reply("{\"type\":\"config\",\"stallThresholdMs\":300,\"strictMode\":false}")
                waitFor { configs.get() > seen }
                link.send("{\"type\":\"marker\"}")
                val applied = input.linesUntil("marker").any { it.contains("\"mocksApplied\"") }
                val active = capture.isActive
                assertEquals(active, link.isServerVerified)
                assertEquals(active, applied)
                active
            }

            // No key handed over.
            assertFalse(connect(GOLDEN_WELCOME))
            waitFor { !link.isConnected }
            key.set(TEST_LINK_KEY)
            // A wrong proof, or none.
            assertFalse(connect(GOLDEN_WELCOME.replace(goldenProof, "0".repeat(64))))
            waitFor { !link.isConnected }
            assertFalse(connect("{\"type\":\"welcome\",\"protocolVersion\":7,\"mode\":\"session\"}"))
            waitFor { !link.isConnected }
            // The right proof.
            assertTrue(connect(GOLDEN_WELCOME))
            waitFor { !link.isConnected && !capture.isActive }
            // A proof made for another connection's nonce.
            nonce.set("0123456789abcdef0123456789abcdef")
            assertFalse(connect(GOLDEN_WELCOME))
            waitFor { !link.isConnected }
            nonce.set(GOLDEN_NONCE)
            // An inspect-only link, and an older server, never capture.
            assertFalse(connect(GOLDEN_WELCOME.replace("\"session\"", "\"inspect\"")))
            waitFor { !link.isConnected }
            assertFalse(connect(GOLDEN_WELCOME.replace("\"protocolVersion\":7", "\"protocolVersion\":6")))
        } finally {
            gateway.close()
        }
    }

    private fun Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

    private fun BufferedReader.linesUntil(type: String): List<String> {
        val lines = ArrayList<String>()
        while (true) {
            val line = readLine() ?: error("stream closed")
            if ((TestJson.parse(line) as Map<*, *>)["type"] == type) return lines
            lines += line
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

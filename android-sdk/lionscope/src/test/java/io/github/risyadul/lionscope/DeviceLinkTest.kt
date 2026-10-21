package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList

class DeviceLinkTest {

    private val hello = "{\"type\":\"hello\",\"protocolVersion\":1}"
    private val home = ScreenRef("homepage", "app.HomeFragment", ScreenKind.FRAGMENT)
    private val loopback = InetAddress.getByName("127.0.0.1")

    private fun localServer() = ServerSocket(0, 4, loopback).apply { soTimeout = 10_000 }

    /** Re-binds a port this test just released; retried because the OS may need a moment to free it. */
    private fun rebind(port: Int): ServerSocket {
        repeat(50) {
            val server = ServerSocket()
            try {
                server.reuseAddress = true
                server.bind(InetSocketAddress(loopback, port), 4)
                server.soTimeout = 10_000
                return server
            } catch (e: BindException) {
                server.close()
                Thread.sleep(50)
            }
        }
        error("could not re-bind port $port")
    }

    private fun link(port: Int, policy: ReconnectPolicy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(50)))) =
        DeviceLink(helloLine = { hello }, port = port, policy = policy, heartbeatIntervalMs = 200)

    private fun Socket.reader(): BufferedReader = getInputStream().bufferedReader(Charsets.UTF_8)

    private fun Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

    private fun BufferedReader.readUntil(predicate: (Map<*, *>) -> Boolean): Map<*, *> {
        while (true) {
            val message = TestJson.parse(readLine() ?: error("stream closed")) as Map<*, *>
            if (predicate(message)) return message
        }
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(10)
        }
    }

    @Test(timeout = 20_000)
    fun handshakeStreamingHeartbeatByeAndReconnect() {
        localServer().use { server ->
            val link = link(server.localPort)
            val welcomeEvents = CopyOnWriteArrayList<Boolean>()
            link.addWelcomeListener { welcomeEvents += it }
            link.onScreen(1, home) // Before connecting: remembered, not queued.
            link.start()

            server.accept().use { client ->
                val input = client.reader()
                assertEquals(hello, input.readLine())
                val screen = TestJson.parse(input.readLine()) as Map<*, *>
                assertEquals("screen", screen["type"])
                assertEquals("homepage", (screen["screen"] as Map<*, *>)["name"])
                assertFalse(link.isWelcomed)
                assertNull(link.negotiatedVersion)

                client.reply("{\"type\":\"welcome\",\"protocolVersion\":1}")
                waitFor { link.isWelcomed }
                assertEquals(1, link.negotiatedVersion)
                link.send("{\"type\":\"custom\",\"n\":1}")
                assertEquals(1.0, input.readUntil { it["type"] == "custom" }["n"])
                link.onScreen(2, null) // Encoded on the link thread.
                assertEquals(null, input.readUntil { it["type"] == "screen" }["screen"])
                val heartbeat = input.readUntil { it["type"] == "heartbeat" }
                assertEquals(0.0, heartbeat["droppedMessages"])

                link.onScreen(3, home)
                client.reply("{\"type\":\"bye\",\"reason\":\"no_session\"}")
                waitFor { !link.isConnected }
                assertFalse(link.isWelcomed)
                assertNull(link.negotiatedVersion)
                link.send("{\"type\":\"stale\"}") // Discarded while disconnected.
            }
            assertEquals(listOf(true, false), welcomeEvents.toList())

            server.accept().use { client ->
                val input = client.reader()
                assertEquals(hello, input.readLine())
                val screen = TestJson.parse(input.readLine()) as Map<*, *>
                assertEquals("screen", screen["type"])
                assertEquals("homepage", (screen["screen"] as Map<*, *>)["name"])
                link.send("{\"type\":\"fresh\"}")
                val next = input.readUntil { it["type"] != "heartbeat" }
                assertEquals("fresh", next["type"])
            }
        }
    }

    @Test(timeout = 20_000)
    fun unknownGatewayMessagesAreIgnoredAndTheWelcomeVersionIsNegotiated() {
        localServer().use { server ->
            val link = link(server.localPort)
            link.start()

            server.accept().use { client ->
                val input = client.reader()
                assertEquals(hello, input.readLine())
                // A newer server: unknown types before and after welcome, extra welcome fields, higher version.
                client.reply("{\"type\":\"configure\",\"protocolVersion\":7,\"sampleRate\":10}")
                client.reply("{\"type\":\"welcome\",\"serverVersion\":\"9.0.0\",\"protocolVersion\":7,\"extra\":[1,2]}")
                waitFor { link.isWelcomed }
                // Never above what this SDK speaks.
                assertEquals(DEVICE_PROTOCOL_VERSION, link.negotiatedVersion)
                client.reply("{\"type\":\"future_thing\",\"payload\":{\"a\":1}}")
                link.send("{\"type\":\"still_here\"}")
                assertEquals("still_here", input.readUntil { it["type"] != "heartbeat" }["type"])
                assertTrue(link.isConnected)
                assertTrue(link.isWelcomed)
            }
            waitFor { !link.isConnected }
            assertNull(link.negotiatedVersion)

            server.accept().use { client ->
                assertEquals(hello, client.reader().readLine())
                assertNull(link.negotiatedVersion) // Reset per connection, not carried over.
                client.reply("{\"type\":\"welcome\"}") // Older server without the field: version 1.
                waitFor { link.isWelcomed }
                assertEquals(1, link.negotiatedVersion)
            }
            waitFor { !link.isConnected }

            server.accept().use { client ->
                assertEquals(hello, client.reader().readLine())
                client.reply("{\"type\":\"welcome\",\"protocolVersion\":0}") // Below MIN: clamped up for now.
                waitFor { link.isWelcomed }
                assertEquals(MIN_DEVICE_PROTOCOL_VERSION, link.negotiatedVersion)
            }
        }
    }

    @Test(timeout = 20_000)
    fun reconnectsAfterTheServerDisappears() {
        val first = localServer()
        val port = first.localPort
        val link = link(port)
        link.start()
        first.accept().use { client -> assertEquals(hello, client.reader().readLine()) }
        first.close() // Server gone: attempts are refused for a while.
        Thread.sleep(200)
        assertFalse(link.isConnected)

        rebind(port).use { server ->
            server.accept().use { client -> assertEquals(hello, client.reader().readLine()) }
        }
    }

    @Test(timeout = 20_000)
    fun parksWhileBackgroundedAndWakesWhenAnActivityStarts() {
        localServer().use { server ->
            val policy = ReconnectPolicy(startMs = 0, backoff = Backoff(longArrayOf(50)), parkAfterBackgroundMs = 0)
            val link = link(server.localPort, policy)
            link.start()
            server.soTimeout = 500
            try {
                server.accept().close()
                error("connected while it should be parked")
            } catch (e: SocketTimeoutException) {
                // Parked: no attempt at all.
            }
            server.soTimeout = 10_000
            link.setForeground(true)
            server.accept().use { client -> assertEquals(hello, client.reader().readLine()) }
            assertTrue(link.isConnected)
        }
    }
}

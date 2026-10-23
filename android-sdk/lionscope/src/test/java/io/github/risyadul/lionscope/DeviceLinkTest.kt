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
import java.util.concurrent.Callable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

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

    /** A single-thread executor as the main thread; [onMain] runs a block there and waits for it. */
    private class ExecutorMain : MainScheduler, AutoCloseable {
        private val executor = Executors.newSingleThreadExecutor()

        override fun post(task: Runnable) {
            executor.execute(task)
        }

        override fun postDelayed(task: Runnable, delayMs: Long) = error("unused")

        fun <T> onMain(block: () -> T): T = executor.submit(Callable(block)).get()

        override fun close() {
            executor.shutdownNow()
        }
    }

    @Test(timeout = 20_000)
    fun v2WelcomeAndConfigDriveTheWatchdogAndStrictMode() {
        localServer().use { server ->
            ExecutorMain().use { main ->
                val link = link(server.localPort)
                val watchdog = FakeWatchdog()
                val strictMode = FakeStrictMode()
                val controller = DiagnosticsController(link, main, watchdog, strictMode)
                main.onMain { controller.onActivityStarted(PlainTestActivity()) }
                link.start()

                server.accept().use { client ->
                    val input = client.reader()
                    assertEquals(hello, input.readLine())
                    link.sendV2(16) { "{\"type\":\"stall\",\"n\":0}" } // Not welcomed yet: dropped.
                    client.reply("{\"type\":\"config\",\"stallThresholdMs\":500,\"strictMode\":true}") // Ignored.
                    client.reply("{\"type\":\"welcome\",\"protocolVersion\":2}")
                    waitFor { main.onMain { watchdog.isRunning } }
                    assertEquals(2, link.negotiatedVersion)
                    assertEquals(SdkOptions.DEFAULT.stallThresholdMs, main.onMain { watchdog.thresholdMs })
                    assertFalse(strictMode.enabled)

                    client.reply("{\"type\":\"config\",\"stallThresholdMs\":250,\"strictMode\":true,\"later\":1}")
                    waitFor { strictMode.enabled }
                    assertEquals(250L, main.onMain { watchdog.thresholdMs })

                    link.sendV2(16) { "{\"type\":\"stall\",\"n\":1}" }
                    assertEquals(1.0, input.readUntil { it["type"] != "heartbeat" }["n"])
                }
                // Link closed: watchdog stopped, StrictMode policies restored.
                waitFor { main.onMain { !watchdog.isRunning && !strictMode.enabled } }
                assertEquals(listOf(true, false), strictMode.changes)
            }
        }
    }

    @Test(timeout = 20_000)
    fun aV1LinkSendsNoV2MessagesAndIgnoresConfig() {
        localServer().use { server ->
            ExecutorMain().use { main ->
                val link = link(server.localPort)
                val watchdog = FakeWatchdog()
                val strictMode = FakeStrictMode()
                val controller = DiagnosticsController(link, main, watchdog, strictMode)
                main.onMain { controller.onActivityStarted(PlainTestActivity()) }
                link.start()

                server.accept().use { client ->
                    val input = client.reader()
                    assertEquals(hello, input.readLine())
                    client.reply("{\"type\":\"welcome\",\"protocolVersion\":1}") // A 0.1.x server.
                    waitFor { link.isWelcomed }
                    client.reply("{\"type\":\"config\",\"stallThresholdMs\":250,\"strictMode\":true}")
                    link.sendV2(16) { "{\"type\":\"stall\"}" }
                    link.sendV2(16) { "{\"type\":\"strictmode\"}" }
                    link.send("{\"type\":\"marker\"}")
                    assertEquals("marker", input.readUntil { it["type"] != "heartbeat" }["type"])
                    Thread.sleep(300) // Let the reader get to the config line.
                    main.onMain {
                        assertFalse(watchdog.isRunning)
                        assertEquals(0, watchdog.starts)
                    }
                    assertFalse(strictMode.enabled)
                    assertTrue(strictMode.changes.isEmpty())
                }
            }
        }
    }

    @Test
    fun aV2ItemIsEncodedOnlyOnAV2ConnectionAndAFailingEncoderDropsJustThatMessage() {
        var encoded = 0
        val item = DeviceLink.V2Item(16) {
            encoded++
            "{\"type\":\"stall\"}"
        }
        // Queued while v2, written after a reconnect that negotiated v1 (or before its welcome): dropped unencoded.
        assertNull(DeviceLink.encode(item, negotiatedVersion = 1))
        assertNull(DeviceLink.encode(item, negotiatedVersion = null))
        assertEquals(0, encoded)
        assertEquals("{\"type\":\"stall\"}", DeviceLink.encode(item, negotiatedVersion = 2))
        assertEquals(1, encoded)
        assertNull(DeviceLink.encode(DeviceLink.V2Item(16) { error("bad stack") }, negotiatedVersion = 2))
        assertEquals("{\"type\":\"custom\"}", DeviceLink.encode("{\"type\":\"custom\"}", negotiatedVersion = 1))
    }

    @Test
    fun aV3ItemIsEncodedOnlyOnAV3Connection() {
        val item = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V3) { "{\"type\":\"inflate\"}" }
        assertNull(DeviceLink.encode(item, negotiatedVersion = null))
        assertNull(DeviceLink.encode(item, negotiatedVersion = 1))
        assertNull(DeviceLink.encode(item, negotiatedVersion = 2))
        assertEquals("{\"type\":\"inflate\"}", DeviceLink.encode(item, negotiatedVersion = 3))
    }

    @Test
    fun aV4ItemIsEncodedOnlyOnAV4Connection() {
        val item = DeviceLink.V2Item(16, DEVICE_PROTOCOL_V4) { "{\"type\":\"inspectError\"}" }
        assertNull(DeviceLink.encode(item, negotiatedVersion = null))
        assertNull(DeviceLink.encode(item, negotiatedVersion = 3))
        assertEquals("{\"type\":\"inspectError\"}", DeviceLink.encode(item, negotiatedVersion = 4))
    }

    @Test(timeout = 20_000)
    fun inspectRequestsReachListenersOnlyOnAV4Link() {
        localServer().use { server ->
            val link = link(server.localPort)
            val requests = CopyOnWriteArrayList<Int>()
            link.addInspectListener { requests += it }
            link.start()

            server.accept().use { client ->
                val input = client.reader()
                assertEquals(hello, input.readLine())
                client.reply("{\"type\":\"inspect\",\"requestId\":1}") // Before welcome: ignored.
                client.reply("{\"type\":\"welcome\",\"protocolVersion\":3}")
                waitFor { link.isWelcomed }
                client.reply("{\"type\":\"inspect\",\"requestId\":2}") // A v3 link: ignored.
                link.sendV4(16) { "{\"type\":\"inspectError\"}" } // Dropped.
                link.send("{\"type\":\"marker\"}")
                assertEquals("marker", input.readUntil { it["type"] != "heartbeat" }["type"])
            }
            waitFor { !link.isConnected }

            server.accept().use { client ->
                val input = client.reader()
                assertEquals(hello, input.readLine())
                client.reply("{\"type\":\"welcome\",\"protocolVersion\":4}")
                waitFor { link.isWelcomed }
                client.reply("{\"type\":\"inspect\",\"requestId\":3}")
                waitFor { requests.isNotEmpty() }
                link.sendV4(16) { "{\"type\":\"inspectError\",\"requestId\":3}" }
                assertEquals(3.0, input.readUntil { it["type"] != "heartbeat" }["requestId"])
            }
            assertEquals(listOf(3), requests.toList())
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

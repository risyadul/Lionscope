package io.github.risyadul.lionscope

import android.content.ContextWrapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket

/** Runs posted tasks inline (on the link thread) under a lock; delayed ones wait for [runDelayed]. */
private class LockedScheduler : MainScheduler {
    private val lock = Any()
    private val delayed = ArrayList<Runnable>()

    override fun post(task: Runnable) = synchronized(lock) { task.run() }

    override fun postDelayed(task: Runnable, delayMs: Long) = synchronized(lock) { delayed += task; Unit }

    fun runDelayed() = synchronized(lock) {
        val due = delayed.toList()
        delayed.clear()
        due.forEach(Runnable::run)
    }

    fun <T> sync(read: () -> T): T = synchronized(lock) { read() }
}

/** The real [DeviceLink] driving the real trackers: only a `session` welcome activates them. */
class ModeGatingTest {

    private val hello = "{\"type\":\"hello\",\"protocolVersion\":5}"
    private val home = ScreenRef("homepage", "com.example.shop.HomeFragment", ScreenKind.FRAGMENT)
    private val layout = LayoutName("fragment_home", null, false)

    @Test(timeout = 20_000)
    fun inspectWelcomeActivatesNoTrackerAndALaterSessionWelcomeActivatesAll() {
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 10_000 }
        server.use {
            val link = DeviceLink(
                helloLine = { hello },
                port = server.localPort,
                policy = ReconnectPolicy(System.currentTimeMillis(), Backoff(longArrayOf(50))),
                heartbeatIntervalMs = 200,
            )
            val main = LockedScheduler()
            var now = 0L
            val frames = FrameTracker(ContextWrapper(null), link, main) {}
            val watchdog = FakeWatchdog()
            val strictMode = FakeStrictMode()
            val diagnostics = DiagnosticsController(link, main, watchdog, strictMode)
            val reporter = InflateReporter(link, main) { now }
            val snapshots = ArrayList<Runnable>()
            val layouts = LayoutsTracker(
                link, main, reporter, tracer = null,
                snapshotter = ViewTreeSnapshotter(link, { "homepage" }, afterFrameAndIdle = { snapshots += it }),
            )
            diagnostics.onActivityStarted(PlainTestActivity())
            layouts.onScreenChanged(home, Any())
            link.start()

            it.accept().use { client ->
                val input = client.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                client.reply("{\"type\":\"welcome\",\"protocolVersion\":5,\"mode\":\"inspect\"}")
                client.reply("{\"type\":\"config\",\"stallThresholdMs\":150,\"strictMode\":true}")
                waitFor { link.isWelcomed }
                reporter.add(layout, "homepage", 1, 5.0, 3)
                now = 5_000
                main.runDelayed()
                link.send("{\"type\":\"marker\"}")
                // The marker is the first non-heartbeat line: no inflate line, frames or view tree came before it.
                assertEquals("marker", input.readUntil { m -> m["type"] != "heartbeat" }["type"])
                main.sync {
                    assertFalse(frames.isActive)
                    assertFalse(watchdog.isRunning)
                    assertEquals(0, watchdog.starts)
                    assertTrue(strictMode.changes.isEmpty())
                    assertTrue(snapshots.isEmpty())
                }
            }
            waitFor { !link.isConnected }

            it.accept().use { client ->
                val input = client.getInputStream().bufferedReader(Charsets.UTF_8)
                assertEquals(hello, input.readLine())
                client.reply("{\"type\":\"welcome\",\"protocolVersion\":5,\"mode\":\"session\"}")
                client.reply("{\"type\":\"config\",\"stallThresholdMs\":150,\"strictMode\":true}")
                waitFor { main.sync { frames.isActive && watchdog.isRunning && strictMode.enabled && snapshots.size == 1 } }
                reporter.add(layout, "homepage", 2, 5.0, 3)
                now = 10_000
                main.runDelayed()
                assertEquals("inflate", input.readUntil { m -> m["type"] == "inflate" }["type"])
            }
            waitFor { !link.isConnected }
            waitFor { main.sync { !frames.isActive && !watchdog.isRunning } }
        }
    }

    private fun java.net.Socket.reply(line: String) {
        getOutputStream().write("$line\n".toByteArray(Charsets.UTF_8))
        getOutputStream().flush()
    }

    private fun java.io.BufferedReader.readUntil(predicate: (Map<*, *>) -> Boolean): Map<*, *> {
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
}

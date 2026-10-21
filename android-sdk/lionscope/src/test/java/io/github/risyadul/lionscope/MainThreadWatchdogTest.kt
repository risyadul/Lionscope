package io.github.risyadul.lionscope

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Real threads: a single-thread executor stands in for the main Looper. Timing-tolerant on purpose: the block is far
 * above the threshold, waits are latches with generous timeouts, and only stalls from the deliberate block are
 * inspected (a slow CI machine may report extra ones).
 */
class MainThreadWatchdogTest {

    private val mainExecutor = Executors.newSingleThreadExecutor { Thread(it, "fake-main").apply { isDaemon = true } }
    private val mainThread: Thread = mainExecutor.submit<Thread> { Thread.currentThread() }.get()
    private val main = object : MainScheduler {
        override fun post(task: Runnable) {
            mainExecutor.execute(task)
        }

        override fun postDelayed(task: Runnable, delayMs: Long) = error("unused")
    }
    private val stalls = CopyOnWriteArrayList<StallDetector.Stall>()
    private val blockReported = CountDownLatch(1)
    private val watchdog = MainThreadWatchdog(
        main = main,
        sampleStack = { mainThread.stackTrace },
        screenName = { "homepage" },
        report = { stall ->
            stalls += stall
            if (stall.stack.any { it.methodName == "blockMainFor" }) blockReported.countDown()
        },
        debuggerAttached = { true },
    )

    @After
    fun tearDown() {
        watchdog.stop()
        mainExecutor.shutdownNow()
    }

    private fun blockMainFor(ms: Long) = Thread.sleep(ms)

    @Test(timeout = 60_000)
    fun reportsABlockWithTheBlockingStackAndStopsItsThread() {
        watchdog.start()
        val thread = checkNotNull(watchdog.thread)
        assertEquals("lionscope-watchdog", thread.name)
        assertTrue(thread.isDaemon)

        mainExecutor.submit { blockMainFor(1_000) }.get()
        assertTrue("no stall for the block", blockReported.await(30, TimeUnit.SECONDS))

        val stall = stalls.first { s -> s.stack.any { it.methodName == "blockMainFor" } }
        assertTrue("duration ${stall.durationMs}", stall.durationMs >= SdkOptions.DEFAULT.stallThresholdMs)
        assertTrue(stall.samples >= 1)
        assertEquals("homepage", stall.screen)
        assertTrue(stall.debugger)

        watchdog.stop()
        assertFalse(watchdog.isRunning)
        assertNull(watchdog.thread)
        thread.join(10_000)
        assertFalse(thread.isAlive)
    }

    @Test(timeout = 60_000)
    fun startAndStopAreIdempotentAndEachStartIsAFreshThread() {
        watchdog.start()
        val first = checkNotNull(watchdog.thread)
        watchdog.start()
        assertTrue(first === watchdog.thread)
        watchdog.stop()
        watchdog.stop()
        first.join(10_000)
        assertFalse(first.isAlive)

        watchdog.start()
        val second = checkNotNull(watchdog.thread)
        assertTrue(second !== first)
        assertTrue(second.isAlive)
        watchdog.stop()
        second.join(10_000)
        assertFalse(second.isAlive)
    }

    @Test(timeout = 60_000)
    fun aWatchdogThreadThatDiesIsForgottenSoTheNextStartRestarts() {
        val failing = MainThreadWatchdog(
            main = main,
            sampleStack = { mainThread.stackTrace },
            screenName = { null },
            report = {},
            clock = object : WatchdogClock {
                override fun nanoTime(): Long = throw IllegalStateException("clock broke")
                override fun wallMs(): Long = 0
            },
        )
        val dead = checkNotNull(
            mainExecutor.submit<Thread?> {
                failing.start()
                failing.thread
            }.get(),
        )
        dead.join(10_000)
        assertFalse(dead.isAlive)
        // The thread posts its own removal to main; wait for it, then start again.
        mainExecutor.submit {}.get()
        assertFalse(mainExecutor.submit<Boolean> { failing.isRunning }.get())
        // Read in the same main task: the new thread dies right away too and would clear itself afterwards.
        val restarted = mainExecutor.submit<Thread?> {
            failing.start()
            failing.thread
        }.get()
        assertTrue(restarted != null && restarted !== dead)
        mainExecutor.submit { failing.stop() }.get()
    }
}

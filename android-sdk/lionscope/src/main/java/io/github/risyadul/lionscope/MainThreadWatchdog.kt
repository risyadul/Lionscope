package io.github.risyadul.lionscope

import android.os.Debug
import android.util.Log

/** Time sources of the watchdog: monotonic nanos for durations, wall-clock ms for `ts`. */
internal interface WatchdogClock {
    fun nanoTime(): Long
    fun wallMs(): Long

    object System : WatchdogClock {
        override fun nanoTime(): Long = java.lang.System.nanoTime()
        override fun wallMs(): Long = java.lang.System.currentTimeMillis()
    }
}

/** What [DiagnosticsController] drives; [start] / [stop] are idempotent and called on the main thread. */
internal interface Watchdog {
    var thresholdMs: Long
    fun start()
    fun stop()
}

/**
 * Detects main-thread blocks without touching the main Looper's message logging. A tick is posted to the main thread
 * every [INTERVAL_MS]; from the first round at which a tick is late by `threshold - INTERVAL_MS`, the main thread's
 * stack is sampled on each [step] (on the caller's thread, never on main) until the tick runs. One early sample means
 * a block just over the threshold, which may end before the next round, still has a stack. When the tick runs, a
 * block of at least the threshold is reported as ONE [Stall]: its start is the tick's post time, its stack the most
 * frequent sample (keyed by the innermost [KEY_FRAMES] frames). Blocks longer than [maxBlockMs] (or [maxSamples]
 * samples) are reported at that point with the time elapsed so far, then ignored until they end. The time from a
 * block's start to the next tick post (≤ [INTERVAL_MS]) is not counted. [report] is never called under the lock.
 * With each sample it reads the Rx task running on main ([rxTask], kept only when the same before and after the
 * stack) and the main thread's name ([threadName]); a representative stack keeps those of its first sample.
 */
internal class StallDetector(
    private val clock: WatchdogClock,
    private val post: (Runnable) -> Unit,
    private val sampleStack: () -> Array<StackTraceElement>,
    private val thresholdMs: () -> Long,
    private val screenName: () -> String?,
    private val debuggerAttached: () -> Boolean,
    private val report: (Stall) -> Unit,
    private val maxSamples: Int = MAX_SAMPLES,
    private val maxBlockMs: Long = MAX_BLOCK_MS,
    private val rxTask: () -> Any? = { null },
    private val threadName: () -> String? = { null },
) {
    class Stall(
        /** Wall-clock ms when the late tick was posted. */
        val ts: Long,
        val durationMs: Double,
        /** Innermost [StackFrames.MAX_SAMPLED_ELEMENTS] elements of the representative sample. */
        val stack: Array<StackTraceElement>,
        /** The sampled stack had more elements than [stack]. */
        val stackCut: Boolean,
        val samples: Int,
        /** Top screen when the block was first sampled. */
        val screen: String?,
        val debugger: Boolean,
        /** Outermost elements of a cut stack, at most [MAX_OUTER_FRAMES], none of them in [stack] (empty otherwise). */
        val outer: Array<StackTraceElement> = emptyArray(),
        /** The Rx task the main thread ran (see [RxTracking]), null outside Rx work. */
        val rxTask: Any? = null,
        val threadName: String? = null,
    )

    private inner class Tick(val postedNanos: Long, val postedWallMs: Long) : Runnable {
        @Volatile
        var ranAtNanos = NOT_RUN

        override fun run() {
            ranAtNanos = clock.nanoTime()
        }
    }

    private class StackCount(
        val stack: Array<StackTraceElement>,
        val cut: Boolean,
        val outer: Array<StackTraceElement>,
        val rxTask: Any?,
        val threadName: String?,
    ) {
        var count = 0
    }

    private var tick: Tick? = null
    private val stacks = LinkedHashMap<List<StackTraceElement>, StackCount>()
    private var samples = 0
    private var reported = false
    private var screen: String? = null
    private var debugger = false

    @Volatile
    var isClosed = false
        private set

    /** One watchdog round; the caller sleeps [INTERVAL_MS] between rounds. */
    fun step() {
        synchronized(this) { stepLocked() }?.let(report)
    }

    /**
     * Stops for good. Called on the main thread, which is therefore not blocked right now: a block being sampled
     * ends here and is reported (e.g. app work in `onStop` before the last activity stopped).
     */
    fun close() {
        synchronized(this) { closeLocked() }?.let(report)
    }

    private fun stepLocked(): Stall? {
        if (isClosed) return null
        val now = clock.nanoTime()
        val current = tick
        if (current == null) {
            postTick(now)
            return null
        }
        val ranAt = current.ranAtNanos
        if (ranAt != NOT_RUN) {
            val stall = finish(current, ranAt)
            postTick(now)
            return stall
        }
        if (reported) return null
        val elapsedNanos = now - current.postedNanos
        if (elapsedNanos < (thresholdMs() - INTERVAL_MS) * NANOS_PER_MS) return null
        sample(current)
        if (samples >= maxSamples || elapsedNanos >= maxBlockMs * NANOS_PER_MS) {
            reported = true
            return stall(current, elapsedNanos)
        }
        return null
    }

    private fun closeLocked(): Stall? {
        if (isClosed) return null
        isClosed = true
        val current = tick ?: return null
        tick = null
        val ranAt = current.ranAtNanos
        return finish(current, if (ranAt != NOT_RUN) ranAt else clock.nanoTime())
    }

    private fun postTick(now: Long) {
        val next = Tick(now, clock.wallMs())
        tick = next
        post(next)
    }

    private fun sample(current: Tick) {
        val taskBefore = rxTask()
        val stack = sampleStack()
        // The tick ran while the stack was taken: the sample may show what ran after the block.
        if (current.ranAtNanos != NOT_RUN) return
        val task = rxTask().takeIf { it === taskBefore }
        if (samples == 0) {
            screen = screenName()
            debugger = debuggerAttached()
        }
        samples++
        val key = ArrayList(stack.asList().subList(0, minOf(KEY_FRAMES, stack.size)))
        stacks.getOrPut(key) {
            val kept = StackFrames.MAX_SAMPLED_ELEMENTS
            val cut = stack.size > kept
            StackCount(
                stack = if (cut) stack.copyOf(kept).requireNoNulls() else stack,
                cut = cut,
                outer = if (cut) stack.copyOfRange(maxOf(kept, stack.size - MAX_OUTER_FRAMES), stack.size) else NO_ELEMENTS,
                rxTask = task,
                threadName = threadName(),
            )
        }.count++
    }

    private fun finish(current: Tick, endNanos: Long): Stall? {
        val durationNanos = endNanos - current.postedNanos
        val stall = if (samples > 0 && !reported && durationNanos >= thresholdMs() * NANOS_PER_MS) {
            stall(current, durationNanos)
        } else {
            null
        }
        stacks.clear()
        samples = 0
        reported = false
        screen = null
        debugger = false
        return stall
    }

    private fun stall(current: Tick, durationNanos: Long): Stall? {
        // First of the most frequent: LinkedHashMap keeps insertion order and maxByOrNull keeps the first maximum.
        val representative = stacks.values.maxByOrNull { it.count } ?: return null
        return Stall(
            ts = current.postedWallMs,
            durationMs = durationNanos / NANOS_PER_MS_D,
            stack = representative.stack,
            stackCut = representative.cut,
            outer = representative.outer,
            rxTask = representative.rxTask,
            threadName = representative.threadName,
            samples = samples,
            screen = screen,
            debugger = debugger,
        )
    }

    internal companion object {
        const val INTERVAL_MS = 50L
        const val MAX_SAMPLES = 600
        const val MAX_BLOCK_MS = 30_000L
        const val KEY_FRAMES = 8
        private const val NANOS_PER_MS = 1_000_000L
        private const val NANOS_PER_MS_D = 1_000_000.0
        private const val NOT_RUN = Long.MIN_VALUE
        private val NO_ELEMENTS = emptyArray<StackTraceElement>()
    }
}

/**
 * Runs a [StallDetector] on a dedicated `lionscope-watchdog` thread while started. The thread runs at default
 * priority (a background-priority sampler would starve exactly when the app is busy) and exists only between
 * [start] and [stop]; each start gets a fresh thread and detector. If the thread dies unexpectedly, the next [start]
 * starts a new one.
 */
internal class MainThreadWatchdog(
    private val main: MainScheduler,
    private val sampleStack: () -> Array<StackTraceElement>,
    private val screenName: () -> String?,
    private val report: (StallDetector.Stall) -> Unit,
    private val debuggerAttached: () -> Boolean = Debug::isDebuggerConnected,
    private val clock: WatchdogClock = WatchdogClock.System,
    private val rxTask: () -> Any? = { null },
    private val threadName: () -> String? = { null },
) : Watchdog {
    private class Running(val detector: StallDetector, val thread: Thread)

    @Volatile
    override var thresholdMs: Long = SdkOptions.DEFAULT.stallThresholdMs

    private var running: Running? = null // main thread only

    val isRunning: Boolean
        get() = running != null

    /** The current thread, for tests. */
    internal val thread: Thread?
        get() = running?.thread

    override fun start() {
        if (running != null) return
        val detector = StallDetector(
            clock = clock,
            post = main::post,
            sampleStack = sampleStack,
            thresholdMs = { thresholdMs },
            screenName = screenName,
            debuggerAttached = debuggerAttached,
            report = { stall -> guarded { report(stall) } },
            rxTask = rxTask,
            threadName = threadName,
        )
        lateinit var started: Running
        val thread = Thread({ loop(started) }, "lionscope-watchdog")
        thread.isDaemon = true
        started = Running(detector, thread)
        try {
            thread.start()
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            // e.g. pthread_create failing under memory pressure: no watchdog this time.
            Log.w(LOG_TAG, "Lionscope watchdog not started: ${t.javaClass.simpleName}")
            return
        }
        running = started
    }

    override fun stop() {
        val current = running ?: return
        running = null
        current.detector.close()
        current.thread.interrupt()
    }

    private fun loop(self: Running) {
        try {
            defaultThreadPriority()
            while (!self.detector.isClosed) {
                self.detector.step()
                Thread.sleep(StallDetector.INTERVAL_MS)
            }
        } catch (e: InterruptedException) {
            // Stopped.
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "Lionscope watchdog stopped: ${t.javaClass.simpleName}")
            // Forget the dead thread so that the next start() (e.g. next foreground) gets a new one.
            main.post(Runnable { if (running === self) running = null })
        }
    }
}

package io.github.risyadul.lionscope

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composer
import androidx.compose.runtime.Composition
import androidx.compose.runtime.InternalComposeApi
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.system.exitProcess

/**
 * Standalone subprocess entry point for the concurrent enable/disable + subcomposition deadlock regression test.
 * Running inside an isolated child JVM with `Runtime.getRuntime().halt(...)` on failure prevents `runBlocking`'s
 * structured cancellation from hanging inside `Recomposer.effectJob` if a deadlock regression holds `stateLock`.
 */
@OptIn(InternalComposeApi::class)
internal object Compose19DeadlockSubprocessRunner {

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.contains("--simulate-deadlock")) {
            runSimulatedDeadlock()
            return
        }
        try {
            runConcurrentStress()
            exitProcess(0)
        } catch (t: Throwable) {
            t.printStackTrace(System.err)
            Runtime.getRuntime().halt(3)
        }
    }

    private fun runSimulatedDeadlock() {
        val lockA = Any()
        val lockB = Any()
        val bothLockedFirst = CountDownLatch(2)
        Thread({
            synchronized(lockA) {
                bothLockedFirst.countDown()
                bothLockedFirst.await(2, TimeUnit.SECONDS)
                synchronized(lockB) {}
            }
        }, "sim-deadlock-1").apply { isDaemon = true }.start()
        Thread({
            synchronized(lockB) {
                bothLockedFirst.countDown()
                bothLockedFirst.await(2, TimeUnit.SECONDS)
                synchronized(lockA) {}
            }
        }, "sim-deadlock-2").apply { isDaemon = true }.start()

        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            findDeadlockDump()?.let { dump ->
                System.err.println("Simulated deadlock detected:\n$dump")
                Runtime.getRuntime().halt(2)
            }
            Thread.sleep(20)
        }
        System.err.println("Simulated deadlock was not detected in time")
        Runtime.getRuntime().halt(4)
    }

    private fun runConcurrentStress() = runBlocking {
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19
        val tick = mutableIntStateOf(0)
        val activeSubs = ArrayList<Composition>()

        fun composeSub(c: Composer, id: Int, changed: Int = 0) {
            val cc = c.startRestartGroup(8100 + id)
            if (changed != 0 || !cc.skipping) {
                // subcomposition body
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeSub(next, id, nextChanged) }
            }
        }

        fun composeParent(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(8000)
            if (changed != 0 || !cc.skipping) {
                val generation = tick.intValue
                val subContext = cc.buildContext()
                val sub = Composition(EmptyApplier(), subContext)
                Compose19TestBridge.setContent(sub) { sc, scChanged -> composeSub(sc, generation, scChanged) }
                activeSubs.add(sub)
                if (activeSubs.size > 4) {
                    activeSubs.removeAt(0).dispose()
                }
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeParent(next, nextChanged) }
            }
        }

        val parentComp = Composition(EmptyApplier(), recomposer)
        Compose19TestBridge.setContent(parentComp) { composer, changed -> composeParent(composer, changed) }

        val stop = AtomicBoolean(false)
        val failure = AtomicReference<Throwable?>()
        val started = CountDownLatch(2)
        val finished = CountDownLatch(2)

        val composerThread = Thread({
            started.countDown()
            try {
                for (i in 1..250) {
                    if (stop.get()) break
                    tick.intValue = i
                    Snapshot.sendApplyNotifications()
                    clock.advanceFrame()
                }
            } catch (t: Throwable) {
                failure.compareAndSet(null, t)
            } finally {
                stop.set(true)
                finished.countDown()
            }
        }, "test-compose-subcomp-composer").apply { isDaemon = true }

        val toggleThread = Thread({
            started.countDown()
            try {
                while (!stop.get()) {
                    tracker.setEnabled(true)
                    tracker.rescan()
                    tracker.setEnabled(false)
                }
            } catch (t: Throwable) {
                failure.compareAndSet(null, t)
            } finally {
                finished.countDown()
            }
        }, "test-compose-subcomp-toggle").apply { isDaemon = true }

        composerThread.start()
        toggleThread.start()
        if (!started.await(5, TimeUnit.SECONDS)) {
            System.err.println("Worker threads failed to start")
            Runtime.getRuntime().halt(5)
        }

        val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(12)
        while (!finished.await(20, TimeUnit.MILLISECONDS)) {
            findDeadlockDump()?.let { dump ->
                System.err.println("Deadlock detected between Compose and Lionscope tracker:\n$dump")
                // Halt immediately so runBlocking cancellation cannot hang in Recomposer.effectJob on stateLock.
                Runtime.getRuntime().halt(2)
            }
            if (System.nanoTime() >= deadlineNanos) {
                System.err.println("Timed out waiting for concurrent toggle + subcomposition stress run")
                Runtime.getRuntime().halt(6)
            }
        }
        failure.get()?.let {
            it.printStackTrace(System.err)
            Runtime.getRuntime().halt(3)
        }

        tracker.setEnabled(false)
        activeSubs.forEach { runCatching { it.dispose() } }
        runCatching { parentComp.dispose() }
        recomposer.cancel()
        job.join()
    }

    private fun findDeadlockDump(): String? {
        val factory = Class.forName("java.lang.management.ManagementFactory")
        val beanInterface = Class.forName("java.lang.management.ThreadMXBean")
        val bean = factory.getMethod("getThreadMXBean").invoke(null)
        val ids = beanInterface.getMethod("findDeadlockedThreads").invoke(bean) as? LongArray ?: return null
        if (ids.isEmpty()) return null
        val infoMethod = beanInterface.getMethod(
            "getThreadInfo",
            LongArray::class.java,
            Boolean::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
        )
        val infos = infoMethod.invoke(bean, ids, true, true) as? Array<*>
        return infos?.joinToString("\n") { it?.toString() ?: "null" } ?: ids.contentToString()
    }

    private class EmptyApplier : AbstractApplier<Unit>(Unit) {
        override fun insertTopDown(index: Int, instance: Unit) = Unit
        override fun insertBottomUp(index: Int, instance: Unit) = Unit
        override fun remove(index: Int, count: Int) = Unit
        override fun move(from: Int, to: Int, count: Int) = Unit
        override fun onClear() = Unit
    }

    private class ManualFrameClock : MonotonicFrameClock {
        private var pending: CompletableDeferred<Long>? = null
        private var frameTimeNanos = 0L

        override suspend fun <R> withFrameNanos(onFrame: (frameTimeNanos: Long) -> R): R {
            val waiter = CompletableDeferred<Long>()
            pending = waiter
            return onFrame(waiter.await())
        }

        fun advanceFrame() {
            frameTimeNanos += 16_666_667L
            val waiter = pending
            pending = null
            waiter?.complete(frameTimeNanos)
        }
    }
}

package io.github.risyadul.lionscope

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composer
import androidx.compose.runtime.Composition
import androidx.compose.runtime.InternalComposeApi
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.RecomposeScope
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Compose 1.9+ regression scenarios. Unit tests compile against Compose 1.6.8 (`testImplementation`) and run against
 * Compose `runtime-android` 1.9.2 under `testCompose19`, so 1.9-only observer types and JVM `ManagementFactory` are
 * invoked reflectively here.
 */
@OptIn(InternalComposeApi::class)
internal object Compose19TestScenarios {

    private class SyntheticMovedFlagsScope : RecomposeScope {
        @JvmField
        var flags: Int = 0

        @Suppress("unused")
        fun `getSkipped$runtime`(): Boolean = (flags and MOVED_SKIPPED_FLAG) != 0

        @Suppress("unused")
        fun getRereading(): Boolean = (flags and MOVED_REREADING_FLAG) != 0

        override fun invalidate() = Unit

        companion object {
            // Deliberately moved away from Compose 1.9.2's 0x10 / 0x20 masks.
            const val MOVED_SKIPPED_FLAG = 0x40
            const val MOVED_REREADING_FLAG = 0x80
        }
    }

    fun assertAndroidRuntimeArtifactResolved() {
        val artifact = System.getProperty("lionscope.composeRuntimeArtifact") ?: ""
        assertTrue(
            "Expected testCompose19 to resolve androidx.compose.runtime:runtime-android:1.9.*, got '$artifact'",
            artifact.startsWith("androidx.compose.runtime:runtime-android:1.9."),
        )
        val location = Recomposer::class.java.protectionDomain?.codeSource?.location?.toString() ?: ""
        assertFalse(
            "Expected Android runtime jar on testCompose19 classpath, got desktop jar: $location",
            location.contains("runtime-desktop"),
        )
        // Android-specific runtime class only packaged in runtime-android (absent from runtime-desktop).
        assertNotNull(Class.forName("androidx.compose.runtime.DefaultChoreographerFrameClock", false, javaClass.classLoader))
    }

    fun assertMovedSkipFlagUsesResolvedGetter() {
        val probe = ComposeRecompositionSupport.probe(
            findClass = { name ->
                if (name == "androidx.compose.runtime.RecomposeScopeImpl") {
                    SyntheticMovedFlagsScope::class.java
                } else {
                    Class.forName(name, false, javaClass.classLoader)
                }
            },
        )
        assertTrue(
            "Expected probe to succeed on synthetic scope with getters, got $probe",
            probe is ComposeRecompositionSupport.ProbeResult.Supported,
        )
        val access = (probe as ComposeRecompositionSupport.ProbeResult.Supported).access
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(emptySet()) },
        )
        tracker.setEnabled(true)
        assertEquals(RecompositionStatus.ACTIVE, tracker.status)

        val observer = tracker.observerForTest()
        val enterMethod = observer.javaClass.getMethod("onScopeEnter", RecomposeScope::class.java)
        val readMethod = observer.javaClass.getMethod("onReadInScope", RecomposeScope::class.java, Any::class.java)
        val exitMethod = observer.javaClass.getMethod("onScopeExit", RecomposeScope::class.java)
        val scope = SyntheticMovedFlagsScope()

        // Moved skip bit (0x40): getter reports skipped == true -> must count 1 skip, 0 recompositions.
        scope.flags = SyntheticMovedFlagsScope.MOVED_SKIPPED_FLAG
        enterMethod.invoke(observer, scope)
        exitMethod.invoke(observer, scope)
        assertEquals(RecompositionCounts(0, 1), tracker.countsFor(scope))

        // Legacy hardcoded bit (0x10): getter reports skipped == false -> must count 1 recomposition.
        scope.flags = 0x10
        enterMethod.invoke(observer, scope)
        exitMethod.invoke(observer, scope)
        assertEquals(RecompositionCounts(1, 1), tracker.countsFor(scope))

        // Moved rereading bit (0x80): getter reports rereading == true -> no-op reread, counts unchanged.
        scope.flags = SyntheticMovedFlagsScope.MOVED_REREADING_FLAG
        enterMethod.invoke(observer, scope)
        readMethod.invoke(observer, scope, Any())
        scope.flags = 0
        exitMethod.invoke(observer, scope)
        assertEquals(RecompositionCounts(1, 1), tracker.countsFor(scope))

        tracker.setEnabled(false)
    }

    fun assertResetDuringDerivedStateRereadDoesNotInventRecomposition() {
        val probe = ComposeRecompositionSupport.probe(
            findClass = { name ->
                if (name == "androidx.compose.runtime.RecomposeScopeImpl") {
                    SyntheticMovedFlagsScope::class.java
                } else {
                    Class.forName(name, false, javaClass.classLoader)
                }
            },
        ) as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(emptySet()) },
        )
        tracker.setEnabled(true)
        val observer = tracker.observerForTest()
        val enterMethod = observer.javaClass.getMethod("onScopeEnter", RecomposeScope::class.java)
        val readMethod = observer.javaClass.getMethod("onReadInScope", RecomposeScope::class.java, Any::class.java)
        val exitMethod = observer.javaClass.getMethod("onScopeExit", RecomposeScope::class.java)
        val scope = SyntheticMovedFlagsScope()

        // Reproduce: onScopeEnter -> onReadInScope(rereading) -> reset -> onScopeExit.
        enterMethod.invoke(observer, scope)
        scope.flags = SyntheticMovedFlagsScope.MOVED_REREADING_FLAG
        readMethod.invoke(observer, scope, Any())
        tracker.reset()
        scope.flags = 0
        exitMethod.invoke(observer, scope)

        assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scope))

        // A subsequent full pass after reset must still count normally.
        enterMethod.invoke(observer, scope)
        exitMethod.invoke(observer, scope)
        assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scope))
        tracker.setEnabled(false)
    }

    fun assertRuntimeLinkageErrorTransitionsToUnsupported() {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { throw NoSuchMethodError("simulated runningRecomposers linkage failure") },
        )
        assertEquals(RecompositionStatus.OFF, tracker.status)
        tracker.setEnabled(true)
        assertEquals(RecompositionStatus.UNSUPPORTED, tracker.status)
        assertNull(tracker.countsFor(Any()))
        // Stays fail-closed on subsequent enable attempts.
        tracker.setEnabled(true)
        assertEquals(RecompositionStatus.UNSUPPORTED, tracker.status)
    }

    fun assertExistingCompositionObserverIsPreservedAndReportedAsConflict() = runBlocking {
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19

        val tick = mutableIntStateOf(0)
        val rootScope = AtomicReference<RecomposeScope>()
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(7001)
            rootScope.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) {
                tick.intValue
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeRoot(next, nextChanged) }
            }
        }

        val composition = Composition(EmptyApplier(), recomposer)
        val externalEnters = AtomicInteger(0)
        val externalExits = AtomicInteger(0)
        val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
        val externalObserver = Proxy.newProxyInstance(
            observerInterface.classLoader,
            arrayOf(observerInterface),
        ) { proxy, method, args ->
            when (method.name) {
                "onScopeEnter" -> {
                    externalEnters.incrementAndGet()
                    null
                }
                "onScopeExit" -> {
                    externalExits.incrementAndGet()
                    null
                }
                "equals" -> proxy === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "ExternalTestCompositionObserver"
                else -> null
            }
        }
        val setObserverMethod = composition.javaClass.getMethod("setObserver", observerInterface)
        val externalHandle = setObserverMethod.invoke(composition, externalObserver)
        assertNotNull("Expected real 1.9 Composition to support setObserver", externalHandle)
        val disposeHandleMethod = externalHandle!!.javaClass.getMethod("dispose")

        try {
            // BEFORE Lionscope enables: external observer receives initial composition and recomposition.
            Compose19TestBridge.setContent(composition) { composer, changed -> composeRoot(composer, changed) }
            assertEquals(1, externalEnters.get())
            assertEquals(1, externalExits.get())

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(2, externalEnters.get())
            assertEquals(2, externalExits.get())

            // DURING Lionscope enabled: detects conflict, does NOT displace external observer.
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertEquals(0, tracker.attachedCompositionCount())
            assertNull(tracker.countsFor(rootScope.get()))

            tick.intValue = 2
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(3, externalEnters.get())
            assertEquals(3, externalExits.get())

            // AFTER Lionscope disables: external observer is STILL attached and receiving callbacks.
            tracker.setEnabled(false)
            assertEquals(RecompositionStatus.OFF, tracker.status)

            tick.intValue = 3
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(4, externalEnters.get())
            assertEquals(4, externalExits.get())

            // Once external observer detaches, Lionscope can enable cleanly and track counts.
            disposeHandleMethod.invoke(externalHandle)
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedCompositionCount())

            tick.intValue = 4
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(4, externalEnters.get())
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(rootScope.get()))

            composition.dispose()
        } finally {
            tracker.setEnabled(false)
            runCatching { disposeHandleMethod.invoke(externalHandle) }
            recomposer.cancel()
            job.join()
        }
    }

    fun assertConcurrentEnableToggleAndSubcompositionDoesNotDeadlock() = runBlocking {
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
                // Creating & disposing subcompositions holds parent CompositionImpl.lock and calls
                // Recomposer.composeInitial() / unregisterComposition() (acquiring Recomposer.stateLock).
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
        }, "test-compose-subcomp-composer")

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
        }, "test-compose-subcomp-toggle")

        try {
            composerThread.start()
            toggleThread.start()
            assertTrue("Worker threads failed to start", started.await(5, TimeUnit.SECONDS))

            val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (!finished.await(20, TimeUnit.MILLISECONDS)) {
                findDeadlockDump()?.let { dump ->
                    stop.set(true)
                    throw AssertionError("Deadlock detected between Compose and Lionscope tracker:\n$dump")
                }
                if (System.nanoTime() >= deadlineNanos) {
                    stop.set(true)
                    throw AssertionError("Timed out waiting for concurrent toggle + subcomposition test to finish")
                }
            }
            failure.get()?.let { throw AssertionError("Concurrent worker failed", it) }
        } finally {
            stop.set(true)
            tracker.setEnabled(false)
            activeSubs.forEach { runCatching { it.dispose() } }
            runCatching { parentComp.dispose() }
            recomposer.cancel()
            job.join()
        }
    }

    /** Calls `ManagementFactory.getThreadMXBean().findDeadlockedThreads()` via reflection (android.jar lacks java.lang.management). */
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

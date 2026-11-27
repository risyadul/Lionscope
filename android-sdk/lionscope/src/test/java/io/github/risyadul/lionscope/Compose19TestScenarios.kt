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
import java.util.concurrent.CopyOnWriteArrayList
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
            compositionLockField = access.compositionLockField,
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
            compositionLockField = access.compositionLockField,
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
            compositionLockField = access.compositionLockField,
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

        var deadlockedOrTimedOut = false
        try {
            composerThread.start()
            toggleThread.start()
            assertTrue("Worker threads failed to start", started.await(5, TimeUnit.SECONDS))

            val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (!finished.await(20, TimeUnit.MILLISECONDS)) {
                findDeadlockDump()?.let { dump ->
                    deadlockedOrTimedOut = true
                    stop.set(true)
                    throw AssertionError("Deadlock detected between Compose and Lionscope tracker:\n$dump")
                }
                if (System.nanoTime() >= deadlineNanos) {
                    deadlockedOrTimedOut = true
                    stop.set(true)
                    throw AssertionError("Timed out waiting for concurrent toggle + subcomposition test to finish")
                }
            }
            failure.get()?.let { throw AssertionError("Concurrent worker failed", it) }
        } finally {
            stop.set(true)
            // Avoid re-acquiring deadlocked Composition/Recomposer monitors on the failure path so CI fails fast
            // instead of hanging forever in cleanup.
            if (!deadlockedOrTimedOut) {
                tracker.setEnabled(false)
                activeSubs.forEach { runCatching { it.dispose() } }
                runCatching { parentComp.dispose() }
                recomposer.cancel()
                job.join()
            }
        }
    }

    /**
     * Finding #1 regression: forces gen1's deferred attach task to sit queued (and a second gen1 attach attempt to
     * race across disable + re-enable) while gen2 attaches to the same real 1.9.2 CompositionImpl.
     * Proves stale gen1 work can never clear gen2's observer slot or leave status ACTIVE with an empty slot.
     */
    fun assertDisableReenableRaceCannotLeaveActiveWithEmptyObserverSlot() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tick = mutableIntStateOf(0)
        val rootScope = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9101)
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
        Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }

        val info = recomposer.asRecomposerInfo()
        val flow = MutableStateFlow(setOf(info))
        val deferredTasks = CopyOnWriteArrayList<Runnable>()
        val deferTasks = AtomicBoolean(true)
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
            scheduleTask = { task ->
                if (deferTasks.get()) deferredTasks.add(task) else task.run()
            },
        )

        try {
            // Generation 1 enables; its attach Runnable is held before execution.
            tracker.setEnabled(true)
            val gen1Observer = tracker.observerForTest()
            assertEquals(1, deferredTasks.size)

            // Disable gen1, then immediately re-enable gen2 (running gen2's attach synchronously).
            tracker.setEnabled(false)
            deferTasks.set(false)
            tracker.setEnabled(true)
            val gen2Observer = tracker.observerForTest()
            assertTrue("Each enable generation must have a distinct observer identity", gen1Observer !== gen2Observer)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedCompositionCount())
            assertTrue(readObserverSlot(access, comp) === gen2Observer)

            // Now release stale gen1 Runnable: it must NOT overwrite or dispose gen2's slot.
            deferredTasks.forEach { it.run() }
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertTrue("Gen2 observer must still occupy slot after stale gen1 task ran", readObserverSlot(access, comp) === gen2Observer)

            // Even if a stale gen1 handle was already obtained before disable, disposing it must NEVER clear gen2's slot.
            val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
            val setObserverMethod = comp.javaClass.getMethod("setObserver", observerInterface)
            val staleGen1Handle = setObserverMethod.invoke(comp, gen1Observer)!!
            // Restore empty slot, enable gen3, then dispose staleGen1Handle.
            tracker.setEnabled(false)
            staleGen1Handle.javaClass.getMethod("dispose").invoke(staleGen1Handle)
            tracker.setEnabled(true)
            val gen3Observer = tracker.observerForTest()
            assertTrue(readObserverSlot(access, comp) === gen3Observer)
            staleGen1Handle.javaClass.getMethod("dispose").invoke(staleGen1Handle)
            assertTrue("Disposing stale gen1 handle must never clear gen3 observer", readObserverSlot(access, comp) === gen3Observer)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)

            // Also test an in-flight ATTACHING worker blocked on compLock across disable -> re-enable.
            tracker.setEnabled(false)
            val compLock = access.compositionLockField.get(comp)!!
            val workerStarted = CountDownLatch(1)
            val workerFinished = CountDownLatch(1)
            val workerRef = AtomicReference<Thread>()
            val inFlightTracker = ComposeRecomposition19(
                scopeImplClass = access.scopeImplClass,
                skippedGetter = access.skippedGetter,
                rereadingGetter = access.rereadingGetter,
                compositionImplClass = access.compositionImplClass,
                compositionLockField = access.compositionLockField,
                observerHolderField = access.observerHolderField,
                holderGetObserver = access.holderGetObserver,
                holderCurrent = access.holderCurrent,
                runningRecomposersFlow = { flow },
                scheduleTask = { task ->
                    if (workerRef.get() == null) {
                        Thread({
                            workerRef.set(Thread.currentThread())
                            workerStarted.countDown()
                            try {
                                task.run()
                            } finally {
                                workerFinished.countDown()
                            }
                        }, "test-inflight-gen1").apply { isDaemon = true }.start()
                    } else {
                        deferredTasks.add(task)
                    }
                },
            )
            deferredTasks.clear()
            synchronized(compLock) {
                inFlightTracker.setEnabled(true)
                assertTrue(workerStarted.await(5, TimeUnit.SECONDS))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (workerRef.get()?.state != Thread.State.BLOCKED && System.nanoTime() < deadline) {
                    Thread.sleep(2)
                }
                assertEquals(Thread.State.BLOCKED, workerRef.get()?.state)
                // Disable gen1 and re-enable gen2 while gen1's worker is blocked on compLock.
                inFlightTracker.setEnabled(false)
                inFlightTracker.setEnabled(true)
            }
            assertTrue(workerFinished.await(5, TimeUnit.SECONDS))
            // Run gen2's queued attach now that gen1's stale worker has exited.
            deferredTasks.forEach { it.run() }
            val inFlightGen2Observer = inFlightTracker.observerForTest()
            assertEquals(RecompositionStatus.ACTIVE, inFlightTracker.status)
            assertEquals(1, inFlightTracker.attachedCompositionCount())
            assertTrue(readObserverSlot(access, comp) === inFlightGen2Observer)

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), inFlightTracker.countsFor(rootScope.get()))
            inFlightTracker.setEnabled(false)

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Finding #2a regression: holds real CompositionImpl.lock while Lionscope's attach worker blocks on that lock,
     * installs a foreign observer atomically before releasing the lock, and proves Lionscope detects CONFLICT without
     * overwriting the foreign observer.
     */
    fun assertConcurrentForeignObserverInstallIsAtomicAndNeverOverwritten() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tick = mutableIntStateOf(0)
        val rootScope = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9201)
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
        Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }

        val externalEnters = AtomicInteger(0)
        val foreignObserver = createExternalObserver(externalEnters)
        val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
        val setObserverMethod = comp.javaClass.getMethod("setObserver", observerInterface)
        val compLock = access.compositionLockField.get(comp)!!

        val attachStarted = CountDownLatch(1)
        val attachFinished = CountDownLatch(1)
        val workerRef = AtomicReference<Thread>()
        val info = recomposer.asRecomposerInfo()
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(info)) },
            scheduleTask = { task ->
                Thread({
                    workerRef.set(Thread.currentThread())
                    attachStarted.countDown()
                    try {
                        task.run()
                    } finally {
                        attachFinished.countDown()
                    }
                }, "test-atomic-attach").apply { isDaemon = true }.start()
            },
        )

        var foreignHandle: Any? = null
        try {
            synchronized(compLock) {
                tracker.setEnabled(true)
                assertTrue("Attach worker did not start", attachStarted.await(5, TimeUnit.SECONDS))
                // Wait until attach worker blocks on compLock.
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (workerRef.get()?.state != Thread.State.BLOCKED && System.nanoTime() < deadline) {
                    Thread.sleep(2)
                }
                assertEquals(Thread.State.BLOCKED, workerRef.get()?.state)
                // Install foreign observer while holding compLock, right in the check-then-set window.
                foreignHandle = setObserverMethod.invoke(comp, foreignObserver)
            }
            assertTrue("Attach worker did not finish", attachFinished.await(5, TimeUnit.SECONDS))

            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertTrue("Foreign observer must not be overwritten", readObserverSlot(access, comp) === foreignObserver)
            assertNull(tracker.countsFor(rootScope.get()))

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals("Foreign observer must keep receiving callbacks", 1, externalEnters.get())

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            foreignHandle?.let { runCatching { it.javaClass.getMethod("dispose").invoke(it) } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Finding #2b + #6 (SDK side) regression: installs a foreign observer AFTER Lionscope is already ACTIVE,
     * proves status immediately reports CONFLICT with null counts (not ACTIVE with silent missing callbacks),
     * and proves Retry (`setEnabled(true)` again on the same tracker) recovers cleanly once the foreign observer detaches.
     */
    fun assertPostAttachForeignObserverTakeoverReportsConflictAndRetryRecovers() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tick = mutableIntStateOf(0)
        val rootScope = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9251)
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
        Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }

        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19
        val externalEnters = AtomicInteger(0)
        val foreignObserver = createExternalObserver(externalEnters)
        val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
        val setObserverMethod = comp.javaClass.getMethod("setObserver", observerInterface)
        var foreignHandle: Any? = null

        try {
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(rootScope.get()))

            // Foreign observer takes over the slot AFTER Lionscope attached.
            foreignHandle = setObserverMethod.invoke(comp, foreignObserver)!!
            assertTrue(readObserverSlot(access, comp) === foreignObserver)

            // Ownership re-verification must detect takeover immediately (never stay ACTIVE with missing callbacks).
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertNull(tracker.countsFor(rootScope.get()))
            assertEquals(0, tracker.attachedCompositionCount())

            // Retry while foreign observer is still attached remains CONFLICT without displacing it.
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertTrue(readObserverSlot(access, comp) === foreignObserver)

            // Once foreign observer detaches, Retry (`setEnabled(true)`) recovers to ACTIVE on the same tracker.
            foreignHandle.javaClass.getMethod("dispose").invoke(foreignHandle)
            foreignHandle = null
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedCompositionCount())

            tick.intValue = 2
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(rootScope.get()))

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            foreignHandle?.let { runCatching { it.javaClass.getMethod("dispose").invoke(it) } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Finding #3 regression: blocks an in-flight attach on CompositionImpl.lock, fires onCompositionUnregistered
     * while the record is ATTACHING, then releases the lock. Proves the handle is never published or retained
     * (even after rescan) and the composition's observer slot is clean.
     */
    fun assertUnregisterDuringInFlightAttachDisposesHandleAndNeverRetains() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val comp = Composition(EmptyApplier(), recomposer)
        Compose19TestBridge.setContent(comp) { c, _ ->
            val cc = c.startRestartGroup(9301)
            cc.endRestartGroup()
        }

        val compLock = access.compositionLockField.get(comp)!!
        val recomposerInfoInterface = Class.forName("androidx.compose.runtime.RecomposerInfo")
        val handleInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserverHandle")
        val observableInterface = Class.forName("androidx.compose.runtime.tooling.ObservableComposition")
        val capturedRegObserver = AtomicReference<Any?>()
        val knownComps = CopyOnWriteArrayList<Any>(listOf(comp))
        val noopHandle = Proxy.newProxyInstance(handleInterface.classLoader, arrayOf(handleInterface)) { _, _, _ -> null }
        val controlledInfo = Proxy.newProxyInstance(
            recomposerInfoInterface.classLoader,
            arrayOf(recomposerInfoInterface),
        ) { proxy, method, args ->
            when (method.name) {
                "observe" -> {
                    val regObserver = args!![0]
                    capturedRegObserver.set(regObserver)
                    val onReg = regObserver.javaClass.getMethod("onCompositionRegistered", observableInterface)
                    for (c in knownComps) onReg.invoke(regObserver, c)
                    noopHandle
                }
                "equals" -> proxy === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(proxy)
                else -> null
            }
        }

        val attachStarted = CountDownLatch(1)
        val attachFinished = CountDownLatch(1)
        val workerRef = AtomicReference<Thread>()
        @Suppress("UNCHECKED_CAST")
        val flow = MutableStateFlow(setOf(controlledInfo as androidx.compose.runtime.RecomposerInfo))
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
            scheduleTask = { task ->
                Thread({
                    workerRef.set(Thread.currentThread())
                    attachStarted.countDown()
                    try {
                        task.run()
                    } finally {
                        attachFinished.countDown()
                    }
                }, "test-unregister-inflight").apply { isDaemon = true }.start()
            },
        )

        try {
            synchronized(compLock) {
                tracker.setEnabled(true)
                assertTrue("Attach worker did not start", attachStarted.await(5, TimeUnit.SECONDS))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (workerRef.get()?.state != Thread.State.BLOCKED && System.nanoTime() < deadline) {
                    Thread.sleep(2)
                }
                assertEquals(Thread.State.BLOCKED, workerRef.get()?.state)

                // Unregister composition while its attach is in flight (blocked on compLock).
                knownComps.remove(comp)
                val regObserver = capturedRegObserver.get()!!
                regObserver.javaClass.getMethod("onCompositionUnregistered", observableInterface).invoke(regObserver, comp)
            }
            assertTrue("Attach worker did not finish", attachFinished.await(5, TimeUnit.SECONDS))

            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.trackedCompositionRecordCount())
            assertNull("Observer slot must remain empty after unregister during in-flight attach", readObserverSlot(access, comp))

            tracker.rescan()
            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.trackedCompositionRecordCount())

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Finding #4 regression: Thread A holds CompositionImpl.lock of Recomposer A's composition (busy recomposer)
     * while Recomposer B starts and composes its initial tree. Proves discovery & attachment of Recomposer B are
     * completely independent of Recomposer A's blocked attachment, so B's very first snapshot sees 1/0 (not 0/0).
     */
    fun assertBusyRecomposerNeverBlocksAnotherRecomposerInitialComposition() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clockA = ManualFrameClock()
        val recomposerA = Recomposer(coroutineContext + clockA)
        val jobA = launch(Dispatchers.Unconfined + clockA, start = CoroutineStart.UNDISPATCHED) {
            recomposerA.runRecomposeAndApplyChanges()
        }
        val compA = Composition(EmptyApplier(), recomposerA)
        Compose19TestBridge.setContent(compA) { c, _ ->
            val cc = c.startRestartGroup(9401)
            cc.endRestartGroup()
        }

        val clockB = ManualFrameClock()
        val recomposerB = Recomposer(coroutineContext + clockB)
        val jobB = launch(Dispatchers.Unconfined + clockB, start = CoroutineStart.UNDISPATCHED) {
            recomposerB.runRecomposeAndApplyChanges()
        }
        val flow = MutableStateFlow(setOf(recomposerA.asRecomposerInfo()))
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
        )

        val compALock = access.compositionLockField.get(compA)!!
        val lockHeldA = CountDownLatch(1)
        val releaseA = CountDownLatch(1)
        val blockerThread = Thread({
            synchronized(compALock) {
                lockHeldA.countDown()
                releaseA.await(10, TimeUnit.SECONDS)
            }
        }, "test-busy-recomposer-A").apply { isDaemon = true }

        val scopeB = AtomicReference<RecomposeScope>()
        val compB = Composition(EmptyApplier(), recomposerB)
        try {
            blockerThread.start()
            assertTrue("Blocker thread did not acquire compA.lock", lockHeldA.await(5, TimeUnit.SECONDS))

            // Enable tracker while compA.lock is held: must NOT hang or block discovery.
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedRecomposerCount())

            // Recomposer B appears while compA is STILL blocked.
            flow.value = setOf(recomposerA.asRecomposerInfo(), recomposerB.asRecomposerInfo())
            assertEquals(2, tracker.attachedRecomposerCount())

            // Recomposer B runs its initial composition while compA is STILL blocked.
            Compose19TestBridge.setContent(compB) { c, _ ->
                val cc = c.startRestartGroup(9402)
                scopeB.set(cc.recomposeScope!!)
                cc.endRestartGroup()
            }
            assertNotNull(scopeB.get())
            assertEquals(
                "Busy Recomposer A must never hide Recomposer B's initial composition",
                RecompositionCounts(1, 0),
                tracker.countsFor(scopeB.get()),
            )
            assertFalse(tracker.truncated)
        } finally {
            releaseA.countDown()
            blockerThread.join(5_000)
            tracker.setEnabled(false)
            runCatching { compB.dispose() }
            runCatching { compA.dispose() }
            recomposerB.cancel()
            jobB.join()
            recomposerA.cancel()
            jobA.join()
        }
    }

    /**
     * Finding #5 regression: fills capacity (cap=2) so scope B is dropped, disposes scope A so map size drops below
     * cap, then executes scope B again. Proves B stays unavailable (null) instead of gaining an exact-looking 1/0
     * partial count until reset().
     */
    fun assertDroppedScopeAfterCapExceededNeverGetsPartialCountUntilReset() = runBlocking {
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker(maxTrackedScopes = 2) as ComposeRecomposition19
        val showA = mutableIntStateOf(1)
        val tickB = mutableIntStateOf(0)
        val scopeA = AtomicReference<RecomposeScope>()
        val scopeB = AtomicReference<RecomposeScope>()

        fun composeChildA(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9501)
            scopeA.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) {
                // child A body
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeChildA(next, nextChanged) }
            }
        }

        fun composeChildB(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9502)
            scopeB.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) {
                tickB.intValue
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeChildB(next, nextChanged) }
            }
        }

        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9500)
            if (changed != 0 || !cc.skipping) {
                if (showA.intValue != 0) composeChildA(cc)
                composeChildB(cc)
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeRoot(next, nextChanged) }
            }
        }

        val comp = Composition(EmptyApplier(), recomposer)
        try {
            tracker.setEnabled(true)
            Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }
            // Root + ChildA filled cap=2; ChildB was dropped.
            assertTrue(tracker.truncated)
            assertEquals(2, tracker.trackedScopeCount())
            assertNotNull(scopeA.get())
            assertNotNull(scopeB.get())
            assertNull("Dropped scope B must be unavailable", tracker.countsFor(scopeB.get()))

            // Dispose ChildA: map size drops from 2 to 1 (below maxTrackedScopes).
            showA.intValue = 0
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(1, tracker.trackedScopeCount())
            assertTrue(tracker.truncated)

            // Recompose ChildB: must STILL remain unavailable (null), never acquiring a misleading 1/0 partial count.
            tickB.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertTrue(tracker.truncated)
            assertNull(
                "Previously dropped scope B must stay unavailable until Reset, not report partial 1/0",
                tracker.countsFor(scopeB.get()),
            )

            // After Reset, tracking resumes cleanly and ChildB counts normally.
            tracker.reset()
            assertFalse(tracker.truncated)
            tickB.intValue = 2
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopeB.get()))

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Proves that if a composition created after enable has already composed before Lionscope attaches (late replay),
     * coverage is marked incomplete (`truncated = true`) and its scopes return null rather than exact-looking 0/0 or
     * partial counts until reset().
     */
    fun assertPostEnableLateReplayedCompositionMarksCoverageIncomplete() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val flow = MutableStateFlow<Set<androidx.compose.runtime.RecomposerInfo>>(emptySet())
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
            scheduleTask = { task -> task.run() },
        )
        val tick = mutableIntStateOf(0)
        val scope = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9601)
            scope.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) {
                tick.intValue
            } else {
                cc.skipToGroupEnd()
            }
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeRoot(next, nextChanged) }
            }
        }

        try {
            tracker.setEnabled(true)
            assertFalse(tracker.truncated)

            // Composition composes BEFORE its RecomposerInfo is delivered to the tracker.
            Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }
            flow.value = setOf(recomposer.asRecomposerInfo())

            assertTrue("Late post-enable composition must mark coverage incomplete", tracker.truncated)
            assertNull("Missed initial composition must not fabricate 0/0", tracker.countsFor(scope.get()))

            // Subsequent recomposition while incomplete must also not fabricate partial 1/0.
            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertNull(tracker.countsFor(scope.get()))

            // After Reset, fresh counts start cleanly.
            tracker.reset()
            assertFalse(tracker.truncated)
            tick.intValue = 2
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scope.get()))

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    private fun readObserverSlot(access: ComposeRecompositionSupport.ProbeSuccess, composition: Any): Any? {
        val holder = access.observerHolderField.get(composition) ?: return null
        return access.holderGetObserver.invoke(holder) ?: access.holderCurrent.invoke(holder)
    }

    private fun createExternalObserver(enterCounter: AtomicInteger): Any {
        val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
        return Proxy.newProxyInstance(observerInterface.classLoader, arrayOf(observerInterface)) { proxy, method, args ->
            when (method.name) {
                "onScopeEnter" -> {
                    enterCounter.incrementAndGet()
                    null
                }
                "equals" -> proxy === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(proxy)
                "toString" -> "ExternalTestCompositionObserver"
                else -> null
            }
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

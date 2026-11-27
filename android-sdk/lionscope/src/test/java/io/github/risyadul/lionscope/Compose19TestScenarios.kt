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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import java.io.File
import java.lang.reflect.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadFactory
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

    @OptIn(androidx.compose.runtime.ExperimentalComposeRuntimeApi::class)
    @Suppress("unused")
    private class SyntheticObserverHolder {
        fun getObserver(): androidx.compose.runtime.tooling.CompositionObserver? = null
        fun current(): androidx.compose.runtime.tooling.CompositionObserver? = null
    }

    @Suppress("unused")
    private class SyntheticValidLockComposition {
        @JvmField
        val lock: Any = Any()

        @JvmField
        var observerHolder: SyntheticObserverHolder? = null
    }

    @Suppress("unused")
    private class SyntheticPrimitiveLockComposition {
        @JvmField
        var lock: Int = 0

        @JvmField
        var observerHolder: SyntheticObserverHolder? = null
    }

    @Suppress("unused")
    private class SyntheticStaticLockComposition {
        @JvmField
        var observerHolder: SyntheticObserverHolder? = null

        companion object {
            @JvmField
            val lock: Any = Any()
        }
    }

    @Suppress("unused")
    private class SyntheticRenamedLockComposition {
        @JvmField
        val otherLock: Any = Any()

        @JvmField
        var observerHolder: SyntheticObserverHolder? = null
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

    /** Round-3 #8 regression: probe must reject primitive, static, or renamed CompositionImpl.lock fields. */
    fun assertProbeRejectsPrimitiveStaticOrMissingCompositionLockField() {
        fun probeWith(candidate: Class<*>): ComposeRecompositionSupport.ProbeResult =
            ComposeRecompositionSupport.probe(
                findClass = { name ->
                    when (name) {
                        "androidx.compose.runtime.CompositionImpl" -> candidate
                        "androidx.compose.runtime.CompositionObserverHolder" -> SyntheticObserverHolder::class.java
                        else -> Class.forName(name, false, javaClass.classLoader)
                    }
                },
            )

        // Positive control: valid reference instance lock + matching observerHolder must pass probe().
        val valid = probeWith(SyntheticValidLockComposition::class.java)
        assertTrue(
            "Expected SyntheticValidLockComposition to pass probe, got $valid",
            valid is ComposeRecompositionSupport.ProbeResult.Supported,
        )

        for (candidate in listOf(
            SyntheticPrimitiveLockComposition::class.java,
            SyntheticStaticLockComposition::class.java,
        )) {
            val probe = probeWith(candidate)
            assertTrue(
                "Expected probe to reject ${candidate.simpleName}, got $probe",
                probe is ComposeRecompositionSupport.ProbeResult.Unsupported,
            )
            assertEquals(
                "Expected ${candidate.simpleName} to fail specifically on lock validation",
                "unexpected_composition_lock_type",
                (probe as ComposeRecompositionSupport.ProbeResult.Unsupported).reason,
            )
        }

        val renamed = probeWith(SyntheticRenamedLockComposition::class.java)
        assertTrue(
            "Expected probe to reject SyntheticRenamedLockComposition, got $renamed",
            renamed is ComposeRecompositionSupport.ProbeResult.Unsupported,
        )
        assertEquals(
            "missing_symbol:NoSuchFieldException",
            (renamed as ComposeRecompositionSupport.ProbeResult.Unsupported).reason,
        )
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
            scopeOwnerField = access.scopeOwnerField,
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
            scopeOwnerField = access.scopeOwnerField,
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
            scopeOwnerField = access.scopeOwnerField,
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
            awaitCondition { tracker.status == RecompositionStatus.CONFLICT }
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
            awaitCondition { tracker.attachedCompositionCount() == 1 }
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

    /**
     * Round-3 #4: Runs the concurrent toggle + subcomposition stress test in an isolated child JVM with an external
     * watchdog so a deadlock regression fails fast instead of hanging in `runBlocking` / `Recomposer.effectJob`.
     */
    fun assertConcurrentEnableToggleAndSubcompositionDoesNotDeadlock() {
        val (exitCode, output) = runDeadlockSubprocess(timeoutSeconds = 20L)
        assertEquals(
            "Concurrent toggle + subcomposition subprocess failed (exit=$exitCode):\n$output",
            0,
            exitCode,
        )
    }

    /** Proves the subprocess watchdog fails fast on a genuine deadlock without hanging CI. */
    fun assertDeadlockSubprocessWatchdogFailsFastOnGenuineDeadlock() {
        val startMs = System.nanoTime() / 1_000_000L
        val (exitCode, output) = runDeadlockSubprocess(timeoutSeconds = 10L, extraArgs = listOf("--simulate-deadlock"))
        val elapsedMs = System.nanoTime() / 1_000_000L - startMs
        assertNotEquals("Expected simulated deadlock subprocess to exit non-zero", 0, exitCode)
        assertTrue("Expected deadlock dump in subprocess output, got:\n$output", output.contains("Simulated deadlock detected"))
        assertTrue("Expected fast failure (< 8s), took ${elapsedMs}ms", elapsedMs < 8_000L)
    }

    /**
     * Round-3 #1 regression (`Gap42`): 4 pre-existing compositions are actively composing (holding their locks)
     * while a 5th idle pre-existing composition exists. Proves:
     * - `setEnabled(true)` does NOT sleep 100ms on the enabling thread.
     * - The 5th idle composition attaches serially right after `observe()` returns and counts `1/0` (both with and
     *   without `reset()` while the 4 busy ones are still pending!).
     * - The 4 busy compositions report unavailable (`null`, NEVER `0/0`) and `incompleteCoverage == true`, `truncated == false`.
     */
    fun assertBusyReplaysDoNotDelayIdleReplayOrFabricateZeroCounts() = runBlocking {
        for (doReset in listOf(false, true)) {
            val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
            val access = probe.access
            val clock = ManualFrameClock()
            val recomposer = Recomposer(coroutineContext + clock)
            val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
                recomposer.runRecomposeAndApplyChanges()
            }
            val busyComps = List(4) {
                Composition(EmptyApplier(), recomposer).also { c ->
                    Compose19TestBridge.setContent(c) { composer, _ ->
                        val cc = composer.startRestartGroup(9700 + it)
                        cc.endRestartGroup()
                    }
                }
            }
            val busyScope = AtomicReference<RecomposeScope>()
            val fifthComp = Composition(EmptyApplier(), recomposer).also { c ->
                Compose19TestBridge.setContent(c) { composer, _ ->
                    val cc = composer.startRestartGroup(9750)
                    cc.endRestartGroup()
                }
            }

            val busyEntered = CountDownLatch(4)
            val releaseBusy = CountDownLatch(1)
            val busyThreads = busyComps.mapIndexed { idx, comp ->
                Thread({
                    Compose19TestBridge.setContent(comp) { composer, _ ->
                        val cc = composer.startRestartGroup(9710 + idx)
                        if (idx == 0) busyScope.set(cc.recomposeScope!!)
                        busyEntered.countDown()
                        releaseBusy.await(10, TimeUnit.SECONDS)
                        cc.endRestartGroup()
                    }
                }, "test-gap42-busy-$idx").apply {
                    isDaemon = true
                    start()
                }
            }

            val tracker = ComposeRecomposition19(
                scopeImplClass = access.scopeImplClass,
                skippedGetter = access.skippedGetter,
                rereadingGetter = access.rereadingGetter,
                scopeOwnerField = access.scopeOwnerField,
                compositionImplClass = access.compositionImplClass,
                compositionLockField = access.compositionLockField,
                observerHolderField = access.observerHolderField,
                holderGetObserver = access.holderGetObserver,
                holderCurrent = access.holderCurrent,
                runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
            )
            try {
                assertTrue("Busy compositions did not enter setContent", busyEntered.await(5, TimeUnit.SECONDS))

                val startNs = System.nanoTime()
                tracker.setEnabled(true)
                val enableMs = (System.nanoTime() - startNs) / 1_000_000L

                assertEquals(RecompositionStatus.ACTIVE, tracker.status)
                assertTrue("setEnabled must return immediately without waiting on replays (took ${enableMs}ms)", enableMs < 80L)
                assertTrue("Pending replayed compositions must mark incompleteCoverage", tracker.incompleteCoverage)
                assertFalse("Incomplete coverage must not masquerade as capacity truncated", tracker.truncated)

                // Busy pending composition must report unavailable (null), NEVER 0/0.
                assertNotNull(busyScope.get())
                assertNull("Pending busy composition must never report 0/0", tracker.countsFor(busyScope.get()))

                if (doReset) tracker.reset()

                val fifthScope = AtomicReference<RecomposeScope>()
                Compose19TestBridge.setContent(fifthComp) { composer, _ ->
                    val cc = composer.startRestartGroup(9751)
                    fifthScope.set(cc.recomposeScope!!)
                    cc.endRestartGroup()
                }
                // While queued behind busy compositions, fifth is NOT attached yet so it must report unavailable (null),
                // NEVER false exact 0/0 (Gap42 invariant).
                assertNull(
                    "Pending 5th composition must report unavailable (null), never false 0/0 (doReset=$doReset)",
                    tracker.countsFor(fifthScope.get()),
                )
                assertNull("Busy composition remains unavailable even after reset while pending", tracker.countsFor(busyScope.get()))

                releaseBusy.countDown()
                busyThreads.forEach { it.join(5_000) }
                awaitCondition { tracker.attachedCompositionCount() == 5 }
                assertEquals(5, tracker.attachedCompositionCount())

                if (doReset) {
                    // Explicit reset ran while pending, so compositions stayed incomplete until post-attach reset.
                    assertTrue(tracker.incompleteCoverage)
                    tracker.reset()
                }
                // Once attached + baselined (or reset), all 5 have exact coverage and count subsequent passes accurately.
                assertFalse("All 5 attached compositions should have exact coverage", tracker.incompleteCoverage)
                assertEquals(RecompositionCounts(0, 0), tracker.countsFor(busyScope.get()))
                assertEquals(RecompositionCounts(0, 0), tracker.countsFor(fifthScope.get()))

                Compose19TestBridge.setContent(fifthComp) { composer, _ ->
                    val cc = composer.startRestartGroup(9751)
                    fifthScope.set(cc.recomposeScope!!)
                    cc.endRestartGroup()
                }
                assertEquals(RecompositionCounts(1, 0), tracker.countsFor(fifthScope.get()))
            } finally {
                releaseBusy.countDown()
                busyThreads.forEach { it.join(5_000) }
                tracker.setEnabled(false)
                busyComps.forEach { runCatching { it.dispose() } }
                runCatching { fifthComp.dispose() }
                recomposer.cancel()
                job.join()
            }
        }
    }

    /**
     * Round-3 #2 regression: discovering pre-enable Recomposer A marks ONLY A's composition incomplete (no global
     * freeze, `truncated == false`, `incompleteCoverage == true`), while sibling Recomposer B composes and counts
     * exact `1/0`.
     */
    fun assertPostEnableIncompleteCompositionDoesNotFreezeSiblingExactCounts() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clockA = ManualFrameClock()
        val recomposerA = Recomposer(coroutineContext + clockA)
        val jobA = launch(Dispatchers.Unconfined + clockA, start = CoroutineStart.UNDISPATCHED) {
            recomposerA.runRecomposeAndApplyChanges()
        }
        val clockB = ManualFrameClock()
        val recomposerB = Recomposer(coroutineContext + clockB)
        val jobB = launch(Dispatchers.Unconfined + clockB, start = CoroutineStart.UNDISPATCHED) {
            recomposerB.runRecomposeAndApplyChanges()
        }
        val flow = MutableStateFlow<Set<androidx.compose.runtime.RecomposerInfo>>(emptySet())
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
        )

        val tickA = mutableIntStateOf(0)
        val scopeA = AtomicReference<RecomposeScope>()
        val compA = Composition(EmptyApplier(), recomposerA)
        fun composeA(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9801)
            scopeA.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tickA.intValue else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeA(next, nextChanged) }
            }
        }

        val tickB = mutableIntStateOf(0)
        val scopeB = AtomicReference<RecomposeScope>()
        val compB = Composition(EmptyApplier(), recomposerB)
        fun composeB(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9802)
            scopeB.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tickB.intValue else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeB(next, nextChanged) }
            }
        }

        try {
            // Pre-enable composition A composes before tracker discovers Recomposer A.
            Compose19TestBridge.setContent(compA) { c, ch -> composeA(c, ch) }
            tracker.setEnabled(true)

            // Discovering A post-enable marks A incomplete, NOT capacity truncated.
            flow.value = setOf(recomposerA.asRecomposerInfo())
            assertTrue(tracker.incompleteCoverage)
            assertFalse("Incomplete coverage must not set capacity truncated", tracker.truncated)
            assertNull("Incomplete composition A must report null", tracker.countsFor(scopeA.get()))

            // Now sibling Recomposer B appears and composes: B must NOT be frozen by A!
            flow.value = setOf(recomposerA.asRecomposerInfo(), recomposerB.asRecomposerInfo())
            Compose19TestBridge.setContent(compB) { c, ch -> composeB(c, ch) }
            assertEquals(
                "Sibling composition B must record exact counts even while A has incomplete coverage",
                RecompositionCounts(1, 0),
                tracker.countsFor(scopeB.get()),
            )
            assertNull("Composition A remains unavailable until reset", tracker.countsFor(scopeA.get()))

            // Recompose both: B advances to 2/0, A still unavailable until reset.
            tickA.intValue = 1
            tickB.intValue = 1
            Snapshot.sendApplyNotifications()
            clockA.advanceFrame()
            clockB.advanceFrame()
            assertEquals(RecompositionCounts(2, 0), tracker.countsFor(scopeB.get()))
            assertNull(tracker.countsFor(scopeA.get()))

            // Reset establishes exact baseline for both attached compositions.
            tracker.reset()
            assertFalse(tracker.incompleteCoverage)
            assertFalse(tracker.truncated)
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopeA.get()))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopeB.get()))

            tickA.intValue = 2
            tickB.intValue = 2
            Snapshot.sendApplyNotifications()
            clockA.advanceFrame()
            clockB.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopeA.get()))
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopeB.get()))
        } finally {
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
     * Round-3 #3 regression (`LivePool42`): disabling after a child subcomposition inherited its parent's Lionscope
     * observer (before the child's queued handle upgrade ran) leaves a cached retired-generation reference in the
     * child's `CompositionObserverHolder`. Subsequent enables must recognize it as ours and succeed as ACTIVE
     * (never persistent false CONFLICT), while still preserving genuine foreign observers as CONFLICT.
     */
    fun assertInheritedObserverFromRetiredGenerationNeverCausesFalseConflict() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val busyComps = List(4) {
            Composition(EmptyApplier(), recomposer).also { c ->
                Compose19TestBridge.setContent(c) { composer, _ ->
                    val cc = composer.startRestartGroup(9850 + it)
                    cc.endRestartGroup()
                }
            }
        }
        val held = CountDownLatch(4)
        val release = CountDownLatch(1)
        val busyThreads = busyComps.mapIndexed { idx, comp ->
            Thread({
                Compose19TestBridge.setContent(comp) { composer, _ ->
                    val cc = composer.startRestartGroup(9860 + idx)
                    held.countDown()
                    release.await(10, TimeUnit.SECONDS)
                    cc.endRestartGroup()
                }
            }, "test-livepool-busy-$idx").apply {
                isDaemon = true
                start()
            }
        }

        val parent = Composition(EmptyApplier(), recomposer)
        val childRef = AtomicReference<Composition>()
        var foreignHandle: Any? = null
        try {
            assertTrue(held.await(5, TimeUnit.SECONDS))
            tracker.setEnabled(true)

            Compose19TestBridge.setContent(parent) { c, _ ->
                val cc = c.startRestartGroup(9870)
                val sub = Composition(EmptyApplier(), cc.buildContext())
                Compose19TestBridge.setContent(sub) { sc, _ ->
                    val scc = sc.startRestartGroup(9871)
                    scc.endRestartGroup()
                }
                childRef.set(sub)
                cc.endRestartGroup()
            }
            val child = childRef.get()!!
            // Child inherited gen1 observer and cached it in its holder before its queued attach could run.
            assertNotNull(readRawObserverField(access, child))

            // Disable BEFORE child's queued attach runs: parent is cleared, child keeps cached retired gen1 observer!
            tracker.setEnabled(false)
            assertNull(readRawObserverField(access, parent))
            assertNotNull("Expected child to retain cached retired observer right after disable", readRawObserverField(access, child))

            release.countDown()
            busyThreads.forEach { it.join(5_000) }

            // Two subsequent enables must BOTH succeed as ACTIVE with all 6 compositions attached (never CONFLICT).
            repeat(2) { attempt ->
                tracker.setEnabled(true)
                awaitCondition { tracker.attachedCompositionCount() == 6 }
                assertEquals("Enable attempt ${attempt + 1} must be ACTIVE", RecompositionStatus.ACTIVE, tracker.status)
                assertEquals("Enable attempt ${attempt + 1} must attach all 6 compositions", 6, tracker.attachedCompositionCount())
                tracker.setEnabled(false)
            }

            // Genuine foreign root observer must STILL be preserved and reported as CONFLICT.
            val foreignEnters = AtomicInteger(0)
            val foreignObserver = createExternalObserver(foreignEnters)
            val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
            foreignHandle = parent.javaClass.getMethod("setObserver", observerInterface).invoke(parent, foreignObserver)
            tracker.setEnabled(true)
            awaitCondition { tracker.status == RecompositionStatus.CONFLICT }
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertTrue("Foreign observer must remain untouched", readEffectiveObserverSlot(access, parent) === foreignObserver)
        } finally {
            release.countDown()
            busyThreads.forEach { it.join(5_000) }
            tracker.setEnabled(false)
            foreignHandle?.let { runCatching { it.javaClass.getMethod("dispose").invoke(it) } }
            runCatching { childRef.get()?.dispose() }
            runCatching { parent.dispose() }
            busyComps.forEach { runCatching { it.dispose() } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-3 #6 regression (`Queue42`): verifies queued deferred tasks for an ended generation are purged immediately
     * on `setEnabled(false)` and the single deferred worker thread retires cleanly once idle.
     */
    fun assertDeferredExecutorPurgesEndedGenerationAndRetiresIdleThread() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val busyComps = List(4) {
            Composition(EmptyApplier(), recomposer).also { c ->
                Compose19TestBridge.setContent(c) { composer, _ ->
                    val cc = composer.startRestartGroup(9900 + it)
                    cc.endRestartGroup()
                }
            }
        }
        val entered = CountDownLatch(4)
        val release = CountDownLatch(1)
        val threads = busyComps.mapIndexed { idx, comp ->
            Thread({
                Compose19TestBridge.setContent(comp) { composer, _ ->
                    val cc = composer.startRestartGroup(9910 + idx)
                    entered.countDown()
                    release.await(10, TimeUnit.SECONDS)
                    cc.endRestartGroup()
                }
            }, "test-queue42-$idx").apply {
                isDaemon = true
                start()
            }
        }

        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            tracker.setEnabled(true)
            // 1 task is running on the serial worker (blocked on busyComps[0]), 3 remain queued.
            awaitCondition { tracker.deferredPendingCount() <= 3 && tracker.deferredPoolSize() == 1 }
            assertEquals("Serial executor must never spawn more than 1 worker", 1, tracker.deferredPoolSize())

            // Ending the generation must purge all queued obsolete tasks immediately.
            tracker.setEnabled(false)
            assertEquals("Queued tasks for ended generation must be purged immediately", 0, tracker.deferredPendingCount())

            // Once the running task unblocks and idles past keep-alive (100ms), the worker thread must retire.
            release.countDown()
            threads.forEach { it.join(5_000) }
            awaitCondition(timeoutMs = 3_000L) { tracker.deferredPoolSize() == 0 }
            assertEquals("Idle deferred worker must retire", 0, tracker.deferredPoolSize())
        } finally {
            release.countDown()
            threads.forEach { it.join(5_000) }
            tracker.setEnabled(false)
            busyComps.forEach { runCatching { it.dispose() } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-3 #7 regression (`Bench42`): verifies `countsFor` does not scan all 128 attached compositions per lookup
     * (neither inside `beginCapture()` nor on standalone lookups), while takeover is still caught on `beginCapture()`,
     * `status`, and standalone `countsFor(realScope)`.
     */
    fun assertCountsForDoesNotScanAllCompositionsPerLookup() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val scopes = ArrayList<RecomposeScope>(128)
        val comps = List(128) { idx ->
            Composition(EmptyApplier(), recomposer).also { c ->
                Compose19TestBridge.setContent(c) { composer, _ ->
                    val cc = composer.startRestartGroup(10_000 + idx)
                    scopes.add(cc.recomposeScope!!)
                    cc.endRestartGroup()
                }
            }
        }
        var foreignHandle: Any? = null
        try {
            tracker.setEnabled(true)
            awaitCondition { tracker.attachedCompositionCount() == 128 }
            assertEquals(128, tracker.attachedCompositionCount())
            assertFalse(tracker.incompleteCoverage)

            // Inside a capture window: beginCapture verifies the 128 compositions ONCE, and 2,000 countsFor lookups
            // perform ZERO additional ownership scans (never O(nodes * compositions)).
            val sampleObj = Any()
            val checksBeforeCapture = tracker.ownershipCheckCountForTest()
            tracker.beginCapture()
            try {
                val checksAfterBegin = tracker.ownershipCheckCountForTest()
                assertEquals(
                    "beginCapture must verify each of the 128 attached compositions once",
                    128L,
                    checksAfterBegin - checksBeforeCapture,
                )
                repeat(200) { tracker.countsFor(scopes[it % scopes.size]) }
                val startNs = System.nanoTime()
                repeat(2_000) { i ->
                    assertEquals(RecompositionCounts.ZERO, tracker.countsFor(scopes[i % scopes.size]))
                    assertEquals(RecompositionCounts.ZERO, tracker.countsFor(sampleObj))
                }
                val elapsedMs = (System.nanoTime() - startNs) / 1_000_000L
                val checksDuringLookups = tracker.ownershipCheckCountForTest() - checksAfterBegin
                assertEquals("countsFor inside beginCapture must do zero per-node ownership checks", 0L, checksDuringLookups)
                assertTrue("Expected O(1) countsFor across 128 compositions (< 500ms), took ${elapsedMs}ms", elapsedMs < 500L)
            } finally {
                tracker.endCapture()
            }

            // Outside a capture window: each standalone countsFor checks ONLY its single owning composition (O(1)).
            val checksBeforeStandalone = tracker.ownershipCheckCountForTest()
            repeat(64) { i ->
                assertEquals(RecompositionCounts.ZERO, tracker.countsFor(scopes[i]))
            }
            val standaloneChecks = tracker.ownershipCheckCountForTest() - checksBeforeStandalone
            assertEquals(
                "Standalone countsFor must check only 1 owning composition per lookup (not all 128)",
                64L,
                standaloneChecks,
            )

            // Takeover on one of the 128 compositions is still caught immediately by standalone countsFor(realScope).
            val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
            val foreign = createExternalObserver(AtomicInteger(0))
            foreignHandle = comps[64].javaClass.getMethod("setObserver", observerInterface).invoke(comps[64], foreign)
            assertNull(tracker.countsFor(scopes[64]))
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
        } finally {
            tracker.setEnabled(false)
            foreignHandle?.let { runCatching { it.javaClass.getMethod("dispose").invoke(it) } }
            comps.forEach { runCatching { it.dispose() } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-2 #1 regression: forces gen1's deferred attach task to sit queued (and a blocked serial attach attempt to
     * race across disable + re-enable) while gen2 attaches to the same real 1.9.2 CompositionImpl.
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
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
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
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
            customScheduler = { task ->
                if (deferTasks.get()) deferredTasks.add(task) else task.run()
            },
        )

        try {
            // Generation 1 enables; its attach Runnable is held before execution.
            tracker.setEnabled(true)
            val gen1Observer = tracker.observerForTest()
            assertEquals(1, deferredTasks.size)

            // Disable gen1, then immediately re-enable gen2.
            tracker.setEnabled(false)
            deferTasks.set(false)
            tracker.setEnabled(true)
            val gen2Observer = tracker.observerForTest()
            assertTrue("Each enable generation must have a distinct observer identity", gen1Observer !== gen2Observer)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedCompositionCount())
            assertTrue(readEffectiveObserverSlot(access, comp) === gen2Observer)

            // Release stale gen1 Runnable: must NOT overwrite or dispose gen2's slot.
            deferredTasks.forEach { it.run() }
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertTrue(readEffectiveObserverSlot(access, comp) === gen2Observer)

            // Even if a stale gen1 handle was already obtained before disable, disposing it must NEVER clear gen3's slot.
            val observerInterface = Class.forName("androidx.compose.runtime.tooling.CompositionObserver")
            val setObserverMethod = comp.javaClass.getMethod("setObserver", observerInterface)
            val staleGen1Handle = setObserverMethod.invoke(comp, gen1Observer)!!
            tracker.setEnabled(false)
            staleGen1Handle.javaClass.getMethod("dispose").invoke(staleGen1Handle)
            tracker.setEnabled(true)
            val gen3Observer = tracker.observerForTest()
            assertTrue(readEffectiveObserverSlot(access, comp) === gen3Observer)
            staleGen1Handle.javaClass.getMethod("dispose").invoke(staleGen1Handle)
            assertTrue(readEffectiveObserverSlot(access, comp) === gen3Observer)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)

            // Also test an in-flight worker attach blocked on compLock across disable -> re-enable (production path).
            tracker.setEnabled(false)
            val compLock = access.compositionLockField.get(comp)!!
            val realTracker = ComposeRecomposition19(
                scopeImplClass = access.scopeImplClass,
                skippedGetter = access.skippedGetter,
                rereadingGetter = access.rereadingGetter,
                scopeOwnerField = access.scopeOwnerField,
                compositionImplClass = access.compositionImplClass,
                compositionLockField = access.compositionLockField,
                observerHolderField = access.observerHolderField,
                holderGetObserver = access.holderGetObserver,
                holderCurrent = access.holderCurrent,
                runningRecomposersFlow = { flow },
            )
            synchronized(compLock) {
                realTracker.setEnabled(true)
                awaitAnyWorkerBlockedInAttach()
                realTracker.setEnabled(false)
            }
            awaitCondition { realTracker.deferredPendingCount() == 0 && readEffectiveObserverSlot(access, comp) == null }
            assertEquals(RecompositionStatus.OFF, realTracker.status)
            assertNull(readEffectiveObserverSlot(access, comp))

            realTracker.setEnabled(true)
            awaitCondition { realTracker.attachedCompositionCount() == 1 }
            val realGen2Observer = realTracker.observerForTest()
            assertEquals(RecompositionStatus.ACTIVE, realTracker.status)
            assertEquals(1, realTracker.attachedCompositionCount())
            assertTrue(readEffectiveObserverSlot(access, comp) === realGen2Observer)

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), realTracker.countsFor(rootScope.get()))
            realTracker.setEnabled(false)

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-2 #2a + Round-3 #5 regression: uses the real production serial-attach path (no custom scheduler hook)
     * while main thread holds `CompositionImpl.lock`, waits for the enabling thread to block on `compLock`, installs
     * a foreign observer atomically before releasing the lock, and proves CONFLICT with foreign observer preserved.
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
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
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

        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        var foreignHandle: Any? = null
        try {
            synchronized(compLock) {
                tracker.setEnabled(true)
                awaitAnyWorkerBlockedInAttach()
                foreignHandle = setObserverMethod.invoke(comp, foreignObserver)
            }
            awaitCondition { tracker.status == RecompositionStatus.CONFLICT }

            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertTrue("Foreign observer must not be overwritten", readEffectiveObserverSlot(access, comp) === foreignObserver)
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

    /** Round-2 #2b + #6 (SDK side) regression: post-attach takeover reports CONFLICT and Retry recovers. */
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
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
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
            awaitCondition { tracker.attachedCompositionCount() == 1 }
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(rootScope.get()))

            foreignHandle = setObserverMethod.invoke(comp, foreignObserver)!!
            assertTrue(readEffectiveObserverSlot(access, comp) === foreignObserver)

            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertNull(tracker.countsFor(rootScope.get()))
            assertEquals(0, tracker.attachedCompositionCount())

            // Retry while foreign observer is still attached remains CONFLICT without displacing it.
            tracker.setEnabled(true)
            awaitCondition { tracker.status == RecompositionStatus.CONFLICT }
            assertEquals(RecompositionStatus.CONFLICT, tracker.status)
            assertTrue(readEffectiveObserverSlot(access, comp) === foreignObserver)

            // Once foreign observer detaches, Retry (`setEnabled(true)`) recovers to ACTIVE on the same tracker.
            foreignHandle.javaClass.getMethod("dispose").invoke(foreignHandle)
            foreignHandle = null
            tracker.setEnabled(true)
            awaitCondition { tracker.attachedCompositionCount() == 1 }
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
     * Round-2 #3 + Round-3 #5 regression: holds real `CompositionImpl.lock` while the real enabling thread blocks on
     * `compLock`, disposes the composition (firing real `onCompositionUnregistered`), then releases the lock.
     * Proves the handle is never published or retained even after `rescan()`.
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
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        try {
            synchronized(compLock) {
                tracker.setEnabled(true)
                awaitAnyWorkerBlockedInAttach()
                // Dispose composition while worker is blocked on compLock (reentrant on this thread, fires real unregister).
                comp.dispose()
            }
            awaitCondition { tracker.deferredPendingCount() == 0 && tracker.trackedCompositionRecordCount() == 0 }
            // Give the unblocked worker a moment to finish checking stillAttaching and exit.
            awaitCondition { !anyWorkerBlockedInAttach() }

            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.trackedCompositionRecordCount())
            assertNull("Observer slot must remain empty after unregister during in-flight attach", readEffectiveObserverSlot(access, comp))

            tracker.rescan()
            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.trackedCompositionRecordCount())
        } finally {
            tracker.setEnabled(false)
            runCatching { comp.dispose() }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-2 #4 + Round-3 #5 regression: keeps Recomposer A's composition actively composing (holding `compA.lock`)
     * with NO short timeout until AFTER Recomposer B asserts its first snapshot count `1/0`, enforced by an external
     * 5-second watchdog deadline so a blocking implementation fails fast instead of timing out `compA`.
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
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
        )

        val lockHeldA = CountDownLatch(1)
        val releaseA = CountDownLatch(1)
        val blockerThread = Thread({
            Compose19TestBridge.setContent(compA) { c, _ ->
                val cc = c.startRestartGroup(9403)
                lockHeldA.countDown()
                // Hold compA actively composing until main test explicitly releases AFTER asserting B's first count.
                releaseA.await()
                cc.endRestartGroup()
            }
        }, "test-busy-recomposer-A").apply { isDaemon = true }

        val scopeB = AtomicReference<RecomposeScope>()
        val compB = Composition(EmptyApplier(), recomposerB)
        try {
            blockerThread.start()
            assertTrue("Blocker thread did not enter compA composition", lockHeldA.await(5, TimeUnit.SECONDS))

            val done = CountDownLatch(1)
            val err = AtomicReference<Throwable?>()
            val runner = Thread({
                try {
                    tracker.setEnabled(true)
                    assertEquals(RecompositionStatus.ACTIVE, tracker.status)
                    assertEquals(1, tracker.attachedRecomposerCount())

                    // Recomposer B appears while compA is STILL actively composing.
                    flow.value = setOf(recomposerA.asRecomposerInfo(), recomposerB.asRecomposerInfo())
                    assertEquals(2, tracker.attachedRecomposerCount())

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
                    // Prove compA was STILL held when B asserted its first count!
                    assertEquals("compA must still be blocked when B asserts 1/0", 1L, releaseA.count)
                    assertTrue(blockerThread.isAlive)
                    assertFalse("Sibling B must not appear capacity-truncated", tracker.truncated)
                } catch (t: Throwable) {
                    err.set(t)
                } finally {
                    done.countDown()
                }
            }, "test-busy-recomposer-watchdog-runner").apply { isDaemon = true }

            runner.start()
            val finishedInTime = done.await(5, TimeUnit.SECONDS)
            if (!finishedInTime) {
                throw AssertionError("Busy Recomposer A blocked Recomposer B past 5s external deadline")
            }
            err.get()?.let { throw it }
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
     * Round-2 #5 regression: fills capacity (cap=2) so scope B is dropped, disposes scope A so map size drops below
     * cap, then executes scope B again. Proves B stays unavailable (null) until reset().
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
            if (changed != 0 || !cc.skipping) Unit else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeChildA(next, nextChanged) }
            }
        }

        fun composeChildB(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9502)
            scopeB.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tickB.intValue else cc.skipToGroupEnd()
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
            assertTrue(tracker.truncated)
            assertEquals(2, tracker.trackedScopeCount())
            assertNotNull(scopeA.get())
            assertNotNull(scopeB.get())
            assertNull("Dropped scope B must be unavailable", tracker.countsFor(scopeB.get()))

            showA.intValue = 0
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(1, tracker.trackedScopeCount())
            assertTrue(tracker.truncated)

            tickB.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertTrue(tracker.truncated)
            assertNull(
                "Previously dropped scope B must stay unavailable until Reset, not report partial 1/0",
                tracker.countsFor(scopeB.get()),
            )

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
     * coverage is marked incomplete (`incompleteCoverage == true`, `truncated == false`) and its scopes return null
     * rather than exact-looking 0/0 or partial counts until reset().
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
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
        )
        val tick = mutableIntStateOf(0)
        val scope = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(9601)
            scope.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeRoot(next, nextChanged) }
            }
        }

        try {
            tracker.setEnabled(true)
            assertFalse(tracker.incompleteCoverage)
            assertFalse(tracker.truncated)

            Compose19TestBridge.setContent(comp) { c, ch -> composeRoot(c, ch) }
            flow.value = setOf(recomposer.asRecomposerInfo())

            assertTrue("Late post-enable composition must mark coverage incomplete", tracker.incompleteCoverage)
            assertFalse("Incomplete coverage must not masquerade as capacity truncated", tracker.truncated)
            assertNull("Missed initial composition must not fabricate 0/0", tracker.countsFor(scope.get()))

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertNull(tracker.countsFor(scope.get()))

            tracker.reset()
            assertFalse(tracker.incompleteCoverage)
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

    private fun runDeadlockSubprocess(
        timeoutSeconds: Long,
        extraArgs: List<String> = emptyList(),
    ): Pair<Int, String> {
        val javaBin = File(System.getProperty("java.home"), "bin/java").absolutePath
        val classpath = checkNotNull(System.getProperty("java.class.path")) { "java.class.path is not set" }
        val cmd = ArrayList<String>().apply {
            add(javaBin)
            add("-cp")
            add(classpath)
            add(Compose19DeadlockSubprocessRunner::class.java.name)
            addAll(extraArgs)
        }
        val process = ProcessBuilder(cmd).redirectErrorStream(true).start()
        val output = StringBuilder()
        val reader = Thread({
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { output.appendLine(it) }
            }
        }, "test-deadlock-subprocess-reader").apply {
            isDaemon = true
            start()
        }
        val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            process.waitFor(5, TimeUnit.SECONDS)
            reader.join(1_000)
            return -1 to "Subprocess timed out after ${timeoutSeconds}s:\n$output"
        }
        reader.join(2_000)
        return process.exitValue() to output.toString()
    }

    /**
     * Round-4 #1 regression (`Sample42`): holds `CompositionImpl.lock` while `isComposing == false` so replay attach
     * waits on the background serial worker, executes `target.setContent` BEFORE slot claim, proves:
     * - `setEnabled(true)` returns immediately on the calling thread (never blocks on `target.lock`).
     * - Counts during the pre-claim execution are unavailable (`null`, `incompleteCoverage == true`), NEVER `0/0`.
     * - Once `target.lock` is released and the worker attaches + takes its implicit per-composition baseline, coverage
     *   becomes exact (`incompleteCoverage == false`, `0/0` since attach baseline) and the next pass counts `1/0`.
     */
    fun assertSample42ExecutionBetweenCheckAndClaimIsUnavailableThenBaselinedAtAttach() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tick = mutableIntStateOf(0)
        val scope = AtomicReference<RecomposeScope>()
        val target = Composition(EmptyApplier(), recomposer)
        fun composeTarget(c: Composer, changed: Int = 0) {
            val cc = c.startRestartGroup(10_401)
            scope.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeTarget(next, nextChanged) }
            }
        }
        Compose19TestBridge.setContent(target) { c, ch -> composeTarget(c, ch) }

        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val compLock = access.compositionLockField.get(target)!!
        try {
            val done = CountDownLatch(1)
            val err = AtomicReference<Throwable?>()
            val driver = Thread({
                try {
                    synchronized(compLock) {
                        val startNs = System.nanoTime()
                        // Must NOT block on compLock (fails on 2e080d1 where setEnabled blocks on compLock).
                        tracker.setEnabled(true)
                        val enableMs = (System.nanoTime() - startNs) / 1_000_000L
                        assertTrue("setEnabled must return promptly while compLock is held (took ${enableMs}ms)", enableMs < 100L)
                        assertEquals(RecompositionStatus.ACTIVE, tracker.status)
                        assertTrue("Replayed composition must start INCOMPLETE before claim", tracker.incompleteCoverage)

                        awaitAnyWorkerBlockedInAttach()
                        // Execute target BEFORE slot claim while worker is blocked on compLock.
                        Compose19TestBridge.setContent(target) { c, ch -> composeTarget(c, ch) }
                        assertNull("Execution before attach must report unavailable (null), never 0/0", tracker.countsFor(scope.get()))
                        assertTrue(tracker.incompleteCoverage)
                    }
                    // Release compLock: worker attaches and performs implicit per-composition baseline at attach time.
                    awaitCondition { tracker.attachedCompositionCount() == 1 && !tracker.incompleteCoverage }
                    assertEquals(1, tracker.attachedCompositionCount())
                    assertFalse("Implicit per-composition baseline at attach clears incompleteCoverage", tracker.incompleteCoverage)
                    assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scope.get()))

                    // Subsequent recomposition after attach-time baseline counts exact 1/0.
                    tick.intValue = 1
                    Snapshot.sendApplyNotifications()
                    clock.advanceFrame()
                    assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scope.get()))
                } catch (t: Throwable) {
                    err.set(t)
                } finally {
                    done.countDown()
                }
            }, "test-sample42").apply { isDaemon = true }
            driver.start()
            assertTrue("Sample42 scenario timed out (likely blocked on compLock in setEnabled)", done.await(5, TimeUnit.SECONDS))
            err.get()?.let { throw it }
        } finally {
            tracker.setEnabled(false)
            runCatching { target.dispose() }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-4 #2 regression (`Apply42`): a background `SideEffect` holds `CompositionImpl.lock` during `applyChanges`
     * (where `isComposing == false`). Proves:
     * (a) Enable path: `setEnabled(true)` returns promptly on the calling thread (< 100 ms, never blocked for 500+ ms).
     * (b) Discovery/flow path: emitting Recomposer A into `runningRecomposers` returns promptly (< 100 ms) so sibling
     *     Recomposer B is discovered immediately and B's first composition counts `RecompositionCounts(1, 0)`.
     */
    fun assertBackgroundSideEffectApplyNeverBlocksEnableOrDiscoveryAndSiblingCountsFirstPass() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access

        for (flowMode in listOf(false, true)) {
            val clockA = ManualFrameClock()
            val recomposerA = Recomposer(coroutineContext + clockA)
            val jobA = launch(Dispatchers.Unconfined + clockA, start = CoroutineStart.UNDISPATCHED) {
                recomposerA.runRecomposeAndApplyChanges()
            }
            val clockB = ManualFrameClock()
            val recomposerB = Recomposer(coroutineContext + clockB)
            val jobB = launch(Dispatchers.Unconfined + clockB, start = CoroutineStart.UNDISPATCHED) {
                recomposerB.runRecomposeAndApplyChanges()
            }

            val compA = Composition(EmptyApplier(), recomposerA)
            Compose19TestBridge.setContent(compA) { c, _ ->
                val cc = c.startRestartGroup(10_500)
                cc.endRestartGroup()
            }

            val sideEffectEntered = CountDownLatch(1)
            val releaseSideEffect = CountDownLatch(1)
            val bgApplyThread = Thread({
                Compose19TestBridge.setContent(compA) { c, _ ->
                    val cc = c.startRestartGroup(10_501)
                    cc.recordSideEffect {
                        sideEffectEntered.countDown()
                        releaseSideEffect.await(10, TimeUnit.SECONDS)
                    }
                    cc.endRestartGroup()
                }
            }, "test-apply42-side-effect-$flowMode").apply { isDaemon = true }

            val initialSet = if (flowMode) emptySet() else setOf(recomposerA.asRecomposerInfo())
            val flow = MutableStateFlow(initialSet)
            val tracker = ComposeRecomposition19(
                scopeImplClass = access.scopeImplClass,
                skippedGetter = access.skippedGetter,
                rereadingGetter = access.rereadingGetter,
                scopeOwnerField = access.scopeOwnerField,
                compositionImplClass = access.compositionImplClass,
                compositionLockField = access.compositionLockField,
                observerHolderField = access.observerHolderField,
                holderGetObserver = access.holderGetObserver,
                holderCurrent = access.holderCurrent,
                runningRecomposersFlow = { flow },
            )

            val compB = Composition(EmptyApplier(), recomposerB)
            val scopeB = AtomicReference<RecomposeScope>()
            try {
                if (flowMode) tracker.setEnabled(true)
                bgApplyThread.start()
                assertTrue("SideEffect did not start", sideEffectEntered.await(5, TimeUnit.SECONDS))
                // Confirm we are in applyChanges where isComposing == false while compA.lock IS held!
                assertFalse((compA as androidx.compose.runtime.ControlledComposition).isComposing)

                val done = CountDownLatch(1)
                val err = AtomicReference<Throwable?>()
                val caller = Thread({
                    try {
                        val startNs = System.nanoTime()
                        if (flowMode) {
                            flow.value = setOf(recomposerA.asRecomposerInfo())
                        } else {
                            tracker.setEnabled(true)
                        }
                        val callerMs = (System.nanoTime() - startNs) / 1_000_000L
                        assertTrue(
                            "Caller (flowMode=$flowMode) blocked on SideEffect apply lock (${callerMs}ms)",
                            callerMs < 150L,
                        )
                        assertEquals(RecompositionStatus.ACTIVE, tracker.status)
                        assertTrue(tracker.incompleteCoverage)

                        // While compA is STILL stuck in SideEffect, Recomposer B appears and runs its first pass!
                        flow.value = setOf(recomposerA.asRecomposerInfo(), recomposerB.asRecomposerInfo())
                        assertEquals(2, tracker.attachedRecomposerCount())
                        Compose19TestBridge.setContent(compB) { c, _ ->
                            val cc = c.startRestartGroup(10_502)
                            scopeB.set(cc.recomposeScope!!)
                            cc.endRestartGroup()
                        }
                        assertNotNull(scopeB.get())
                        assertEquals(
                            "Sibling B's first composition must count 1/0 while A is in SideEffect (flowMode=$flowMode)",
                            RecompositionCounts(1, 0),
                            tracker.countsFor(scopeB.get()),
                        )
                        assertEquals("SideEffect must still be held when B asserts 1/0", 1L, releaseSideEffect.count)
                    } catch (t: Throwable) {
                        err.set(t)
                    } finally {
                        done.countDown()
                    }
                }, "test-apply42-caller-$flowMode").apply { isDaemon = true }
                caller.start()
                assertTrue(
                    "Apply42 (flowMode=$flowMode) blocked past 4s watchdog",
                    done.await(4, TimeUnit.SECONDS),
                )
                err.get()?.let { throw it }
            } finally {
                releaseSideEffect.countDown()
                bgApplyThread.join(5_000)
                tracker.setEnabled(false)
                runCatching { compB.dispose() }
                runCatching { compA.dispose() }
                recomposerB.cancel()
                jobB.join()
                recomposerA.cancel()
                jobA.join()
            }
        }
    }

    /**
     * Round-4 #3 regression (`Purge42`): pauses a producer at `SerialDeferredExecutor.queueLock` right before enqueue,
     * calls `setEnabled(false)` (cancelling & purging gen1), then releases `queueLock`. Proves the retired
     * generation's composition is rejected atomically and `deferredPendingCount()` remains 0.
     */
    fun assertEnqueueRacingGenerationCancellationNeverQueuesRetiredComposition() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clockA = ManualFrameClock()
        val recomposerA = Recomposer(coroutineContext + clockA)
        val jobA = launch(Dispatchers.Unconfined + clockA, start = CoroutineStart.UNDISPATCHED) {
            recomposerA.runRecomposeAndApplyChanges()
        }
        val clockB = ManualFrameClock()
        val recomposerB = Recomposer(coroutineContext + clockB)
        val jobB = launch(Dispatchers.Unconfined + clockB, start = CoroutineStart.UNDISPATCHED) {
            recomposerB.runRecomposeAndApplyChanges()
        }

        val release = CountDownLatch(1)
        val started = CountDownLatch(2)
        val compA = Composition(EmptyApplier(), recomposerA).also { c ->
            Compose19TestBridge.setContent(c) { cc, _ -> cc.startRestartGroup(10_600).endRestartGroup() }
        }
        val compB = Composition(EmptyApplier(), recomposerB).also { c ->
            Compose19TestBridge.setContent(c) { cc, _ -> cc.startRestartGroup(10_601).endRestartGroup() }
        }
        val tA = Thread({
            Compose19TestBridge.setContent(compA) { cc, _ ->
                val g = cc.startRestartGroup(10_602)
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
                g.endRestartGroup()
            }
        }, "test-purge42-A").apply { isDaemon = true; start() }
        val tB = Thread({
            Compose19TestBridge.setContent(compB) { cc, _ ->
                val g = cc.startRestartGroup(10_603)
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
                g.endRestartGroup()
            }
        }, "test-purge42-B").apply { isDaemon = true; start() }

        val flow = MutableStateFlow(setOf(recomposerA.asRecomposerInfo()))
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { flow },
        )

        try {
            assertTrue(started.await(5, TimeUnit.SECONDS))
            tracker.setEnabled(true)
            awaitCondition { tracker.deferredPoolSize() == 1 }

            val execField = ComposeRecomposition19::class.java.getDeclaredField("deferredExecutor").apply { isAccessible = true }
            val exec = execField.get(tracker)!!
            val queueLockField = exec.javaClass.getDeclaredField("queueLock").apply { isAccessible = true }
            val queueLock = queueLockField.get(exec)!!

            var publisher: Thread? = null
            synchronized(queueLock) {
                publisher = Thread({
                    flow.value = setOf(recomposerA.asRecomposerInfo(), recomposerB.asRecomposerInfo())
                }, "test-purge42-publisher").apply {
                    isDaemon = true
                    start()
                }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
                while (System.nanoTime() < deadline &&
                    publisher!!.stackTrace.none { it.methodName == "enqueue" }
                ) {
                    Thread.sleep(1)
                }
                assertTrue(
                    "Publisher did not reach SerialDeferredExecutor.enqueue",
                    publisher!!.stackTrace.any { it.methodName == "enqueue" },
                )
                // Disable & cancel gen1 while publisher is paused right at queueLock!
                tracker.setEnabled(false)
                assertEquals(0, tracker.deferredPendingCount())
            }
            publisher!!.join(3_000)
            assertFalse("Publisher thread did not finish", publisher!!.isAlive)
            assertEquals(RecompositionStatus.OFF, tracker.status)
            assertEquals(
                "Retired generation's composition must NEVER be enqueued after cancelGeneration",
                0,
                tracker.deferredPendingCount(),
            )

            release.countDown()
            tA.join(5_000)
            tB.join(5_000)
            awaitCondition(timeoutMs = 3_000L) { tracker.deferredPoolSize() == 0 }
            assertEquals(0, tracker.deferredPoolSize())
        } finally {
            release.countDown()
            tA.join(5_000)
            tB.join(5_000)
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
     * Round-4 #4 regression (`Capture42`): verifies an outer Inspector capture reading 8 `AndroidComposeView`s over
     * 128 attached compositions performs exactly 128 ownership slot checks total (ONCE per capture), not 2,048+.
     */
    fun assertCaptureLevelOwnershipVerificationRunsOnceAcrossMultipleComposeViews() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val scopes = ArrayList<RecomposeScope>(128)
        val comps = List(128) { idx ->
            Composition(EmptyApplier(), recomposer).also { c ->
                Compose19TestBridge.setContent(c) { composer, _ ->
                    val cc = composer.startRestartGroup(10_700 + idx)
                    scopes.add(cc.recomposeScope!!)
                    cc.endRestartGroup()
                }
            }
        }
        try {
            tracker.setEnabled(true)
            awaitCondition { tracker.attachedCompositionCount() == 128 }
            assertEquals(128, tracker.attachedCompositionCount())

            val reader = ComposeViewReader(tracker)
            val checksBefore = tracker.ownershipCheckCountForTest()
            // Outer capture lifecycle: ViewScene.prepare -> ComposeViewReader.beginCapture -> 8 ComposeViews -> Inspector status -> endCapture.
            reader.beginCapture(recompositionCounts = true)
            try {
                repeat(8) {
                    assertEquals(RecompositionStatus.ACTIVE, tracker.status)
                    repeat(250) { nodeIdx ->
                        assertEquals(RecompositionCounts.ZERO, tracker.countsFor(scopes[nodeIdx % scopes.size]))
                    }
                }
                // Final inspectBegin status read inside outer capture window.
                assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            } finally {
                reader.endCapture()
            }
            val totalChecks = tracker.ownershipCheckCountForTest() - checksBefore
            assertEquals(
                "8 ComposeViews over 128 attached compositions must verify each composition ONCE total (128 checks, not 2,048)",
                128L,
                totalChecks,
            )

            // Once outer capture closes, standalone status check verifies freshly again (another 128 checks).
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(256L, tracker.ownershipCheckCountForTest() - checksBefore)
        } finally {
            tracker.setEnabled(false)
            comps.forEach { runCatching { it.dispose() } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-5 #1 regression: enables tracking on 64 idle pre-existing compositions and immediately calls `reset()`
     * while replays are still pending attachment. Proves that once the serial worker attaches all 64 compositions,
     * `incompleteCoverage` clears automatically, every scope has exact `0/0` counts, and the first post-attach
     * execution reports `1/0` with NO second `reset()`.
     */
    fun assertResetWhilePreExistingReplayIsPendingStillBaselinesAtAttachWithoutSecondReset() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
        )

        val ticks = List(64) { mutableIntStateOf(0) }
        val scopes = ArrayList<RecomposeScope>(64)
        val comps = List(64) { idx ->
            Composition(EmptyApplier(), recomposer).also { c ->
                fun composeItem(composer: Composer, changed: Int = 0) {
                    val cc = composer.startRestartGroup(11_100 + idx)
                    if (scopes.size <= idx) scopes.add(cc.recomposeScope!!) else scopes[idx] = cc.recomposeScope!!
                    if (changed != 0 || !cc.skipping) ticks[idx].intValue else cc.skipToGroupEnd()
                    cc.endRestartGroup()?.let {
                        Compose19TestBridge.updateScope(it) { next, nextChanged -> composeItem(next, nextChanged) }
                    }
                }
                Compose19TestBridge.setContent(c) { composer, changed -> composeItem(composer, changed) }
            }
        }
        // Hold the first composition's lock briefly so replay is guaranteed pending during immediate reset().
        val firstCompLock = access.compositionLockField.get(comps[0])!!
        try {
            synchronized(firstCompLock) {
                tracker.setEnabled(true)
                assertTrue("Pre-existing replays must start incomplete before attach", tracker.incompleteCoverage)
                tracker.reset()
                assertTrue("Still-pending compositions stay incomplete until attach", tracker.incompleteCoverage)
                assertNull(tracker.countsFor(scopes[0]))
            }
            awaitCondition(timeoutMs = 5_000L) { tracker.attachedCompositionCount() == 64 }
            assertEquals(64, tracker.attachedCompositionCount())
            assertFalse(
                "incompleteCoverage must clear automatically once pending pre-existing replays attach (no second Reset)",
                tracker.incompleteCoverage,
            )
            for (idx in 0 until 64) {
                assertEquals(
                    "Composition $idx must report 0/0 after attach without a second Reset",
                    RecompositionCounts.ZERO,
                    tracker.countsFor(scopes[idx]),
                )
            }
            // First post-attach execution reports 1/0 on all 64 compositions with NO second Reset.
            ticks.forEach { it.intValue = 1 }
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            for (idx in 0 until 64) {
                assertEquals(
                    "Composition $idx must report 1/0 on first post-attach execution without a second Reset",
                    RecompositionCounts(1, 0),
                    tracker.countsFor(scopes[idx]),
                )
            }
        } finally {
            tracker.setEnabled(false)
            comps.forEach { runCatching { it.dispose() } }
            recomposer.cancel()
            job.join()
        }
    }

    /**
     * Round-5 #3 regression: if the first worker thread spawn throws (e.g. thread creation failure), `drainScheduled`
     * must roll back to `false` so that after the factory recovers, Off/On spawns a worker, attaches pending
     * compositions, clears `incompleteCoverage`, and counts recompositions normally.
     */
    fun assertFailedWorkerStartRollsBackSchedulingSoRetryOffOnAttachesAndCounts() = runBlocking {
        val probe = ComposeRecompositionSupport.probe() as ComposeRecompositionSupport.ProbeResult.Supported
        val access = probe.access
        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tick = mutableIntStateOf(0)
        val scopeRef = AtomicReference<RecomposeScope>()
        val comp = Composition(EmptyApplier(), recomposer)
        fun composeRoot(composer: Composer, changed: Int = 0) {
            val cc = composer.startRestartGroup(11_301)
            scopeRef.set(cc.recomposeScope!!)
            if (changed != 0 || !cc.skipping) tick.intValue else cc.skipToGroupEnd()
            cc.endRestartGroup()?.let {
                Compose19TestBridge.updateScope(it) { next, nextChanged -> composeRoot(next, nextChanged) }
            }
        }
        Compose19TestBridge.setContent(comp) { composer, changed -> composeRoot(composer, changed) }

        val failThreadCreation = AtomicBoolean(true)
        val tracker = ComposeRecomposition19(
            scopeImplClass = access.scopeImplClass,
            skippedGetter = access.skippedGetter,
            rereadingGetter = access.rereadingGetter,
            scopeOwnerField = access.scopeOwnerField,
            compositionImplClass = access.compositionImplClass,
            compositionLockField = access.compositionLockField,
            observerHolderField = access.observerHolderField,
            holderGetObserver = access.holderGetObserver,
            holderCurrent = access.holderCurrent,
            runningRecomposersFlow = { MutableStateFlow(setOf(recomposer.asRecomposerInfo())) },
            workerThreadFactory = ThreadFactory { runnable ->
                if (failThreadCreation.get()) {
                    throw OutOfMemoryError("pthread_create (1040KB stack) failed: Try again")
                }
                Thread(runnable, ComposeRecomposition19.WORKER_THREAD_NAME).apply { isDaemon = true }
            },
        )

        try {
            // First enable: worker creation fails safely without crashing the app.
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.deferredPoolSize())
            assertTrue(tracker.incompleteCoverage)

            // Restore thread factory and toggle Off -> On: must retry scheduling, spawn worker, and attach.
            failThreadCreation.set(false)
            tracker.setEnabled(false)
            tracker.setEnabled(true)

            awaitCondition(timeoutMs = 5_000L) { tracker.attachedCompositionCount() == 1 }
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedCompositionCount())
            assertFalse(tracker.incompleteCoverage)

            tick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopeRef.get()))
        } finally {
            tracker.setEnabled(false)
            runCatching { comp.dispose() }
            recomposer.cancel()
            job.join()
        }
    }

    private fun awaitAnyWorkerBlockedInAttach(timeoutMs: Long = 5_000L) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            if (anyWorkerBlockedInAttach()) return
            Thread.sleep(2)
        }
        throw AssertionError("Deferred attach worker did not block in attachRecord/setObserver")
    }

    private fun anyWorkerBlockedInAttach(): Boolean =
        Thread.getAllStackTraces().entries.any { (thread, stack) ->
            thread.name == ComposeRecomposition19.WORKER_THREAD_NAME &&
                thread.state == Thread.State.BLOCKED &&
                stack.any { it.methodName == "attachRecord" || it.methodName == "setObserver" }
        }

    private fun awaitCondition(timeoutMs: Long = 2_000L, condition: () -> Boolean) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (!condition() && System.nanoTime() < deadline) {
            Thread.sleep(5)
        }
    }

    private fun readRawObserverField(access: ComposeRecompositionSupport.ProbeSuccess, composition: Any): Any? {
        val holder = access.observerHolderField.get(composition) ?: return null
        return access.holderGetObserver.invoke(holder)
    }

    private fun readEffectiveObserverSlot(access: ComposeRecompositionSupport.ProbeSuccess, composition: Any): Any? {
        val holder = access.observerHolderField.get(composition) ?: return null
        return access.holderCurrent.invoke(holder)
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

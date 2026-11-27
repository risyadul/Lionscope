package io.github.risyadul.lionscope

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composer
import androidx.compose.runtime.Composition
import androidx.compose.runtime.InternalComposeApi
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.RecomposeScope
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicReference

/**
 * Unit tests for [ComposeRecompositionSupport], [ComposeRecompositionLifecycle], and [ComposeRecomposition19].
 *
 * On `testDebugUnitTest` (Compose 1.6.8), verifies fail-closed `unsupported` behavior and zero 1.9 linkage errors.
 * On `testCompose19` (Compose 1.9.2), drives real `Recomposer` + `Composition` + `RecomposeScopeImpl` instances
 * across stable/unstable children, `derivedStateOf`, `LazyColumn`-style item sub-compositions, reset,
 * initial-composition semantics, enable/disable detach, lifecycle re-scan, and bounded weak-identity memory.
 */
@OptIn(InternalComposeApi::class)
class ComposeRecompositionTest {

    private fun isCompose19Run(): Boolean = System.getProperty("lionscope.composeRuntimeMinor") == "9"

    @Test
    fun probeFailsClosedWhenRequiredSymbolsOrInternalFlagsAreMissing() {
        val noCompose = ComposeRecompositionSupport.probe(findClass = { null })
        assertTrue(noCompose is ComposeRecompositionSupport.ProbeResult.Unsupported)
        val unsupported = ComposeRecompositionSupport.createTracker(probeResult = noCompose)
        assertEquals(RecompositionStatus.UNSUPPORTED, unsupported.status)
        assertFalse(unsupported.truncated)
        unsupported.setEnabled(true)
        assertEquals(RecompositionStatus.UNSUPPORTED, unsupported.status)
        assertNull(unsupported.countsFor(Any()))
        unsupported.rescan()
        unsupported.reset()

        // Missing internal RecomposeScopeImpl (or wrong class without `getSkipped*()` / `getRereading()`):
        // must fail closed to UNSUPPORTED instead of conflating skips with recompositions.
        val missingFlags = ComposeRecompositionSupport.probe(
            findClass = { name ->
                if (name == "androidx.compose.runtime.RecomposeScopeImpl") Any::class.java
                else try {
                    Class.forName(name, false, javaClass.classLoader)
                } catch (_: ClassNotFoundException) {
                    null
                }
            },
        )
        assertTrue(missingFlags is ComposeRecompositionSupport.ProbeResult.Unsupported)

        // Minified/obfuscated build where RecomposeScopeImpl is stripped or renamed must fail closed to UNSUPPORTED,
        // and consumer-rules.pro must not ship a misleading -keepclassmembernames rule that still allows removal.
        val obfuscated = ComposeRecompositionSupport.probe(
            findClass = { name ->
                if (name == "androidx.compose.runtime.RecomposeScopeImpl") null
                else try {
                    Class.forName(name, false, javaClass.classLoader)
                } catch (_: ClassNotFoundException) {
                    null
                }
            },
        )
        assertTrue(obfuscated is ComposeRecompositionSupport.ProbeResult.Unsupported)
        val rulesFile = java.io.File("consumer-rules.pro")
        if (rulesFile.isFile) {
            val rules = rulesFile.readText()
            assertFalse(
                "consumer-rules.pro must not use -keepclassmembernames for RecomposeScopeImpl",
                rules.contains("-keepclassmembernames class androidx.compose.runtime.RecomposeScopeImpl"),
            )
            assertTrue(rules.contains("-dontwarn androidx.compose.runtime.tooling.**"))
        }
    }

    @Test
    fun compose16RuntimeCleanlyReportsUnsupportedWithoutLinkageError() {
        val result = ComposeRecompositionSupport.probe()
        if (isCompose19Run()) {
            assertTrue("Expected Supported on Compose 1.9+, got $result", result is ComposeRecompositionSupport.ProbeResult.Supported)
            val tracker = ComposeRecompositionSupport.createTracker(probeResult = result)
            assertEquals(RecompositionStatus.OFF, tracker.status)
            assertNull(tracker.countsFor(Any()))
            return
        }
        assertTrue("Expected Unsupported on Compose 1.6.8, got $result", result is ComposeRecompositionSupport.ProbeResult.Unsupported)
        val tracker = ComposeRecompositionSupport.createTracker(probeResult = result)
        assertEquals(RecompositionStatus.UNSUPPORTED, tracker.status)
        tracker.setEnabled(true)
        assertEquals(RecompositionStatus.UNSUPPORTED, tracker.status)
        assertNull(tracker.countsFor(Any()))
    }

    @Test
    fun lifecycleAdapterRescansOnActivityStartAndResume() {
        var rescans = 0
        val fakeTracker = object : ComposeRecompositionTracker {
            override val status = RecompositionStatus.ACTIVE
            override val truncated = false
            override fun setEnabled(enabled: Boolean) = Unit
            override fun rescan() {
                rescans++
            }
            override fun reset() = Unit
            override fun countsFor(scope: Any): RecompositionCounts? = null
        }
        val lifecycle = ComposeRecompositionLifecycle(fakeTracker)
        val activity = PlainTestActivity()
        lifecycle.onActivityCreated(activity, null)
        lifecycle.onActivityStarted(activity)
        lifecycle.onActivityResumed(activity)
        lifecycle.onActivityPaused(activity)
        lifecycle.onActivityStopped(activity)
        lifecycle.onActivityDestroyed(activity)
        assertEquals(2, rescans)
    }

    @Test
    fun compose19TracksExactRecompositionsSkipsDerivedStateLazyItemsAndReset() = runBlocking {
        if (!isCompose19Run()) return@runBlocking

        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19

        try {
            // Default OFF: countsFor returns null, zero attached observers.
            assertEquals(RecompositionStatus.OFF, tracker.status)
            assertEquals(0, tracker.attachedRecomposerCount())
            assertEquals(0, tracker.attachedCompositionCount())

            val tick = mutableIntStateOf(0)
            val derivedSource = mutableIntStateOf(0)
            val derivedThreshold = derivedStateOf { derivedSource.intValue >= 10 }
            val visibleItems = mutableIntStateOf(2)

            val scopes = HashMap<String, RecomposeScope>()
            val itemCompositions = LinkedHashMap<Int, Composition>()
            val itemScopes = HashMap<Int, RecomposeScope>()

            // Ground-truth body execution counters (not including initial compose before tracking starts).
            var parentRuns = 0
            var stableChildRuns = 0
            var unstableSameChildRuns = 0
            var unstableFreshChildRuns = 0
            var derivedChildRuns = 0
            val itemRuns = HashMap<Int, Int>()

            // Unstable holder class (mutable var) to mirror unstable params: same instance (skippable) vs fresh instance.
            class UnstableBox(var label: String)
            val sameBox = UnstableBox("same")

            fun composeStableChild(c: Composer, label: String, changed: Int = 0) {
                val cc = c.startRestartGroup(1001)
                scopes["StableChild"] = cc.recomposeScope!!
                var dirty = changed
                if (changed and 6 == 0) dirty = dirty or if (cc.changed(label)) 4 else 2
                if (dirty and 3 != 2 || !cc.skipping) {
                    stableChildRuns++
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged -> composeStableChild(next, label, nextChanged) }
                }
            }

            fun composeUnstableSameInstanceChild(c: Composer, box: UnstableBox, changed: Int = 0) {
                val cc = c.startRestartGroup(1002)
                scopes["UnstableSameInstanceChild"] = cc.recomposeScope!!
                // Strong Skipping compares unstable params by reference (changedInstance).
                var dirty = changed
                if (changed and 6 == 0) dirty = dirty or if (cc.changedInstance(box)) 4 else 2
                if (dirty and 3 != 2 || !cc.skipping) {
                    unstableSameChildRuns++
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged ->
                        composeUnstableSameInstanceChild(next, box, nextChanged)
                    }
                }
            }

            fun composeUnstableFreshChild(c: Composer, box: UnstableBox, changed: Int = 0) {
                val cc = c.startRestartGroup(1003)
                scopes["UnstableFreshChild"] = cc.recomposeScope!!
                var dirty = changed
                if (changed and 6 == 0) dirty = dirty or if (cc.changedInstance(box)) 4 else 2
                if (dirty and 3 != 2 || !cc.skipping) {
                    unstableFreshChildRuns++
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged ->
                        composeUnstableFreshChild(next, box, nextChanged)
                    }
                }
            }

            fun composeDerivedChild(c: Composer, changed: Int = 0) {
                val cc = c.startRestartGroup(1004)
                scopes["DerivedChild"] = cc.recomposeScope!!
                if (changed != 0 || !cc.skipping) {
                    derivedChildRuns++
                    // Reads derivedStateOf; changes to derivedSource that keep derivedThreshold==false trigger reread only.
                    derivedThreshold.value
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged -> composeDerivedChild(next, nextChanged) }
                }
            }

            fun composeLazyItem(c: Composer, index: Int, changed: Int = 0) {
                val cc = c.startRestartGroup(2000 + index)
                itemScopes[index] = cc.recomposeScope!!
                var dirty = changed
                if (changed and 6 == 0) dirty = dirty or if (cc.changed(index)) 4 else 2
                if (dirty and 3 != 2 || !cc.skipping) {
                    itemRuns[index] = (itemRuns[index] ?: 0) + 1
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged -> composeLazyItem(next, index, nextChanged) }
                }
            }

            fun composeParent(c: Composer, changed: Int = 0) {
                val cc = c.startRestartGroup(1000)
                scopes["Parent"] = cc.recomposeScope!!
                if (changed != 0 || !cc.skipping) {
                    parentRuns++
                    val currentTick = tick.intValue
                    composeStableChild(cc, "static")
                    composeUnstableSameInstanceChild(cc, sameBox)
                    composeUnstableFreshChild(cc, UnstableBox("tick-$currentTick"))
                    composeDerivedChild(cc)

                    // Simulate LazyColumn sub-compositions registered via buildContext().
                    val subContext = cc.buildContext()
                    val wanted = visibleItems.intValue
                    for (idx in 0 until wanted) {
                        if (idx !in itemCompositions) {
                            val sub = Composition(EmptyApplier(), subContext)
                            itemCompositions[idx] = sub
                            Compose19TestBridge.setContent(sub) { itemComposer, itemChanged ->
                                composeLazyItem(itemComposer, idx, itemChanged)
                            }
                        }
                    }
                    val toDispose = itemCompositions.keys.filter { it >= wanted }
                    for (idx in toDispose) {
                        itemCompositions.remove(idx)?.dispose()
                    }
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged -> composeParent(next, nextChanged) }
                }
            }

            val rootComposition = Composition(EmptyApplier(), recomposer)
            Compose19TestBridge.setContent(rootComposition) { composer, changed -> composeParent(composer, changed) }

            // Initial composition happened while tracking was OFF.
            assertEquals(1, parentRuns)
            assertEquals(1, stableChildRuns)
            assertEquals(1, unstableSameChildRuns)
            assertEquals(1, unstableFreshChildRuns)
            assertEquals(1, derivedChildRuns)
            assertEquals(1, itemRuns[0])
            assertEquals(1, itemRuns[1])
            assertNull(tracker.countsFor(scopes["Parent"]!!))

            // Turn tracking ON: existing scopes attach on the serial worker and start at 0/0.
            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(1, tracker.attachedRecomposerCount())
            awaitCondition { tracker.attachedCompositionCount() == 3 }
            assertEquals(3, tracker.attachedCompositionCount()) // root + 2 LazyColumn items
            assertFalse(tracker.incompleteCoverage)
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes["Parent"]!!))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes["StableChild"]!!))

            // Step 1: 4 parent state ticks.
            repeat(4) { step ->
                tick.intValue = step + 1
                Snapshot.sendApplyNotifications()
                clock.advanceFrame()
            }
            assertEquals(RecompositionCounts(4, 0), tracker.countsFor(scopes["Parent"]!!))
            assertEquals(RecompositionCounts(0, 4), tracker.countsFor(scopes["StableChild"]!!))
            assertEquals(RecompositionCounts(0, 4), tracker.countsFor(scopes["UnstableSameInstanceChild"]!!))
            assertEquals(RecompositionCounts(4, 0), tracker.countsFor(scopes["UnstableFreshChild"]!!))
            assertEquals(RecompositionCounts(0, 4), tracker.countsFor(scopes["DerivedChild"]!!))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(itemScopes[0]!!))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(itemScopes[1]!!))

            // Step 2: 3 derivedSource mutations that do NOT change derivedStateOf (still false).
            // Must NOT count as recompositions or skips (RereadingFlag no-op reread).
            repeat(3) { step ->
                derivedSource.intValue = step + 1
                Snapshot.sendApplyNotifications()
                clock.advanceFrame()
            }
            assertEquals(1, derivedChildRuns) // Body never ran again.
            assertEquals(RecompositionCounts(0, 4), tracker.countsFor(scopes["DerivedChild"]!!))

            // Step 3: derivedSource crosses threshold (>= 10), flipping derivedStateOf to true -> 1 recomposition.
            derivedSource.intValue = 12
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(2, derivedChildRuns)
            assertEquals(RecompositionCounts(1, 4), tracker.countsFor(scopes["DerivedChild"]!!))

            // Step 4: scroll LazyColumn to add item #2 while tracking is ON -> initial composition counts as 1 (Android Studio semantics).
            visibleItems.intValue = 3
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(1, itemRuns[2])
            awaitCondition { tracker.attachedCompositionCount() == 4 }
            assertEquals(4, tracker.attachedCompositionCount())
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(itemScopes[2]!!))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(itemScopes[0]!!))

            // Dispose item #2 (scrolled off): eager removal on onScopeDisposed + composition unregistration.
            val disposedItemScope = itemScopes[2]!!
            visibleItems.intValue = 2
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()
            assertEquals(3, tracker.attachedCompositionCount())
            // Entry was eagerly removed; countsFor returns ZERO (absent in map) rather than stale (1, 0).
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(disposedItemScope))

            // Step 5: Reset clears all counts while keeping observers attached.
            tracker.reset()
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            assertEquals(3, tracker.attachedCompositionCount())
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes["Parent"]!!))
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes["StableChild"]!!))

            repeat(2) { step ->
                tick.intValue = 100 + step
                Snapshot.sendApplyNotifications()
                clock.advanceFrame()
            }
            assertEquals(RecompositionCounts(2, 0), tracker.countsFor(scopes["Parent"]!!))
            assertEquals(RecompositionCounts(0, 2), tracker.countsFor(scopes["StableChild"]!!))
            assertEquals(RecompositionCounts(2, 0), tracker.countsFor(scopes["UnstableFreshChild"]!!))
            assertEquals(RecompositionCounts(0, 2), tracker.countsFor(scopes["DerivedChild"]!!))

            // Step 6: Disable detaches all observers and drops counts; re-enable attaches cleanly at 0/0.
            tracker.setEnabled(false)
            assertEquals(RecompositionStatus.OFF, tracker.status)
            assertEquals(0, tracker.attachedRecomposerCount())
            assertEquals(0, tracker.attachedCompositionCount())
            assertEquals(0, tracker.trackedScopeCount())
            assertNull(tracker.countsFor(scopes["Parent"]!!))

            tick.intValue = 200
            Snapshot.sendApplyNotifications()
            clock.advanceFrame()

            tracker.setEnabled(true)
            assertEquals(RecompositionStatus.ACTIVE, tracker.status)
            awaitCondition { tracker.attachedCompositionCount() == 3 }
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes["Parent"]!!))

            itemCompositions.values.forEach { it.dispose() }
            rootComposition.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    @Test
    fun testCompose19ResolvesAndroidRuntimeArtifact() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertAndroidRuntimeArtifactResolved()
    }

    @Test
    fun movedSkipFlagBitUsesResolvedGetterInsteadOfHardcodedMask() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertMovedSkipFlagUsesResolvedGetter()
    }

    @Test
    fun resetDuringDerivedStateRereadDoesNotInventRecomposition() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertResetDuringDerivedStateRereadDoesNotInventRecomposition()
    }

    @Test
    fun runtimeLinkageErrorTransitionsTrackerToUnsupported() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertRuntimeLinkageErrorTransitionsToUnsupported()
    }

    @Test
    fun existingCompositionObserverIsPreservedAndReportedAsConflict() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertExistingCompositionObserverIsPreservedAndReportedAsConflict()
    }

    @Test
    fun probeRejectsPrimitiveStaticOrMissingCompositionLockField() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertProbeRejectsPrimitiveStaticOrMissingCompositionLockField()
    }

    @Test
    fun deadlockSubprocessWatchdogFailsFastOnGenuineDeadlock() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertDeadlockSubprocessWatchdogFailsFastOnGenuineDeadlock()
    }

    @Test
    fun busyReplaysDoNotDelayIdleReplayOrFabricateZeroCounts() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertBusyReplaysDoNotDelayIdleReplayOrFabricateZeroCounts()
    }

    @Test
    fun postEnableIncompleteCompositionDoesNotFreezeSiblingExactCounts() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertPostEnableIncompleteCompositionDoesNotFreezeSiblingExactCounts()
    }

    @Test
    fun inheritedObserverFromRetiredGenerationNeverCausesFalseConflict() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertInheritedObserverFromRetiredGenerationNeverCausesFalseConflict()
    }

    @Test
    fun deferredExecutorPurgesEndedGenerationAndRetiresIdleThread() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertDeferredExecutorPurgesEndedGenerationAndRetiresIdleThread()
    }

    @Test
    fun sample42ExecutionBetweenCheckAndClaimIsUnavailableThenBaselinedAtAttach() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertSample42ExecutionBetweenCheckAndClaimIsUnavailableThenBaselinedAtAttach()
    }

    @Test
    fun backgroundSideEffectApplyNeverBlocksEnableOrDiscoveryAndSiblingCountsFirstPass() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertBackgroundSideEffectApplyNeverBlocksEnableOrDiscoveryAndSiblingCountsFirstPass()
    }

    @Test
    fun enqueueRacingGenerationCancellationNeverQueuesRetiredComposition() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertEnqueueRacingGenerationCancellationNeverQueuesRetiredComposition()
    }

    @Test
    fun captureLevelOwnershipVerificationRunsOnceAcrossMultipleComposeViews() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertCaptureLevelOwnershipVerificationRunsOnceAcrossMultipleComposeViews()
    }

    @Test
    fun resetWhilePreExistingReplayIsPendingStillBaselinesAtAttachWithoutSecondReset() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertResetWhilePreExistingReplayIsPendingStillBaselinesAtAttachWithoutSecondReset()
    }

    @Test
    fun failedWorkerStartRollsBackSchedulingSoRetryOffOnAttachesAndCounts() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertFailedWorkerStartRollsBackSchedulingSoRetryOffOnAttachesAndCounts()
    }

    @Test
    fun countsForDoesNotScanAllCompositionsPerLookup() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertCountsForDoesNotScanAllCompositionsPerLookup()
    }

    @Test
    fun concurrentEnableToggleAndSubcompositionDoesNotDeadlock() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertConcurrentEnableToggleAndSubcompositionDoesNotDeadlock()
    }

    @Test
    fun disableReenableRaceCannotLeaveActiveWithEmptyObserverSlot() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertDisableReenableRaceCannotLeaveActiveWithEmptyObserverSlot()
    }

    @Test
    fun concurrentForeignObserverInstallIsAtomicAndNeverOverwritten() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertConcurrentForeignObserverInstallIsAtomicAndNeverOverwritten()
    }

    @Test
    fun postAttachForeignObserverTakeoverReportsConflictAndRetryRecovers() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertPostAttachForeignObserverTakeoverReportsConflictAndRetryRecovers()
    }

    @Test
    fun unregisterDuringInFlightAttachDisposesHandleAndNeverRetains() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertUnregisterDuringInFlightAttachDisposesHandleAndNeverRetains()
    }

    @Test
    fun busyRecomposerNeverBlocksAnotherRecomposerInitialComposition() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertBusyRecomposerNeverBlocksAnotherRecomposerInitialComposition()
    }

    @Test
    fun droppedScopeAfterCapExceededNeverGetsPartialCountUntilReset() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertDroppedScopeAfterCapExceededNeverGetsPartialCountUntilReset()
    }

    @Test
    fun postEnableLateReplayedCompositionMarksCoverageIncomplete() {
        if (!isCompose19Run()) return
        Compose19TestScenarios.assertPostEnableLateReplayedCompositionMarksCoverageIncomplete()
    }

    @Test
    fun observingRunningRecomposersCapturesNewWindowInitialCompositionWithoutRescan() = runBlocking {
        if (!isCompose19Run()) return@runBlocking

        val clock1 = ManualFrameClock()
        val recomposer1 = Recomposer(coroutineContext + clock1)
        val job1 = launch(Dispatchers.Unconfined + clock1, start = CoroutineStart.UNDISPATCHED) {
            recomposer1.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19
        val clock2 = ManualFrameClock()
        var recomposer2: Recomposer? = null
        var job2: kotlinx.coroutines.Job? = null

        try {
            tracker.setEnabled(true)
            assertEquals(1, tracker.attachedRecomposerCount())

            // Start a second Recomposer (e.g. a brand-new Activity window) while tracking is already active,
            // WITHOUT calling rescan(): its first snapshot must already capture initial composition counts (1/0).
            val second = Recomposer(coroutineContext + clock2)
            recomposer2 = second
            job2 = launch(Dispatchers.Unconfined + clock2, start = CoroutineStart.UNDISPATCHED) {
                second.runRecomposeAndApplyChanges()
            }
            assertEquals(2, tracker.attachedRecomposerCount())

            val secondTick = mutableIntStateOf(0)
            val secondScope = AtomicReference<RecomposeScope>()
            val comp2 = Composition(EmptyApplier(), second)
            fun composeSecond(c: Composer, changed: Int = 0) {
                val cc = c.startRestartGroup(3001)
                secondScope.set(cc.recomposeScope!!)
                if (changed != 0 || !cc.skipping) {
                    secondTick.intValue
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, nextChanged -> composeSecond(next, nextChanged) }
                }
            }
            Compose19TestBridge.setContent(comp2) { composer, changed -> composeSecond(composer, changed) }

            assertNotNull(secondScope.get())
            // First snapshot immediately sees initial composition count 1/0 (never 0/0).
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(secondScope.get()))

            secondTick.intValue = 1
            Snapshot.sendApplyNotifications()
            clock2.advanceFrame()
            assertEquals(RecompositionCounts(2, 0), tracker.countsFor(secondScope.get()))

            // Shut down the second Recomposer and verify stale handle is pruned automatically without rescan().
            comp2.dispose()
            second.cancel()
            job2.join()
            recomposer2 = null
            assertEquals(1, tracker.attachedRecomposerCount())
        } finally {
            tracker.setEnabled(false)
            recomposer2?.cancel()
            job2?.join()
            recomposer1.cancel()
            job1.join()
        }
    }

    @Test
    fun boundedCapacitySetsTruncatedFlagAndResetClearsIt() = runBlocking {
        if (!isCompose19Run()) return@runBlocking

        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker(maxTrackedScopes = 2) as ComposeRecomposition19
        try {
            tracker.setEnabled(true)
            assertFalse(tracker.truncated)

            val tick = mutableIntStateOf(0)
            val scopes = ArrayList<RecomposeScope>()
            fun composeChild(c: Composer, id: Int, v: Int) {
                val cc = c.startRestartGroup(4000 + id)
                scopes.add(cc.recomposeScope!!)
                val dirty = if (cc.changed(v)) 4 else 2
                if (dirty and 3 != 2 || !cc.skipping) {
                    // body
                } else {
                    cc.skipToGroupEnd()
                }
                cc.endRestartGroup()?.let {
                    Compose19TestBridge.updateScope(it) { next, _ -> composeChild(next, id, v) }
                }
            }

            val comp = Composition(EmptyApplier(), recomposer)
            Compose19TestBridge.setContent(comp) { composer, _ ->
                val cc = composer.startRestartGroup(4000)
                val v = tick.intValue
                composeChild(cc, 1, v)
                composeChild(cc, 2, v)
                composeChild(cc, 3, v)
                cc.endRestartGroup()
            }

            assertTrue("Expected cap of 2 to flag truncated when 4 scopes composed", tracker.truncated)
            assertEquals(2, tracker.trackedScopeCount())
            // Overflow scopes that could not be inserted must report null (unavailable), NEVER 0/0.
            assertEquals(3, scopes.size)
            assertNull("Overflow scope must be unavailable (null) when truncated", tracker.countsFor(scopes[2]))
            assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopes[0]))

            tracker.reset()
            assertFalse(tracker.truncated)
            assertEquals(0, tracker.trackedScopeCount())
            assertEquals(RecompositionCounts(0, 0), tracker.countsFor(scopes[2]))

            comp.dispose()
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    @Test
    fun weakIdentityKeysDoNotRetainAbandonedScopes() = runBlocking {
        if (!isCompose19Run()) return@runBlocking

        val clock = ManualFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val job = launch(Dispatchers.Unconfined + clock, start = CoroutineStart.UNDISPATCHED) {
            recomposer.runRecomposeAndApplyChanges()
        }
        val tracker = ComposeRecompositionSupport.createTracker() as ComposeRecomposition19
        try {
            tracker.setEnabled(true)
            var scopeRef: WeakReference<RecomposeScope>? = null
            run {
                var localComp: Composition? = Composition(EmptyApplier(), recomposer)
                Compose19TestBridge.setContent(localComp!!) { composer, _ ->
                    val cc = composer.startRestartGroup(5001)
                    scopeRef = WeakReference(cc.recomposeScope!!)
                    cc.endRestartGroup()
                }
                assertSame(scopeRef!!.get(), scopeRef!!.get())
                assertEquals(RecompositionCounts(1, 0), tracker.countsFor(scopeRef!!.get()!!))
                localComp.dispose()
                localComp = null
            }
            // Disposing removes eagerly, so count drops to 0 immediately even before GC.
            assertEquals(0, tracker.trackedScopeCount())
        } finally {
            tracker.setEnabled(false)
            recomposer.cancel()
            job.join()
        }
    }

    private fun awaitCondition(timeoutMs: Long = 2_000L, condition: () -> Boolean) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (!condition() && System.nanoTime() < deadline) {
            Thread.sleep(2)
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

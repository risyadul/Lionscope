package io.github.risyadul.lionscope

import androidx.compose.runtime.ControlledComposition
import androidx.compose.runtime.ExperimentalComposeRuntimeApi
import androidx.compose.runtime.RecomposeScope
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.RecomposerInfo
import androidx.compose.runtime.tooling.CompositionObserver
import androidx.compose.runtime.tooling.CompositionObserverHandle
import androidx.compose.runtime.tooling.CompositionRegistrationObserver
import androidx.compose.runtime.tooling.ObservableComposition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.lang.ref.ReferenceQueue
import java.lang.ref.WeakReference
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.IdentityHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Compose runtime 1.9+ recomposition and skip tracker backed by an explicit generation-scoped attachment state machine.
 *
 * Everything in this file links against `compileOnly` Compose runtime 1.9+ (`@ExperimentalComposeRuntimeApi`).
 * It is only loaded after [ComposeRecompositionSupport.probe] verifies every required public observer symbol,
 * `RecomposeScopeImpl` skip/rereading getters, and `CompositionImpl.lock` / `observerHolder`.
 *
 * State-machine invariants:
 * - **Enable generations**: every `setEnabled(true)` (including retry after conflict) creates a fresh [Generation]
 *   with its own [CompositionObserver] and [CompositionRegistrationObserver] identity. Work started in an earlier
 *   generation can never install into, dispose handles of, or count into a newer generation.
 * - **Per-composition registration records**: each observed composition has an explicit [CompState] lifecycle
 *   (`REGISTERED` -> `ATTACHING` -> `ATTACHED` -> `DISPOSED`) owned under our private leaf [lock]. An unregister
 *   arriving while an attach is in flight invalidates the record (`DISPOSED`), so any handle returned afterwards is
 *   disposed immediately and never published.
 * - **Atomic slot ownership**: checking `CompositionImpl.observerHolder` for a foreign observer and claiming the slot
 *   via `setObserver()` run atomically under `CompositionImpl.lock`. Ownership is re-verified before reporting status
 *   or counts; if a foreign observer takes over a slot later, the generation transitions to [RecompositionStatus.CONFLICT]
 *   and stops reporting counts.
 * - **Discovery independent of attachment**: collecting `Recomposer.runningRecomposers` only discovers recomposers and
 *   queues replayed compositions onto an asynchronous daemon pool — attachment of a busy recomposer never blocks
 *   discovery of another recomposer. Non-replay registrations of brand-new, non-composing root compositions attach
 *   synchronously so initial compositions are observed; any post-enable composition attached after it has already
 *   started composing marks coverage incomplete (`truncated = true`) until [reset].
 * - **Capacity monotonicity**: once [maxTrackedScopes] is hit, no new or previously dropped scope can enter the map
 *   until [reset], preventing dropped scopes from later acquiring misleading partial counts.
 */
@OptIn(ExperimentalComposeRuntimeApi::class)
internal class ComposeRecomposition19(
    private val scopeImplClass: Class<*>,
    private val skippedGetter: Method,
    private val rereadingGetter: Method,
    private val compositionImplClass: Class<*>,
    private val compositionLockField: Field,
    private val observerHolderField: Field,
    private val holderGetObserver: Method,
    private val holderCurrent: Method,
    private val maxTrackedScopes: Int = DEFAULT_MAX_TRACKED_SCOPES,
    private val runningRecomposersFlow: () -> StateFlow<Set<RecomposerInfo>> = { Recomposer.runningRecomposers },
    scheduleTask: ((Runnable) -> Unit)? = null,
) : ComposeRecompositionTracker {

    private val useDefaultExecutor: Boolean = scheduleTask == null
    private val taskScheduler: (Runnable) -> Unit = scheduleTask ?: ::defaultScheduleTask

    private class ScopeEntry {
        var recompositions: Int = 0
        var skips: Int = 0
        var activePassDepth: Int = 0
        var passEpoch: Long = -1L
        var sawRereadingInPass: Boolean = false
    }

    /** Weak identity key for [RecomposeScope] so GC'd scopes never leak and identity (`===`) is guaranteed. */
    private class IdentityWeakKey(
        scope: RecomposeScope,
        queue: ReferenceQueue<RecomposeScope>,
    ) : WeakReference<RecomposeScope>(scope, queue) {
        val hash: Int = System.identityHashCode(scope)

        override fun hashCode(): Int = hash

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            val mine = get() ?: return false
            return when (other) {
                is IdentityWeakKey -> mine === other.get()
                is LookupKey -> mine === other.scope
                else -> false
            }
        }
    }

    /** Zero-allocation lookup probe reused strictly under [lock]; [scope] is cleared immediately after each lookup. */
    private class LookupKey {
        var scope: Any? = null
        var hash: Int = 0

        override fun hashCode(): Int = hash

        override fun equals(other: Any?): Boolean = other is IdentityWeakKey && other.get() === scope
    }

    private enum class ObserverSlot { NONE, OURS, FOREIGN, FAILED }

    private enum class CompState { REGISTERED, ATTACHING, ATTACHED, DISPOSED }

    private class CompositionRecord(
        val composition: ObservableComposition,
        val gen: Generation,
        var state: CompState,
        var missedInitial: Boolean = false,
        var handle: CompositionObserverHandle? = null,
    )

    private inner class Generation(val id: Long) {
        val observer: CompositionObserver = createCompositionObserver(this)
        val registrationObserver: CompositionRegistrationObserver = createRegistrationObserver(this)
        val collectorScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val recomposers = IdentityHashMap<RecomposerInfo, CompositionObserverHandle>()
        val compositions = IdentityHashMap<ObservableComposition, CompositionRecord>()
        var active: Boolean = true
    }

    /** Private leaf lock: NEVER held across Compose `observe`, `setObserver`, `dispose`, or `CompositionImpl.lock`. */
    private val lock = Any()
    private val referenceQueue = ReferenceQueue<RecomposeScope>()
    private val counts = HashMap<Any, ScopeEntry>()
    private val lookupKey = LookupKey()
    private var currentGen: Generation? = null
    private var nextGenerationId: Long = 0L
    private var resetEpoch: Long = 0L

    private val inObserveReplay = ThreadLocal<Boolean>()
    private val inRegistrationCallback = ThreadLocal<Boolean>()

    @Volatile
    private var capHit: Boolean = false

    @Volatile
    private var coverageIncomplete: Boolean = false

    @Volatile
    private var observerConflict: Boolean = false

    @Volatile
    private var failedUnsupported: Boolean = false

    override val status: RecompositionStatus
        get() {
            verifyOwnershipFast()
            return rawStatus()
        }

    override val truncated: Boolean
        get() = capHit || coverageIncomplete

    private fun rawStatus(): RecompositionStatus = when {
        failedUnsupported -> RecompositionStatus.UNSUPPORTED
        observerConflict -> RecompositionStatus.CONFLICT
        currentGen != null -> RecompositionStatus.ACTIVE
        else -> RecompositionStatus.OFF
    }

    private fun isGenerationActive(gen: Generation): Boolean =
        !failedUnsupported && !observerConflict && currentGen === gen && gen.active

    private fun createRegistrationObserver(gen: Generation): CompositionRegistrationObserver =
        object : CompositionRegistrationObserver {
            override fun onCompositionRegistered(composition: ObservableComposition) {
                val prev = inRegistrationCallback.get() == true
                inRegistrationCallback.set(true)
                try {
                    guarded { handleCompositionRegistered(gen, composition) }
                } finally {
                    inRegistrationCallback.set(prev)
                }
            }

            override fun onCompositionUnregistered(composition: ObservableComposition) {
                val prev = inRegistrationCallback.get() == true
                inRegistrationCallback.set(true)
                try {
                    guarded { handleCompositionUnregistered(gen, composition) }
                } finally {
                    inRegistrationCallback.set(prev)
                }
            }
        }

    private fun createCompositionObserver(gen: Generation): CompositionObserver =
        object : CompositionObserver {
            override fun onBeginComposition(composition: ObservableComposition) = Unit

            override fun onEndComposition(composition: ObservableComposition) = Unit

            override fun onScopeInvalidated(scope: RecomposeScope, value: Any?) = Unit

            override fun onScopeEnter(scope: RecomposeScope) {
                if (currentGen !== gen || failedUnsupported || observerConflict) return
                guarded {
                    synchronized(lock) {
                        if (!isGenerationActive(gen)) return@synchronized
                        val entry = getOrCreateLocked(scope) ?: return@synchronized
                        entry.activePassDepth++
                        entry.passEpoch = resetEpoch
                        entry.sawRereadingInPass = false
                    }
                }
            }

            override fun onReadInScope(scope: RecomposeScope, value: Any) {
                if (currentGen !== gen || failedUnsupported || observerConflict) return
                val rereading = invokeBooleanGetter(rereadingGetter, scope) ?: return
                if (!rereading) return
                guarded {
                    synchronized(lock) {
                        if (!isGenerationActive(gen)) return@synchronized
                        getLocked(scope)?.sawRereadingInPass = true
                    }
                }
            }

            override fun onScopeExit(scope: RecomposeScope) {
                if (currentGen !== gen || failedUnsupported || observerConflict) return
                val skipped = invokeBooleanGetter(skippedGetter, scope) ?: return
                guarded {
                    synchronized(lock) {
                        if (!isGenerationActive(gen)) return@synchronized
                        // Never create an entry on exit: passes that started before reset() (or before attach,
                        // or after capHit froze insertions) are discarded rather than misclassified.
                        val entry = getLocked(scope) ?: return@synchronized
                        if (entry.activePassDepth <= 0) return@synchronized
                        entry.activePassDepth--
                        if (entry.passEpoch != resetEpoch) {
                            entry.sawRereadingInPass = false
                            return@synchronized
                        }
                        if (entry.sawRereadingInPass) {
                            entry.sawRereadingInPass = false
                            return@synchronized
                        }
                        if (skipped) {
                            if (entry.skips < Int.MAX_VALUE) entry.skips++
                        } else {
                            if (entry.recompositions < Int.MAX_VALUE) entry.recompositions++
                        }
                    }
                }
            }

            override fun onScopeDisposed(scope: RecomposeScope) {
                guarded {
                    synchronized(lock) {
                        if (currentGen !== gen) return@synchronized
                        removeLocked(scope)
                    }
                }
            }
        }

    override fun setEnabled(enabled: Boolean) {
        if (enabled) {
            if (failedUnsupported) return
            verifyOwnershipFast()
            val gen = synchronized(lock) {
                if (failedUnsupported) return
                // If already active and healthy, keep the current generation.
                // If OFF or CONFLICT (Retry), create a brand-new generation with a fresh observer identity.
                if (currentGen != null && !observerConflict) {
                    null
                } else {
                    observerConflict = false
                    capHit = false
                    coverageIncomplete = false
                    resetEpoch++
                    counts.clear()
                    drainQueueLocked()
                    Generation(++nextGenerationId).also { currentGen = it }
                }
            } ?: return
            val initialLatch = startCollectingRecomposers(gen)
            // Wait briefly for the initial batch of idle replayed compositions when using the default async pool,
            // without ever blocking discovery of new recomposers or blocking indefinitely on a busy composition.
            if (initialLatch != null && useDefaultExecutor) {
                runCatching { initialLatch.await(INITIAL_ATTACH_WAIT_MS, TimeUnit.MILLISECONDS) }
            }
        } else {
            endGeneration(targetGen = null, markConflict = false, markUnsupported = false)
        }
    }

    override fun rescan() {
        verifyOwnershipFast()
        val gen = synchronized(lock) { currentGen?.takeIf { isGenerationActive(it) } } ?: return
        val running = try {
            runningRecomposersFlow().value
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                return
            }
            if (isFatal(t)) throw t
            return
        }
        discoverRecomposers(gen, running, isInitialEnable = false)
    }

    override fun reset() {
        synchronized(lock) {
            resetEpoch++
            counts.clear()
            drainQueueLocked()
            capHit = false
            coverageIncomplete = false
            currentGen?.compositions?.values?.forEach { it.missedInitial = false }
        }
    }

    override fun countsFor(scope: Any): RecompositionCounts? {
        verifyOwnershipFast()
        return synchronized(lock) {
            val gen = currentGen
            if (gen == null || !isGenerationActive(gen)) return@synchronized null
            val entry = getLocked(scope)
            when {
                entry != null -> RecompositionCounts(entry.recompositions, entry.skips)
                capHit || coverageIncomplete -> null // Incomplete coverage: never fabricate 0/0.
                else -> RecompositionCounts.ZERO
            }
        }
    }

    /** Number of live scope entries currently stored (tests). */
    internal fun trackedScopeCount(): Int = synchronized(lock) {
        drainQueueLocked()
        counts.size
    }

    /** Number of currently attached Recomposers in the active generation (tests). */
    internal fun attachedRecomposerCount(): Int = synchronized(lock) { currentGen?.recomposers?.size ?: 0 }

    /** Number of currently attached Compositions (`ATTACHED` state) in the active generation (tests). */
    internal fun attachedCompositionCount(): Int = synchronized(lock) {
        currentGen?.compositions?.values?.count { it.state == CompState.ATTACHED } ?: 0
    }

    /** Number of composition records in any state in the active generation (tests). */
    internal fun trackedCompositionRecordCount(): Int = synchronized(lock) { currentGen?.compositions?.size ?: 0 }

    /** Exposes the active generation's observer for targeted unit tests. */
    internal fun observerForTest(): Any = synchronized(lock) {
        checkNotNull(currentGen) { "Tracker is not enabled" }.observer
    }

    private fun startCollectingRecomposers(gen: Generation): CountDownLatch? {
        val flow = try {
            runningRecomposersFlow()
        } catch (t: Throwable) {
            gen.collectorScope.cancel()
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                return null
            }
            if (isFatal(t)) throw t
            return null
        }
        var initialLatch: CountDownLatch? = null
        var firstEmission = true
        gen.collectorScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                flow.collect { running ->
                    if (!isGenerationActive(gen)) return@collect
                    val isInitial = firstEmission
                    firstEmission = false
                    var latch: CountDownLatch? = null
                    guarded { latch = discoverRecomposers(gen, running, isInitialEnable = isInitial) }
                    if (isInitial) {
                        initialLatch = latch
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                if (isRuntimeIncompatibility(t)) {
                    failUnsupported()
                } else if (isFatal(t)) {
                    throw t
                }
            }
        }
        return initialLatch
    }

    /**
     * Discovery-only step: observes new Recomposers and prunes stopped ones.
     * NEVER calls `composition.setObserver()` inline — all replayed compositions are dispatched asynchronously
     * so a busy Recomposer can never block discovery of another Recomposer.
     */
    private fun discoverRecomposers(
        gen: Generation,
        running: Set<RecomposerInfo>,
        isInitialEnable: Boolean,
    ): CountDownLatch? {
        if (!isGenerationActive(gen)) return null

        val staleHandles = synchronized(lock) {
            if (!isGenerationActive(gen)) return null
            val stale = ArrayList<CompositionObserverHandle>()
            val iterator = gen.recomposers.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key !in running) {
                    stale.add(entry.value)
                    iterator.remove()
                }
            }
            stale
        }
        for (handle in staleHandles) scheduleDispose(handle)

        val replayedRecords = ArrayList<CompositionRecord>()
        for (info in running) {
            if (!isGenerationActive(gen)) break
            val alreadyAttached = synchronized(lock) { !isGenerationActive(gen) || gen.recomposers.containsKey(info) }
            if (alreadyAttached) continue

            val prevReplay = inObserveReplay.get() == true
            val prevPostEnable = inPostEnableReplay.get() == true
            val prevBatch = replayCollector.get()
            replayCollector.set(replayedRecords)
            inObserveReplay.set(true)
            inPostEnableReplay.set(!isInitialEnable)
            val handle = try {
                info.observe(gen.registrationObserver)
            } catch (t: Throwable) {
                if (isRuntimeIncompatibility(t)) {
                    failUnsupported()
                    return null
                }
                if (isFatal(t)) throw t
                null
            } finally {
                inObserveReplay.set(prevReplay)
                inPostEnableReplay.set(prevPostEnable)
                replayCollector.set(prevBatch)
            } ?: continue

            val keep = synchronized(lock) {
                if (isGenerationActive(gen) && !gen.recomposers.containsKey(info)) {
                    gen.recomposers[info] = handle
                    true
                } else {
                    false
                }
            }
            if (!keep) scheduleDispose(handle)
        }

        if (replayedRecords.isEmpty()) return null
        val latch = CountDownLatch(replayedRecords.size)
        for (record in replayedRecords) {
            scheduleAttach(record, latch)
        }
        return latch
    }

    private val inPostEnableReplay = ThreadLocal<Boolean>()
    private val replayCollector = ThreadLocal<MutableList<CompositionRecord>?>()

    private fun handleCompositionRegistered(gen: Generation, composition: ObservableComposition) {
        if (!isGenerationActive(gen)) return
        if (isCompositionDisposed(composition)) return

        // Case 1: Replay inside RecomposerInfo.observe() while Recomposer holds stateLock.
        // NEVER acquire CompositionImpl.lock or call setObserver() here: create a REGISTERED record
        // and let discoverRecomposers dispatch it asynchronously once observe() releases stateLock.
        if (inObserveReplay.get() == true) {
            val missed = inPostEnableReplay.get() == true
            val record = synchronized(lock) {
                if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                    null
                } else {
                    if (missed) coverageIncomplete = true
                    CompositionRecord(composition, gen, CompState.REGISTERED, missedInitial = missed).also {
                        gen.compositions[composition] = it
                    }
                }
            }
            if (record != null) {
                val batch = replayCollector.get()
                if (batch != null) batch.add(record) else scheduleAttach(record, null)
            }
            return
        }

        // Case 2: Non-replay registration (new composition entering Recomposer.composeInitial()).
        when (peekObserverSlot(composition, gen.observer)) {
            ObserverSlot.FAILED -> {
                failUnsupported()
                return
            }
            ObserverSlot.FOREIGN -> {
                markConflict(gen)
                return
            }
            ObserverSlot.OURS -> {
                // Subcomposition already inherits gen.observer from its parent during initial composition:
                // defer explicit handle acquisition off-lock.
                val record = synchronized(lock) {
                    if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                        null
                    } else {
                        CompositionRecord(composition, gen, CompState.REGISTERED).also {
                            gen.compositions[composition] = it
                        }
                    }
                }
                if (record != null) scheduleAttach(record, null)
                return
            }
            ObserverSlot.NONE -> {
                // If already composing, defer off-lock and mark incomplete coverage so we never show exact-looking 0/0.
                if (isCompositionActive(composition)) {
                    val record = synchronized(lock) {
                        if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                            null
                        } else {
                            coverageIncomplete = true
                            CompositionRecord(composition, gen, CompState.REGISTERED, missedInitial = true).also {
                                gen.compositions[composition] = it
                            }
                        }
                    }
                    if (record != null) scheduleAttach(record, null)
                    return
                }
                // Brand-new, unobserved, non-composing root composition (e.g. new Activity) about to run
                // composeContent() synchronously on this thread: claim slot atomically right now.
                val record = synchronized(lock) {
                    if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                        null
                    } else {
                        CompositionRecord(composition, gen, CompState.ATTACHING).also {
                            gen.compositions[composition] = it
                        }
                    }
                } ?: return
                attachRecord(record)
            }
        }
    }

    private fun handleCompositionUnregistered(gen: Generation, composition: ObservableComposition) {
        val handleToDispose = synchronized(lock) {
            val record = gen.compositions.remove(composition) ?: return
            record.state = CompState.DISPOSED
            val handle = record.handle
            record.handle = null
            handle
        }
        if (handleToDispose != null) {
            // Never call handle.dispose() synchronously inside Recomposer's stateLock callback.
            scheduleDispose(handleToDispose)
        }
    }

    private fun scheduleAttach(record: CompositionRecord, latch: CountDownLatch?) {
        taskScheduler(
            Runnable {
                try {
                    guarded {
                        val ready = synchronized(lock) {
                            if (!isGenerationActive(record.gen) ||
                                record.state != CompState.REGISTERED ||
                                record.gen.compositions[record.composition] !== record
                            ) {
                                false
                            } else {
                                record.state = CompState.ATTACHING
                                true
                            }
                        }
                        if (ready) attachRecord(record)
                    }
                } finally {
                    latch?.countDown()
                }
            },
        )
    }

    private fun scheduleDispose(handle: CompositionObserverHandle) {
        taskScheduler(Runnable { guarded { disposeHandle(handle) } })
    }

    /**
     * Atomically checks for an existing foreign observer, claims the slot via `setObserver()`, and publishes (or
     * rolls back) the handle under `CompositionImpl.lock` (the exact monitor used by `CompositionImpl.setObserver()`).
     */
    private fun attachRecord(record: CompositionRecord) {
        val gen = record.gen
        val composition = record.composition

        var conflictDetected = false
        var unsupportedDetected = false

        if (compositionImplClass.isInstance(composition)) {
            val compLock = try {
                compositionLockField.get(composition)
            } catch (t: Throwable) {
                if (isRuntimeIncompatibility(t)) {
                    failUnsupported()
                    return
                }
                if (isFatal(t)) throw t
                failUnsupported()
                return
            }
            if (compLock == null) {
                failUnsupported()
                return
            }
            // Acquire CompositionImpl.lock FIRST (same monitor as setObserver), then briefly acquire our leaf lock.
            // Lock order is strictly `compLock` -> `lock` (never reversed), eliminating deadlocks and check-then-set races.
            synchronized(compLock) {
                val stillAttaching = synchronized(lock) {
                    isGenerationActive(gen) &&
                        record.state == CompState.ATTACHING &&
                        gen.compositions[composition] === record
                }
                if (!stillAttaching) return

                when (peekObserverSlot(composition, gen.observer)) {
                    ObserverSlot.FAILED -> {
                        unsupportedDetected = true
                    }
                    ObserverSlot.FOREIGN -> {
                        conflictDetected = true
                    }
                    ObserverSlot.NONE, ObserverSlot.OURS -> {
                        if (record.missedInitial) {
                            synchronized(lock) {
                                if (isGenerationActive(gen)) coverageIncomplete = true
                            }
                        }
                        val handle = try {
                            composition.setObserver(gen.observer)
                        } catch (t: Throwable) {
                            if (isRuntimeIncompatibility(t)) {
                                unsupportedDetected = true
                                null
                            } else if (isFatal(t)) {
                                throw t
                            } else {
                                null
                            }
                        }
                        if (handle == null) {
                            synchronized(lock) {
                                if (record.state == CompState.ATTACHING && gen.compositions[composition] === record) {
                                    gen.compositions.remove(composition)
                                    record.state = CompState.DISPOSED
                                }
                            }
                        } else {
                            val published = synchronized(lock) {
                                if (isGenerationActive(gen) &&
                                    record.state == CompState.ATTACHING &&
                                    gen.compositions[composition] === record
                                ) {
                                    record.handle = handle
                                    record.state = CompState.ATTACHED
                                    true
                                } else {
                                    false
                                }
                            }
                            if (!published) {
                                // Generation ended or composition unregistered while attach was in flight:
                                // roll back immediately inside compLock (gen.observer identity guarantees we
                                // never clear a newer generation's observer).
                                disposeHandle(handle)
                            }
                        }
                    }
                }
            }
        } else {
            val stillAttaching = synchronized(lock) {
                isGenerationActive(gen) &&
                    record.state == CompState.ATTACHING &&
                    gen.compositions[composition] === record
            }
            if (!stillAttaching) return
            val handle = try {
                composition.setObserver(gen.observer)
            } catch (t: Throwable) {
                if (isRuntimeIncompatibility(t)) {
                    unsupportedDetected = true
                    null
                } else if (isFatal(t)) {
                    throw t
                } else {
                    null
                }
            }
            if (handle == null) {
                synchronized(lock) {
                    if (record.state == CompState.ATTACHING && gen.compositions[composition] === record) {
                        gen.compositions.remove(composition)
                        record.state = CompState.DISPOSED
                    }
                }
            } else {
                val published = synchronized(lock) {
                    if (isGenerationActive(gen) &&
                        record.state == CompState.ATTACHING &&
                        gen.compositions[composition] === record
                    ) {
                        record.handle = handle
                        record.state = CompState.ATTACHED
                        true
                    } else {
                        false
                    }
                }
                if (!published) {
                    if (inRegistrationCallback.get() == true) scheduleDispose(handle) else disposeHandle(handle)
                }
            }
        }

        if (unsupportedDetected) {
            failUnsupported()
        } else if (conflictDetected) {
            markConflict(gen)
        }
    }

    /**
     * Re-verifies that every `ATTACHED` `CompositionImpl` in the active generation still holds this generation's
     * observer. If another tool overwrote the slot after Lionscope attached, transitions immediately to `CONFLICT`.
     */
    private fun verifyOwnershipFast() {
        val snapshot = synchronized(lock) {
            val gen = currentGen ?: return
            if (!isGenerationActive(gen) || gen.compositions.isEmpty()) return
            val attached = ArrayList<ObservableComposition>(gen.compositions.size)
            for (record in gen.compositions.values) {
                if (record.state == CompState.ATTACHED && compositionImplClass.isInstance(record.composition)) {
                    attached.add(record.composition)
                }
            }
            if (attached.isEmpty()) return
            gen to attached
        }
        val (gen, attached) = snapshot
        for (composition in attached) {
            when (peekObserverSlot(composition, gen.observer)) {
                ObserverSlot.OURS -> Unit
                ObserverSlot.FOREIGN -> {
                    markConflict(gen)
                    return
                }
                ObserverSlot.NONE -> {
                    // Slot was cleared externally (e.g. another observer replaced ours then disposed);
                    // if the record is still ATTACHED in this generation, we lost ownership.
                    val stillAttached = synchronized(lock) {
                        isGenerationActive(gen) && gen.compositions[composition]?.state == CompState.ATTACHED
                    }
                    if (stillAttached) {
                        markConflict(gen)
                        return
                    }
                }
                ObserverSlot.FAILED -> {
                    failUnsupported()
                    return
                }
            }
        }
    }

    private fun peekObserverSlot(composition: ObservableComposition, mine: CompositionObserver): ObserverSlot {
        if (!compositionImplClass.isInstance(composition)) return ObserverSlot.NONE
        return try {
            val holder = observerHolderField.get(composition) ?: return ObserverSlot.FAILED
            val direct = holderGetObserver.invoke(holder)
            val effective = direct ?: holderCurrent.invoke(holder)
            when {
                effective == null -> ObserverSlot.NONE
                effective === mine -> ObserverSlot.OURS
                else -> ObserverSlot.FOREIGN
            }
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) ObserverSlot.FAILED
            else if (isFatal(t)) throw t
            else ObserverSlot.FAILED
        }
    }

    private fun isCompositionActive(composition: ObservableComposition): Boolean = try {
        (composition as? ControlledComposition)?.isComposing == true
    } catch (_: Throwable) {
        false
    }

    private fun isCompositionDisposed(composition: ObservableComposition): Boolean = try {
        (composition as? ControlledComposition)?.isDisposed == true
    } catch (_: Throwable) {
        false
    }

    private fun markConflict(gen: Generation) {
        endGeneration(targetGen = gen, markConflict = true, markUnsupported = false)
    }

    private fun failUnsupported() {
        endGeneration(targetGen = null, markConflict = false, markUnsupported = true)
    }

    private fun endGeneration(targetGen: Generation?, markConflict: Boolean, markUnsupported: Boolean) {
        val gen: Generation?
        val rHandles: List<CompositionObserverHandle>
        val cHandles: List<CompositionObserverHandle>
        synchronized(lock) {
            if (targetGen != null && currentGen !== targetGen) return
            if (markUnsupported) failedUnsupported = true
            observerConflict = markConflict && !failedUnsupported
            gen = currentGen
            currentGen = null
            capHit = false
            coverageIncomplete = false
            resetEpoch++
            counts.clear()
            drainQueueLocked()
            if (gen != null) {
                gen.active = false
                rHandles = gen.recomposers.values.toList()
                gen.recomposers.clear()
                cHandles = ArrayList(gen.compositions.size)
                for (record in gen.compositions.values) {
                    record.state = CompState.DISPOSED
                    record.handle?.let { cHandles.add(it) }
                    record.handle = null
                }
                gen.compositions.clear()
            } else {
                rHandles = emptyList()
                cHandles = emptyList()
            }
        }
        gen?.collectorScope?.cancel()
        val deferDispose = inRegistrationCallback.get() == true
        for (handle in cHandles) {
            if (deferDispose) scheduleDispose(handle) else disposeHandle(handle)
        }
        for (handle in rHandles) {
            if (deferDispose) scheduleDispose(handle) else disposeHandle(handle)
        }
    }

    private fun disposeHandle(handle: CompositionObserverHandle) {
        try {
            handle.dispose()
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) {
                if (!failedUnsupported) failUnsupported()
            } else if (isFatal(t)) {
                throw t
            }
        }
    }

    private fun getLocked(scope: Any): ScopeEntry? {
        lookupKey.scope = scope
        lookupKey.hash = System.identityHashCode(scope)
        return try {
            counts[lookupKey]
        } finally {
            lookupKey.scope = null
        }
    }

    private fun removeLocked(scope: Any) {
        lookupKey.scope = scope
        lookupKey.hash = System.identityHashCode(scope)
        try {
            counts.remove(lookupKey)
        } finally {
            lookupKey.scope = null
        }
    }

    private fun getOrCreateLocked(scope: RecomposeScope): ScopeEntry? {
        getLocked(scope)?.let { return it }
        // Once capacity has been exceeded or coverage is incomplete, freeze new insertions until reset() so
        // previously dropped or late-attached scopes cannot later report misleading partial counts.
        if (capHit || coverageIncomplete) return null
        drainQueueLocked()
        if (counts.size >= maxTrackedScopes) {
            capHit = true
            return null
        }
        val created = ScopeEntry()
        counts[IdentityWeakKey(scope, referenceQueue)] = created
        return created
    }

    private fun drainQueueLocked() {
        while (true) {
            val ref = referenceQueue.poll() ?: break
            counts.remove(ref)
        }
    }

    private fun invokeBooleanGetter(getter: Method, scope: RecomposeScope): Boolean? {
        if (!scopeImplClass.isInstance(scope)) {
            failUnsupported()
            return null
        }
        return try {
            val result = getter.invoke(scope)
            if (result is Boolean) result else {
                failUnsupported()
                null
            }
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                null
            } else if (isFatal(t)) {
                throw t
            } else {
                null
            }
        }
    }

    internal companion object {
        const val DEFAULT_MAX_TRACKED_SCOPES = 16_384
        private const val INITIAL_ATTACH_WAIT_MS = 100L
        private const val ATTACH_POOL_SIZE = 4
        private val workerCounter = AtomicInteger(0)

        /**
         * Bounded daemon pool so attaching one busy/blocked composition never blocks discovery of other recomposers
         * or attachment of sibling compositions.
         */
        private val attachExecutor: ExecutorService by lazy {
            Executors.newFixedThreadPool(ATTACH_POOL_SIZE) { runnable ->
                Thread(runnable, "lionscope-compose-${workerCounter.incrementAndGet()}").apply {
                    isDaemon = true
                }
            }
        }

        private fun defaultScheduleTask(task: Runnable) {
            attachExecutor.execute(task)
        }

        private fun isRuntimeIncompatibility(t: Throwable): Boolean =
            t is LinkageError || t is ReflectiveOperationException || t is SecurityException
    }
}

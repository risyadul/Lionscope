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
import java.util.ArrayDeque
import java.util.IdentityHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Compose runtime 1.9+ recomposition and skip tracker backed by a generation-scoped attachment state machine.
 *
 * Everything in this file links against `compileOnly` Compose runtime 1.9+ (`@ExperimentalComposeRuntimeApi`).
 * It is only loaded after [ComposeRecompositionSupport.probe] verifies every required public observer symbol,
 * `RecomposeScopeImpl` skip/rereading/owner members, and `CompositionImpl.lock` / `observerHolder`.
 *
 * State-machine invariants:
 * - **Enable generations & own-observer marker**: every `setEnabled(true)` (including retry after conflict) creates a
 *   fresh [Generation] whose [CompositionObserver] implements [LionscopeCompositionObserver]. Effective slot ownership
 *   is resolved through `CompositionObserverHolder.current()`, so cached/inherited references to a retired Lionscope
 *   generation are recognized as ours (replaced cleanly) rather than a foreign conflict, while foreign observers are
 *   preserved and reported as [RecompositionStatus.CONFLICT].
 * - **Non-blocking serial replay & implicit per-composition baseline**: `RecomposerInfo.observe()` only records known
 *   compositions while Compose holds `Recomposer.stateLock` (preventing deadlocks). All replayed compositions attach
 *   on one retiring serial background executor (never blocking the enabling/main thread or running-recomposer
 *   collector, even if a background `SideEffect` holds `CompositionImpl.lock` during apply). Every pre-enable
 *   replayed composition starts as `INCOMPLETE` (counts unavailable); once its observer is attached, an implicit
 *   per-composition baseline clears only that composition's scopes before marking it `EXACT` — removing any
 *   dependence on sampling `isComposing`. Generation-tagged enqueue and cancellation share one queue lock so ended
 *   generations can never enqueue stale work.
 * - **Per-composition coverage, no global freeze**: each [CompositionRecord] tracks its own [Coverage] (`EXACT` vs
 *   `INCOMPLETE`). A composition pending attachment or discovered post-enable after already composing reports
 *   unavailable counts (`null`, never `0/0`) for its own scopes while fully attached sibling compositions keep exact
 *   counts. Capacity overflow ([truncated]) remains monotonic until [reset].
 * - **Capture-level ownership verification**: [beginCapture]..[endCapture] verifies attached compositions ONCE across
 *   an entire multi-view Inspector capture (zero per-view or per-node scans), while standalone [countsFor] peeks at
 *   most the single scope's owning composition.
 */
@OptIn(ExperimentalComposeRuntimeApi::class)
internal class ComposeRecomposition19(
    private val scopeImplClass: Class<*>,
    private val skippedGetter: Method,
    private val rereadingGetter: Method,
    private val scopeOwnerField: Field? = null,
    private val compositionImplClass: Class<*>,
    private val compositionLockField: Field,
    private val observerHolderField: Field,
    private val holderGetObserver: Method,
    private val holderCurrent: Method,
    private val maxTrackedScopes: Int = DEFAULT_MAX_TRACKED_SCOPES,
    private val runningRecomposersFlow: () -> StateFlow<Set<RecomposerInfo>> = { Recomposer.runningRecomposers },
    private val customScheduler: ((Runnable) -> Unit)? = null,
) : ComposeRecompositionTracker {

    /** Marker implemented by every generation's observer so retired Lionscope observers are never misread as foreign. */
    private interface LionscopeCompositionObserver : CompositionObserver

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

    private enum class ObserverSlot { NONE, OURS_CURRENT, OURS_RETIRED, FOREIGN, FAILED }

    private enum class CompState { REGISTERED, ATTACHING, ATTACHED, DISPOSED }

    private enum class Coverage { EXACT, INCOMPLETE }

    private class CompositionRecord(
        val composition: ObservableComposition,
        val gen: Generation,
        var state: CompState,
        var coverage: Coverage,
        var missedInitial: Boolean = false,
        var handle: CompositionObserverHandle? = null,
    )

    private inner class Generation(val id: Long) {
        val observer: CompositionObserver = createCompositionObserver(this)
        val registrationObserver: CompositionRegistrationObserver = createRegistrationObserver(this)
        val collectorScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val recomposers = IdentityHashMap<RecomposerInfo, CompositionObserverHandle>()
        val compositions = IdentityHashMap<ObservableComposition, CompositionRecord>()
        var incompleteCount: Int = 0
        var active: Boolean = true

        /** Pre-built array of `ATTACHED` `CompositionImpl` instances so ownership checks allocate nothing. */
        @Volatile
        var attachedSnapshot: Array<ObservableComposition> = emptyArray()
    }

    /**
     * Single serial deferred executor with generation-tagged coalescing, immediate purge on generation end, and
     * idle thread retirement (`allowCoreThreadTimeOut = true`). Never spawns a thread unless deferred work occurs.
     */
    private class SerialDeferredExecutor {
        private class GenTask(val genId: Long, val key: Any?, val action: () -> Unit)

        private val queueLock = Any()
        private val pending = ArrayDeque<GenTask>()
        private var cancelledThroughGenId: Long = 0L
        private var drainScheduled = false
        private val worker: ThreadPoolExecutor by lazy {
            ThreadPoolExecutor(
                1,
                1,
                IDLE_KEEP_ALIVE_MS,
                TimeUnit.MILLISECONDS,
                LinkedBlockingQueue(),
            ) { runnable ->
                Thread(runnable, WORKER_THREAD_NAME).apply { isDaemon = true }
            }.apply {
                allowCoreThreadTimeOut(true)
            }
        }

        @Volatile
        private var workerCreated = false

        fun enqueue(genId: Long, key: Any?, action: () -> Unit): Boolean {
            synchronized(queueLock) {
                // Reject tasks for ended generations atomically under the same lock used by cancelGeneration().
                if (genId != DISPOSE_GEN_ID && genId <= cancelledThroughGenId) return false
                if (key != null && pending.any { it.genId == genId && it.key === key }) return true
                pending.addLast(GenTask(genId, key, action))
                if (!drainScheduled) {
                    drainScheduled = true
                    workerCreated = true
                    worker.execute(::drain)
                }
                return true
            }
        }

        fun cancelGeneration(genId: Long) {
            synchronized(queueLock) {
                if (genId > cancelledThroughGenId) cancelledThroughGenId = genId
                if (pending.isEmpty()) return
                val it = pending.iterator()
                while (it.hasNext()) {
                    val task = it.next()
                    if (task.genId != DISPOSE_GEN_ID && task.genId <= cancelledThroughGenId) it.remove()
                }
            }
        }

        fun pendingCount(): Int = synchronized(queueLock) { pending.size }

        fun poolSize(): Int = if (!workerCreated) 0 else worker.poolSize

        private fun drain() {
            while (true) {
                val next = synchronized(queueLock) {
                    if (pending.isEmpty()) {
                        drainScheduled = false
                        return
                    }
                    pending.removeFirst()
                }
                guarded { next.action() }
            }
        }
    }

    /** Private leaf lock: NEVER held across Compose `observe`, `setObserver`, `dispose`, or `CompositionImpl.lock`. */
    private val lock = Any()
    private val referenceQueue = ReferenceQueue<RecomposeScope>()
    private val counts = HashMap<Any, ScopeEntry>()
    private val lookupKey = LookupKey()
    private val deferredExecutor = SerialDeferredExecutor()

    @Volatile
    private var currentGen: Generation? = null
    private var nextGenerationId: Long = 0L
    private var resetEpoch: Long = 0L

    private val inObserveReplay = ThreadLocal<Boolean>()
    private val inPostEnableReplay = ThreadLocal<Boolean>()
    private val inRegistrationCallback = ThreadLocal<Boolean>()
    private val replayCollector = ThreadLocal<MutableList<CompositionRecord>?>()
    private val captureDepth = ThreadLocal<Int>()

    @Volatile
    private var capHit: Boolean = false

    @Volatile
    private var observerConflict: Boolean = false

    @Volatile
    private var failedUnsupported: Boolean = false

    @Volatile
    private var ownershipChecksForTest: Long = 0L

    override val status: RecompositionStatus
        get() {
            // Reuse the outer capture's ownership verification when inside beginCapture()..endCapture().
            if ((captureDepth.get() ?: 0) == 0) verifyOwnershipAll()
            return rawStatus()
        }

    override val truncated: Boolean
        get() = capHit

    override val incompleteCoverage: Boolean
        get() = synchronized(lock) {
            val gen = currentGen
            gen != null && isGenerationActive(gen) && gen.incompleteCount > 0
        }

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
        object : LionscopeCompositionObserver {
            override fun onBeginComposition(composition: ObservableComposition) = Unit

            override fun onEndComposition(composition: ObservableComposition) = Unit

            override fun onScopeInvalidated(scope: RecomposeScope, value: Any?) = Unit

            override fun onScopeEnter(scope: RecomposeScope) {
                if (currentGen !== gen || failedUnsupported || observerConflict) return
                val owner = scopeOwner(scope)
                guarded {
                    synchronized(lock) {
                        if (!isGenerationActive(gen)) return@synchronized
                        if (owner != null && compositionImplClass.isInstance(owner)) {
                            val record = gen.compositions[owner]
                            if (record == null || record.coverage != Coverage.EXACT) return@synchronized
                        }
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
                        // or on an incomplete composition, or after capHit froze insertions) are discarded.
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
            verifyOwnershipAll()
            val gen = synchronized(lock) {
                if (failedUnsupported) return
                // If already active and healthy, keep the current generation.
                // If OFF or CONFLICT (Retry), create a brand-new generation with a fresh observer identity.
                if (currentGen != null && !observerConflict) {
                    null
                } else {
                    observerConflict = false
                    capHit = false
                    resetEpoch++
                    counts.clear()
                    drainQueueLocked()
                    Generation(++nextGenerationId).also { currentGen = it }
                }
            } ?: return
            startCollectingRecomposers(gen)
        } else {
            endGeneration(targetGen = null, markConflict = false, markUnsupported = false)
        }
    }

    override fun rescan() {
        if ((captureDepth.get() ?: 0) == 0) verifyOwnershipAll()
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
            val gen = currentGen ?: return
            var incomplete = 0
            for (record in gen.compositions.values) {
                if (record.state == CompState.ATTACHED) {
                    // Attached compositions get a clean exact baseline after reset.
                    record.missedInitial = false
                    record.coverage = Coverage.EXACT
                } else {
                    // Compositions still pending attachment remain incomplete even after reset until attached & reset.
                    record.missedInitial = true
                    record.coverage = Coverage.INCOMPLETE
                    incomplete++
                }
            }
            gen.incompleteCount = incomplete
        }
    }

    override fun beginCapture() {
        val depth = captureDepth.get() ?: 0
        if (depth == 0) verifyOwnershipAll()
        captureDepth.set(depth + 1)
    }

    override fun endCapture() {
        val depth = captureDepth.get() ?: 0
        if (depth <= 1) captureDepth.remove() else captureDepth.set(depth - 1)
    }

    override fun countsFor(scope: Any): RecompositionCounts? {
        val gen = currentGen ?: return null
        if (!isGenerationActive(gen)) return null

        val owner = scopeOwner(scope)
        val owningComp = if (owner != null && compositionImplClass.isInstance(owner)) {
            owner as ObservableComposition
        } else {
            null
        }

        // Outside a capture window (where beginCapture already verified every attached composition once),
        // verify ONLY this scope's owning composition in O(1) with zero allocations.
        if (owningComp != null && (captureDepth.get() ?: 0) == 0) {
            if (!verifySingleOwner(gen, owningComp)) return null
        }

        return synchronized(lock) {
            if (!isGenerationActive(gen)) return@synchronized null
            if (owningComp != null) {
                val record = gen.compositions[owningComp]
                if (record == null || record.coverage != Coverage.EXACT) return@synchronized null
            }
            val entry = getLocked(scope)
            when {
                entry != null -> RecompositionCounts(entry.recompositions, entry.skips)
                capHit -> null // Capacity reached: never fabricate 0/0 for dropped scopes.
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

    /** Number of pending deferred tasks in the internal serial executor (tests). */
    internal fun deferredPendingCount(): Int = deferredExecutor.pendingCount()

    /** Current worker pool size of the internal serial executor (tests). */
    internal fun deferredPoolSize(): Int = deferredExecutor.poolSize()

    /** Total reflective `CompositionObserverHolder` slot checks performed (tests). */
    internal fun ownershipCheckCountForTest(): Long = ownershipChecksForTest

    /** Exposes the active generation's observer for targeted unit tests. */
    internal fun observerForTest(): Any = synchronized(lock) {
        checkNotNull(currentGen) { "Tracker is not enabled" }.observer
    }

    private fun startCollectingRecomposers(gen: Generation) {
        val flow = try {
            runningRecomposersFlow()
        } catch (t: Throwable) {
            gen.collectorScope.cancel()
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                return
            }
            if (isFatal(t)) throw t
            return
        }
        var firstEmission = true
        gen.collectorScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                flow.collect { running ->
                    if (!isGenerationActive(gen)) return@collect
                    val isInitial = firstEmission
                    firstEmission = false
                    guarded { discoverRecomposers(gen, running, isInitialEnable = isInitial) }
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
    }

    /**
     * Observes all newly discovered Recomposers FIRST (collecting replayed compositions without calling `setObserver`
     * inside `observe()`), then attaches idle replayed compositions serially on this thread now that `stateLock` is
     * released. Only actively-composing compositions are deferred to the single retiring serial executor.
     */
    private fun discoverRecomposers(
        gen: Generation,
        running: Set<RecomposerInfo>,
        isInitialEnable: Boolean,
    ) {
        if (!isGenerationActive(gen)) return

        val staleHandles = synchronized(lock) {
            if (!isGenerationActive(gen)) return
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
        for (handle in staleHandles) disposeOrDefer(handle)

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
                    return
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
            if (!keep) disposeOrDefer(handle)
        }

        if (replayedRecords.isEmpty()) return
        // Always attach replayed compositions on the single serial background worker:
        // - Never blocks the enabling/main thread or running-recomposer collector (e.g. if a background apply/SideEffect
        //   holds CompositionImpl.lock while isComposing == false).
        // - Never samples isComposing to decide coverage: each replayed composition stays INCOMPLETE (counts unavailable)
        //   until its observer is attached and its per-composition baseline is taken atomically inside compLock.
        for (record in replayedRecords) {
            if (!isGenerationActive(gen)) break
            enqueueDeferredAttach(record)
        }
    }

    private fun handleCompositionRegistered(gen: Generation, composition: ObservableComposition) {
        if (!isGenerationActive(gen)) return
        if (isCompositionDisposed(composition)) return

        // Case 1: Replay inside RecomposerInfo.observe() while Recomposer holds stateLock.
        // NEVER acquire CompositionImpl.lock or call setObserver() here: create a REGISTERED (INCOMPLETE) record
        // and let discoverRecomposers attach it serially once observe() releases stateLock.
        if (inObserveReplay.get() == true) {
            val missed = inPostEnableReplay.get() == true
            val record = synchronized(lock) {
                if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                    null
                } else {
                    addRecordLocked(
                        gen,
                        CompositionRecord(
                            composition = composition,
                            gen = gen,
                            state = CompState.REGISTERED,
                            coverage = Coverage.INCOMPLETE,
                            missedInitial = missed,
                        ),
                    )
                }
            }
            if (record != null) {
                val batch = replayCollector.get()
                if (batch != null) batch.add(record) else enqueueDeferredAttach(record)
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
            ObserverSlot.OURS_CURRENT -> {
                // Subcomposition already inherits gen.observer from its parent during initial composition:
                // its initial composition IS observed (EXACT); defer explicit handle upgrade off-lock.
                val record = synchronized(lock) {
                    if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                        null
                    } else {
                        addRecordLocked(
                            gen,
                            CompositionRecord(
                                composition = composition,
                                gen = gen,
                                state = CompState.REGISTERED,
                                coverage = Coverage.EXACT,
                            ),
                        )
                    }
                }
                if (record != null) enqueueDeferredAttach(record)
                return
            }
            ObserverSlot.NONE, ObserverSlot.OURS_RETIRED -> {
                // If already composing, defer off-lock and mark THIS composition incomplete (never global freeze).
                if (isCompositionActive(composition)) {
                    val record = synchronized(lock) {
                        if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                            null
                        } else {
                            addRecordLocked(
                                gen,
                                CompositionRecord(
                                    composition = composition,
                                    gen = gen,
                                    state = CompState.REGISTERED,
                                    coverage = Coverage.INCOMPLETE,
                                    missedInitial = true,
                                ),
                            )
                        }
                    }
                    if (record != null) enqueueDeferredAttach(record)
                    return
                }
                // Brand-new, unobserved, non-composing root composition about to run composeContent()
                // synchronously on this thread: claim slot atomically right now so initial composition is counted.
                val record = synchronized(lock) {
                    if (!isGenerationActive(gen) || gen.compositions.containsKey(composition)) {
                        null
                    } else {
                        addRecordLocked(
                            gen,
                            CompositionRecord(
                                composition = composition,
                                gen = gen,
                                state = CompState.ATTACHING,
                                coverage = Coverage.EXACT,
                            ),
                        )
                    }
                } ?: return
                attachRecord(record)
            }
        }
    }

    private fun handleCompositionUnregistered(gen: Generation, composition: ObservableComposition) {
        val handleToDispose = synchronized(lock) {
            val record = removeRecordLocked(gen, composition) ?: return
            val handle = record.handle
            record.handle = null
            handle
        }
        if (handleToDispose != null) {
            // Never call handle.dispose() synchronously inside Recomposer's stateLock callback.
            enqueueDeferredDispose(handleToDispose)
        }
    }

    private fun enqueueDeferredAttach(record: CompositionRecord) {
        val action = {
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
        val custom = customScheduler
        if (custom != null) {
            custom(Runnable { guarded { action() } })
        } else {
            deferredExecutor.enqueue(record.gen.id, record.composition, action)
        }
    }

    private fun disposeOrDefer(handle: CompositionObserverHandle) {
        if (inRegistrationCallback.get() == true) {
            enqueueDeferredDispose(handle)
        } else {
            disposeHandle(handle)
        }
    }

    private fun enqueueDeferredDispose(handle: CompositionObserverHandle) {
        val custom = customScheduler
        if (custom != null) {
            custom(Runnable { guarded { disposeHandle(handle) } })
        } else {
            deferredExecutor.enqueue(DISPOSE_GEN_ID, handle) { disposeHandle(handle) }
        }
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
                    ObserverSlot.NONE, ObserverSlot.OURS_CURRENT, ObserverSlot.OURS_RETIRED -> {
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
                                    removeRecordLocked(gen, composition)
                                }
                            }
                        } else {
                            val published = synchronized(lock) {
                                if (isGenerationActive(gen) &&
                                    record.state == CompState.ATTACHING &&
                                    gen.compositions[composition] === record
                                ) {
                                    // Implicit per-composition baseline at attach time for pre-enable replays:
                                    // clear any stale entries for this composition only before transitioning to EXACT.
                                    if (record.coverage == Coverage.INCOMPLETE && !record.missedInitial) {
                                        clearScopesForCompositionLocked(composition)
                                    }
                                    record.handle = handle
                                    record.state = CompState.ATTACHED
                                    setCoverageLocked(
                                        gen,
                                        record,
                                        if (record.missedInitial) Coverage.INCOMPLETE else Coverage.EXACT,
                                    )
                                    rebuildAttachedSnapshotLocked(gen)
                                    true
                                } else {
                                    false
                                }
                            }
                            if (!published) {
                                // Generation ended or composition unregistered while attach was in flight:
                                // roll back immediately inside compLock (unique gen.observer prevents touching newer gens).
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
                        removeRecordLocked(gen, composition)
                    }
                }
            } else {
                val published = synchronized(lock) {
                    if (isGenerationActive(gen) &&
                        record.state == CompState.ATTACHING &&
                        gen.compositions[composition] === record
                    ) {
                        if (record.coverage == Coverage.INCOMPLETE && !record.missedInitial) {
                            clearScopesForCompositionLocked(composition)
                        }
                        record.handle = handle
                        record.state = CompState.ATTACHED
                        setCoverageLocked(
                            gen,
                            record,
                            if (record.missedInitial) Coverage.INCOMPLETE else Coverage.EXACT,
                        )
                        rebuildAttachedSnapshotLocked(gen)
                        true
                    } else {
                        false
                    }
                }
                if (!published) disposeOrDefer(handle)
            }
        }

        if (unsupportedDetected) {
            failUnsupported()
        } else if (conflictDetected) {
            markConflict(gen)
        }
    }

    /**
     * Re-verifies every `ATTACHED` `CompositionImpl` in the active generation using its pre-built [Generation.attachedSnapshot]
     * array (zero per-call allocation). Called once per capture ([beginCapture]) and on [status] / [rescan] / [setEnabled].
     */
    private fun verifyOwnershipAll() {
        val gen = currentGen ?: return
        if (!isGenerationActive(gen)) return
        val attached = gen.attachedSnapshot
        if (attached.isEmpty()) return
        for (composition in attached) {
            if (!verifySingleOwner(gen, composition)) return
        }
    }

    /**
     * O(1), zero-allocation ownership check for a single `CompositionImpl`. Returns false if ownership was lost or
     * runtime inspection failed (having already transitioned the generation to `CONFLICT` or `UNSUPPORTED`).
     */
    private fun verifySingleOwner(gen: Generation, composition: ObservableComposition): Boolean {
        val isAttached = synchronized(lock) {
            isGenerationActive(gen) && gen.compositions[composition]?.state == CompState.ATTACHED
        }
        if (!isAttached) return isGenerationActive(gen)
        return when (peekObserverSlot(composition, gen.observer)) {
            ObserverSlot.OURS_CURRENT -> true
            ObserverSlot.FOREIGN, ObserverSlot.OURS_RETIRED -> {
                markConflict(gen)
                false
            }
            ObserverSlot.NONE -> {
                val stillAttached = synchronized(lock) {
                    isGenerationActive(gen) && gen.compositions[composition]?.state == CompState.ATTACHED
                }
                if (stillAttached) {
                    markConflict(gen)
                    false
                } else {
                    isGenerationActive(gen)
                }
            }
            ObserverSlot.FAILED -> {
                failUnsupported()
                false
            }
        }
    }

    /**
     * Resolves effective ownership of [composition]'s observer slot via `CompositionObserverHolder.current()`.
     * For inherited holders (`root == false`), `current()` refreshes from the parent context so a stale cached
     * reference from a retired Lionscope generation is cleared rather than misreported as a foreign conflict.
     */
    private fun peekObserverSlot(composition: ObservableComposition, mine: CompositionObserver): ObserverSlot {
        if (!compositionImplClass.isInstance(composition)) return ObserverSlot.NONE
        ownershipChecksForTest++
        return try {
            val holder = observerHolderField.get(composition) ?: return ObserverSlot.FAILED
            val effective = holderCurrent.invoke(holder)
            when {
                effective == null -> ObserverSlot.NONE
                effective === mine -> ObserverSlot.OURS_CURRENT
                effective is LionscopeCompositionObserver -> ObserverSlot.OURS_RETIRED
                else -> ObserverSlot.FOREIGN
            }
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) ObserverSlot.FAILED
            else if (isFatal(t)) throw t
            else ObserverSlot.FAILED
        }
    }

    private fun scopeOwner(scope: Any): Any? {
        val field = scopeOwnerField ?: return null
        if (!scopeImplClass.isInstance(scope)) return null
        return try {
            field.get(scope)
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

    private fun clearScopesForCompositionLocked(composition: ObservableComposition) {
        if (counts.isEmpty() || scopeOwnerField == null) return
        val iterator = counts.entries.iterator()
        while (iterator.hasNext()) {
            val key = iterator.next().key as? IdentityWeakKey ?: continue
            val scope = key.get()
            if (scope == null || scopeOwner(scope) === composition) {
                iterator.remove()
            }
        }
    }

    private fun addRecordLocked(gen: Generation, record: CompositionRecord): CompositionRecord {
        gen.compositions[record.composition] = record
        if (record.coverage == Coverage.INCOMPLETE) gen.incompleteCount++
        return record
    }

    private fun setCoverageLocked(gen: Generation, record: CompositionRecord, coverage: Coverage) {
        if (record.coverage == coverage) return
        if (record.coverage == Coverage.INCOMPLETE) gen.incompleteCount--
        record.coverage = coverage
        if (coverage == Coverage.INCOMPLETE) gen.incompleteCount++
    }

    private fun removeRecordLocked(gen: Generation, composition: ObservableComposition): CompositionRecord? {
        val record = gen.compositions.remove(composition) ?: return null
        val wasAttached = record.state == CompState.ATTACHED
        if (record.coverage == Coverage.INCOMPLETE) gen.incompleteCount--
        record.state = CompState.DISPOSED
        if (wasAttached) rebuildAttachedSnapshotLocked(gen)
        return record
    }

    private fun rebuildAttachedSnapshotLocked(gen: Generation) {
        val list = ArrayList<ObservableComposition>(gen.compositions.size)
        for (record in gen.compositions.values) {
            if (record.state == CompState.ATTACHED && compositionImplClass.isInstance(record.composition)) {
                list.add(record.composition)
            }
        }
        gen.attachedSnapshot = if (list.isEmpty()) emptyArray() else list.toTypedArray()
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
            resetEpoch++
            counts.clear()
            drainQueueLocked()
            if (gen != null) {
                gen.active = false
                gen.incompleteCount = 0
                gen.attachedSnapshot = emptyArray()
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
        if (gen != null) {
            gen.collectorScope.cancel()
            deferredExecutor.cancelGeneration(gen.id)
        }
        for (handle in cHandles) disposeOrDefer(handle)
        for (handle in rHandles) disposeOrDefer(handle)
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
        // Once capacity has been exceeded, freeze new insertions until reset() so previously dropped scopes
        // cannot later report misleading partial counts after another scope is disposed.
        if (capHit) return null
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
        private const val DISPOSE_GEN_ID = -1L
        private const val IDLE_KEEP_ALIVE_MS = 100L
        const val WORKER_THREAD_NAME = "lionscope-compose-worker"

        private fun isRuntimeIncompatibility(t: Throwable): Boolean =
            t is LinkageError || t is ReflectiveOperationException || t is SecurityException
    }
}

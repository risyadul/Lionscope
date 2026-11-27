package io.github.risyadul.lionscope

import android.os.Handler
import android.os.Looper
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
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Compose runtime 1.9+ recomposition and skip tracker.
 *
 * Everything in this file links against `compileOnly` Compose runtime 1.9+ (`@ExperimentalComposeRuntimeApi`).
 * It is only loaded after [ComposeRecompositionSupport.probe] verifies every required public observer symbol,
 * `RecomposeScopeImpl` skip/rereading getters, and `CompositionImpl.observerHolder`.
 *
 * Counts follow Android Studio semantics: counts since tracking was enabled or last [reset]. A composable first
 * composed while tracking is active (e.g. a newly scrolled `LazyColumn` item or a new Activity) counts its initial
 * composition as 1.
 *
 * Threading, deadlock avoidance & conflict safety:
 * - Single private [lock] guards the bounded weak-identity scope map, handle registries, and pending queues.
 * - [lock] is never held across Compose observer registration/disposal calls.
 * - `RecomposerInfo.observe()` replays already-known compositions while holding Compose's `stateLock`. Calling
 *   `setObserver()` inside that replay acquires `CompositionImpl.lock`, which deadlocks against a composing thread
 *   holding `CompositionImpl.lock` and entering `Recomposer.composeInitial()` (`stateLock`). Therefore replay
 *   callbacks only enqueue compositions and drain immediately AFTER `observe()` returns (outside `stateLock`).
 * - `onCompositionUnregistered()` never calls `handle.dispose()` synchronously; handles are queued and disposed
 *   outside Compose locks.
 * - Existing observers on `CompositionImpl.observerHolder` are detected before calling `setObserver()`; an occupied
 *   slot is never displaced and transitions [status] to [RecompositionStatus.CONFLICT].
 * - While enabled, collects [runningRecomposersFlow] (`Recomposer.runningRecomposers`) undispatched so newly created
 *   window Recomposers (e.g. a fresh Activity) are observed before their first `composeInitial`.
 * - Any runtime linkage/access error transitions permanently to [RecompositionStatus.UNSUPPORTED].
 */
@OptIn(ExperimentalComposeRuntimeApi::class)
internal class ComposeRecomposition19(
    private val scopeImplClass: Class<*>,
    private val skippedGetter: Method,
    private val rereadingGetter: Method,
    private val compositionImplClass: Class<*>,
    private val observerHolderField: Field,
    private val holderGetObserver: Method,
    private val holderCurrent: Method,
    private val maxTrackedScopes: Int = DEFAULT_MAX_TRACKED_SCOPES,
    private val runningRecomposersFlow: () -> StateFlow<Set<RecomposerInfo>> = { Recomposer.runningRecomposers },
    private val scheduleDrain: (Runnable) -> Unit = ::defaultScheduleDrain,
) : ComposeRecompositionTracker {

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

    private val lock = Any()
    private val referenceQueue = ReferenceQueue<RecomposeScope>()
    private val counts = HashMap<Any, ScopeEntry>()
    private val lookupKey = LookupKey()
    private val recomposerHandles = IdentityHashMap<RecomposerInfo, CompositionObserverHandle>()
    private val compositionHandles = IdentityHashMap<ObservableComposition, CompositionObserverHandle>()
    private val pendingAttach = Collections.newSetFromMap(IdentityHashMap<ObservableComposition, Boolean>())
    private val pendingDispose = ArrayList<CompositionObserverHandle>()
    private var collectorScope: CoroutineScope? = null
    private var resetEpoch: Long = 0L
    private var drainScheduled: Boolean = false

    private val inObserveReplay = ThreadLocal<Boolean>()
    private val inRegistrationCallback = ThreadLocal<Boolean>()

    @Volatile
    private var enabled: Boolean = false

    @Volatile
    private var capHit: Boolean = false

    @Volatile
    private var observerConflict: Boolean = false

    @Volatile
    private var failedUnsupported: Boolean = false

    override val status: RecompositionStatus
        get() = when {
            failedUnsupported -> RecompositionStatus.UNSUPPORTED
            observerConflict -> RecompositionStatus.CONFLICT
            enabled -> RecompositionStatus.ACTIVE
            else -> RecompositionStatus.OFF
        }

    override val truncated: Boolean
        get() = capHit

    private val drainRunnable = Runnable { guarded { drainPending() } }

    private val registrationObserver = object : CompositionRegistrationObserver {
        override fun onCompositionRegistered(composition: ObservableComposition) {
            val prevInCallback = inRegistrationCallback.get() == true
            inRegistrationCallback.set(true)
            try {
                guarded { handleCompositionRegistered(composition) }
            } finally {
                inRegistrationCallback.set(prevInCallback)
            }
        }

        override fun onCompositionUnregistered(composition: ObservableComposition) {
            val prevInCallback = inRegistrationCallback.get() == true
            inRegistrationCallback.set(true)
            try {
                guarded {
                    val shouldSchedule = synchronized(lock) {
                        pendingAttach.remove(composition)
                        val handle = compositionHandles.remove(composition)
                        if (handle != null) {
                            pendingDispose.add(handle)
                            scheduleDrainLocked()
                        } else {
                            false
                        }
                    }
                    if (shouldSchedule && inObserveReplay.get() != true) {
                        scheduleDrain(drainRunnable)
                    }
                }
            } finally {
                inRegistrationCallback.set(prevInCallback)
            }
        }
    }

    private val compositionObserver = object : CompositionObserver {
        override fun onBeginComposition(composition: ObservableComposition) = Unit

        override fun onEndComposition(composition: ObservableComposition) = Unit

        override fun onScopeInvalidated(scope: RecomposeScope, value: Any?) = Unit

        override fun onScopeEnter(scope: RecomposeScope) {
            if (!isActive()) return
            guarded {
                synchronized(lock) {
                    if (!isActive()) return@synchronized
                    val entry = getOrCreateLocked(scope) ?: return@synchronized
                    entry.activePassDepth++
                    entry.passEpoch = resetEpoch
                    entry.sawRereadingInPass = false
                }
            }
        }

        override fun onReadInScope(scope: RecomposeScope, value: Any) {
            if (!isActive()) return
            val rereading = invokeBooleanGetter(rereadingGetter, scope) ?: return
            if (!rereading) return
            guarded {
                synchronized(lock) {
                    if (!isActive()) return@synchronized
                    getLocked(scope)?.sawRereadingInPass = true
                }
            }
        }

        override fun onScopeExit(scope: RecomposeScope) {
            if (!isActive()) return
            val skipped = invokeBooleanGetter(skippedGetter, scope) ?: return
            guarded {
                synchronized(lock) {
                    if (!isActive()) return@synchronized
                    // Never fabricate a fresh entry on exit: a pass that began before reset() (or before attach)
                    // is discarded rather than misclassified when sawRereadingInPass was cleared by reset().
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
                    removeLocked(scope)
                }
            }
        }
    }

    override fun setEnabled(enabled: Boolean) {
        if (enabled) {
            if (failedUnsupported) return
            val scopeToStart = synchronized(lock) {
                if (failedUnsupported) return
                if (this.enabled && !observerConflict) {
                    null
                } else {
                    observerConflict = false
                    this.enabled = true
                    capHit = false
                    resetEpoch++
                    collectorScope?.cancel()
                    CoroutineScope(SupervisorJob() + Dispatchers.Unconfined).also { collectorScope = it }
                }
            } ?: return
            startCollectingRecomposers(scopeToStart)
        } else {
            detachAll(markConflict = false, markUnsupported = false)
        }
    }

    override fun rescan() {
        if (!isActive()) return
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
        syncRecomposers(running)
        drainPending()
    }

    override fun reset() {
        synchronized(lock) {
            resetEpoch++
            counts.clear()
            drainQueueLocked()
            capHit = false
        }
    }

    override fun countsFor(scope: Any): RecompositionCounts? {
        if (!isActive()) return null
        return synchronized(lock) {
            if (!isActive()) return@synchronized null
            val entry = getLocked(scope)
            when {
                entry != null -> RecompositionCounts(entry.recompositions, entry.skips)
                capHit -> null // Capacity was hit: unknown whether this scope executed; never misreport 0/0.
                else -> RecompositionCounts.ZERO
            }
        }
    }

    /** Number of live scope entries currently stored (tests). */
    internal fun trackedScopeCount(): Int = synchronized(lock) {
        drainQueueLocked()
        counts.size
    }

    /** Number of currently attached Recomposers (tests). */
    internal fun attachedRecomposerCount(): Int = synchronized(lock) { recomposerHandles.size }

    /** Number of currently attached Compositions (tests). */
    internal fun attachedCompositionCount(): Int = synchronized(lock) { compositionHandles.size }

    /** Exposes the observer for targeted unit tests (e.g. reset during derived-state reread). */
    internal fun observerForTest(): Any = compositionObserver

    private fun isActive(): Boolean = enabled && !failedUnsupported && !observerConflict

    private fun startCollectingRecomposers(scope: CoroutineScope) {
        val flow = try {
            runningRecomposersFlow()
        } catch (t: Throwable) {
            scope.cancel()
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                return
            }
            if (isFatal(t)) throw t
            return
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                flow.collect { running ->
                    if (!isActive()) return@collect
                    guarded { syncRecomposers(running) }
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

    private fun syncRecomposers(running: Set<RecomposerInfo>) {
        if (!isActive()) return

        // Prune handles for Recomposers that are no longer running so finished Activities do not accumulate.
        val staleHandles = synchronized(lock) {
            if (!isActive()) return
            val stale = ArrayList<CompositionObserverHandle>()
            val iterator = recomposerHandles.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key !in running) {
                    stale.add(entry.value)
                    iterator.remove()
                }
            }
            stale
        }
        for (handle in staleHandles) disposeHandle(handle)

        for (info in running) {
            if (!isActive()) return
            val alreadyAttached = synchronized(lock) { !isActive() || recomposerHandles.containsKey(info) }
            if (alreadyAttached) continue
            val prevReplay = inObserveReplay.get() == true
            inObserveReplay.set(true)
            val handle = try {
                info.observe(registrationObserver)
            } catch (t: Throwable) {
                if (isRuntimeIncompatibility(t)) {
                    failUnsupported()
                    return
                }
                if (isFatal(t)) throw t
                null
            } finally {
                inObserveReplay.set(prevReplay)
            } ?: continue
            val keep = synchronized(lock) {
                if (isActive() && !recomposerHandles.containsKey(info)) {
                    recomposerHandles[info] = handle
                    true
                } else {
                    false
                }
            }
            if (!keep) disposeHandle(handle)
        }
        // Drain any compositions replayed inside observe() now that Recomposer's stateLock has been released.
        drainPending()
    }

    private fun handleCompositionRegistered(composition: ObservableComposition) {
        if (!isActive()) return
        // During RecomposerInfo.observe() replay, Recomposer holds stateLock for already-known compositions whose
        // locks may be held by composing threads: NEVER call setObserver() here. Queue and drain after observe().
        if (inObserveReplay.get() == true) {
            enqueuePendingAttach(composition, schedule = false)
            return
        }
        when (inspectObserverSlot(composition)) {
            ObserverSlot.FAILED -> {
                failUnsupported()
                return
            }
            ObserverSlot.FOREIGN -> {
                markConflict()
                return
            }
            ObserverSlot.OURS -> {
                // Subcomposition already inherits our observer from its parent during initial composition:
                // defer explicit handle registration outside Compose locks.
                enqueuePendingAttach(composition, schedule = true)
                return
            }
            ObserverSlot.NONE -> {
                // If already composing, never acquire composition.lock inside registration callback; queue instead.
                if (isCompositionActive(composition)) {
                    enqueuePendingAttach(composition, schedule = true)
                    return
                }
                // Brand-new, unobserved, non-composing root composition (e.g. fresh Activity) about to run
                // composeContent() synchronously on this thread: attach now to keep initial-count semantics.
                attachComposition(composition)
            }
        }
    }

    private fun enqueuePendingAttach(composition: ObservableComposition, schedule: Boolean) {
        val shouldSchedule = synchronized(lock) {
            if (!isActive() || compositionHandles.containsKey(composition)) return
            pendingAttach.add(composition)
            if (schedule) scheduleDrainLocked() else false
        }
        if (shouldSchedule) scheduleDrain(drainRunnable)
    }

    private fun scheduleDrainLocked(): Boolean {
        if (drainScheduled) return false
        drainScheduled = true
        return true
    }

    private fun drainPending() {
        while (true) {
            val toDispose: List<CompositionObserverHandle>
            val toAttach: List<ObservableComposition>
            synchronized(lock) {
                drainScheduled = false
                toDispose = if (pendingDispose.isEmpty()) emptyList() else ArrayList(pendingDispose).also {
                    pendingDispose.clear()
                }
                toAttach = if (!isActive() || pendingAttach.isEmpty()) {
                    pendingAttach.clear()
                    emptyList()
                } else {
                    ArrayList(pendingAttach).also { pendingAttach.clear() }
                }
            }
            if (toDispose.isEmpty() && toAttach.isEmpty()) return
            for (handle in toDispose) disposeHandle(handle)
            for (composition in toAttach) {
                if (!isActive()) break
                attachComposition(composition)
            }
        }
    }

    private fun attachComposition(composition: ObservableComposition) {
        val skip = synchronized(lock) { !isActive() || compositionHandles.containsKey(composition) }
        if (skip) return
        when (inspectObserverSlot(composition)) {
            ObserverSlot.FAILED -> {
                failUnsupported()
                return
            }
            ObserverSlot.FOREIGN -> {
                markConflict()
                return
            }
            ObserverSlot.NONE, ObserverSlot.OURS -> Unit
        }
        val handle = try {
            composition.setObserver(compositionObserver)
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) {
                failUnsupported()
                return
            }
            if (isFatal(t)) throw t
            return
        }
        val keep = synchronized(lock) {
            if (isActive() && !compositionHandles.containsKey(composition)) {
                compositionHandles[composition] = handle
                true
            } else {
                false
            }
        }
        if (!keep) disposeHandle(handle)
    }

    private fun inspectObserverSlot(composition: ObservableComposition): ObserverSlot {
        if (!compositionImplClass.isInstance(composition)) return ObserverSlot.NONE
        return try {
            val holder = observerHolderField.get(composition) ?: return ObserverSlot.FAILED
            val direct = holderGetObserver.invoke(holder)
            val effective = direct ?: holderCurrent.invoke(holder)
            when {
                effective == null -> ObserverSlot.NONE
                effective === compositionObserver -> ObserverSlot.OURS
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

    private fun markConflict() {
        detachAll(markConflict = true, markUnsupported = false)
    }

    private fun failUnsupported() {
        detachAll(markConflict = false, markUnsupported = true)
    }

    private fun detachAll(markConflict: Boolean, markUnsupported: Boolean) {
        val rHandles: List<CompositionObserverHandle>
        val cHandles: List<CompositionObserverHandle>
        val queuedDisposals: List<CompositionObserverHandle>
        val scopeToCancel: CoroutineScope?
        val deferDispose = inRegistrationCallback.get() == true
        var shouldSchedule = false
        synchronized(lock) {
            if (markUnsupported) failedUnsupported = true
            observerConflict = markConflict && !failedUnsupported
            this.enabled = false
            capHit = false
            resetEpoch++
            scopeToCancel = collectorScope
            collectorScope = null
            pendingAttach.clear()
            rHandles = recomposerHandles.values.toList()
            recomposerHandles.clear()
            cHandles = compositionHandles.values.toList()
            compositionHandles.clear()
            counts.clear()
            drainQueueLocked()
            if (deferDispose) {
                pendingDispose.addAll(cHandles)
                pendingDispose.addAll(rHandles)
                queuedDisposals = emptyList()
                shouldSchedule = pendingDispose.isNotEmpty() && scheduleDrainLocked()
            } else {
                queuedDisposals = if (pendingDispose.isEmpty()) emptyList() else ArrayList(pendingDispose).also {
                    pendingDispose.clear()
                }
            }
        }
        scopeToCancel?.cancel()
        if (deferDispose) {
            if (shouldSchedule && inObserveReplay.get() != true) scheduleDrain(drainRunnable)
            return
        }
        for (handle in queuedDisposals) disposeHandle(handle)
        for (handle in cHandles) disposeHandle(handle)
        for (handle in rHandles) disposeHandle(handle)
    }

    private fun disposeHandle(handle: CompositionObserverHandle) {
        try {
            handle.dispose()
        } catch (t: Throwable) {
            if (isRuntimeIncompatibility(t)) {
                // Only transition to unsupported if we aren't already shutting down into unsupported.
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

        private val fallbackDrainExecutor: ExecutorService by lazy {
            Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "lionscope-compose-drain").apply { isDaemon = true }
            }
        }

        private fun defaultScheduleDrain(task: Runnable) {
            val mainLooper = try {
                Looper.getMainLooper()
            } catch (_: RuntimeException) {
                null
            }
            if (mainLooper != null) {
                Handler(mainLooper).post(task)
            } else {
                fallbackDrainExecutor.execute(task)
            }
        }

        private fun isRuntimeIncompatibility(t: Throwable): Boolean =
            t is LinkageError || t is ReflectiveOperationException || t is SecurityException
    }
}

package io.github.risyadul.lionscope

import androidx.compose.runtime.ExperimentalComposeRuntimeApi
import androidx.compose.runtime.RecomposeScope
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.RecomposerInfo
import androidx.compose.runtime.tooling.CompositionObserver
import androidx.compose.runtime.tooling.CompositionObserverHandle
import androidx.compose.runtime.tooling.CompositionRegistrationObserver
import androidx.compose.runtime.tooling.ObservableComposition
import java.lang.ref.ReferenceQueue
import java.lang.ref.WeakReference
import java.lang.reflect.Field
import java.util.IdentityHashMap

/**
 * Compose runtime 1.9+ recomposition and skip tracker.
 *
 * Everything in this file links against `compileOnly` Compose runtime 1.9+ (`@ExperimentalComposeRuntimeApi`).
 * It is only loaded after [ComposeRecompositionSupport.probe] verifies every required public observer symbol and
 * internal `RecomposeScopeImpl` flag symbol.
 *
 * Counts follow Android Studio semantics: counts since tracking was enabled or last [reset]. A composable first
 * composed while tracking is active (e.g. a newly scrolled `LazyColumn` item) counts its initial composition as 1.
 *
 * Threading & memory:
 * - Single private [lock] guards the bounded weak-identity scope map and handle registries.
 * - [lock] is never held across Compose observer registration/disposal calls to avoid lock-ordering cycles with
 *   Compose's internal `stateLock`.
 * - Weak-identity keys ([IdentityWeakKey]) + [ReferenceQueue] drain + eager removal in [onScopeDisposed] +
 *   hard cap ([maxTrackedScopes], setting [truncated] when hit) prevent scope leaks.
 */
@OptIn(ExperimentalComposeRuntimeApi::class)
internal class ComposeRecomposition19(
    private val scopeImplClass: Class<*>,
    private val flagsField: Field,
    private val maxTrackedScopes: Int = DEFAULT_MAX_TRACKED_SCOPES,
    private val runningRecomposers: () -> Set<RecomposerInfo> = { Recomposer.runningRecomposers.value },
) : ComposeRecompositionTracker {

    private class ScopeEntry {
        var recompositions: Int = 0
        var skips: Int = 0
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

    private val lock = Any()
    private val referenceQueue = ReferenceQueue<RecomposeScope>()
    private val counts = HashMap<Any, ScopeEntry>()
    private val lookupKey = LookupKey()
    private val recomposerHandles = IdentityHashMap<RecomposerInfo, CompositionObserverHandle>()
    private val compositionHandles = IdentityHashMap<ObservableComposition, CompositionObserverHandle>()

    @Volatile
    private var enabled: Boolean = false

    @Volatile
    private var capHit: Boolean = false

    override val status: RecompositionStatus
        get() = if (enabled) RecompositionStatus.ACTIVE else RecompositionStatus.OFF

    override val truncated: Boolean
        get() = capHit

    private val registrationObserver = object : CompositionRegistrationObserver {
        override fun onCompositionRegistered(composition: ObservableComposition) {
            guarded { attachComposition(composition) }
        }

        override fun onCompositionUnregistered(composition: ObservableComposition) {
            guarded {
                val handle = synchronized(lock) { compositionHandles.remove(composition) }
                handle?.dispose()
            }
        }
    }

    private val compositionObserver = object : CompositionObserver {
        override fun onBeginComposition(composition: ObservableComposition) = Unit

        override fun onEndComposition(composition: ObservableComposition) = Unit

        override fun onScopeInvalidated(scope: RecomposeScope, value: Any?) = Unit

        override fun onScopeEnter(scope: RecomposeScope) {
            if (!enabled) return
            guarded {
                synchronized(lock) {
                    if (!enabled) return@synchronized
                    val entry = getOrCreateLocked(scope) ?: return@synchronized
                    entry.sawRereadingInPass = false
                }
            }
        }

        override fun onReadInScope(scope: RecomposeScope, value: Any) {
            if (!enabled) return
            if (!hasFlag(scope, REREADING_FLAG)) return
            guarded {
                synchronized(lock) {
                    if (!enabled) return@synchronized
                    getLocked(scope)?.sawRereadingInPass = true
                }
            }
        }

        override fun onScopeExit(scope: RecomposeScope) {
            if (!enabled) return
            val skipped = readSkippedFlag(scope) ?: return
            guarded {
                synchronized(lock) {
                    if (!enabled) return@synchronized
                    val entry = getOrCreateLocked(scope) ?: return@synchronized
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
            val shouldStart = synchronized(lock) {
                if (this.enabled) {
                    false
                } else {
                    this.enabled = true
                    capHit = false
                    true
                }
            }
            if (shouldStart) rescan()
        } else {
            val rHandles: List<CompositionObserverHandle>
            val cHandles: List<CompositionObserverHandle>
            synchronized(lock) {
                this.enabled = false
                capHit = false
                rHandles = recomposerHandles.values.toList()
                recomposerHandles.clear()
                cHandles = compositionHandles.values.toList()
                compositionHandles.clear()
                counts.clear()
                drainQueueLocked()
            }
            for (handle in cHandles) guarded { handle.dispose() }
            for (handle in rHandles) guarded { handle.dispose() }
        }
    }

    override fun rescan() {
        if (!enabled) return
        val running = try {
            runningRecomposers()
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            return
        }

        // Prune handles for Recomposers that are no longer running so finished Activities do not accumulate.
        val staleHandles = synchronized(lock) {
            if (!enabled) return
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
        for (handle in staleHandles) guarded { handle.dispose() }

        for (info in running) {
            if (!enabled) return
            val alreadyAttached = synchronized(lock) { !enabled || recomposerHandles.containsKey(info) }
            if (alreadyAttached) continue
            val handle = try {
                info.observe(registrationObserver)
            } catch (t: Throwable) {
                if (isFatal(t)) throw t
                null
            } ?: continue
            val keep = synchronized(lock) {
                if (enabled && !recomposerHandles.containsKey(info)) {
                    recomposerHandles[info] = handle
                    true
                } else {
                    false
                }
            }
            if (!keep) guarded { handle.dispose() }
        }
    }

    override fun reset() {
        synchronized(lock) {
            counts.clear()
            drainQueueLocked()
            capHit = false
        }
    }

    override fun countsFor(scope: Any): RecompositionCounts? {
        if (!enabled) return null
        return synchronized(lock) {
            if (!enabled) return@synchronized null
            val entry = getLocked(scope) ?: return@synchronized RecompositionCounts.ZERO
            RecompositionCounts(entry.recompositions, entry.skips)
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

    private fun attachComposition(composition: ObservableComposition) {
        val skip = synchronized(lock) { !enabled || compositionHandles.containsKey(composition) }
        if (skip) return
        val handle = try {
            composition.setObserver(compositionObserver)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            return
        }
        val keep = synchronized(lock) {
            if (enabled && !compositionHandles.containsKey(composition)) {
                compositionHandles[composition] = handle
                true
            } else {
                false
            }
        }
        if (!keep) guarded { handle.dispose() }
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

    private fun readSkippedFlag(scope: RecomposeScope): Boolean? {
        if (!scopeImplClass.isInstance(scope)) return null
        return try {
            (flagsField.getInt(scope) and SKIPPED_FLAG) != 0
        } catch (_: ReflectiveOperationException) {
            null
        } catch (_: RuntimeException) {
            null
        }
    }

    private fun hasFlag(scope: RecomposeScope, flag: Int): Boolean {
        if (!scopeImplClass.isInstance(scope)) return false
        return try {
            (flagsField.getInt(scope) and flag) != 0
        } catch (_: ReflectiveOperationException) {
            false
        } catch (_: RuntimeException) {
            false
        }
    }

    internal companion object {
        const val DEFAULT_MAX_TRACKED_SCOPES = 16_384

        // From androidx.compose.runtime.RecomposeScopeImplKt:
        // UsedFlag = 0x01, DefaultsInScopeFlag = 0x02, DefaultsInvalidFlag = 0x04,
        // RequiresRecomposeFlag = 0x08, SkippedFlag = 0x10, RereadingFlag = 0x20.
        private const val SKIPPED_FLAG = 0x10
        private const val REREADING_FLAG = 0x20
    }
}

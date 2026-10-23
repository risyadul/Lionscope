package io.github.risyadul.lionscope

import java.lang.ref.ReferenceQueue
import java.lang.ref.WeakReference

/** Where a view was inflated from: the layout resource and the line where its start tag ends (as aapt2 keeps it). */
internal class ViewOrigin(val resId: Int, val line: Int)

/**
 * The layout and line of every view [InflateTracer]'s factory creates on the main thread (API 29+), for the Inspector.
 * Views are held weakly and compared by identity (an app view may override `equals` / `hashCode`); equal origins
 * (a RecyclerView row inflated many times) share one [ViewOrigin]. Main thread only.
 */
internal class ViewOrigins(private val maxInterned: Int = MAX_INTERNED) {
    private val views = WeakIdentityMap<Any, ViewOrigin>()
    private val interned = HashMap<Long, ViewOrigin>()

    val size: Int
        get() = views.size

    /** Unknown resources (0) and lines (< 1) are not recorded. */
    fun record(view: Any, resId: Int, line: Int) {
        if (resId == 0 || line < 1) return
        val key = (resId.toLong() shl 32) or line.toLong()
        val origin = interned[key] ?: ViewOrigin(resId, line).also { if (interned.size < maxInterned) interned[key] = it }
        views[view] = origin
    }

    operator fun get(view: Any): ViewOrigin? = views[view]

    private companion object {
        const val MAX_INTERNED = 4_096
    }
}

/** A minimal map with weakly held keys compared by identity; entries of collected keys are expunged on access. */
internal class WeakIdentityMap<K : Any, V : Any> {
    private class Key(referent: Any, queue: ReferenceQueue<Any>?) : WeakReference<Any>(referent, queue) {
        private val hash = System.identityHashCode(referent)

        override fun hashCode(): Int = hash

        override fun equals(other: Any?): Boolean {
            if (other === this) return true
            if (other !is Key || other.hash != hash) return false
            val referent = get()
            return referent != null && referent === other.get()
        }
    }

    private val queue = ReferenceQueue<Any>()
    private val entries = HashMap<Key, V>()

    val size: Int
        get() {
            expunge()
            return entries.size
        }

    operator fun set(key: K, value: V) {
        expunge()
        entries[Key(key, queue)] = value
    }

    operator fun get(key: K): V? = entries[Key(key, null)]

    private fun expunge() {
        while (true) {
            val collected = queue.poll() ?: return
            entries.remove(collected)
        }
    }
}

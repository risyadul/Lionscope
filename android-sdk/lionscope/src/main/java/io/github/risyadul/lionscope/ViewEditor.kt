package io.github.risyadul.lionscope

import java.lang.ref.WeakReference
import java.util.concurrent.ThreadLocalRandom

/** How [ViewEditor] reads and sets a view's properties, so its bookkeeping can be tested on fake views. Main thread. */
internal interface ViewEditAccess<V : Any> {
    /** Still in a window: an edit of a detached view would show nowhere. */
    fun isAttached(view: V): Boolean

    /** Whether [property] applies to [view] at all (a TextView for text, MarginLayoutParams for margins, ...). */
    fun supports(view: V, property: ViewProperty): Boolean

    /** A password field right now: its text is never read or set. */
    fun isPassword(view: V): Boolean

    /** What restores the current value exactly (a Drawable, a ColorStateList, styled text). */
    fun save(view: V, property: ViewProperty): Any?

    /** The current value, comparable with what [save] and an earlier [read] gave (equal, or the same object). */
    fun read(view: V, property: ViewProperty): Any?

    /** [value] is what [ViewValues.parse] gave for [property]. */
    fun write(view: V, property: ViewProperty, value: Any)

    fun restore(view: V, property: ViewProperty, saved: Any?)

    /** After a change: lay out and draw again. */
    fun refresh(view: V)
}

/** The outcome of one edit or revert: [error] null when it worked, and the live edits in effect after it. */
internal class EditResult(val error: EditError?, val liveEdits: Int)

/**
 * Live edits of the app's views (v8): keys that name views across snapshots, the latest capture's views, and per view
 * and property what to restore. A view's key comes from a per-process counter the first time a capture meets it and
 * stays with that object (held weakly, by identity) for as long as it lives; a recreated view is a new object with a
 * new key, so a key never names another view. The counter starts at a random [firstKey], so a restarted process does
 * not hand out the keys of the one before (the server carries its selection by key). An edit only reaches a view of
 * the latest committed capture that is still attached; anything else is [EditError.STALE].
 *
 * An edit keeps the original value the first time a property of a view changes, then remembers what it set. Whenever
 * edits are looked at, one whose view no longer shows the value it set (the app set the property itself, e.g. a
 * RecyclerView row rebound) is forgotten instead of being reverted over the app's new value. Setting a property back
 * to its original value forgets the edit too. At most [maxEdits] are kept. Main thread only.
 */
internal class ViewEditor<V : Any>(
    private val access: ViewEditAccess<V>,
    private val maxEdits: Int = MAX_LIVE_EDITS,
    firstKey: Int = ThreadLocalRandom.current().nextInt(1, FIRST_KEY_BOUND),
) {
    private class Edit(val saved: Any?, val original: Any?, val applied: Any?)

    private val keys = WeakIdentityMap<V, Int>()
    private var nextKey = firstKey
    private var latest: Map<Int, WeakReference<V>> = emptyMap()
    private val edits = WeakIdentityMap<V, MutableMap<ViewProperty, Edit>>()

    /** The keys of one capture; [commit] it once the capture worked, and edits name its views from then on. */
    inner class Capture {
        private val views = HashMap<Int, WeakReference<V>>()

        fun keyOf(view: V): Int {
            val key = keys[view] ?: nextKey++.also { keys[view] = it }
            views[key] = WeakReference(view)
            return key
        }

        /** [view]'s edits in effect, in [ViewProperty] order. */
        fun edited(view: V): List<ViewProperty> = inEffect(view)?.keys?.sortedBy { it.ordinal } ?: emptyList()

        fun commit() {
            latest = views
        }
    }

    fun beginCapture(): Capture = Capture()

    /** Edits in effect over every live view (also ones not in the latest capture). */
    fun liveEdits(): Int = edits.entries().sumOf { (view, _) -> inEffect(view)?.size ?: 0 }

    /** Set [property] of the view with [key] to [raw] (a wire value: String, Double or Boolean). */
    fun set(key: Int, property: ViewProperty, raw: Any?): EditResult {
        val view = resolve(key) ?: return result(EditError.STALE)
        if (!access.supports(view, property)) return result(EditError.UNSUPPORTED)
        if (property == ViewProperty.TEXT && access.isPassword(view)) return result(EditError.PASSWORD)
        val value = ViewValues.parse(property, raw) ?: return result(EditError.INVALID)
        val own = inEffect(view)
        val previous = own?.get(property)
        if (previous == null && liveEdits() >= maxEdits) return result(EditError.LIMIT)
        val saved = if (previous != null) previous.saved else access.save(view, property)
        val original = if (previous != null) previous.original else access.read(view, property)
        val updated = own ?: LinkedHashMap()
        try {
            access.write(view, property, value)
        } catch (e: RuntimeException) {
            // Back to the original (a setter may have thrown half way): this property's edit is over.
            restoreQuietly(view, property, saved)
            forget(view, updated, property)
            return result(EditError.FAILED)
        }
        access.refresh(view)
        val applied = readQuietly(view, property)
        if (applied === Unreadable || same(applied, original)) {
            forget(view, updated, property)
        } else {
            updated[property] = Edit(saved, original, applied)
            edits[view] = updated
        }
        return result(null)
    }

    private fun forget(view: V, own: MutableMap<ViewProperty, Edit>, property: ViewProperty) {
        own.remove(property)
        if (own.isEmpty()) edits.remove(view)
    }

    /**
     * Revert [properties] (all when null) of the view with [key], or every edit when [key] is null. An edit the app
     * has overwritten since is only forgotten.
     */
    fun revert(key: Int?, properties: List<ViewProperty>?): EditResult {
        val targets = if (key == null) {
            edits.entries().map { it.first }
        } else {
            listOf(resolve(key) ?: return result(EditError.STALE))
        }
        var failed = false
        for (view in targets) {
            val own = inEffect(view) ?: continue
            val reverted = own.keys.filter { properties == null || it in properties }
            for (property in reverted) {
                val edit = own.remove(property) ?: continue
                try {
                    access.restore(view, property, edit.saved)
                } catch (e: RuntimeException) {
                    failed = true
                }
            }
            if (reverted.isNotEmpty()) access.refresh(view)
            if (own.isEmpty()) edits.remove(view)
        }
        return result(if (failed) EditError.FAILED else null)
    }

    private fun resolve(key: Int): V? = latest[key]?.get()?.takeIf(access::isAttached)

    /** [view]'s edits after forgetting those it no longer shows; null when none is left. */
    private fun inEffect(view: V): MutableMap<ViewProperty, Edit>? {
        val own = edits[view] ?: return null
        own.entries.removeAll { (property, edit) -> !same(readQuietly(view, property), edit.applied) }
        if (own.isEmpty()) {
            edits.remove(view)
            return null
        }
        return own
    }

    /** A read that throws (a view in an odd state) counts as changed: the edit is forgotten. */
    private fun readQuietly(view: V, property: ViewProperty): Any? = try {
        access.read(view, property)
    } catch (e: RuntimeException) {
        Unreadable
    }

    private fun restoreQuietly(view: V, property: ViewProperty, saved: Any?) {
        try {
            access.restore(view, property, saved)
        } catch (e: RuntimeException) {
            // The setter failed half way: nothing better to do than leave it.
        }
    }

    private fun result(error: EditError?) = EditResult(error, liveEdits())

    private object Unreadable

    private companion object {
        /** Keys start below this, leaving a billion before an Int runs out. */
        const val FIRST_KEY_BOUND = 1 shl 30

        /** Values (numbers, strings, flags) by equality; objects (a Drawable, a ColorStateList) by identity. */
        fun same(a: Any?, b: Any?): Boolean =
            if (a is Number || a is Boolean || a is String || a is Enum<*>) a == b else a === b
    }
}

/**
 * Answers the server's v8 edit requests on the main thread with [editor], or `disabled` without one (the Inspector
 * could not be set up), so the server never waits for an answer. Anything an edit throws is answered `failed`.
 */
internal class ViewEditRequests<V : Any>(
    private val link: LinkPort,
    main: MainScheduler,
    private val editor: ViewEditor<V>?,
) {
    init {
        link.addViewEditListener { message -> main.post(Runnable { guarded { answer(message) } }) }
    }

    /** Main thread. */
    fun answer(message: GatewayMessage) {
        if (!DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V8)) return
        val requestId: Int
        val result = when (message) {
            is GatewayMessage.SetViewProperty -> {
                requestId = message.requestId
                edit { it.set(message.viewKey, message.property, message.value) }
            }
            is GatewayMessage.RevertViewProperties -> {
                requestId = message.requestId
                edit { it.revert(message.viewKey, message.properties) }
            }
            else -> return
        }
        link.sendV8(RESULT_SIZE_HINT) { DeviceMessages.viewPropertyResult(requestId, result) }
    }

    private fun edit(action: (ViewEditor<V>) -> EditResult): EditResult {
        val editor = editor ?: return EditResult(EditError.DISABLED, 0)
        return try {
            action(editor)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            EditResult(EditError.FAILED, try { editor.liveEdits() } catch (e: RuntimeException) { 0 })
        }
    }

    private companion object {
        const val RESULT_SIZE_HINT = 96
    }
}

package io.github.risyadul.lionscope

/**
 * The windows that should be measured (resumed activities, shown dialogs) and whether measuring is active.
 * Listeners ([attach] → handle, [detach]) exist only while active, i.e. while a dashboard is connected.
 * Main thread only.
 */
internal class WindowRegistry<W : Any, H : Any>(
    private val attach: (window: W, name: String) -> H?,
    private val detach: (window: W, handle: H) -> Unit,
) {
    private class Entry<W, H>(val window: W, val name: String) {
        var handle: H? = null
    }

    private val entries = HashMap<Any, Entry<W, H>>()

    var isActive = false
        private set

    val attachedCount: Int
        get() = entries.values.count { it.handle != null }

    fun show(key: Any, window: W, name: String) {
        val existing = entries[key]
        if (existing != null && existing.window === window) return
        hide(key)
        val entry = Entry<W, H>(window, name)
        entries[key] = entry
        if (isActive) entry.handle = attach(window, name)
    }

    /** Returns the window name that was removed, if any. */
    fun hide(key: Any): String? {
        val entry = entries.remove(key) ?: return null
        release(entry)
        return entry.name
    }

    fun setActive(active: Boolean) {
        if (active == isActive) return
        isActive = active
        for (entry in entries.values) {
            if (active) entry.handle = attach(entry.window, entry.name) else release(entry)
        }
    }

    private fun release(entry: Entry<W, H>) {
        val handle = entry.handle ?: return
        entry.handle = null
        detach(entry.window, handle)
    }
}

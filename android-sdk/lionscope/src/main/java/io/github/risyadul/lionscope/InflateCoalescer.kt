package io.github.risyadul.lionscope

import android.os.SystemClock

/**
 * Coalesces inflations per (layout or label, screen, library, nested) over one window: count, total, the slowest one's
 * duration, start and views. At most [maxKeys] keys per window; inflations of further keys are counted in
 * [overflow] and not sent. Not thread-safe; [nowMs] is monotonic.
 */
internal class InflateCoalescer(private val maxKeys: Int = MAX_KEYS) {
    data class Key(val name: LayoutName, val screen: String?, val nested: Boolean = false)

    class Entry(val key: Key, var tsMs: Long, var maxMs: Double, var views: Int) {
        var count = 1
        var totalMs = maxMs
    }

    private val entries = LinkedHashMap<Key, Entry>()

    /** When the current window's first inflation was added; null while empty. */
    var windowStartMs: Long? = null
        private set

    var overflow = 0
        private set

    val isEmpty: Boolean
        get() = entries.isEmpty()

    fun add(name: LayoutName, screen: String?, tsMs: Long, durationMs: Double, views: Int, nowMs: Long, nested: Boolean = false) {
        val key = Key(name, screen, nested)
        val entry = entries[key]
        if (entry == null) {
            if (entries.size >= maxKeys) {
                overflow++
                return
            }
            entries[key] = Entry(key, tsMs, durationMs, views)
            if (windowStartMs == null) windowStartMs = nowMs
            return
        }
        entry.count++
        entry.totalMs += durationMs
        if (durationMs > entry.maxMs) {
            entry.maxMs = durationMs
            entry.tsMs = tsMs
            entry.views = views
        }
    }

    /** Returns the window's entries in order of first appearance and starts a new window. */
    fun drain(): List<Entry> = take(Int.MAX_VALUE, nowMs = 0)

    /**
     * Removes and returns the first [max] entries. What is left forms a window starting at [nowMs] (its counts
     * keep growing); the overflow count goes with the window that is fully drained.
     */
    fun take(max: Int, nowMs: Long): List<Entry> {
        if (entries.size <= max) {
            val drained = ArrayList(entries.values)
            clear()
            return drained
        }
        val taken = ArrayList<Entry>(max)
        val iterator = entries.values.iterator()
        while (taken.size < max) {
            taken += iterator.next()
            iterator.remove()
        }
        windowStartMs = nowMs
        return taken
    }

    fun clear() {
        entries.clear()
        windowStartMs = null
        overflow = 0
    }

    internal companion object {
        /** Also the most `inflate` lines one window can produce (the server allows a burst of 200 lines). */
        const val MAX_KEYS = 64
    }
}

/**
 * Sends coalesced inflations as v3 `inflate` messages (main thread only). A window is sent [FLUSH_INTERVAL_MS] after
 * it opened, or early on a screen change, but never less than [MIN_FLUSH_GAP_MS] after the previous send, and at
 * most [MAX_LINES_PER_SECOND] lines in any second (what does not fit waits, still coalescing): the server closes a
 * link that exceeds its line rate. Recording runs while tracking is on and the link is v3 or not welcomed yet, so a
 * cold start's inflations, measured before the link is up, are sent once it is welcomed at v3 and the `config` that
 * a v3 server sends right after `welcome` has arrived ([setTracking]; it may turn tracking off, which drops them),
 * or after [CONFIG_WAIT_MS] without one; a window waiting for a link longer than [HOLD_MS] is dropped. A link
 * negotiated below v3, a link closing and tracking turned off drop what is pending.
 */
internal class InflateReporter(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val uptimeMs: () -> Long = SystemClock::uptimeMillis,
) {
    private val coalescer = InflateCoalescer()

    /** Id of the one live flush task; earlier-scheduled tasks with another id do nothing. */
    private var pendingTask = 0
    private var pendingDueMs: Long? = null
    private var earlyFlush = false
    private var lastSendMs: Long? = null
    /** Send times of the lines sent within the last second, oldest first. */
    private val recentLines = ArrayDeque<Long>()

    /** Negotiated version of the welcomed link, 0 while not welcomed. */
    private var linkVersion = 0
    private var tracking = SdkOptions.DEFAULT.inflateTracking
    /** Welcomed at v3 at this time and no `config` yet: nothing is sent until one arrives (or the wait ends). */
    private var awaitingConfigSince: Long? = null

    val isRecording: Boolean
        get() = tracking && (linkVersion == 0 || linkVersion >= DEVICE_PROTOCOL_V3)

    val pendingOverflow: Int
        get() = coalescer.overflow

    /** [nested]: inflated within another layout's inflation (its time is already in that one's). */
    fun add(name: LayoutName, screen: String?, tsMs: Long, durationMs: Double, views: Int, nested: Boolean = false) {
        if (!isRecording) return
        coalescer.add(name, screen, tsMs, durationMs, views, uptimeMs(), nested)
        schedule()
    }

    /** Sends the window early (still within the rate limits). */
    fun onScreenChanged() {
        if (linkVersion < DEVICE_PROTOCOL_V3 || coalescer.isEmpty) return
        earlyFlush = true
        flushDue()
    }

    /** [version] = negotiated version, 0 when the link is down. */
    fun setLink(version: Int) {
        if (version == linkVersion) return
        linkVersion = version
        if (version < DEVICE_PROTOCOL_V3) {
            awaitingConfigSince = null
            coalescer.clear()
        } else {
            awaitingConfigSince = uptimeMs()
            schedule()
        }
    }

    /** The session's `inflateTracking`, from each `config`. */
    fun setTracking(enabled: Boolean) {
        tracking = enabled
        awaitingConfigSince = null
        if (enabled) schedule() else coalescer.clear()
    }

    private fun flushDue() {
        val start = coalescer.windowStartMs
        if (start == null) {
            earlyFlush = false
            return
        }
        val now = uptimeMs()
        if (linkVersion < DEVICE_PROTOCOL_V3) {
            if (now - start >= HOLD_MS) coalescer.clear() else schedule()
            return
        }
        val due = dueMs(start, now)
        if (now < due) {
            schedule()
            return
        }
        awaitingConfigSince = null // The wait is over: a server that sends no config keeps the default (on).
        send(now)
        schedule()
    }

    /** When the current window may be sent, given the interval, the gap since the last send and the line budget. */
    private fun dueMs(start: Long, now: Long): Long {
        trimRecent(now)
        val wanted = if (earlyFlush) now else start + FLUSH_INTERVAL_MS
        val afterGap = lastSendMs?.let { it + MIN_FLUSH_GAP_MS } ?: wanted
        val budgetAt = if (recentLines.size >= MAX_LINES_PER_SECOND) recentLines.first() + WINDOW_MS else wanted
        val configAt = awaitingConfigSince?.let { it + CONFIG_WAIT_MS } ?: wanted
        return maxOf(wanted, afterGap, budgetAt, configAt)
    }

    /** Schedules the next [flushDue], replacing a later one (the task is cheap and idempotent). */
    private fun schedule() {
        val start = coalescer.windowStartMs ?: return
        val now = uptimeMs()
        val due = if (linkVersion >= DEVICE_PROTOCOL_V3) dueMs(start, now) else now + FLUSH_INTERVAL_MS
        val pending = pendingDueMs
        if (pending != null && pending <= due) return
        val task = ++pendingTask
        pendingDueMs = due
        main.postDelayed(Runnable {
            guarded {
                if (task != pendingTask) return@guarded
                pendingDueMs = null
                flushDue()
            }
        }, (due - now).coerceAtLeast(1))
    }

    private fun send(now: Long) {
        trimRecent(now)
        val budget = MAX_LINES_PER_SECOND - recentLines.size
        if (budget <= 0) return
        earlyFlush = false
        lastSendMs = now
        for (entry in coalescer.take(budget, now)) {
            recentLines.addLast(now)
            val name = entry.key.name
            val screen = entry.key.screen
            val nested = entry.key.nested
            val ts = entry.tsMs
            val count = entry.count
            val totalMs = entry.totalMs
            val maxMs = entry.maxMs
            val views = entry.views
            link.sendV3(MESSAGE_SIZE_HINT) {
                DeviceMessages.inflate(ts, name.layout, name.label, name.library, nested, screen, count, totalMs, maxMs, views)
            }
        }
    }

    private fun trimRecent(now: Long) {
        while (recentLines.isNotEmpty() && now - recentLines.first() >= WINDOW_MS) recentLines.removeFirst()
    }

    internal companion object {
        const val FLUSH_INTERVAL_MS = 1_000L
        const val MIN_FLUSH_GAP_MS = 250L
        const val MAX_LINES_PER_SECOND = 64
        const val HOLD_MS = 10_000L
        const val CONFIG_WAIT_MS = 3_000L
        private const val WINDOW_MS = 1_000L
        private const val MESSAGE_SIZE_HINT = 256
    }
}

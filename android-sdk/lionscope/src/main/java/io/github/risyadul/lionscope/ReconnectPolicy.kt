package io.github.risyadul.lionscope

/**
 * When and how fast the link retries. 1 s → 2 s → 5 s while the app is in use; 15 s once the app has spent
 * [slowAfterForegroundMs] in the foreground without a `welcome`; parked (no attempts) after
 * [parkAfterBackgroundMs] with no started activity. Not thread-safe: guarded by [DeviceLink]'s lock.
 */
internal class ReconnectPolicy(
    startMs: Long,
    private val backoff: Backoff = Backoff(),
    private val parkAfterBackgroundMs: Long = 30_000,
    private val slowAfterForegroundMs: Long = 10 * 60_000,
    private val slowDelayMs: Long = 15_000,
) {
    private var foreground = false
    private var backgroundSinceMs = startMs
    private var foregroundSinceMs = startMs
    /** Foreground time accumulated (excluding the current foreground stretch) since the last welcome. */
    private var unwelcomedForegroundMs = 0L

    fun onForeground(isForeground: Boolean, nowMs: Long) {
        if (isForeground == foreground) return
        foreground = isForeground
        if (isForeground) {
            foregroundSinceMs = nowMs
        } else {
            unwelcomedForegroundMs += nowMs - foregroundSinceMs
            backgroundSinceMs = nowMs
        }
    }

    fun onWelcome(nowMs: Long) {
        backoff.reset()
        unwelcomedForegroundMs = 0
        foregroundSinceMs = nowMs
    }

    fun nextDelayMs(nowMs: Long): Long {
        val delay = backoff.next()
        return if (unwelcomedForeground(nowMs) >= slowAfterForegroundMs) maxOf(delay, slowDelayMs) else delay
    }

    fun shouldPark(nowMs: Long): Boolean = !foreground && nowMs - backgroundSinceMs >= parkAfterBackgroundMs

    private fun unwelcomedForeground(nowMs: Long): Long =
        unwelcomedForegroundMs + if (foreground) nowMs - foregroundSinceMs else 0
}

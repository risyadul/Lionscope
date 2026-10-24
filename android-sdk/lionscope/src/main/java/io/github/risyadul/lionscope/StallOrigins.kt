package io.github.risyadul.lionscope

/**
 * RxJava 2 hooks (v9 `stall.rx`) behind an Rx-free interface: [createIfPresent] loads [RxJava2Hooks] only when the
 * app has RxJava 2, so an app without it never loads a class that refers to RxJava.
 */
internal interface RxTracking {
    /**
     * Main thread. On: installs the hooks (chained after the app's own) on first use; off: removes each hook that is
     * still the installed one, and the others stay as pass-throughs.
     */
    fun setEnabled(enabled: Boolean)

    /** The Rx task the main thread runs right now, null outside one; read from the watchdog thread. */
    val currentTask: Any?

    /**
     * What a stall's [task] tells, read off the main thread: its class, the chain's final consumer and the subscribe
     * site ([frames] maps its elements); null when there is nothing to say or reading it failed.
     */
    fun describe(task: Any, frames: (Array<StackTraceElement>) -> List<StackFrame>): RxOrigin?

    companion object {
        private const val PLUGINS = "io.reactivex.plugins.RxJavaPlugins"

        /** Null without RxJava 2 in the app; the hooks themselves are only created on the first enable. */
        fun createIfPresent(mainThread: Thread): RxTracking? = try {
            Class.forName(PLUGINS, false, RxTracking::class.java.classLoader)
            LazyRxTracking { RxJava2Hooks(mainThread) }
        } catch (e: ClassNotFoundException) {
            null
        } catch (e: LinkageError) {
            null
        }
    }
}

/**
 * Creates the hooks ([create], which loads RxJava's classes) on the first enable, so a process that never has a v9
 * session loads none of it. A failing [create] leaves RxJava tracking off for the process.
 */
internal class LazyRxTracking(private val create: () -> RxTracking) : RxTracking {
    @Volatile
    private var hooks: RxTracking? = null
    private var failed = false

    override fun setEnabled(enabled: Boolean) {
        val current = hooks ?: if (enabled && !failed) created() else null
        current?.setEnabled(enabled)
    }

    private fun created(): RxTracking? = try {
        create().also { hooks = it }
    } catch (t: Throwable) {
        if (isFatal(t)) throw t
        failed = true
        null
    }

    override val currentTask: Any?
        get() = hooks?.currentTask

    override fun describe(task: Any, frames: (Array<StackTraceElement>) -> List<StackFrame>): RxOrigin? =
        hooks?.describe(task, frames)
}

/**
 * The coroutine a main-thread name names: kotlinx.coroutines debug mode renames the thread a coroutine runs on to
 * `<name> @<coroutine name>#<id>` while it runs. Null for any other name.
 */
internal object CoroutineNames {
    private const val SEPARATOR = " @"
    private val NAME_AND_ID = Regex(".+#\\d+")

    fun parse(threadName: String?): String? {
        if (threadName == null) return null
        val at = threadName.lastIndexOf(SEPARATOR)
        if (at < 0) return null
        return threadName.substring(at + SEPARATOR.length).takeIf { NAME_AND_ID.matches(it) }
    }
}

/**
 * Values keyed weakly by objects' identity ([WeakIdentityMap]), shared by threads, at most [maxSize] at a time: once
 * full, new entries are refused until collected keys free room.
 */
internal class BoundedWeakIdentityMap<K : Any, V : Any>(private val maxSize: Int) {
    private val entries = WeakIdentityMap<K, V>()

    val size: Int
        @Synchronized get() = entries.size

    /** False when the map is full. */
    @Synchronized
    fun put(key: K, value: V): Boolean {
        if (entries.size >= maxSize && entries[key] == null) return false
        entries[key] = value
        return true
    }

    @Synchronized
    fun get(key: K): V? = entries[key]

    @Synchronized
    fun clear() {
        for ((key, _) in entries.entries()) entries.remove(key)
    }
}

/** At most [perSecond] events in each second (by [nanoTime]); thread-safe. */
internal class PerSecondLimit(private val perSecond: Int, private val nanoTime: () -> Long = System::nanoTime) {
    private var windowStart = Long.MIN_VALUE
    private var count = 0

    @Synchronized
    fun tryAcquire(): Boolean {
        val now = nanoTime()
        if (windowStart == Long.MIN_VALUE || now - windowStart >= NANOS_PER_SECOND) {
            windowStart = now
            count = 0
        }
        if (count >= perSecond) return false
        count++
        return true
    }

    private companion object {
        const val NANOS_PER_SECOND = 1_000_000_000L
    }
}

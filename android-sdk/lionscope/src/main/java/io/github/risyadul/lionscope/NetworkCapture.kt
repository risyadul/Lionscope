package io.github.risyadul.lionscope

import android.util.Log
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The network inspector's state, without any OkHttp type (the interceptor in [LionscopeOkHttpInterceptor] feeds it):
 * whether capture is on, the rate cap, exchange ids, and the active mock rules.
 *
 * Active only while the link is a welcomed profiling session at v7 whose welcome carried a valid link proof
 * ([LinkPort.isNetworkAuthenticated]; [isActive], one volatile read for the interceptor's fast path). Mock rules arrive from the server per session and are cleared whenever the session
 * starts or ends. Everything here is called from app threads (the interceptor) or the link threads, never blocks
 * and never throws into callers.
 */
internal class NetworkCapture(
    private val nanoTime: () -> Long = System::nanoTime,
    private val clock: () -> Long = System::currentTimeMillis,
    private val log: (priority: Int, message: String) -> Unit = { priority, message -> Log.println(priority, LOG_TAG, message) },
) {
    /** True while exchanges are recorded and mocks apply. */
    @Volatile
    var isActive = false
        private set

    /** The active rule set, in the server's precedence order (immutable; replaced as a whole). */
    @Volatile
    var mocks: List<MockRule> = emptyList()
        private set

    @Volatile
    private var link: LinkPort? = null

    /** Bumped on every session change, so a record started in one session is never sent on the next one. */
    @Volatile
    private var generation = 0

    private val lock = Any()
    private val assembler = MockSetAssembler()
    private val nextId = AtomicInteger(0)
    private val dropped = AtomicInteger(0)
    private val bucket = TokenBucket(HTTP_EXCHANGES_PER_SECOND, HTTP_EXCHANGE_BURST, nanoTime)
    // ConcurrentHashMap.newKeySet is API 24.
    private val loggedFailures: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val loggedNotices: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())

    /** Follows [link]'s sessions and mock rule sets; called once, before the link starts. */
    fun attach(link: LinkPort) {
        this.link = link
        link.addSessionListener { active -> onSession(link, active) }
        link.addMocksListener(::onMocksMessage)
    }

    /**
     * Starts recording an exchange: null when capture is off or over the rate cap (then counted and reported as
     * `dropped` with the next recorded request).
     */
    fun begin(): Recording? {
        if (!isActive) return null
        if (!bucket.tryTake()) {
            if (dropped.get() < MAX_HTTP_DROPPED) dropped.incrementAndGet()
            return null
        }
        return Recording(nextExchangeId(), clock(), nanoTime(), generation)
    }

    /** The `dropped` count for the next `httpRequest`, reset by the call. */
    fun takeDropped(): Int = dropped.getAndSet(0).coerceIn(0, MAX_HTTP_DROPPED)

    fun elapsedMs(recording: Recording): Double = (nanoTime() - recording.startNanos) / NANOS_PER_MS

    fun sendRequest(recording: Recording, record: HttpRequestRecord) {
        val link = linkFor(recording) ?: return
        link.sendV7(record.sizeHint()) { HttpMessages.httpRequest(record) }
    }

    fun sendResponse(recording: Recording, record: HttpResponseRecord) {
        val link = linkFor(recording) ?: return
        link.sendV7(record.sizeHint()) { HttpMessages.httpResponse(record) }
    }

    /** The first active rule that matches, or null. */
    fun findMock(method: String, url: String): MockRule? {
        val rules = mocks
        return if (rules.isEmpty()) null else MockMatching.find(rules, method, url)
    }

    /** One info line per mocked request: `Mocked GET <redacted url> (rule m1): 200`. */
    fun logMocked(method: String, url: String, rule: MockRule) {
        val outcome = if (rule.action == MockAction.RESPOND) rule.status.toString() else rule.action.wire
        log(Log.INFO, "Mocked $method ${HttpRedaction.redactUrl(url)} (rule ${rule.id}): $outcome")
    }

    /** Logs [message] once per [key] for the process (e.g. a misplaced interceptor). */
    fun noticeOnce(key: String, message: String) {
        if (loggedNotices.size < MAX_LOGGED_KINDS && loggedNotices.add(key)) log(Log.WARN, message)
    }

    /**
     * An SDK failure contained by the interceptor: one warning per place and exception class, with the class name only
     * (a message can hold request data).
     */
    fun onSdkFailure(where: String, t: Throwable) {
        val key = "$where:${t.javaClass.name}"
        if (loggedFailures.size < MAX_LOGGED_KINDS && loggedFailures.add(key)) {
            log(Log.WARN, "Lionscope network capture: $where failed, the call goes on unchanged: ${t.javaClass.name}")
        }
    }

    private fun linkFor(recording: Recording): LinkPort? =
        if (isActive && recording.generation == generation) link else null

    private fun nextExchangeId(): Int {
        while (true) {
            val current = nextId.get()
            val next = if (current == Int.MAX_VALUE) 1 else current + 1
            if (nextId.compareAndSet(current, next)) return next
        }
    }

    private fun onSession(link: LinkPort, active: Boolean) = synchronized(lock) {
        generation++
        assembler.reset()
        mocks = emptyList()
        isActive = active && link.isNetworkAuthenticated && DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V7)
    }

    private fun onMocksMessage(message: GatewayMessage) {
        val applied = synchronized(lock) {
            if (!isActive) return
            val applied = when (message) {
                is GatewayMessage.Mocks -> assembler.begin(message.rev, message.count)
                is GatewayMessage.Mock -> assembler.add(message.rev, message.index, message.rule)
                else -> null
            } ?: return
            mocks = applied.rules
            applied
        }
        if (applied.rev != MockSetAssembler.UNCONFIRMED) {
            link?.sendV7(MOCKS_APPLIED_SIZE_HINT) { HttpMessages.mocksApplied(applied.rev, applied.rules.size) }
        }
    }

    /** One exchange being recorded: [id] on the wire, [ts] its wall-clock start, [startNanos] its monotonic start. */
    class Recording(val id: Int, val ts: Long, val startNanos: Long, val generation: Int)

    companion object {
        private const val NANOS_PER_MS = 1_000_000.0
        private const val MAX_LOGGED_KINDS = 32
        private const val MOCKS_APPLIED_SIZE_HINT = 48

        /** The process-wide instance behind `Lionscope.okHttpInterceptor()`; attached when the SDK installs. */
        val shared = NetworkCapture()
    }
}

/** At most [perSecond] takes per second on average, [burst] at once; [nanoTime] is monotonic. */
internal class TokenBucket(private val perSecond: Int, private val burst: Int, private val nanoTime: () -> Long) {
    private var tokens = burst.toDouble()
    private var lastNanos = nanoTime()

    @Synchronized
    fun tryTake(): Boolean {
        val now = nanoTime()
        tokens = minOf(burst.toDouble(), tokens + (now - lastNanos) * perSecond / NANOS_PER_SECOND)
        lastNanos = now
        if (tokens < 1.0) return false
        tokens -= 1.0
        return true
    }

    private companion object {
        const val NANOS_PER_SECOND = 1_000_000_000.0
    }
}

package io.github.risyadul.lionscope

import android.util.Log
import java.io.BufferedWriter
import java.io.IOException
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Keeps one NDJSON TCP connection to the Lionscope gateway (127.0.0.1:8700 via `adb reverse`), retrying per
 * [ReconnectPolicy]. Producers call [send] / [onScreen] from any thread; nothing here blocks or throws into them.
 */
internal class DeviceLink(
    private val helloLine: () -> String,
    private val host: String = "127.0.0.1",
    private val port: Int = DEVICE_LINK_PORT,
    private val clock: () -> Long = System::currentTimeMillis,
    private val policy: ReconnectPolicy = ReconnectPolicy(clock()),
    private val queue: OutboundQueue<Any> = OutboundQueue(sizeOf = ::sizeHint),
    private val heartbeatIntervalMs: Long = HEARTBEAT_INTERVAL_MS,
) : LinkPort {
    /** True while a socket is open; items sent while disconnected are discarded (not counted as drops). */
    @Volatile
    var isConnected = false
        private set

    @Volatile
    override var isWelcomed = false
        private set

    /**
     * Protocol version agreed in `welcome` (clamped to what this SDK speaks); null until welcomed and after each
     * disconnect. Message types newer than this must not be sent.
     */
    @Volatile
    override var negotiatedVersion: Int? = null
        private set

    @Volatile
    private var currentScreen: ScreenRef? = null

    @Volatile
    private var loggedState = LinkState.DISCONNECTED

    private val stateLock = ReentrantLock()
    private val stateChanged = stateLock.newCondition()
    private val welcomeListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    private val configListeners = CopyOnWriteArrayList<(SdkOptions) -> Unit>()
    private val inspectListeners = CopyOnWriteArrayList<(Int) -> Unit>()

    fun start() {
        val thread = Thread(::runForever, "lionscope-link")
        thread.isDaemon = true
        thread.start()
    }

    fun send(line: String) {
        if (isConnected) queue.offer(line)
    }

    override fun sendV2(sizeHint: Int, encode: () -> String?) {
        if (isConnected && speaksV2()) queue.offer(V2Item(sizeHint, encode = encode))
    }

    override fun sendV3(sizeHint: Int, encode: () -> String?) {
        if (isConnected && speaks(negotiatedVersion, DEVICE_PROTOCOL_V3)) {
            queue.offer(V2Item(sizeHint, DEVICE_PROTOCOL_V3, encode))
        }
    }

    override fun sendV4(sizeHint: Int, encode: () -> String?) {
        if (isConnected && speaks(negotiatedVersion, DEVICE_PROTOCOL_V4)) {
            queue.offer(V2Item(sizeHint, DEVICE_PROTOCOL_V4, encode))
        }
    }

    /** Records the top screen (re-sent after every reconnect); encoding happens on the link thread. */
    override fun onScreen(ts: Long, screen: ScreenRef?) {
        currentScreen = screen
        if (isConnected) queue.offer(ScreenEvent(ts, screen))
    }

    override fun setForeground(foreground: Boolean) = stateLock.withLock {
        policy.onForeground(foreground, clock())
        stateChanged.signalAll()
    }

    override fun addWelcomeListener(listener: (welcomed: Boolean) -> Unit) {
        welcomeListeners.add(listener)
    }

    override fun addConfigListener(listener: (SdkOptions) -> Unit) {
        configListeners.add(listener)
    }

    override fun addInspectListener(listener: (requestId: Int) -> Unit) {
        inspectListeners.add(listener)
    }

    private fun speaksV2(): Boolean = speaksV2(negotiatedVersion)

    private fun runForever() {
        try {
            lowerThreadPriority()
            while (true) {
                parkWhileBackgrounded()
                logState(connectOnce())
                sleepBeforeRetry()
            }
        } catch (e: InterruptedException) {
            // Process is going away.
        } catch (t: Throwable) {
            // Never let SDK failures reach the app's uncaught-exception handler.
            Log.w(LOG_TAG, "Lionscope link stopped: ${t.javaClass.simpleName}")
        }
    }

    /** Blocks (no polling) while the app has been in the background long enough; [setForeground] wakes it. */
    private fun parkWhileBackgrounded() = stateLock.withLock {
        while (policy.shouldPark(clock())) stateChanged.await()
    }

    private fun sleepBeforeRetry() = stateLock.withLock {
        stateChanged.await(policy.nextDelayMs(clock()), TimeUnit.MILLISECONDS)
    }

    /** Runs one connection attempt to completion and returns the state it ended in. */
    private fun connectOnce(): LinkState {
        val socket = Socket()
        val session = Session(socket)
        try {
            socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            socket.tcpNoDelay = true
            queue.clear()
            isConnected = true
            GatewayReader(socket.getInputStream(), onMessage = session::onMessage, onClosed = session::close).start()
            pump(session, BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8), WRITE_BUFFER))
        } catch (e: IOException) {
            // Connection refused / reset / closed: handled by the retry loop.
        } catch (e: RuntimeException) {
            // e.g. SecurityException without the INTERNET permission.
        } finally {
            isConnected = false
            session.close()
            negotiatedVersion = null
            if (session.welcomed) setWelcomed(false)
        }
        val reason = session.byeReason
        return if (reason != null) LinkState.bye(reason) else LinkState.DISCONNECTED
    }

    private fun pump(session: Session, out: BufferedWriter) {
        out.writeLine(helloLine())
        currentScreen?.let { out.writeLine(DeviceMessages.screen(clock(), it)) }
        out.flush()
        val batch = ArrayList<Any>(DRAIN_BATCH)
        var nextHeartbeat = clock() + heartbeatIntervalMs
        while (!session.closed) {
            queue.drainTo(batch, DRAIN_BATCH, (nextHeartbeat - clock()).coerceAtLeast(0))
            if (session.closed) return
            for (item in batch) encode(item, negotiatedVersion)?.let { out.writeLine(it) }
            batch.clear()
            val now = clock()
            if (now >= nextHeartbeat) {
                out.writeLine(DeviceMessages.heartbeat(now, queue.takeDropped()))
                nextHeartbeat = now + heartbeatIntervalMs
            }
            out.flush()
        }
    }


    private fun BufferedWriter.writeLine(line: String) {
        write(line)
        write('\n'.code)
    }

    private fun setWelcomed(welcomed: Boolean) {
        isWelcomed = welcomed
        dispatch(welcomeListeners, welcomed)
    }

    private fun <T> dispatch(listeners: List<(T) -> Unit>, value: T) {
        for (listener in listeners) {
            try {
                listener(value)
            } catch (e: Exception) {
                // A failing listener must not take the link down.
            }
        }
    }

    @Synchronized
    private fun logState(state: LinkState) {
        if (state == loggedState) return
        loggedState = state
        Log.i(LOG_TAG, state.message)
    }

    private inner class Session(private val socket: Socket) {
        @Volatile
        var closed = false
            private set

        @Volatile
        var welcomed = false
            private set

        @Volatile
        var byeReason: String? = null
            private set

        fun onMessage(message: GatewayMessage) {
            when (message) {
                is GatewayMessage.Welcome -> onWelcome(message.protocolVersion)
                is GatewayMessage.Bye -> {
                    byeReason = message.reason
                    close()
                }
                is GatewayMessage.Config -> onConfig(message.options)
                is GatewayMessage.Inspect -> onInspect(message.requestId)
            }
        }

        /** Ignored before `welcome`, after close, and on a link negotiated below v4. */
        @Synchronized
        private fun onInspect(requestId: Int) {
            if (!welcomed || closed || !speaks(negotiatedVersion, DEVICE_PROTOCOL_V4)) return
            dispatch(inspectListeners, requestId)
        }

        /** Ignored before `welcome`, after close, and on a link negotiated below v2. */
        @Synchronized
        private fun onConfig(options: SdkOptions) {
            if (!welcomed || closed || !speaksV2()) return
            dispatch(configListeners, options)
        }

        /** Synchronized with [close] so a late welcome can never outlive its connection. */
        @Synchronized
        private fun onWelcome(protocolVersion: Int) {
            if (welcomed || closed) return
            welcomed = true
            // Nothing below MIN exists while MIN is 1. Once MIN > 1, a welcome below MIN must close the link
            // (unsupported server) instead of being clamped up.
            negotiatedVersion = protocolVersion.coerceIn(MIN_DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_VERSION)
            stateLock.withLock { policy.onWelcome(clock()) }
            logState(LinkState.CONNECTED)
            setWelcomed(true)
        }

        @Synchronized
        fun close() {
            if (closed) return
            closed = true
            try {
                socket.close()
            } catch (e: IOException) {
                // Already closed.
            }
            queue.wake()
        }
    }

    /** A screen change waiting to be encoded on the link thread. */
    private class ScreenEvent(val ts: Long, val screen: ScreenRef?)

    /**
     * A message of v2 or later ([minVersion]), encoded on the link thread only if the connection it ends up on
     * negotiated at least [minVersion].
     */
    internal class V2Item(val sizeHint: Int, val minVersion: Int = DEVICE_PROTOCOL_V2, val encode: () -> String?)

    internal companion object {
        const val CONNECT_TIMEOUT_MS = 1_000
        const val HEARTBEAT_INTERVAL_MS = 5_000L
        const val DRAIN_BATCH = 64
        const val WRITE_BUFFER = 16 * 1024
        const val SCREEN_SIZE_HINT = 256

        fun sizeHint(item: Any): Int = when (item) {
            is String -> item.length
            is V2Item -> item.sizeHint
            else -> SCREEN_SIZE_HINT
        }

        fun speaksV2(negotiatedVersion: Int?): Boolean = speaks(negotiatedVersion, DEVICE_PROTOCOL_V2)

        fun speaks(negotiatedVersion: Int?, version: Int): Boolean = (negotiatedVersion ?: 0) >= version

        /**
         * The line to write for a queued [item], or null. A v2 item can have been queued for an earlier connection
         * (the offer raced a reconnect); on a connection negotiated below its version, or not welcomed yet, it is
         * dropped here. A failing v2 encoder drops that one message, never the connection.
         */
        fun encode(item: Any, negotiatedVersion: Int?): String? = when (item) {
            is ScreenEvent -> DeviceMessages.screen(item.ts, item.screen)
            is V2Item -> if (speaks(negotiatedVersion, item.minVersion)) encodeContained(item) else null
            else -> item.toString()
        }

        private fun encodeContained(item: V2Item): String? = try {
            item.encode()
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            null
        }
    }
}

/** Link states that are worth one log line each. */
internal class LinkState private constructor(private val key: String, val message: String) {
    override fun equals(other: Any?): Boolean = other is LinkState && other.key == key
    override fun hashCode(): Int = key.hashCode()

    companion object {
        val CONNECTED = LinkState("connected", "Connected to Lionscope server")
        val DISCONNECTED = LinkState("disconnected", "Disconnected from Lionscope server; retrying quietly")

        fun bye(reason: String) = LinkState("bye:$reason", "Lionscope server declined the link ($reason); retrying quietly")
    }
}

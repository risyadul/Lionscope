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
 * [helloLine] gets the connection's fresh nonce ([newNonce]); [linkKey] is the key held when a welcome arrives.
 */
internal class DeviceLink(
    private val helloLine: (nonce: String) -> String,
    private val host: String = "127.0.0.1",
    private val port: Int = DEVICE_LINK_PORT,
    private val clock: () -> Long = System::currentTimeMillis,
    private val policy: ReconnectPolicy = ReconnectPolicy(clock()),
    private val queue: OutboundQueue<Any> = OutboundQueue(sizeOf = ::sizeHint),
    private val heartbeatIntervalMs: Long = HEARTBEAT_INTERVAL_MS,
    private val linkKey: () -> ByteArray? = { LinkKey.current },
    private val newNonce: () -> String = LinkProof::newNonce,
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
    override var connection = 0
        private set

    /** True while the current connection is a profiling session (not an `inspect`-only link). */
    @Volatile
    var isSession = false
        private set

    /** True while the current connection is a v7 session whose welcome carried a valid link proof. */
    @Volatile
    override var isNetworkAuthenticated = false
        private set

    @Volatile
    private var currentScreen: ScreenRef? = null

    @Volatile
    private var loggedState = LinkState.DISCONNECTED

    private val stateLock = ReentrantLock()
    private val stateChanged = stateLock.newCondition()
    private val welcomeListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    private val sessionListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    private val configListeners = CopyOnWriteArrayList<(SdkOptions) -> Unit>()
    private val inspectListeners = CopyOnWriteArrayList<(Int) -> Unit>()
    private val mocksListeners = CopyOnWriteArrayList<(GatewayMessage) -> Unit>()
    private val viewEditListeners = CopyOnWriteArrayList<(GatewayMessage) -> Unit>()

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

    override fun sendV7(sizeHint: Int, encode: () -> String?) {
        if (isConnected && isNetworkAuthenticated && speaks(negotiatedVersion, DEVICE_PROTOCOL_V7)) {
            queue.offer(V2Item(sizeHint, DEVICE_PROTOCOL_V7, encode))
        }
    }

    override fun sendV8(sizeHint: Int, encode: () -> String?) {
        if (isConnected && speaks(negotiatedVersion, DEVICE_PROTOCOL_V8)) {
            queue.offer(V2Item(sizeHint, DEVICE_PROTOCOL_V8, encode))
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

    override fun addSessionListener(listener: (active: Boolean) -> Unit) {
        sessionListeners.add(listener)
    }

    override fun addConfigListener(listener: (SdkOptions) -> Unit) {
        configListeners.add(listener)
    }

    override fun addInspectListener(listener: (requestId: Int) -> Unit) {
        inspectListeners.add(listener)
    }

    override fun addMocksListener(listener: (GatewayMessage) -> Unit) {
        mocksListeners.add(listener)
    }

    override fun addViewEditListener(listener: (GatewayMessage) -> Unit) {
        viewEditListeners.add(listener)
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
        val session = Session(socket, newNonce())
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
            isNetworkAuthenticated = false
            if (session.welcomed) setWelcomed(false)
            if (isSession) setSession(false)
        }
        val reason = session.byeReason
        return if (reason != null) LinkState.bye(reason) else LinkState.DISCONNECTED
    }

    private fun pump(session: Session, out: BufferedWriter) {
        out.writeLine(helloLine(session.nonce))
        // Before `welcome` no version is agreed: a destination waits for it, so a v6 server gets its real kind.
        currentScreen?.takeIf { it.kind != ScreenKind.DESTINATION }?.let {
            out.writeLine(DeviceMessages.screen(clock(), it, negotiatedVersion = null))
        }
        out.flush()
        val batch = ArrayList<Any>(DRAIN_BATCH)
        var nextHeartbeat = clock() + heartbeatIntervalMs
        while (!session.closed) {
            queue.drainTo(batch, DRAIN_BATCH, (nextHeartbeat - clock()).coerceAtLeast(0))
            if (session.closed) return
            for (item in batch) encode(item, negotiatedVersion, isNetworkAuthenticated)?.let { out.writeLine(it) }
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

    private fun setSession(active: Boolean) {
        isSession = active
        dispatch(sessionListeners, active)
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

    /** One connection; [nonce] is the link proof challenge sent in its hello. */
    private inner class Session(private val socket: Socket, val nonce: String) {
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
                is GatewayMessage.Welcome -> onWelcome(message)
                is GatewayMessage.Bye -> {
                    byeReason = message.reason
                    close()
                }
                is GatewayMessage.Config -> onConfig(message.options)
                is GatewayMessage.Inspect -> onInspect(message.requestId)
                is GatewayMessage.Mocks, is GatewayMessage.Mock -> onMocks(message)
                is GatewayMessage.SetViewProperty, is GatewayMessage.RevertViewProperties -> onViewEdit(message)
            }
        }

        /** Ignored before `welcome`, after close, and on links that are not network-authenticated (v7 sessions only). */
        @Synchronized
        private fun onMocks(message: GatewayMessage) {
            if (!welcomed || closed || !isNetworkAuthenticated || !speaks(negotiatedVersion, DEVICE_PROTOCOL_V7)) return
            dispatch(mocksListeners, message)
        }

        /** Ignored before `welcome`, after close, and on a link negotiated below v8. */
        @Synchronized
        private fun onViewEdit(message: GatewayMessage) {
            if (!welcomed || closed || !speaks(negotiatedVersion, DEVICE_PROTOCOL_V8)) return
            dispatch(viewEditListeners, message)
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
        private fun onWelcome(welcome: GatewayMessage.Welcome) {
            if (welcomed || closed) return
            welcomed = true
            connection++
            // Nothing below MIN exists while MIN is 1. Once MIN > 1, a welcome below MIN must close the link
            // (unsupported server) instead of being clamped up.
            val version = welcome.protocolVersion.coerceIn(MIN_DEVICE_PROTOCOL_VERSION, DEVICE_PROTOCOL_VERSION)
            negotiatedVersion = version
            // `mode` exists from v5 on; below it every welcome is a session.
            val session = !(welcome.inspectOnly && speaks(version, DEVICE_PROTOCOL_V5))
            stateLock.withLock { policy.onWelcome(clock()) }
            currentScreen?.takeIf { it.kind == ScreenKind.DESTINATION }?.let { queue.offer(ScreenEvent(clock(), it)) }
            logState(LinkState.CONNECTED)
            setWelcomed(true)
            if (!session) return
            // Before the session listeners run: network capture follows this.
            isNetworkAuthenticated = speaks(version, DEVICE_PROTOCOL_V7) && isProven(welcome)
            setSession(true)
        }

        /** The welcome's proof over this connection's nonce, as sent (its `protocolVersion`), with the key held now. */
        private fun isProven(welcome: GatewayMessage.Welcome): Boolean = try {
            LinkProof.verifySession(linkKey(), nonce, welcome.protocolVersion, welcome.proof)
        } catch (e: Exception) {
            // No HMAC on this device, or a key it refuses: network stays off.
            false
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
         * dropped here, and a v7 (network) item unless the connection is [networkAuthenticated]. A failing v2 encoder
         * drops that one message, never the connection.
         */
        fun encode(item: Any, negotiatedVersion: Int?, networkAuthenticated: Boolean = false): String? = when (item) {
            // A destination queued before `welcome` is offered again once the version is agreed (see onWelcome).
            is ScreenEvent -> if (item.screen?.kind == ScreenKind.DESTINATION && negotiatedVersion == null) {
                null
            } else {
                DeviceMessages.screen(item.ts, item.screen, negotiatedVersion)
            }
            is V2Item -> if (speaks(negotiatedVersion, item.minVersion) &&
                (item.minVersion < DEVICE_PROTOCOL_V7 || networkAuthenticated)
            ) {
                encodeContained(item)
            } else {
                null
            }
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

package io.github.risyadul.lionscope

import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArrayList

/** Main-thread stand-in: tasks run only when the test says so. */
internal class FakeScheduler : MainScheduler {
    private val posted = ArrayDeque<Runnable>()
    val delayed = ArrayList<Pair<Runnable, Long>>()

    override fun post(task: Runnable) {
        posted.addLast(task)
    }

    override fun postDelayed(task: Runnable, delayMs: Long) {
        delayed += task to delayMs
    }

    val pendingCount: Int
        get() = posted.size

    fun runPosted() {
        while (posted.isNotEmpty()) posted.pollFirst()!!.run()
    }

    fun runDelayed() {
        val due = delayed.toList()
        delayed.clear()
        due.forEach { it.first.run() }
        runPosted()
    }
}

internal class FakeLink : LinkPort {
    override fun dropConnection() {
        drops++
    }

    private val listeners = ArrayList<(Boolean) -> Unit>()
    private val sessionListeners = ArrayList<(Boolean) -> Unit>()
    private val configListeners = ArrayList<(SdkOptions) -> Unit>()
    private val inspectListeners = ArrayList<(Int) -> Unit>()
    private val mocksListeners = ArrayList<(GatewayMessage) -> Unit>()
    private val viewEditListeners = ArrayList<(GatewayMessage) -> Unit>()
    private val storageListeners = ArrayList<(GatewayMessage) -> Unit>()
    val screens = ArrayList<ScreenRef?>()
    val foreground = ArrayList<Boolean>()
    val v2Lines = ArrayList<String>()
    val v3Lines = ArrayList<String>()
    val v4Lines = ArrayList<String>()
    /** Network lines arrive from OkHttp's threads too. */
    val v7Lines = CopyOnWriteArrayList<String>()
    val v8Lines = ArrayList<String>()
    /** Each v8 item as the real link would queue it, for [DeviceLink.encode] (the link proof gate). */
    val v8Items = ArrayList<DeviceLink.V2Item>()
    val v10Lines = ArrayList<String>()
    /** Each v10 item as the real link would queue it, for [DeviceLink.encode] (the link proof gate). */
    val v10Items = ArrayList<DeviceLink.V2Item>()
    /** v11 lines (storage answers) from any thread. */
    val v11Lines = CopyOnWriteArrayList<String>()
    val v11Items = CopyOnWriteArrayList<DeviceLink.V2Item>()
    var failure: Throwable? = null
    /** [dropConnection] calls (the connection-drop hook). */
    var drops = 0
    /** Thrown by [sendV7] (a link that fails while the interceptor records). */
    var v7Failure: Throwable? = null

    override var isWelcomed = false
        private set

    override var negotiatedVersion: Int? = null
        private set

    override var isServerVerified = false
        private set
    override var connection = 0
        private set

    override fun onScreen(ts: Long, screen: ScreenRef?) {
        failure?.let { throw it }
        screens += screen
    }

    override fun setForeground(foreground: Boolean) {
        this.foreground += foreground
    }

    override fun addWelcomeListener(listener: (welcomed: Boolean) -> Unit) {
        listeners += listener
    }

    override fun addSessionListener(listener: (active: Boolean) -> Unit) {
        sessionListeners += listener
    }

    override fun addConfigListener(listener: (SdkOptions) -> Unit) {
        configListeners += listener
    }

    /** Encodes right away, as the link thread would. */
    override fun sendV2(sizeHint: Int, encode: () -> String?) {
        encode()?.let { v2Lines += it }
    }

    /** Encodes right away, as the link thread would. */
    override fun sendV3(sizeHint: Int, encode: () -> String?) {
        encode()?.let { v3Lines += it }
    }

    override fun addInspectListener(listener: (requestId: Int) -> Unit) {
        inspectListeners += listener
    }

    /** Encodes right away, as the link thread would; dropped below v4 like the real link. */
    override fun sendV4(sizeHint: Int, encode: () -> String?) {
        if ((negotiatedVersion ?: 0) >= DEVICE_PROTOCOL_V4) encode()?.let { v4Lines += it }
    }

    /** Encodes right away, as the link thread would; dropped unless a server-verified link, like the real one. */
    override fun sendV7(sizeHint: Int, encode: () -> String?) {
        v7Failure?.let { throw it }
        if (isServerVerified) encode()?.let { v7Lines += it }
    }

    override fun addMocksListener(listener: (GatewayMessage) -> Unit) {
        mocksListeners += listener
    }

    /** A `mocks` / `mock` line from the server (the real link forwards them only on server-verified links). */
    fun gateway(message: GatewayMessage) {
        mocksListeners.forEach { it(message) }
    }

    override fun addViewEditListener(listener: (GatewayMessage) -> Unit) {
        viewEditListeners += listener
    }

    /** Encodes right away, as the link thread would; dropped below v8 like the real link. */
    override fun sendV8(sizeHint: Int, encode: () -> String?) {
        if ((negotiatedVersion ?: 0) < DEVICE_PROTOCOL_V8) return
        v8Items += DeviceLink.V2Item(sizeHint, DEVICE_PROTOCOL_V8, encode)
        encode()?.let { v8Lines += it }
    }

    override fun addStorageListener(listener: (GatewayMessage) -> Unit) {
        storageListeners += listener
    }

    /** A v11 storage request from the server (the real link forwards it on a v11 link). */
    fun storage(message: GatewayMessage) {
        storageListeners.forEach { it(message) }
    }

    /**
     * Encodes right away; dropped below v11 like the real link. The items are kept too ([v11Items]), for tests that
     * write them through the real encoder (DeviceLink.encode: the link proof gate this fake does not apply).
     */
    override fun sendV11(sizeHint: Int, encode: () -> String?) {
        if ((negotiatedVersion ?: 0) < DEVICE_PROTOCOL_V11) return
        v11Items += DeviceLink.V2Item(sizeHint, DEVICE_PROTOCOL_V11, encode)
        encode()?.let { v11Lines += it }
    }

    /** Encodes right away, as the link thread would; dropped below v10 like the real link. */
    override fun sendV10(sizeHint: Int, encode: () -> String?) {
        if ((negotiatedVersion ?: 0) < DEVICE_PROTOCOL_V10) return
        v10Items += DeviceLink.V2Item(sizeHint, DEVICE_PROTOCOL_V10, encode)
        encode()?.let { v10Lines += it }
    }

    fun inspect(requestId: Int) {
        inspectListeners.forEach { it(requestId) }
    }

    fun viewEdit(message: GatewayMessage) {
        viewEditListeners.forEach { it(message) }
    }

    /**
     * [inspectOnly]: a v5 `inspect`-mode welcome, which the real link does not report as a session. [proven]: the
     * welcome carried a valid link proof (server-verified on a v7 session).
     */
    fun welcome(
        welcomed: Boolean,
        version: Int = DEVICE_PROTOCOL_VERSION,
        inspectOnly: Boolean = false,
        proven: Boolean = true,
    ) {
        isWelcomed = welcomed
        negotiatedVersion = if (welcomed) version else null
        isServerVerified = welcomed && !inspectOnly && proven && version >= DEVICE_PROTOCOL_V7
        if (welcomed) connection++
        listeners.forEach { it(welcomed) }
        if (!inspectOnly) sessionListeners.forEach { it(welcomed) }
    }

    fun config(options: SdkOptions) {
        configListeners.forEach { it(options) }
    }
}

package io.github.risyadul.lionscope

import java.util.ArrayDeque

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
    private val listeners = ArrayList<(Boolean) -> Unit>()
    private val sessionListeners = ArrayList<(Boolean) -> Unit>()
    private val configListeners = ArrayList<(SdkOptions) -> Unit>()
    private val inspectListeners = ArrayList<(Int) -> Unit>()
    val screens = ArrayList<ScreenRef?>()
    val foreground = ArrayList<Boolean>()
    val v2Lines = ArrayList<String>()
    val v3Lines = ArrayList<String>()
    val v4Lines = ArrayList<String>()
    var failure: Throwable? = null

    override var isWelcomed = false
        private set

    override var negotiatedVersion: Int? = null
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

    fun inspect(requestId: Int) {
        inspectListeners.forEach { it(requestId) }
    }

    /** [inspectOnly]: a v5 `inspect`-mode welcome, which the real link does not report as a session. */
    fun welcome(welcomed: Boolean, version: Int = DEVICE_PROTOCOL_VERSION, inspectOnly: Boolean = false) {
        isWelcomed = welcomed
        negotiatedVersion = if (welcomed) version else null
        listeners.forEach { it(welcomed) }
        if (!inspectOnly) sessionListeners.forEach { it(welcomed) }
    }

    fun config(options: SdkOptions) {
        configListeners.forEach { it(options) }
    }
}
